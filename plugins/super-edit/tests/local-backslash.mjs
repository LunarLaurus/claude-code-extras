#!/usr/bin/env node
// Local-only check (branch local-tweaks, not part of the upstream PR): a Bash edit whose command holds a
// backslash gets a warning that the Bash tool strips one level of them. node tests/local-backslash.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../scripts/hook.mjs", import.meta.url));
const data = mkdtempSync(join(tmpdir(), "se-bs-"));
let n = 0;

function run(command) {
  n += 1;
  const payload = { session_id: `t${n}`, tool_name: "Bash", tool_input: { command }, cwd: tmpdir() };
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PLUGIN_DATA_DIR: data },
  });
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : "";
}

const withSlash = run("sed -i 's/a\\nb/X/' README.md");
const without = run("sed -i 's/a/b/' README.md");
const none = run("ls -la");
const checks = [
  ["backslash command gets the note first", withSlash.startsWith("This command contains backslashes")],
  ["backslash command still carries the standard nudge", withSlash.includes("edits a file in place")],
  ["plain sed -i has no backslash note", !without.includes("backslashes") && without.includes("edits a file in place")],
  ["a non-edit command stays silent", none === ""],
];

let failed = 0;
for (const [label, ok] of checks) {
  if (!ok) failed += 1;
  console.log(ok ? "PASS" : "FAIL", label);
}
rmSync(data, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
