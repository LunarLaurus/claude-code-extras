#!/usr/bin/env node
// Per-event latency of the three hook launch paths, measured the way Claude Code launches a hook: `bash -c <command>`
// with the event JSON on stdin. Paths are interleaved in one loop so machine load affects them equally.
//
//   node plugins/timings/tests/bench.mjs [events=50] [payloadKB=2]
//
//   old       plain `node hook.mjs` (what hooks.json ran before the daemon)
//   fast      the shipped command, daemon running
//   fallback  the shipped command, no daemon and spawning disabled (state file absent)

import { spawnSync } from "node:child_process";
import { join } from "node:path";

import { findBash, freePort, makeTempDir, pluginDir, removeDir, sendRequest, readToken, startDaemonProcess } from "./helpers.mjs";
import { readFileSync } from "node:fs";

const events = Number(process.argv[2] ?? 50);
const payloadKb = Number(process.argv[3] ?? 2);
if (!findBash()) {
  console.error("bash not found");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(join(pluginDir, "hooks", "hooks.json"), "utf8"));
const shipped = manifest.hooks.PreToolUse[0].hooks[0].command;
const oldCommand = `node "\${CLAUDE_PLUGIN_ROOT}/scripts/hook.mjs"`;

const stateDir = makeTempDir("bench-state");
const emptyStateDir = makeTempDir("bench-empty");
const dataDir = makeTempDir("bench-data");
const port = await freePort();
const daemon = await startDaemonProcess({ stateDir, port });

const base = { ...process.env, CLAUDE_PLUGIN_ROOT: pluginDir, CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_HOOKD_NO_SPAWN: "1" };
const launch = {
  old: (input) => spawnSync("bash", ["-c", oldCommand], { input, env: { ...base, CLAUDE_HOOKD_DISABLE: "1" } }),
  fast: (input) => spawnSync("bash", ["-c", shipped], { input, env: { ...base, CLAUDE_HOOKD_STATE_DIR: stateDir, CLAUDE_HOOKD_PORT: String(port) } }),
  fallback: (input) => spawnSync("bash", ["-c", shipped], { input, env: { ...base, CLAUDE_HOOKD_STATE_DIR: emptyStateDir } }),
};

const pad = "p".repeat(payloadKb * 1024);
const payloadFor = (i) =>
  JSON.stringify({
    session_id: "bench",
    hook_event_name: i % 2 ? "PostToolUse" : "PreToolUse",
    tool_name: "Read",
    tool_use_id: `toolu_${Math.floor(i / 2)}`,
    tool_input: { file_path: "/x" },
    tool_response: i % 2 ? pad : undefined,
  });

const samples = { old: [], fast: [], fallback: [] };
for (const name of Object.keys(launch)) launch[name](payloadFor(0)); // warm the OS file cache
for (let i = 0; i < events; i += 1) {
  for (const name of Object.keys(launch)) {
    const started = performance.now();
    const run = launch[name](payloadFor(i));
    samples[name].push(performance.now() - started);
    if (run.status !== 0) console.error(`${name}: exit ${run.status} ${String(run.stderr).slice(0, 200)}`);
  }
}

const status = JSON.parse((await sendRequest({ port, token: readToken(stateDir), plugin: "_status" })).split("\n")[0]);
const stats = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return `median ${sorted[Math.floor(sorted.length / 2)].toFixed(0)} ms, p90 ${sorted[Math.floor(sorted.length * 0.9)].toFixed(0)} ms, max ${sorted.at(-1).toFixed(0)} ms`;
};
console.log(`events=${events} payload=${payloadKb}KB(post) daemon handled=${status.handled}`);
for (const name of Object.keys(samples)) console.log(`${name.padEnd(9)} ${stats(samples[name])}`);

daemon.child.kill();
removeDir(stateDir);
removeDir(emptyStateDir);
removeDir(dataDir);
