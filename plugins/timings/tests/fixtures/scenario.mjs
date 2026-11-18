// A recorded-style event stream covering every event name the plugin registers in hooks.json, plus the
// malformed and hostile inputs the script must survive. `at` is milliseconds after BASE_TIME on the fake clock.

export const BASE_TIME = 1_800_000_000_000;

const A = { session_id: "sess-a", cwd: "/work/a", transcript_path: "/t/a.jsonl" };
const B = { session_id: "sess-b" };
const s = (n) => n * 1000;

export const scenario = [
  { at: 0, event: { ...A, hook_event_name: "SessionStart", source: "startup" } },
  { at: s(1), event: { ...A, hook_event_name: "UserPromptSubmit", prompt: "hello" } },
  { at: s(2), event: { ...A, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_1", tool_input: { command: "ls" } } },
  { at: s(2) + 100, event: { ...A, hook_event_name: "PermissionRequest", tool_name: "Bash" } },
  { at: s(5), event: { ...A, hook_event_name: "Notification", notification_type: "permission_prompt", message: "needs approval" } },
  { at: s(20), event: { ...A, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_1", tool_response: { stdout: "x".repeat(3000) } } },
  { at: s(21), event: { ...A, hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "toolu_2" } },
  { at: s(40), event: { ...A, hook_event_name: "PostToolUseFailure", tool_name: "Read", tool_use_id: "toolu_2", error: "boom" } },
  { at: s(41), event: { ...A, hook_event_name: "PreToolUse", tool_name: "Write", tool_use_id: "toolu_3" } },
  { at: s(42), event: { ...A, hook_event_name: "PermissionDenied", tool_name: "Write", tool_use_id: "toolu_3" } },
  { at: s(43), event: { ...A, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "toolu_orphan" } },
  { at: s(44), event: { ...A, hook_event_name: "SubagentStart", agent_type: "Explore" } },
  { at: s(50), event: { ...A, hook_event_name: "SubagentStop", agent_type: "Explore" } },
  { at: s(51), event: { ...A, hook_event_name: "PreCompact", trigger: "auto" } },
  { at: s(52), event: { ...A, hook_event_name: "PostCompact" } },
  { at: s(53), event: { ...A, hook_event_name: "Stop", last_assistant_message: "done" } },
  { at: s(54), event: { ...A, hook_event_name: "StopFailure", error: "rate_limit" } },
  { at: s(400), event: { ...A, hook_event_name: "UserPromptSubmit", prompt: "next" } },
  { at: s(401), event: { ...A, hook_event_name: "Notification", notification_type: "idle_prompt" } },
  { at: s(402), event: { ...A, hook_event_name: "SomeFutureEvent" } },
  { at: s(403), raw: "this is not json" },
  { at: s(404), raw: "" },
  { at: s(405), raw: "   {  \"hook_event_name\": \"Stop\",\n \"session_id\": \"sess-a\" }  " },
  { at: s(406), event: { hook_event_name: "UserPromptSubmit" } },
  { at: s(407), event: { ...A, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "../../etc/passwd" } },
  { at: s(408), event: { hook_event_name: "PreToolUse", session_id: "../../..", tool_name: "Bash", tool_use_id: "toolu_x" } },
  { at: s(409), event: { ...B, hook_event_name: "SessionStart", source: "startup" } },
  { at: s(410), event: { ...B, hook_event_name: "PreToolUse", tool_name: "Grep", tool_use_id: "toolu_b1" } },
  { at: s(430), event: { ...B, hook_event_name: "PostToolUse", tool_name: "Grep", tool_use_id: "toolu_b1" } },
  { at: s(431), event: { ...A, hook_event_name: "SessionEnd", reason: "other" } },
  { at: s(3600) + 431, event: { ...A, hook_event_name: "SessionStart", source: "resume" } },
  { at: s(3600) + 432, event: { ...A, hook_event_name: "UserPromptSubmit", prompt: "back" } },
  { at: s(86400 * 8), snapshotBefore: true, event: { ...B, hook_event_name: "SessionStart", source: "startup" } },
];

/** Option sets the scenario is replayed under; the second one exercises the thresholds and toggles. */
export const configs = [
  { CLAUDE_PLUGIN_OPTION_TOOL_THRESHOLD_SECONDS: "5", CLAUDE_PLUGIN_OPTION_TURN_THRESHOLD_SECONDS: "5" },
  {
    CLAUDE_PLUGIN_OPTION_SHOW_CLOCK: "false",
    CLAUDE_PLUGIN_OPTION_VISIBLE_IDLE: "false",
    CLAUDE_PLUGIN_OPTION_EVENT_LOG: "false",
    CLAUDE_PLUGIN_OPTION_IDLE_THRESHOLD_SECONDS: "0",
    CLAUDE_PLUGIN_OPTION_TOOL_THRESHOLD_SECONDS: "0",
  },
];
