# Why this plugin exists

Findings from an investigation on 2026-08-17, across 113 session transcripts in
`~/.claude/projects` plus direct probing of the running harness.

It started from a handoff document written on 2026-08-14 by a session in another
repo, which had noticed the same habit from the inside. That document was
temporary and is not kept here; the parts of it worth keeping are quoted below,
including the two claims it got wrong.

## What was actually happening

977 Bash turns across all sessions write a file. Most are legitimate: 382 target
`/tmp` or the scratchpad, 312 are heredoc-into-an-interpreter (running a script,
not editing one). **356 are genuine in-place edits of tracked project files.**

Sorted by why the model reached for the shell:

1. **Batching.** Several non-adjacent changes in one file: N `Edit` round-trips,
   or one `python` block. The largest bucket.
2. **Edit chained with its own verification (~114, 32%).** This is the pattern
   the original handoff missed entirely, and it is *good* engineering being
   taxed:
   ```
   sed -i 's/.../.../' tools/plot_checkpoint_paths.py && .venv/bin/python tools/plot_checkpoint_paths.py sweep_data --out figures
   ```
   `Edit` structurally cannot edit-and-then-test in one call, so the shell wins
   on latency every time.
3. **Momentum (~49–140).** No capability gap at all — python heredocs that are
   byte-for-byte what `Edit` does:
   ```python
   p=pathlib.Path("tools/check_dead_ends.py"); s=p.read_text()
   s=s.replace("        if self.branchy and var in BRANCHING_EFFECTS:",
               "        if var in self.branchy and var in BRANCHING_EFFECTS:")
   ```
   Several even write `assert old in s`, hand-rolling `Edit`'s uniqueness check.
4. **Structured data (~62).** `node -e` doing `JSON.parse` → mutate →
   `writeFileSync`. Editing JSON as text really is worse than editing it as a tree.

## The resync mechanism, as actually measured

When a file changes outside the tracked tools, the harness *may* inject a
`<system-reminder>` about it. When it does is not obvious, and getting it wrong
is what produced the handoff's bad cost estimate.

| Prior state of the file | Out-of-band write | Result |
| --- | --- | --- |
| Written via `Edit`/`Write` (fresh snapshot) | any writer | **±8-line window** around each changed hunk is injected, and the snapshot is **refreshed** |
| Only `Read`, never written | any writer | **No injection.** The next `Edit` is refused with "modified since read" → forced **full re-Read** |
| Snapshot already stale | any writer | Nothing |

Three consequences, all of which change the design:

- **It is a diff window, not the whole file.** The handoff claimed the full file
  comes back ("roughly 30× the tokens"). It does not. Changing line 45 of a
  60-line file injected lines 37–53; changing line 5 injected lines 1–13.
  An early estimate of 1–2M wasted tokens across all sessions assumed full-file
  reinjection and is wrong by more than an order of magnitude.
- **The injection refreshes the snapshot, so it is self-healing.** A native
  `Edit` immediately after an injection succeeds with no re-Read. The injection
  is therefore the *cheap* path.
- **The genuinely expensive case is the silent one.** A `sed` on a file that was
  only ever `Read` produces no warning at all, and the cost lands later as a
  forced full re-Read of (mean) a 31 KB file. Quiet, not loud, is what to worry
  about.

### Writer identity is not tracked

A disowned background process, not a child of the tool call, triggers the
injection identically to an inline `sed`. The harness compares its own snapshot
against disk at request time; it has no idea who wrote. This is why the notice
says the change came from "the user or by a linter" and asserts the user is
"already aware" — **both false when the writer was the model's own Bash call**,
and it instructs the model not to mention it. That is a live mechanism for
confidently misinforming the user, and it is how this whole issue first surfaced.

**Therefore an MCP server's writes behave exactly like `sed`'s** — an MCP server
is just another process. **Confirmed empirically on 2026-08-17**, by driving a
separate headless Claude session (`claude -p`, Haiku, with this server
registered):

- A `super_edit` write to a file holding a fresh `Edit` snapshot produced the
  resync notice with the same ±8-line window (lines 37–53 for a change at 45).
- The objective confirmation: in a second run the agent called `Edit` on the file
  **after** the `super_edit` write and **without re-reading**. It succeeded, and
  all three changes survived in the final file. That is only possible if the
  harness resynced its snapshot from the MCP write — had the write gone
  undetected, the stale snapshot would have refused the edit or clobbered the
  MCP change. This evidence comes from harness-generated tool results, not from
  the model's self-report.

So on a file with a fresh write snapshot, the harness does cover us. On a file
that was only ever `Read`, it says nothing at all — which is why `super_edit`
returns the changed regions itself.

### Not measurable after the fact

The resync notice is injected at request time and **never persisted to the
JSONL**. A transcript scan finds zero occurrences even in sessions where it
certainly fired. Any future audit of this has to probe a live session.

## Things the handoff got right, and one to drop

- **Drop its proposal #1.** "Does a partial `Read` satisfy the `Edit`
  precondition?" — it does. Reading lines 10–14 of a 40-line file unlocked an
  edit at line 30, far outside the window. The cheap correct path already exists.
- Its proposals #3 (anchored match), #4 (multi-edit) and #5 (line-anchored) are
  real, and #4 is the biggest bucket.
- Its "momentum" case is real and no tool schema can fix it — that needs a nudge
  at the point of use, which is what the hook in this plugin is for.

## What we built, and why it is shaped this way

**`super_edit` (MCP tool).** One call, a sequence of patches, possibly across
several files.

- **Regex with an expected match count** is the most valuable part, and it is a
  correctness feature `Edit` lacks rather than a convenience. Asking for 10
  replacements and finding 8 means the model's recollection of the file is
  wrong; the right response is to re-read, not to apply 8 changes. `Edit`'s
  `replace_all` silently applies whatever it finds.
- **Atomic vs independent.** Atomic validates every patch against every file
  before writing anything, so a half-applied batch is impossible. Independent
  exists for the case Danya raised: on a large batch you want to know *which*
  row failed, which an all-or-nothing failure hides.
- **No `then_run`.** It would mean reimplementing Bash's timeout handling and
  auto-backgrounding, and the measurement above removed its main justification —
  the saved round-trip no longer costs a file reinjection. It also cannot be
  made meaningfully atomic with the edits.
- Patches to the same file apply **sequentially against an in-memory buffer**, so
  a later patch sees earlier patches' results. Expected counts are evaluated
  against the content as of that patch.

**The Bash hook.** Best-effort detection of in-place edits, as a non-blocking
nudge. It cannot be exhaustive — the sheer variety in the transcripts
(`sed -i`, `perl -pi`, python `write_text`, `node writeFileSync`, `cat > f <<EOF`,
plain `>` redirects) means heuristics will miss cases and occasionally
false-positive. That is acceptable for a nudge and would not be for a block, so
it never blocks.

It warns only for the first few detections per session, because the momentum
case is a habit that needs interrupting once, not a lecture on every call. The
escape hatch is a counter file holding the number of warnings remaining:

- **delete it** → reset to the full budget, keep getting warnings;
- **write `0` into it** → expire it early and stop getting them.

## Field test in a live session, 2026-08-17

A session working on an unrelated project (wlan-site-survey) used the tool for
real work, then probed its failure modes deliberately. Findings, in order of how
much they changed the design.

**The approval gradient is inverted, and no wording fixes it.** In "Edit
automatically" mode, `Edit` runs free and `super_edit` — an MCP tool — prompts the
user on *every* call. The safest of the two is the one that costs a human
decision, and the one whose match counts are declared and whose failures are loud
is the one a user learns to dread.

`sed -i` also ran free and silent in that session, but do not read that as Bash
being ungated: an hour of shell work had accumulated per-session approvals. In a
fresh session Bash surfaces too, and the honest ladder is `Edit` free, `Bash`
prompting, `super_edit` prompting. That is the real indictment — price should
track capability, and `super_edit` is *strictly more constrained* than the Bash it
replaces: it can only substitute text whose occurrence count the caller declared
in advance, atomically, failing loudly on a miss. Bash can do anything. Charging
the same interrupt for both is what needs fixing, and it is why the nudge firing
on a legitimate-looking bulk `cat >> file` append is correct rather than noise:
the append is the more powerful operation, whatever it looks like.

Measured, both directions:
approving with "allow for this project" wrote `.claude/settings.json` correctly
but had no effect until reload, so the very next call prompted again. Hence the
Permissions section in the README: pre-approving is the fix, and the
session-scoped option is the one that takes effect now.

A corollary worth remembering when tuning the nudge: from the caller's side a
pending approval and a denial are **indistinguishable** — both surface as "the
user doesn't want to proceed". It cannot adapt to the cost of an interrupt it
never sees. So any guidance about when to prefer `Edit` has to be mechanical
(patch count, matcher kind) rather than a judgment call about "simple enough";
the caller has no feedback signal to calibrate judgment against.

**The budget was spent exactly when it mattered.** Same session: by the time the
`sed -i` test ran, the warning budget was exhausted and the hook said nothing on
the one call it was designed to catch. A long editing session is both where the
habit reasserts itself and, under a spend-only budget, where the nudge is gone.
Fixed by refilling on `PostToolUse` for `super_edit` — heeded advice buys the
budget back, ignored advice still spends it, so the alarm-fatigue property that
motivated the budget survives.

**A count mismatch had two causes and one message.** When an earlier patch in the
batch rewrites a later patch's target, the failure was byte-identical to a
genuine typo, and the trailing "re-read the file" advice was actively wrong: the
caller's view of the file had been *correct*. Both buffers are already in hand,
so the fix is cheap — if the matcher hits the pre-batch text but not the current
one, name the patch that moved the ground and say not to re-read. The generic
advice is now printed only for failures it fits.

**`expect` is the part that earns the call**, unprompted and twice. Reporting the
actual count (`found 3 matches, expected 1`) is what makes a retry possible with
no re-read. Cosmetics fixed alongside: one-based patch numbers everywhere (the
prose said "1 of 3" while the list said `[0]`), singular `1 match` / `1 time`, and
no more "the other 0 would have applied cleanly".

**`regex` went unused, and the tell was where the caller went instead.** Eight
calls, zero regex — `find` wins for text you wrote minutes ago. But two `sed -i`
calls in the same session were regex's case exactly: rewriting a printf format
string from 18 to 20 `%s` (`regex: "(%s,){17}%s"`, `expect: 1` — shorter than the
literal and self-verifying), and bumping a default value inside a known pattern.
`find` fits *text you remember*; `regex` fits a *shape*. Those moments feel like
shell jobs, which is why they leak to `sed`. If regex adoption is ever worth
chasing, the precise population is `sed -i` invocations containing a quantifier
or a capture group — not a general mention in the description.

Sample caveat, from the reporter: one session, markdown and shell only, editing
content it had authored minutes earlier. A session editing unfamiliar code would
hit the overlap case harder, since patch ordering matters more when you cannot
hold the file in your head.

## The 2026-09 ergonomics pass

Four field reports later (`feedback/`, 2026-08-17 through 2026-09-03, ~43
patches, zero misapplications), the core operation was not the problem —
everything around it was. What changed, and why:

**The report is now a real diff, capped.** The old changed-regions report was
one span from the first to the last differing line, tight for a single edit but
catastrophic for spread-out ones: field measurements put multi-patch calls at
~25–30× the lines actually changed, and on files with a fresh Edit/Write
snapshot the harness printed its own copy right after (the double report two
sessions flagged as the single biggest win available). `diffHunks` is a
line-level LCS between before and after: distant changes produce separate
hunks, hunks longer than 24 lines elide their middles, and if the whole report
would still exceed 60 rendered lines, auto mode replaces it with one line per
file naming the regions. Degrading is safe on the axes that matter: failures
and counts always print in full regardless of report mode, and the summary
keeps final line numbers, so the "only view of the write" property survives —
what is lost is only re-reading text the caller wrote seconds earlier. Two
sessions had `context_lines` in hand as the cost lever and never registered it
as such; the new `report` parameter names the modes, and `context_lines` is
documented as the lever it always was.

**Failed batches hand back a retry token.** Every observed recovery from an
atomic failure re-sent the entire batch — 8 patches to fix one typo. The
server is one long-lived process per session, so a failed attempt caches its
successful patches and issues a token; the next call sends only corrections
and the cached patches re-run from memory. The chosen semantics are
deliberately loose — "re-run what validated and hasn't reached disk, then
apply this call's patches on top" — rather than index-addressed replacement:
no mapping to learn, and a correction that targets an already-satisfied patch
fails its own `expect` loudly instead of silently landing somewhere unintended.
That looseness is why independent mode caches nothing (re-running what landed
would fail its own counts), and why tokens are single-use (a batch can never
apply twice off one token). `dry_run` fell out of the same cache: it validates
without writing and its token applies the batch as-is, which covers "would
these 8 patches apply cleanly?" with no rollback story at all.

**The use-Edit note fires once per session.** It was correct every time and
read none of the time: ~10 firings per session trained readers to skim past
it. The trigger is unchanged; only the repetition went.

**The hook's false positives were the reported ones, verified live before
fixing.** Arrow functions in quoted arguments (`s=>s.name`) matched the
bare-redirect rule — six wrong firings in one session, exhausting the budget
so a real `sed -i` later went unwarned; redirects now require the `>` not to
follow `=`, `-` or `|`. `cat >/tmp/x` escaped the scratch rule because the
path's preceding character is `>`, not whitespace; `>` joined the class.
And a redirect into a path that does not exist yet is creating a file — the
generated/bulk work the nudge's own text exempts — so those are skipped via an
existence probe (injected into `detect` so it stays pure for tests). The
budget, the visible countdown and the write-0 opt-out are unchanged: two of
three reports explicitly endorsed them, and NOTES above records why the
refill-on-heeded design exists.

**The description now states the interaction rules instead of letting callers
invent them.** Two sessions independently invented "never mix super_edit and
Edit on one file" from the old "writes are not tracked" sentence, and worked
around a hazard that (per the resync measurements above) does not exist on
fresh-snapshot files. The description says what is actually true — a later
Read shows new content; on a Read-only file the next Edit may ask for one
re-Read, and that is the whole cost. It also leads with when *not* to use the
tool (one simple substitution → Edit), which reconciles the two nudges that
were pushing in opposite directions, and commits the "strip the Read line
prefix" sentence — sessions quoted it as load-bearing, but it had only ever
lived in the working tree the user-scope registration ran, never in a commit.

One thing deliberately not done: registering writes with the harness's
snapshot. Nothing in the MCP protocol exposes it, and the resync mechanism
already covers the fresh-snapshot case on its own.
