// hook-client.sh as Claude Code runs it: the exact command string from hooks.json, through bash, JSON on stdin.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import {
  findBash,
  freePort,
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

const manifest = JSON.parse(readFileSync(join(pluginDir, "hooks", "hooks.json"), "utf8"));
const command = manifest.hooks.PreToolUse[0].hooks[0].command;

const scratch = [];
const tempDir = (prefix) => {
  const dir = makeTempDir(prefix);
  scratch.push(dir);
  return dir;
};
after(() => scratch.forEach(removeDir));

const event = (session, name = "UserPromptSubmit") => JSON.stringify({ session_id: session, hook_event_name: name });

/**
 * Runs the shipped hook command under bash and reports its output, status and wall time. Asynchronous on purpose:
 * several tests host a fake daemon in this process, which a blocking spawnSync would starve.
 */
function runClient({ payload, stateDir, port, dataDir, env = {}, root = pluginDir }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("bash", ["-c", command], {
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: root,
        CLAUDE_PLUGIN_DATA: dataDir,
        CLAUDE_HOOKD_STATE_DIR: stateDir,
        CLAUDE_HOOKD_PORT: String(port),
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.on("error", () => {});
    child.stdin.end(payload);
    child.on("close", (status) => resolve({ stdout, stderr, status, ms: Date.now() - started }));
  });
}

const timingPrompt = /<timing-prompt>now=\d\d:\d\d:\d\d/;
const skip = findBash() ? false : "bash not available";

/** Listens on a free port and counts connection attempts, so "never connects" is asserted rather than timed. */
async function listenCounting() {
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, count: () => connections, close: () => server.close() };
}

async function stopDaemon(stateDir, port) {
  if (!readStateFile(stateDir)) return;
  await sendRequest({ port, token: readToken(stateDir), plugin: "_shutdown" });
  await waitFor(() => readStateFile(stateDir) === null, 4000).catch(() => {});
}

describe("hook-client.sh fallback to node", { skip }, () => {
  test("the shipped command is short and routes through the client script", () => {
    assert.match(command, /hook-client\.sh/);
    assert.ok(command.length < 200, command);
    assert.match(command, /hook\.mjs/, "the node fallback must stay in the command itself");
  });

  test("no state file: goes straight to node, never attempts a TCP connection", async () => {
    const stateDir = tempDir("cl-state");
    const listener = await listenCounting();
    try {
      const run = await runClient({
        payload: event("n1"),
        stateDir,
        port: listener.port,
        dataDir: tempDir("cl-data"),
        env: { CLAUDE_HOOKD_NO_SPAWN: "1" },
      });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, timingPrompt);
      assert.equal(listener.count(), 0, "a refused loopback connect costs about 2.1 s on Windows; do not even try");
    } finally {
      listener.close();
    }
  });

  test("a stale state file (old heartbeat) is ignored without connecting", async () => {
    const stateDir = tempDir("cl-state");
    const listener = await listenCounting();
    const { port } = listener;
    writeFileSync(join(stateDir, "state"), `port=${port}\npid=1\nstartedAt=1\nversion=0\naliveAt=1\n`);
    writeFileSync(join(stateDir, "token"), "abc");
    try {
      const run = await runClient({ payload: event("n2"), stateDir, port, dataDir: tempDir("cl-data"), env: { CLAUDE_HOOKD_NO_SPAWN: "1" } });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, timingPrompt);
      assert.equal(listener.count(), 0, "a stale heartbeat must not be trusted");
    } finally {
      listener.close();
    }
  });

  test("a fresh-looking state file with a dead port falls back, then invalidates the file", async () => {
    const stateDir = tempDir("cl-state");
    const port = await freePort();
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(join(stateDir, "state"), `port=${port}\npid=1\nstartedAt=${now}\nversion=0\naliveAt=${now}\n`);
    writeFileSync(join(stateDir, "token"), "abc");
    const dataDir = tempDir("cl-data");
    const first = await runClient({ payload: event("n3"), stateDir, port, dataDir, env: { CLAUDE_HOOKD_NO_SPAWN: "1" } });
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stdout, timingPrompt);
    assert.equal(readStateFile(stateDir), null, "the lying state file must be blanked so the dead port is paid for once");
  });

  test("CLAUDE_HOOKD_DISABLE=1 forces the plain node path even with a live daemon", async () => {
    const stateDir = tempDir("cl-state");
    const port = await freePort();
    const daemon = await startDaemonProcess({ stateDir, port });
    try {
      const run = await runClient({ payload: event("n4"), stateDir, port, dataDir: tempDir("cl-data"), env: { CLAUDE_HOOKD_DISABLE: "1" } });
      assert.match(run.stdout, timingPrompt);
      const status = JSON.parse(parseReply(await sendRequest({ port, token: daemon.token, plugin: "_status" })).stdout);
      assert.equal(status.handled, 0);
    } finally {
      await stopDaemon(stateDir, port);
    }
  });

  test("a garbage reply falls back to node with the payload intact", async () => {
    const stateDir = tempDir("cl-state");
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.setTimeout(300, () => socket.end("garbage without an exit line"));
      socket.on("data", () => {});
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(join(stateDir, "state"), `port=${port}\npid=1\nstartedAt=${now}\nversion=0\naliveAt=${now}\n`);
    writeFileSync(join(stateDir, "token"), "abc");
    try {
      const run = await runClient({ payload: event("n5"), stateDir, port, dataDir: tempDir("cl-data"), env: { CLAUDE_HOOKD_NO_SPAWN: "1" } });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, timingPrompt);
      assert.equal(readStateFile(stateDir), null, "an unhealthy daemon must be marked dead");
    } finally {
      server.close();
    }
  });

  test("a daemon that never replies times out and falls back to node", async () => {
    const stateDir = tempDir("cl-state");
    const sockets = [];
    const server = net.createServer((socket) => sockets.push(socket));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const now = Math.floor(Date.now() / 1000);
    writeFileSync(join(stateDir, "state"), `port=${port}\npid=1\nstartedAt=${now}\nversion=0\naliveAt=${now}\n`);
    writeFileSync(join(stateDir, "token"), "abc");
    try {
      const run = await runClient({
        payload: event("n6"),
        stateDir,
        port,
        dataDir: tempDir("cl-data"),
        env: { CLAUDE_HOOKD_NO_SPAWN: "1", CLAUDE_HOOKD_CLIENT_TIMEOUT: "1" },
      });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, timingPrompt);
      assert.ok(run.ms < 6000, `took ${run.ms} ms`);
      assert.equal(readStateFile(stateDir), null, "a hung daemon must be marked dead so later events skip the timeout");
    } finally {
      sockets.forEach((s) => s.destroy());
      server.close();
    }
  });

  test("a payload over 1 MB skips the daemon and goes to node", async () => {
    const stateDir = tempDir("cl-state");
    const port = await freePort();
    const daemon = await startDaemonProcess({ stateDir, port });
    try {
      const big = JSON.stringify({ session_id: "n7", hook_event_name: "UserPromptSubmit", pad: "y".repeat(1024 * 1024 + 10) });
      const run = await runClient({ payload: big, stateDir, port, dataDir: tempDir("cl-data"), env: { CLAUDE_HOOKD_NO_SPAWN: "1" } });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, timingPrompt);
      const status = JSON.parse(parseReply(await sendRequest({ port, token: daemon.token, plugin: "_status" })).stdout);
      assert.equal(status.handled, 0);
    } finally {
      await stopDaemon(stateDir, port);
    }
  });

  test("the first fallback starts the daemon detached, and the hook returns without waiting for it", async () => {
    const stateDir = tempDir("cl-state");
    const port = await freePort();
    const run = await runClient({ payload: event("n8"), stateDir, port, dataDir: tempDir("cl-data") });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, timingPrompt);
    assert.ok(run.ms < 5000, `spawnSync would block until the daemon's pipes close; took ${run.ms} ms`);
    try {
      await waitFor(() => readStateFile(stateDir)?.port === String(port), 10000);
    } finally {
      await stopDaemon(stateDir, port);
    }
  });
});

describe("hook-client.sh fast path", { skip }, () => {
  test("serves the event from the daemon and prints exactly the handler's stdout", async () => {
    const stateDir = tempDir("cl-state");
    const port = await freePort();
    const daemon = await startDaemonProcess({ stateDir, port });
    try {
      const dataDir = tempDir("cl-data");
      const run = await runClient({ payload: event("f1"), stateDir, port, dataDir, env: { CLAUDE_HOOKD_NO_SPAWN: "1" } });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, timingPrompt);
      assert.ok(existsSync(join(dataDir, "sessions", "f1", "state.json")));
      const status = JSON.parse(parseReply(await sendRequest({ port, token: daemon.token, plugin: "_status" })).stdout);
      assert.equal(status.handled, 1);
    } finally {
      await stopDaemon(stateDir, port);
    }
  });

  test("the daemon's version-mismatch FALLBACK reply makes the client run node instead", async () => {
    const stateDir = tempDir("cl-state");
    const port = await freePort();
    const daemon = await startDaemonProcess({ stateDir, port });
    try {
      const dataDir = tempDir("cl-data");
      const otherRoot = tempDir("cl-other-version");
      cpSync(join(pluginDir, ".claude-plugin"), join(otherRoot, ".claude-plugin"), { recursive: true });
      mkdirSync(join(otherRoot, "scripts"));
      for (const name of ["hook.mjs", "hook-client.sh", "hookd.json"]) cpSync(join(pluginDir, "scripts", name), join(otherRoot, "scripts", name));
      const run = await runClient({
        payload: event("f2"),
        stateDir,
        port,
        dataDir,
        root: otherRoot,
        env: { CLAUDE_HOOKD_NO_SPAWN: "1" },
      });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, timingPrompt);
      assert.ok(existsSync(join(dataDir, "sessions", "f2", "state.json")), "node must have handled the event");
      await Promise.race([daemon.exited, new Promise((_, reject) => setTimeout(() => reject(new Error("stale daemon kept running")), 5000))]);
      assert.equal(readStateFile(stateDir), null, "the stale daemon must remove its state file");
    } finally {
      daemon.child.kill();
    }
  });

  test("passes a malformed payload through with exit code 0 and no output", async () => {
    const stateDir = tempDir("cl-state");
    const port = await freePort();
    await startDaemonProcess({ stateDir, port });
    try {
      const run = await runClient({ payload: "{{{{", stateDir, port, dataDir: tempDir("cl-data"), env: { CLAUDE_HOOKD_NO_SPAWN: "1" } });
      assert.equal(run.status, 0, run.stderr);
      assert.equal(run.stdout, "");
    } finally {
      await stopDaemon(stateDir, port);
    }
  });

  test("handles a multi-line payload and one larger than the builtin read window", async () => {
    const stateDir = tempDir("cl-state");
    const port = await freePort();
    await startDaemonProcess({ stateDir, port });
    try {
      const pretty = JSON.stringify({ session_id: "f4", hook_event_name: "UserPromptSubmit", pad: "z".repeat(20000) }, null, 2);
      const run = await runClient({ payload: pretty, stateDir, port, dataDir: tempDir("cl-data"), env: { CLAUDE_HOOKD_NO_SPAWN: "1" } });
      assert.equal(run.status, 0, run.stderr);
      assert.match(run.stdout, timingPrompt);
    } finally {
      await stopDaemon(stateDir, port);
    }
  });
});
