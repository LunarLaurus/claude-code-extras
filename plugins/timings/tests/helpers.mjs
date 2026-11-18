// Shared plumbing for the node:test suites: temp dirs, a framing-level hookd client, a daemon process launcher.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const testsDir = dirname(fileURLToPath(import.meta.url));
export const pluginDir = join(testsDir, "..");
export const scriptsDir = join(pluginDir, "scripts");
export const hookPath = join(scriptsDir, "hook.mjs");
export const hookdPath = join(scriptsDir, "hookd.mjs");
export const clientPath = join(scriptsDir, "hook-client.sh");
export const referenceHookPath = join(testsDir, "fixtures", "hook.reference.mjs");
export const fakeClockPath = join(testsDir, "fixtures", "fake-clock.mjs");
/** `node --import` needs a file URL on Windows, where a drive-letter path parses as a URL scheme. */
export const fakeClockUrl = pathToFileURL(fakeClockPath).href;

/** Creates a throwaway directory under the OS temp dir. */
export function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}

/** Removes a directory tree, ignoring a missing one. */
export function removeDir(dir) {
  rmSync(dir, { recursive: true, force: true });
}

/** Resolves a port nothing is listening on right now. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** Polls `check` until it returns a truthy value or the deadline passes. */
export async function waitFor(check, timeoutMs = 8000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** Returns the path of a usable bash, or null when none is on PATH. */
export function findBash() {
  const probe = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" });
  return probe.status === 0 && probe.stdout.trim() === "ok" ? "bash" : null;
}

/** Parses the daemon's key=value state file, or returns null when absent. */
export function readStateFile(stateDir) {
  const path = join(stateDir, "state");
  if (!existsSync(path)) return null;
  const state = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) state[line.slice(0, at)] = line.slice(at + 1);
  }
  return Object.keys(state).length ? state : null;
}

/** Reads the daemon's auth token from its state dir. */
export function readToken(stateDir) {
  return readFileSync(join(stateDir, "token"), "utf8").trim();
}

/**
 * Speaks the hookd wire protocol directly. Returns the raw reply text, or null if the daemon dropped the connection
 * without answering. `rawBody` overrides the framed payload; `lengthOverride` lies about the payload length.
 */
export function sendRequest({
  port,
  token,
  plugin = "timings",
  event = "PreToolUse",
  env = {},
  payload = "{}",
  lengthOverride,
  closeEarly = false,
}) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const chunks = [];
    const body = Buffer.from(payload, "utf8");
    socket.on("connect", () => {
      const envLines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
      const header =
        `${token}\n${plugin} ${event} ${lengthOverride ?? body.length}\n${envLines.length}\n` +
        envLines.map((line) => `${line}\n`).join("");
      socket.write(header);
      if (closeEarly) {
        socket.write(body.subarray(0, Math.floor(body.length / 2)));
        socket.end();
        return;
      }
      socket.write(body);
    });
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", () => resolve(chunks.length ? Buffer.concat(chunks).toString("utf8") : null));
    socket.on("close", () => resolve(chunks.length ? Buffer.concat(chunks).toString("utf8") : null));
    setTimeout(() => {
      socket.destroy();
      resolve(chunks.length ? Buffer.concat(chunks).toString("utf8") : null);
    }, 6000).unref();
  });
}

/** Splits a hookd reply into the handler stdout and the trailing exit-code line. */
export function parseReply(reply) {
  const trimmed = reply.endsWith("\n") ? reply.slice(0, -1) : reply;
  const cut = trimmed.lastIndexOf("\n");
  return { stdout: cut === -1 ? "" : trimmed.slice(0, cut), code: cut === -1 ? trimmed : trimmed.slice(cut + 1) };
}

/** Launches hookd.mjs as a child process (optionally under the fake clock) and waits for its state file. */
export async function startDaemonProcess({ stateDir, port, env = {}, fakeClock = false, idleMs, script = hookdPath }) {
  const args = fakeClock ? ["--import", fakeClockUrl, script] : [script];
  const child = spawn(process.execPath, args, {
    env: {
      ...process.env,
      CLAUDE_HOOKD_STATE_DIR: stateDir,
      CLAUDE_HOOKD_PORT: String(port),
      ...(idleMs === undefined ? {} : { CLAUDE_HOOKD_IDLE_MS: String(idleMs) }),
      ...env,
    },
    stdio: "ignore",
    windowsHide: true,
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  await waitFor(() => readStateFile(stateDir)?.port === String(port));
  return { child, exited, token: readToken(stateDir) };
}

/** Snapshot of every file under `root` as { relativePath: contents }, for comparing state dirs. */
export function snapshotDir(root) {
  const files = {};
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files[relative(root, path).split("\\").join("/")] = readFileSync(path, "utf8");
    }
  };
  if (existsSync(root)) walk(root);
  return files;
}
