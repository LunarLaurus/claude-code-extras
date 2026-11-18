// Daemon protocol and lifecycle: framing, auth, caps, stale state, idle exit, version fallback, concurrency.

import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  freePort,
  hookdPath,
  makeTempDir,
  parseReply,
  pluginDir,
  readStateFile,
  readToken,
  removeDir,
  sendRequest,
  startDaemonProcess,
  waitFor,
} from "./helpers.mjs";

const { startDaemon } = await import(pathToFileURL(hookdPath).href);

const scratch = [];
const tempDir = (prefix) => {
  const dir = makeTempDir(prefix);
  scratch.push(dir);
  return dir;
};
after(() => scratch.forEach(removeDir));

const running = [];
after(async () => {
  for (const daemon of running) await daemon.stop();
});

/** Copies the plugin's manifest and scripts so a test can edit the version without touching the repo. */
function copyPlugin() {
  const dir = tempDir("hookd-plugin");
  cpSync(join(pluginDir, ".claude-plugin"), join(dir, ".claude-plugin"), { recursive: true });
  mkdirSync(join(dir, "scripts"));
  for (const name of ["hook.mjs", "hookd.json"]) cpSync(join(pluginDir, "scripts", name), join(dir, "scripts", name));
  return dir;
}

async function boot(options = {}) {
  const stateDir = options.stateDir ?? tempDir("hookd-state");
  const dataDir = tempDir("hookd-data");
  const daemon = await startDaemon({
    pluginDir: options.pluginDir ?? pluginDir,
    stateDir,
    port: options.port ?? (await freePort()),
    idleMs: options.idleMs,
    watchdogMs: options.watchdogMs,
  });
  running.push(daemon);
  const token = readToken(stateDir);
  const root = options.pluginDir ?? pluginDir;
  const env = { CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: dataDir };
  return { daemon, stateDir, dataDir, token, env, port: daemon.port };
}

const promptEvent = (session) => JSON.stringify({ session_id: session, hook_event_name: "UserPromptSubmit" });

describe("framing", () => {
  test("serves a valid request: handler stdout, then the exit code as the final line", async () => {
    const d = await boot();
    const reply = await sendRequest({ ...d, event: "UserPromptSubmit", payload: promptEvent("f1") });
    const { stdout, code } = parseReply(reply);
    assert.equal(code, "0");
    assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /<timing-prompt>/);
    assert.ok(reply.endsWith("\n0\n"));
  });

  test("an event with no output replies with an empty body and exit code 0", async () => {
    const d = await boot();
    const reply = await sendRequest({ ...d, event: "SubagentStop", payload: JSON.stringify({ session_id: "f2" }) });
    assert.equal(reply, "\n0\n");
  });

  test("a malformed JSON payload replies empty with exit code 0, as the script does today", async () => {
    const d = await boot();
    assert.equal(await sendRequest({ ...d, payload: "not json at all" }), "\n0\n");
  });

  test("drops a request with the wrong token without answering", async () => {
    const d = await boot();
    const reply = await sendRequest({ ...d, token: "0".repeat(64), payload: promptEvent("f3") });
    assert.equal(reply, null);
    assert.ok(!existsSync(join(d.dataDir, "sessions", "f3")), "a wrong-token request must not reach the handler");
  });

  test("drops a truncated payload without running the handler", async () => {
    const d = await boot();
    const reply = await sendRequest({ ...d, event: "UserPromptSubmit", payload: promptEvent("f4"), closeEarly: true });
    assert.equal(reply, null);
    assert.ok(!existsSync(join(d.dataDir, "sessions", "f4")));
    const after = await sendRequest({ ...d, event: "UserPromptSubmit", payload: promptEvent("f4b") });
    assert.equal(parseReply(after).code, "0", "the daemon must survive a truncated request");
  });

  test("tells the client to fall back when the payload exceeds the 1 MB cap", async () => {
    const d = await boot();
    const reply = await sendRequest({ ...d, payload: "{}", lengthOverride: 1024 * 1024 + 1 });
    assert.equal(parseReply(reply).code, "FALLBACK");
  });

  test("accepts a payload of exactly 1 MB", async () => {
    const d = await boot();
    const base = JSON.stringify({ session_id: "f5", hook_event_name: "SubagentStop", pad: "" });
    const payload = JSON.stringify({ session_id: "f5", hook_event_name: "SubagentStop", pad: "x".repeat(1024 * 1024 - base.length) });
    assert.equal(Buffer.byteLength(payload), 1024 * 1024);
    assert.equal(await sendRequest({ ...d, payload }), "\n0\n");
  });

  test("an unknown plugin id falls back and never touches the handler", async () => {
    const d = await boot();
    for (const plugin of ["quota", "../../etc/passwd", "C:\\evil", "timings/../x"]) {
      const reply = await sendRequest({ ...d, plugin, payload: promptEvent("f6") });
      assert.equal(parseReply(reply ?? "\nDROPPED\n").code === "FALLBACK" || reply === null, true, plugin);
    }
    assert.ok(!existsSync(join(d.dataDir, "sessions", "f6")));
  });

  test("a malformed header line is dropped", async () => {
    const d = await boot();
    assert.equal(await sendRequest({ ...d, event: "Bad Event Name!", payload: "{}" }), null);
  });

  test("only CLAUDE_PLUGIN_* variables are accepted from the request env", async () => {
    const d = await boot();
    const reply = await sendRequest({
      ...d,
      env: { ...d.env, PATH: "/evil", CLAUDE_PLUGIN_OPTION_SHOW_CLOCK: "false" },
      event: "UserPromptSubmit",
      payload: promptEvent("f7"),
    });
    assert.equal(reply, "\n0\n", "the forwarded SHOW_CLOCK=false option must be honoured");
  });

  test("a relative CLAUDE_PLUGIN_DATA is refused so the handler cannot write somewhere unexpected", async () => {
    const d = await boot();
    const reply = await sendRequest({ ...d, env: { ...d.env, CLAUDE_PLUGIN_DATA: "relative/dir" }, payload: promptEvent("f8") });
    assert.equal(parseReply(reply).code, "FALLBACK");
  });

  test("the watchdog answers a stalled client with FALLBACK instead of hanging or dropping the event", async () => {
    const d = await boot({ watchdogMs: 300 });
    const started = Date.now();
    const reply = await sendRequest({ ...d, payload: "{}", lengthOverride: 50 });
    assert.equal(parseReply(reply).code, "FALLBACK");
    assert.ok(Date.now() - started < 3000);
  });
});

describe("state files", () => {
  test("writes port, pid, start time and plugin version to the state file", async () => {
    const d = await boot();
    const state = readStateFile(d.stateDir);
    const manifest = JSON.parse(readFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(state.port, String(d.port));
    assert.equal(state.pid, String(process.pid));
    assert.equal(state.version, manifest.version);
    assert.ok(Number(state.startedAt) > 1_700_000_000);
    assert.ok(Number(state.aliveAt) > 1_700_000_000);
  });

  test("binds the loopback interface only", async () => {
    const d = await boot();
    assert.equal(d.daemon.address.address, "127.0.0.1");
  });

  test("stores a 32-byte random token readable only by the user", async () => {
    const d = await boot();
    assert.match(d.token, /^[0-9a-f]{64}$/);
    if (process.platform !== "win32") assert.equal(statSync(join(d.stateDir, "token")).mode & 0o777, 0o600);
  });

  test("replaces a stale state file left by a dead pid", async () => {
    const stateDir = tempDir("hookd-stale");
    writeFileSync(join(stateDir, "state"), "port=1\npid=999999\nstartedAt=1\nversion=0.0.1\naliveAt=1\n");
    writeFileSync(join(stateDir, "token"), "stale-token");
    const d = await boot({ stateDir });
    const state = readStateFile(stateDir);
    assert.equal(state.pid, String(process.pid));
    assert.equal(state.port, String(d.port));
    assert.notEqual(readToken(stateDir), "stale-token");
  });

  test("refuses to start beside a live daemon with a fresh heartbeat", async () => {
    const first = await boot();
    const second = await startDaemon({
      pluginDir,
      stateDir: first.stateDir,
      port: await freePort(),
    });
    assert.equal(second, null);
    assert.equal(readStateFile(first.stateDir).port, String(first.port));
  });

  test("exits quietly when the port is already taken", async () => {
    const first = await boot();
    const second = await startDaemon({ pluginDir, stateDir: tempDir("hookd-other"), port: first.port });
    assert.equal(second, null);
  });

  test("removes its state file on shutdown", async () => {
    const d = await boot();
    await d.daemon.stop();
    assert.equal(readStateFile(d.stateDir), null);
  });

  test("the heartbeat rewrites aliveAt while the daemon runs", async () => {
    const stateDir = tempDir("hookd-beat");
    const daemon = await startDaemon({ pluginDir, stateDir, port: await freePort(), heartbeatMs: 50 });
    running.push(daemon);
    const first = Number(readStateFile(stateDir).aliveAt);
    await waitFor(() => Number(readStateFile(stateDir)?.aliveAt) > first, 4000);
  });
});

describe("lifecycle", () => {
  test("exits by itself after the idle timeout and removes its state", async () => {
    const d = await boot({ idleMs: 200 });
    await Promise.race([d.daemon.closed, new Promise((_, reject) => setTimeout(() => reject(new Error("no idle exit")), 4000))]);
    assert.equal(readStateFile(d.stateDir), null);
  });

  test("a request resets the idle timer", async () => {
    const d = await boot({ idleMs: 2000 });
    for (let i = 0; i < 4; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.equal(parseReply(await sendRequest({ ...d, payload: "{}" })).code, "0");
    }
    assert.ok(readStateFile(d.stateDir), "daemon must still be up after 2400ms of activity");
  });

  test("a changed plugin version on disk answers FALLBACK and shuts the daemon down", async () => {
    const copy = copyPlugin();
    const d = await boot({ pluginDir: copy });
    assert.equal(parseReply(await sendRequest({ ...d, payload: "{}" })).code, "0");
    const manifestPath = join(copy, ".claude-plugin", "plugin.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: "99.0.0" }));
    assert.equal(parseReply(await sendRequest({ ...d, payload: "{}" })).code, "FALLBACK");
    await d.daemon.closed;
    assert.equal(readStateFile(d.stateDir), null);
  });

  test("a request from a different plugin root answers FALLBACK", async () => {
    const d = await boot();
    const reply = await sendRequest({ ...d, env: { ...d.env, CLAUDE_PLUGIN_ROOT: join(pluginDir, "..", "elsewhere", "9.9.9") } });
    assert.equal(parseReply(reply).code, "FALLBACK");
  });

  test("_shutdown with the token stops the daemon; without it nothing happens", async () => {
    const d = await boot();
    assert.equal(await sendRequest({ ...d, token: "bad", plugin: "_shutdown" }), null);
    assert.ok(readStateFile(d.stateDir));
    await sendRequest({ ...d, plugin: "_shutdown" });
    await d.daemon.closed;
    assert.equal(readStateFile(d.stateDir), null);
  });

  test("SIGTERM and SIGINT remove the state file and exit", { skip: process.platform === "win32" && "signals kill node outright on Windows" }, async () => {
    for (const signal of ["SIGTERM", "SIGINT"]) {
      const stateDir = tempDir("hookd-sig");
      const proc = await startDaemonProcess({ stateDir, port: await freePort() });
      proc.child.kill(signal);
      await proc.exited;
      assert.equal(readStateFile(stateDir), null, signal);
    }
  });

  test("the daemon process exits on _shutdown and cleans up (portable stand-in for SIGTERM)", async () => {
    const stateDir = tempDir("hookd-proc");
    const port = await freePort();
    const proc = await startDaemonProcess({ stateDir, port });
    await sendRequest({ port, token: proc.token, plugin: "_shutdown" });
    await proc.exited;
    assert.equal(readStateFile(stateDir), null);
  });
});

describe("concurrency", () => {
  test("20 parallel clients on separate sessions all receive their own correct reply", async () => {
    const d = await boot({ watchdogMs: 20000 });
    const replies = await Promise.all(
      Array.from({ length: 20 }, (_, i) => sendRequest({ ...d, event: "UserPromptSubmit", payload: promptEvent(`c${i}`) })),
    );
    for (const reply of replies) {
      const { stdout, code } = parseReply(reply);
      assert.equal(code, "0");
      assert.match(JSON.parse(stdout).hookSpecificOutput.additionalContext, /<timing-prompt>now=/);
    }
    for (let i = 0; i < 20; i += 1) assert.ok(existsSync(join(d.dataDir, "sessions", `c${i}`, "state.json")), `c${i}`);
  });

  test("20 parallel PreToolUse events on one session each leave their stamp", async () => {
    const d = await boot({ watchdogMs: 20000 });
    const replies = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        sendRequest({
          ...d,
          event: "PreToolUse",
          payload: JSON.stringify({ session_id: "shared", hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: `t${i}` }),
        }),
      ),
    );
    assert.deepEqual(new Set(replies), new Set(["\n0\n"]));
    assert.equal(readdirSync(join(d.dataDir, "sessions", "shared", "tools")).length, 20);
  });

  test("parallel PostToolUse events never lose a turn-log entry", async () => {
    const d = await boot({ watchdogMs: 20000 });
    const S = { session_id: "race" };
    const ids = Array.from({ length: 20 }, (_, i) => `r${i}`);
    for (const id of ids) await sendRequest({ ...d, payload: JSON.stringify({ ...S, hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: id }) });
    await Promise.all(
      ids.map((id) => sendRequest({ ...d, payload: JSON.stringify({ ...S, hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: id }) })),
    );
    const log = readFileSync(join(d.dataDir, "sessions", "race", "turn.ndjson"), "utf8").split("\n").filter(Boolean);
    assert.equal(log.length, 20);
  });
});
