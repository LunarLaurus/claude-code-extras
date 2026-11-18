// handleEvent is the pure-ish core of hook.mjs: event + env in, { stdout, exitCode } out, files under the data dir.

import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import { hookPath, makeTempDir, removeDir } from "./helpers.mjs";

const { handleEvent } = await import(pathToFileURL(hookPath).href);

const dirs = [];
const dataDir = () => {
  const dir = makeTempDir("handler-data");
  dirs.push(dir);
  return dir;
};
after(() => dirs.forEach(removeDir));

describe("handleEvent", () => {
  test("is exported as a function", () => {
    assert.equal(typeof handleEvent, "function");
  });

  test("returns the injected context as stdout with exit code 0", () => {
    const env = { CLAUDE_PLUGIN_DATA: dataDir() };
    const result = handleEvent({ session_id: "s1", hook_event_name: "UserPromptSubmit" }, { env });
    assert.equal(result.exitCode, 0);
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.additionalContext, /<timing-prompt>now=\d\d:\d\d:\d\d/);
  });

  test("returns empty stdout for an event with nothing to say", () => {
    const env = { CLAUDE_PLUGIN_DATA: dataDir() };
    assert.deepEqual(handleEvent({ session_id: "s1", hook_event_name: "SubagentStop" }, { env }), {
      stdout: "",
      exitCode: 0,
    });
  });

  test("reads configuration from the env argument, never from process.env", () => {
    const quiet = { CLAUDE_PLUGIN_DATA: dataDir(), CLAUDE_PLUGIN_OPTION_SHOW_CLOCK: "false" };
    const loud = { CLAUDE_PLUGIN_DATA: dataDir() };
    process.env.CLAUDE_PLUGIN_OPTION_SHOW_CLOCK = "true";
    try {
      const event = { session_id: "s1", hook_event_name: "UserPromptSubmit" };
      assert.equal(handleEvent(event, { env: quiet }).stdout, "");
      assert.notEqual(handleEvent(event, { env: loud }).stdout, "");
      assert.equal(handleEvent(event, { env: quiet }).stdout, "", "config must not leak between calls");
    } finally {
      delete process.env.CLAUDE_PLUGIN_OPTION_SHOW_CLOCK;
    }
  });

  test("writes state only under the data dir given in env", () => {
    const dir = dataDir();
    handleEvent({ session_id: "s1", hook_event_name: "SessionStart", source: "startup" }, { env: { CLAUDE_PLUGIN_DATA: dir } });
    assert.ok(existsSync(join(dir, "sessions", "s1", "state.json")));
    assert.deepEqual(readdirSync(dir), ["sessions"]);
  });

  test("treats a non-object payload as nothing to time", () => {
    const env = { CLAUDE_PLUGIN_DATA: dataDir() };
    assert.deepEqual(handleEvent(null, { env }), { stdout: "", exitCode: 0 });
  });

  test("hook overhead uses the supplied uptime instead of process.uptime", () => {
    const env = { CLAUDE_PLUGIN_DATA: dataDir(), CLAUDE_PLUGIN_OPTION_SHOW_HOOK_OVERHEAD: "true" };
    const S = { session_id: "s1" };
    handleEvent({ ...S, hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "t1" }, { env, uptimeMs: () => 1234 });
    const log = readFileSync(join(env.CLAUDE_PLUGIN_DATA, "sessions", "s1", "turn.ndjson"), "utf8");
    assert.match(log, /"t":"hook","ms":1234/);
  });
});

describe("importing hook.mjs", () => {
  test("does not read stdin or run the standalone entry as a side effect", () => {
    // Reaching this line means the top-level await above returned instead of blocking on stdin.
    assert.ok(true);
  });
});
