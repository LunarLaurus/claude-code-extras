# timings

Claude has no clock. Within a turn it cannot tell a 200 ms `Read` from a 40-minute
training run, and between turns it cannot tell whether you replied instantly or
came back the next morning. This plugin measures the three gaps that matter and
hands them back as context:

- **how long you were away** — the gap between Claude's last response and your next prompt;
- **how long the assistant turn took**, split into time spent in tools and time spent thinking;
- **how long individual tool calls ran** — any tool, not just `Bash`.

## What it injects

Each block is tagged by what it is, because the tag is the first thing Claude
matches on and several can land in one context window:

| Tag | When | Example |
| --- | --- | --- |
| `timing-prompt` | every prompt | `<timing-prompt>now=20:31:04 date=2026-08-15 idle=5m02s prev_turn=4m12s (tools 2m30s: Bash×3 2m10s; awaiting the user 40s; model ~1m02s)</timing-prompt>` |
| `timing-tool` | after a slow tool call | `<timing-tool>Bash took 2m10s (20:28:54→20:31:04).</timing-tool>` |
| `timing-interrupt` | a call that never finished | `<timing-interrupt>Bash was started 1m02s before the user's next message and never finished, so it was interrupted…</timing-interrupt>` |
| `timing-compaction` | first prompt after a compaction | `<timing-compaction>compacted 9h12m ago, at 22:10 on 2026-08-15</timing-compaction>` |
| `timing-session` | a resumed, forked or dormant session | `<timing-session>source=resume idle for 3d, last active 18:40 on 2026-08-13</timing-session>` |

`interrupt` and `compaction` get their own tags rather than becoming fields on
`timing-prompt` because both change what Claude should *do* — retry versus
rethink, and treat a summarised context as stale — while a field in a list reads
as trivia.

Roughly 40–70 tokens per turn. Everything is thresholded, so a fast turn with fast
tools injects nothing at all.

### Time is relative, with a clock to pin it to

There is no ISO datetime anywhere. Almost everything here is minute- or
hour-scale, so blocks carry a duration (`5m02s`) plus a bare clock reading
(`20:31:04`), and the date only where it earns its place: the first prompt of a
session, a day rollover, and any past instant that was not today. A field that
never changes a decision is worse than absent — it teaches the reader to skim the
block that also carries the fields that do.

### A gated call measures the user, not the tool

`PreToolUse` fires before the permission prompt, so a naive stopwatch reports a
one-line write to `/tmp` that sat unapproved for 90 seconds as a 90-second
`Write`. Splitting that out is harder than it looks:

- `PermissionRequest` lands ~100 ms after `PreToolUse`. It marks the request, not
  the answer, and (despite the docs) carries no `tool_use_id` here.
- `Notification` with `notification_type: permission_prompt` marks when the
  prompt actually reached the user — deferred by the harness while you are still
  typing, so it can be a minute later.
- **Nothing at all fires on approval.**

So a gated call has three spans and only two known edges, and is reported as
bounds rather than a number:

```
Write completed 1m42s after it was requested (02:11:49→02:13:30), but it was gated on
the user's approval: 54s before the prompt reached the user, then 48s covering both
their decision and the run itself. The call ran at most 48s -- likely far less, and
there is no event for the moment they approved.
```

Gated calls are reported regardless of the tool threshold, because the headline
figure would otherwise be read as tool time. The scratchpad hint is suppressed on
them for the same reason: the call was not necessarily slow.

Correlation is by time window, since neither permission event carries a
`tool_use_id`. With several prompts pending at once the attribution is
approximate.

### Interrupts are reported as a bound, not a measurement

No hook fires when you interrupt a tool call: `Stop` never arrives and no
`PostToolUse` lands, so the stamp written at `PreToolUse` is simply left behind.
By the next prompt nothing is in flight, so an orphaned stamp *is* an interrupted
call. What that gives is the span from the call starting to your next message —
which also contains any approval wait and the time you spent typing. It is
reported as an explicit upper bound, because the tempting reading ("you waited
60s") is wrong and is exactly the number Claude would otherwise reason from.

For the same reason, `idle=` is suppressed after an interrupt: it is measured
from the last `Stop`, which never happened, so it would span Claude's own
working time and read as you being away.

### The event log

Every hook event is appended to `events.ndjson` in the session's state
directory, including events this plugin has no handler for:

```
{"at":1786833001164,"clock":"01:30:01","ev":"PreToolUse","tool":"Bash","id":"toolu_01RtXk…"}
```

Which events a given build actually fires, in what order, and how far apart is
not something the documentation settles — this is how you find out. It is also
the fastest way to check whether a hook you just registered is firing at all.

The `model ~` figure is wall time minus tool time, so it is an estimate: parallel
tool calls make the tool total exceed the turn's wall clock, and compaction lands
inside it. It is right to within a few seconds on ordinary turns, which is enough
to answer "have I already waited long enough?" without reaching for `sleep`.

## Install

```
/plugin marketplace add gmatiukhin/claude-code-extras
/plugin install timings@claude-code-extras
```

## Configuration

Set at install time, editable later via `/plugin`:

| Option | Default | Effect |
| --- | --- | --- |
| `tool_threshold_seconds` | `10` | Minimum duration for a tool call to be reported. `0` reports every call. |
| `idle_threshold_seconds` | `10` | Minimum gap since the last response to report. |
| `turn_threshold_seconds` | `20` | Minimum turn duration to report a breakdown for. |
| `clock_pair_seconds` | `60` | Duration at which a tool call is also pinned to the wall clock as `start→end`. |
| `scratchpad_hint_seconds` | `45` | Duration after which a `Bash` call is reminded to log its output somewhere an interrupt cannot discard. |
| `session_gap_seconds` | `600` | Dormancy needed before `SessionStart` reports a gap. |
| `event_log` | `true` | Append every hook event to `events.ndjson`. |
| `show_clock` | `true` | Include clock time, plus the date on day rollover. |
| `visible_idle` | `true` | Also show the idle gap to you as `[after 5m 02s]`, not only to Claude. |
| `show_hook_overhead` | `false` | Append this plugin's own measured cost to the turn breakdown. |
| `debug_log` | `false` | Append internal errors to `errors.ndjson` in the plugin data directory. |

## Cost

Without the daemon, one `node` process per hook event: about 120 ms median on an
idle 4-CPU Windows machine, and several times that under load, almost all of it
node start-up. With the daemon the same event is served by a bash built-in client.
`node plugins/timings/tests/bench.mjs [events] [payloadKB]` measures the three
launch paths interleaved, the way Claude Code launches a hook (`bash -c <command>`).
Measured here, 50 events, median: old `node hook.mjs` 121 ms, daemon fast path
43 ms, no-daemon fallback 115 ms (a 12 KB `PostToolUse` payload costs the fast
path 77 ms, because everything past the first 4 KB is read through one `cat`).
Under load the gain shrinks because bash's own start-up, which the daemon cannot
avoid, dominates: with six busy loops on the 4 CPUs the medians were 2961 ms, 1426
ms and 2967 ms, and in a noisy window with other agents running 235 ms, 167 ms and
292 ms. The fast path is below 100 ms only on a quiet machine. Turn on
`show_hook_overhead` to see the real figure for your machine in the turn breakdown.

## Resident hook daemon

Claude Code starts a fresh process for every hook event. On a loaded machine the
`node` start alone costs hundreds of milliseconds, and this plugin is registered on
about 15 events including `PreToolUse` and `PostToolUse`, so every tool call of
every agent started node twice. With 10 to 20 agents that produced hook timeouts.

**What it is.** `scripts/hookd.mjs` is one long-lived node process per plugin. It
keeps `scripts/hook.mjs` loaded and answers events over a loopback socket.
`scripts/hook-client.sh` is what `hooks.json` runs: a short bash script, sourced by
the hook shell, that uses bash's built-in `/dev/tcp` to hand the event to the
daemon. The fast path starts no node, no `curl`, no `python`.

**The fallback is always `node hook.mjs`.** The client falls back to exactly the
old command when there is no state file, the heartbeat is stale, the connection is
refused, the reply is malformed or late (3 s), the payload is over 1 MB, or the
daemon answers `FALLBACK` (a newer plugin version is on disk). The standalone
`node hook.mjs` also starts the daemon, detached, the first time it runs with none
alive, so later events are served fast. A refused loopback connect costs about 2 s
on Windows, so the client never connects without a fresh state file, and blanks the
state file when a connect is refused, or a reply is late or garbled, so that cost is
paid once per dead or hung daemon. A late reply means the event may be handled twice
(once by the daemon when it catches up, once by node). For tool events that is
harmless (a stamp is an idempotent write and a second `PostToolUse` finds no stamp);
a repeated `UserPromptSubmit` or `Stop` could drop one turn summary. Not measured.

**Turn it off.** Set `CLAUDE_HOOKD_DISABLE=1` in the environment Claude Code runs
hooks in (for example under `env` in `settings.json`). The client then runs plain
`node hook.mjs` and nothing spawns a daemon. `CLAUDE_HOOKD_NO_SPAWN=1` keeps the
client but stops it starting a daemon.

**Kill it.** `node scripts/hookd.mjs stop` asks the running daemon to exit (it
removes its own state file). It also exits by itself after 30 minutes without a
request, when the plugin version on disk differs from the one it started with, and
on SIGTERM or SIGINT. A hard kill is safe: the stale state file is detected (dead
pid or a heartbeat older than 40 s) and replaced by the next daemon.

**State.** `<OS temp dir>/claude-code-hookd/timings/` holds `state` (key=value:
`port`, `pid`, `startedAt`, `version`, `root`, `aliveAt`), `token` (32 random bytes,
hex, mode 0600 where the OS honours it) and `spawn.lock` while a spawn is in
flight. Default port 47821 on 127.0.0.1; override with `CLAUDE_HOOKD_PORT`, and the
state directory with `CLAUDE_HOOKD_STATE_DIR`. Event data still goes to
`${CLAUDE_PLUGIN_DATA}` exactly as before.

**Protocol.** One request per connection. Bash cannot half-close a `/dev/tcp`
socket, so the payload is length-prefixed rather than read until EOF: token line,
`<pluginId> <event> <bytes>` line, an env block (only `CLAUDE_PLUGIN_ROOT`,
`CLAUDE_PLUGIN_DATA` and `CLAUDE_PLUGIN_OPTION_*`), then the event JSON. The reply
is the handler's stdout, a newline, then the exit code or the word `FALLBACK`.
Payloads are capped at 1 MB.

**Races it removes.** Events are handled in one process and `handleEvent` is
synchronous, so they are serialised. As separate processes these could interleave:
`drainTurnLog` reads then deletes `turn.ndjson`, so a parallel `PostToolUse` append
landing in between was lost; `takeOrphans` at `UserPromptSubmit` races a straggling
`PreToolUse` stamp; `state.json` was a read-modify-write across processes; and on
Windows `renameSync` onto a file another process had open could fail.

**Threat model.** The daemon listens on 127.0.0.1 only and drops any request that
does not open with the token, which lives in a file in the state directory (mode
0600 where the OS honours it). The token is only as private as that directory: on
Windows the default is the OS temp dir, whose ACL this plugin does not check, so on
a shared or drive-root TEMP set `CLAUDE_HOOKD_STATE_DIR` to a user-private path. A local
process of the same user could read the token and talk to it, but then it can
already do anything that user can. What such a process could do through the daemon
is feed fake events to this plugin's own handler: forge timing state under the data
directory it names (which must be an absolute path with no `..`). Handlers are a
static allow-list in `scripts/hookd.json`, loaded once at start-up from inside the
plugin's own `scripts/` directory; a request can only select among them by id and
never supplies a path to import. The daemon starts no child processes, makes no
network connections beyond the loopback listener, and writes only to its state
directory and to the plugin data directory the handler already used. A per-request
watchdog (2 s) answers a stalled or starved request with `FALLBACK` rather than
hanging, so node handles the event and nothing is silently dropped; handlers are
synchronous, so one that has started cannot be pre-empted in-thread.

**Known deviation from the standalone script.** A payload of literal `null` used to
crash the script with a stack trace and exit code 1; it is now a no-op with exit 0.

## Design notes

- **Zero dependencies**, one file, no `jq` — hooks that silently do nothing on a
  machine without `jq` are worse than no hooks.
- **Never blocks.** Every failure path exits 0 with no output. Malformed stdin,
  a missing data directory and unknown events are all no-ops.
- **The injected text is written for its reader.** It goes to Claude, not to the
  terminal, so it says "the user" and never "you" — second person in a block
  Claude reads makes Claude the one who approved the tool call.
- **No lost measurements under parallelism.** Tool stamps are one file per
  `tool_use_id` and completed calls are appended to a log, so concurrent tool
  calls cannot clobber a shared JSON object.
- **Stamps get consumed, not swept.** `PostToolUse` does not fire for a denied or
  failed call, so `PostToolUseFailure` and `PermissionDenied` are hooked too. A
  stale sweep still runs as a backstop for interrupts.
- **`SessionEnd` is not the end of the session.** Ctrl+C prints
  `claude --resume <id>`, and the gap across that resume is the most valuable
  thing here — it is precisely the case where the transcript reads as if no time
  had passed. So `SessionEnd` drops only turn-scoped scratch and keeps the state
  the resume is measured against, along with the event log. State lives in
  `${CLAUDE_PLUGIN_DATA}/sessions/<session_id>/` and whole directories are swept
  after 7 days at `SessionStart`, which is what bounds the growth.
- **The manifest does not declare `hooks/hooks.json`.** That path is loaded
  automatically, and naming it in `manifest.hooks` as well is a duplicate load
  that Claude Code rejects outright — leaving the plugin installed, enabled, and
  running no hooks at all.

## Tests

```
node plugins/timings/tests/run.mjs
```

Drives the real script as a subprocess, one process per event, exactly as Claude
Code does — including the orphaned-stamp, path-traversal, and malformed-input
cases, plus the overhead benchmark.

Some behaviour cannot be tested this way, because it depends on a real person
interrupting a real tool call at a real moment. [`tests/MANUAL.md`](tests/MANUAL.md)
is a short script for a human and an agent to run together, one step each.

## Known gaps

- **Queued messages are invisible.** A message typed while Claude is working
  fires no `UserPromptSubmit` — verified: `lastPromptAt` does not move — so it
  cannot be timed. All Claude can rely on is the framing: a queued message was
  written without sight of the output it arrived next to.
- **An interrupted call's stdout is gone.** The harness returns a rejection, not
  the partial output, and no hook can recover it. Hence the scratchpad hint on
  long `Bash` calls: the fix is to not have the output only in the tool result.
- Tool calls made inside a subagent are attributed to the session's turn totals,
  not separated out by `agent_type`, though `SubagentStart`/`SubagentStop` are
  now logged and every event carries `agent_id` to build it on.
- Interrupt spans include the user's typing time and cannot be tightened
  further; they are labelled as bounds rather than corrected.
