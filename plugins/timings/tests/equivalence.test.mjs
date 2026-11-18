// The daemon path must be indistinguishable from the original script: same stdout, same exit code and the same files
// under the state dir for the same recorded events. Three runners replay one scenario against the frozen v0.2.2 script
// (fixtures/hook.reference.mjs), the refactored standalone entry, and the daemon reached through hook-client.sh.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import {
  fakeClockUrl,
  findBash,
  freePort,
  hookPath,
  makeTempDir,
  pluginDir,
  parseReply,
  readToken,
  referenceHookPath,
  removeDir,
  sendRequest,
  snapshotDir,
  startDaemonProcess,
} from "./helpers.mjs";
import { BASE_TIME, configs, scenario } from "./fixtures/scenario.mjs";

const scratch = [];
const tempDir = (prefix) => {
  const dir = makeTempDir(prefix);
  scratch.push(dir);
  return dir;
};
after(() => scratch.forEach(removeDir));

const payloadOf = (step) => (step.raw !== undefined ? step.raw : JSON.stringify(step.event));

function baseEnv(dataDir, clockFile, config) {
  return {
    ...process.env,
    CLAUDE_PLUGIN_DATA: dataDir,
    FAKE_NOW_FILE: clockFile,
    CLAUDE_HOOKD_DISABLE: "1",
    ...config,
  };
}

function runWithNode(script, config) {
  const dataDir = tempDir("eq-data");
  const clockFile = join(tempDir("eq-clock"), "now");
  const beforeSweep = [];
  const results = scenario.map((step) => {
    if (step.snapshotBefore) beforeSweep.push(snapshotDir(dataDir));
    writeFileSync(clockFile, String(BASE_TIME + step.at));
    const run = spawnSync(process.execPath, ["--import", fakeClockUrl, script], {
      input: payloadOf(step),
      encoding: "utf8",
      env: baseEnv(dataDir, clockFile, config),
    });
    return { stdout: run.stdout, status: run.status };
  });
  return { results, files: { final: snapshotDir(dataDir), beforeSweep } };
}

async function runWithDaemon(config) {
  const dataDir = tempDir("eq-data");
  const clockFile = join(tempDir("eq-clock"), "now");
  const stateDir = tempDir("eq-state");
  writeFileSync(clockFile, String(BASE_TIME));
  const port = await freePort();
  const daemon = await startDaemonProcess({ stateDir, port, fakeClock: true, env: { FAKE_NOW_FILE: clockFile } });
  try {
    const beforeSweep = [];
    const results = scenario.map((step) => {
      if (step.snapshotBefore) beforeSweep.push(snapshotDir(dataDir));
      writeFileSync(clockFile, String(BASE_TIME + step.at));
      const run = spawnSync("bash", ["-c", '. "${CLAUDE_PLUGIN_ROOT}/scripts/hook-client.sh" timings'], {
        input: payloadOf(step),
        encoding: "utf8",
        env: {
          ...baseEnv(dataDir, clockFile, config),
          CLAUDE_HOOKD_DISABLE: "",
          CLAUDE_HOOKD_STATE_DIR: stateDir,
          CLAUDE_HOOKD_PORT: String(port),
          CLAUDE_PLUGIN_ROOT: pluginDir.split("\\").join("/"),
        },
      });
      return { stdout: run.stdout, status: run.status };
    });
    const status = JSON.parse(parseReply(await sendRequest({ port, token: readToken(stateDir), plugin: "_status" })).stdout);
    return { results, files: { final: snapshotDir(dataDir), beforeSweep }, handled: status.handled };
  } finally {
    daemon.child.kill();
    await daemon.exited;
  }
}

describe("recorded-event equivalence", { skip: findBash() ? false : "bash not available" }, () => {
  configs.forEach((config, index) => {
    describe(`config ${index}`, () => {
      const reference = runWithNode(referenceHookPath, config);

      test("the scenario produces output worth comparing", () => {
        assert.ok(reference.results.some((r) => r.stdout.includes("timing-")), "reference emitted nothing");
        assert.ok(Object.keys(reference.files.beforeSweep[0]).length > 0, "reference wrote no files");
      });

      test("every step of the reference exits 0", () => {
        assert.deepEqual(reference.results.filter((r) => r.status !== 0), []);
      });

      test("standalone entry matches the reference byte for byte", () => {
        const actual = runWithNode(hookPath, config);
        assert.deepEqual(actual.results, reference.results);
        assert.deepEqual(actual.files, reference.files);
      });

      test("daemon path via hook-client.sh matches the reference byte for byte", async () => {
        const actual = await runWithDaemon(config);
        assert.equal(actual.handled, scenario.length, "events must be served by the daemon, not the node fallback");
        assert.deepEqual(actual.results, reference.results);
        assert.deepEqual(actual.files, reference.files);
      });
    });
  });
});

test("the scenario names every event the plugin registers", () => {
  const manifest = JSON.parse(readFileSync(join(pluginDir, "hooks", "hooks.json"), "utf8"));
  const named = new Set(scenario.map((s) => s.event?.hook_event_name));
  const missing = Object.keys(manifest.hooks).filter((name) => !named.has(name));
  assert.deepEqual(missing, []);
});
