#!/usr/bin/env node
// Resident hook daemon. Claude Code starts a fresh process for every hook event; under load the node start-up alone
// costs several hundred milliseconds, twice per tool call per agent. This daemon keeps the handler module loaded and
// answers events over a loopback socket, so scripts/hook-client.sh can serve an event without starting node.
//
// Wire protocol, one request per connection (bash cannot half-close a /dev/tcp socket, so the payload is
// length-prefixed instead of read until EOF):
//
//   <token>\n
//   <pluginId> <eventName> <payloadBytes>\n
//   <envCount>\n
//   NAME=value\n            (envCount lines; only CLAUDE_PLUGIN_ROOT, CLAUDE_PLUGIN_DATA, CLAUDE_PLUGIN_OPTION_*)
//   <payloadBytes bytes of event JSON>
//
// Reply: the handler's stdout, "\n", then the exit code (or the word FALLBACK) and "\n". FALLBACK means the daemon
// did not handle the event and the client must run `node hook.mjs` itself. A request that fails authentication or
// framing is dropped without a reply, which the client also treats as "fall back".
//
// Safety posture: loopback only, token-authenticated, handlers come from a static allow-list (hookd.json) loaded at
// start-up and are never chosen by a path in a request, no child processes, nothing written outside the state dir
// (the handlers write only to the plugin data dir they have always written to).

import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_ENV_LINES = 64;
const MAX_ENV_LINE_BYTES = 8 * 1024;
export const HEARTBEAT_STALE_SECONDS = 40;
const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const DEFAULT_WATCHDOG_MS = 2000;
const DEFAULT_HEARTBEAT_MS = 10 * 1000;

const EMPTY_REPLY = "\n0\n";
const FALLBACK_REPLY = "\nFALLBACK\n";

const REQUEST_LINE = /^([A-Za-z0-9_-]{1,32}) ([A-Za-z]{1,40}) (\d{1,10})$/;
const ENV_NAME = /^CLAUDE_PLUGIN_(ROOT|DATA|OPTION_[A-Z0-9_]{1,64})$/;

const scriptsDir = dirname(fileURLToPath(import.meta.url));

/** Seconds since the epoch from a clock that scripted-clock test harnesses do not replace. */
function wallSeconds() {
  return Math.floor((performance.timeOrigin + performance.now()) / 1000);
}

/** Normalises a path for comparison: absolute, forward slashes, case-folded on Windows. */
function normalisePath(path) {
  const flat = resolve(path).split("\\").join("/");
  return process.platform === "win32" ? flat.toLowerCase() : flat;
}

/** Parses the daemon's `key=value` state file; returns null when it is missing or empty. */
export function readState(stateDir) {
  try {
    const state = {};
    for (const line of readFileSync(join(stateDir, "state"), "utf8").split("\n")) {
      const at = line.indexOf("=");
      if (at > 0) state[line.slice(0, at)] = line.slice(at + 1);
    }
    return Object.keys(state).length ? state : null;
  } catch {
    return null;
  }
}

/** True when a process with this pid exists (signal 0 only probes). */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** The state directory for a plugin: an explicit override, else <tmp>/claude-code-hookd/<pluginId>. */
export function defaultStateDir(pluginId, env = process.env) {
  return env.CLAUDE_HOOKD_STATE_DIR || join(tmpdir(), "claude-code-hookd", pluginId);
}

function readAllowList(pluginDir) {
  const list = JSON.parse(readFileSync(join(pluginDir, "scripts", "hookd.json"), "utf8"));
  if (typeof list.pluginId !== "string" || !/^[A-Za-z0-9_-]{1,32}$/.test(list.pluginId)) throw new Error("bad pluginId");
  if (!list.handlers || typeof list.handlers !== "object") throw new Error("hookd.json has no handlers");
  return list;
}

function readVersion(pluginDir) {
  return JSON.parse(readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8")).version;
}

/** Imports each allow-listed handler module; a path that escapes the scripts dir is refused. */
async function loadHandlers(pluginDir, list) {
  const base = realpathSync(join(pluginDir, "scripts"));
  const handlers = new Map();
  for (const [id, relative] of Object.entries(list.handlers)) {
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id) || id.startsWith("_")) throw new Error(`bad handler id ${id}`);
    const file = realpathSync(resolve(base, String(relative)));
    if (!file.startsWith(base + sep)) throw new Error(`handler ${id} escapes the plugin scripts dir`);
    const module = await import(pathToFileURL(file).href);
    if (typeof module.handleEvent !== "function") throw new Error(`handler ${id} exports no handleEvent`);
    handlers.set(id, module.handleEvent);
  }
  return handlers;
}

/**
 * Splits a request buffer into its parts. Returns { status: "more" } until the whole request has arrived,
 * { status: "bad" } for a malformed one, { status: "oversize" } when the payload exceeds the cap, and
 * { status: "ok", request } when complete. `checkToken` runs as soon as the first line is available.
 */
function parseRequest(buffer, checkToken) {
  let offset = 0;
  const nextLine = (limit) => {
    const end = buffer.indexOf(10, offset);
    if (end === -1) return buffer.length - offset > limit ? { bad: true } : null;
    if (end - offset > limit) return { bad: true };
    const line = buffer.toString("utf8", offset, end);
    offset = end + 1;
    return { line };
  };

  const tokenLine = nextLine(256);
  if (!tokenLine) return { status: "more" };
  if (tokenLine.bad || !checkToken(tokenLine.line)) return { status: "bad" };

  const requestLine = nextLine(128);
  if (!requestLine) return { status: "more" };
  const match = requestLine.bad ? null : REQUEST_LINE.exec(requestLine.line);
  if (!match) return { status: "bad" };
  const [, plugin, eventName, lengthText] = match;
  const length = Number(lengthText);
  if (length > MAX_PAYLOAD_BYTES) return { status: "oversize" };

  const countLine = nextLine(8);
  if (!countLine) return { status: "more" };
  if (countLine.bad || !/^\d{1,3}$/.test(countLine.line) || Number(countLine.line) > MAX_ENV_LINES) return { status: "bad" };

  const env = {};
  for (let i = 0; i < Number(countLine.line); i += 1) {
    const envLine = nextLine(MAX_ENV_LINE_BYTES);
    if (!envLine) return { status: "more" };
    if (envLine.bad) return { status: "bad" };
    const at = envLine.line.indexOf("=");
    const name = at > 0 ? envLine.line.slice(0, at) : "";
    if (ENV_NAME.test(name)) env[name] = envLine.line.slice(at + 1);
  }

  if (buffer.length - offset < length) return { status: "more" };
  return { status: "ok", request: { plugin, eventName, env, payload: buffer.toString("utf8", offset, offset + length) } };
}

/**
 * Starts the daemon. Returns null when another live daemon already owns the state dir or the port; otherwise an
 * object with `port`, `address`, `stop()` and a `closed` promise that resolves once the daemon has shut down.
 *
 * @param {object} options
 * @param {string} [options.pluginDir] plugin root (defaults to this script's parent).
 * @param {string} [options.stateDir] where state/token live.
 * @param {number} [options.port] listen port (0 picks a free one).
 * @param {number} [options.idleMs] exit after this long without a request.
 * @param {number} [options.watchdogMs] per-request deadline for receiving the request.
 * @param {number} [options.heartbeatMs] how often the state file's aliveAt is refreshed.
 * @param {string} [options.expectedRoot] the CLAUDE_PLUGIN_ROOT clients must present; defaults to pluginDir.
 */
export async function startDaemon(options = {}) {
  const pluginDir = options.pluginDir ?? dirname(scriptsDir);
  const list = readAllowList(pluginDir);
  const stateDir = options.stateDir ?? defaultStateDir(list.pluginId);
  const port = options.port ?? list.defaultPort;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const watchdogMs = options.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const expectedRoot = normalisePath(options.expectedRoot ?? pluginDir);
  const startVersion = readVersion(pluginDir);

  // A live daemon with a fresh heartbeat owns this state dir. A dead pid or a stale heartbeat is a leftover to replace.
  const existing = readState(stateDir);
  if (existing && isProcessAlive(Number(existing.pid)) && wallSeconds() - Number(existing.aliveAt) < HEARTBEAT_STALE_SECONDS) {
    return null;
  }

  const handlers = await loadHandlers(pluginDir, list);
  const token = randomBytes(32).toString("hex");
  const tokenBytes = Buffer.from(token);
  const startedAt = wallSeconds();
  const stats = { handled: 0, fallbacks: 0 };
  const sockets = new Set();
  let stopped = false;
  let idleTimer;
  let heartbeatTimer;
  let resolveClosed;
  const closed = new Promise((done) => {
    resolveClosed = done;
  });

  const server = net.createServer({ allowHalfOpen: true });

  const listening = await new Promise((done) => {
    server.once("error", (err) => done(err));
    server.listen(port, "127.0.0.1", () => done(null));
  });
  if (listening) {
    if (listening.code === "EADDRINUSE") return null;
    throw listening;
  }
  const address = server.address();

  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "token"), token, { mode: 0o600 });

  function writeState() {
    const body =
      `port=${address.port}\npid=${process.pid}\nstartedAt=${startedAt}\nversion=${startVersion}\n` +
      `root=${expectedRoot}\naliveAt=${wallSeconds()}\n`;
    const tmp = join(stateDir, `state.${process.pid}.tmp`);
    try {
      writeFileSync(tmp, body);
      renameSync(tmp, join(stateDir, "state"));
    } catch {
      try {
        writeFileSync(join(stateDir, "state"), body); // a reader holding the file open can block the rename on Windows
      } catch {
        // The next heartbeat retries; a missing state file only costs clients one node start.
      }
      rmSync(tmp, { force: true });
    }
  }

  function removeOwnState() {
    const state = readState(stateDir);
    if (state && state.pid !== String(process.pid)) return; // another daemon took over; leave its files alone
    rmSync(join(stateDir, "state"), { force: true });
    rmSync(join(stateDir, "token"), { force: true });
  }

  async function stop() {
    if (stopped) return closed;
    stopped = true;
    clearTimeout(idleTimer);
    clearInterval(heartbeatTimer);
    removeOwnState();
    for (const socket of sockets) socket.destroy();
    await new Promise((done) => server.close(() => done()));
    resolveClosed();
    return closed;
  }

  function touchIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void stop(), idleMs);
    idleTimer.unref?.();
  }

  function tokenMatches(candidate) {
    const given = Buffer.from(candidate);
    return given.length === tokenBytes.length && timingSafeEqual(given, tokenBytes);
  }

  /** Decides the reply for an authenticated, fully received request. */
  function serve(request, receivedAt) {
    if (request.plugin === "_status") return `${JSON.stringify({ ...stats, pid: process.pid, version: startVersion })}\n0\n`;
    if (request.plugin === "_shutdown") {
      setImmediate(() => void stop());
      return EMPTY_REPLY;
    }

    const handle = handlers.get(request.plugin);
    if (!handle) return FALLBACK_REPLY;

    let diskVersion;
    try {
      diskVersion = readVersion(pluginDir);
    } catch {
      diskVersion = undefined;
    }
    const presentedRoot = request.env.CLAUDE_PLUGIN_ROOT;
    if (diskVersion !== startVersion || (presentedRoot !== undefined && normalisePath(presentedRoot) !== expectedRoot)) {
      stats.fallbacks += 1;
      setImmediate(() => void stop()); // a newer plugin version is on disk: this daemon is stale
      return FALLBACK_REPLY;
    }

    const dataDir = request.env.CLAUDE_PLUGIN_DATA;
    if (dataDir !== undefined && (!isAbsolute(dataDir) || dataDir.split(/[\\/]/).includes(".."))) return FALLBACK_REPLY;

    stats.handled += 1;
    let event;
    try {
      event = JSON.parse(request.payload || "{}");
    } catch {
      return EMPTY_REPLY; // not JSON: nothing to time, exactly as the script behaves
    }

    try {
      const { stdout, exitCode } = handle(event, { env: request.env, uptimeMs: () => performance.now() - receivedAt });
      return `${stdout}\n${exitCode}\n`;
    } catch {
      return EMPTY_REPLY; // fail open: a broken handler must not wedge the session
    }
  }

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());

    const receivedAt = performance.now();
    const chunks = [];
    let received = 0;
    let settled = false;

    const settle = (reply) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      if (reply === null) socket.destroy();
      else socket.end(reply);
    };

    // The watchdog covers receiving the request, so when it fires the handler has not run: answer FALLBACK and let
    // the client run node, rather than an empty reply that would silently drop the event. Handlers are synchronous,
    // so once one starts it cannot be pre-empted here; its own failure modes are all caught inside handleEvent.
    const watchdog = setTimeout(() => settle(FALLBACK_REPLY), watchdogMs);
    watchdog.unref?.();

    socket.on("data", (chunk) => {
      if (settled) return;
      chunks.push(chunk);
      received += chunk.length;
      if (received > MAX_HEADER_BYTES + MAX_PAYLOAD_BYTES) return settle(null);
      const parsed = parseRequest(Buffer.concat(chunks), tokenMatches);
      if (parsed.status === "more") return;
      if (parsed.status === "bad") return settle(null);
      if (parsed.status === "oversize") return settle(FALLBACK_REPLY);
      touchIdle();
      settle(serve(parsed.request, receivedAt));
    });

    socket.on("end", () => {
      if (!settled) settle(null); // client went away before the request was complete
    });
  });

  writeState();
  rmSync(join(stateDir, "spawn.lock"), { force: true });
  heartbeatTimer = setInterval(writeState, heartbeatMs);
  heartbeatTimer.unref?.();
  touchIdle();

  return { port: address.port, address, stop, closed, stats };
}

/** Sends the authenticated `_shutdown` request to the daemon recorded in the state dir. */
async function stopRunningDaemon(stateDir) {
  const state = readState(stateDir);
  if (!state) return "no daemon recorded";
  const token = readFileSync(join(stateDir, "token"), "utf8").trim();
  await new Promise((done) => {
    const socket = net.connect({ port: Number(state.port), host: "127.0.0.1" }, () => {
      socket.write(`${token}\n_shutdown Stop 0\n0\n`);
    });
    socket.on("close", done);
    socket.on("error", done);
    setTimeout(() => socket.destroy(), 3000).unref();
  });
  return "stop requested";
}

async function main() {
  const list = readAllowList(dirname(scriptsDir));
  const stateDir = defaultStateDir(list.pluginId);

  if (process.argv[2] === "stop") {
    console.log(await stopRunningDaemon(stateDir));
    return;
  }

  const number = (name) => (process.env[name] ? Number(process.env[name]) : undefined);
  const daemon = await startDaemon({
    stateDir,
    port: number("CLAUDE_HOOKD_PORT"),
    idleMs: number("CLAUDE_HOOKD_IDLE_MS"),
    expectedRoot: process.env.CLAUDE_PLUGIN_ROOT || undefined,
  });
  if (!daemon) return; // another daemon is already serving this plugin

  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => void daemon.stop());
  await daemon.closed;
}

const isEntryPoint = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isEntryPoint) {
  main().then(
    () => process.exit(0),
    () => process.exit(0), // fail open: a daemon that cannot start simply leaves clients on the node path
  );
}
