# tinyCode in eight capabilities

Everything tinyCode does, as eight capabilities: each with the promise it makes, the evidence so far, and the mechanisms inside it. The ids (A1-E28) are the feature ids used in the release notes; the same page is attached to each release as a PDF ([capabilities.pdf](capabilities.pdf)).

Status of a mechanism:
- ● **stays**: on, unchanged;
- ○ **option**: built, off until measured;
- ↑ **evolves**: kept, with a change in the backlog;
- \+ **new**: a candidate, built behind a switch, off until measured;
- ✕ **retired**: removed, or proposed for removal (the maintainers decide).

Status as of 2026-11-12 (evening, v1.1.0).

---

## 1. Every call fits the window

**Promise:** a long task never fills a 16k window. Code builds each call's context; old tool output is masked, not
kept.
**Evidence:** plain Pi ran out of window 8 times in two rounds (2026-11-10, 2026-11-11); tinyCode never did. Its
highest call was 15.1k (connect, right after tinyCode stepped back and dropped its masks). E28, built 2026-11-11 behind
`limits.stepBackKeepsMasks`, keeps those masks; a replay takes that call to 10.2k.

| | Mechanism | ids |
|---|---|---|
| ● | Short tool results and file views (~1.5k tokens, ~100 lines) | C1, C2 |
| ● | Old tool output masked; harder under pressure | C3, C9 |
| ● | Finished work folded into notes; checkpoints restart from a summary | C7, C8, C10, C11 |
| ● | Oversized AGENTS.md / CLAUDE.md replaced by a digest | D1 |
| ● | Side questions answered in a separate call; only the answer comes back | D3, D4 |
| ● | A short text protocol in tinyCode's own calls; a todo list as working memory | D2, C18 |
| \+ | Long bash commands and writes refused once, with a way past (bash output is already capped by C1) | E23 |
| ○ | A step-back keeps the masks already made (parked 2026-11-12: step-backs are now rare, 3 in 30 runs) | E28 |
| \+ | Masks that go with the run: the plan once /build runs, smaller whole fresh files, older copies of a re-read file | E27 |
| ○ | Terse system prompt; no repeated task in the first turn | E4, E13 |
| ○ | Older turns summarised (later; masking measured better) | E8 |

## 2. Fast on your machine

**Promise:** the server reuses what it has already read, so long runs don't slow down with every call.
**Evidence:** keeping tinyCode's per-turn note out of the cached prefix, and declaring the tool list once, raised
reuse on recorded runs (2026-11-04).

| | Mechanism | ids |
|---|---|---|
| ● | Prompt and tool list kept stable so the cache holds | D5, D6 |
| ● | Learns per model where to start | B8, A4 |
| ● | Chat-template fix for strict models (Mistral family) | C20 |
| ○ | Fewer cache breaks from checkpoints and masks | E12 |

## 3. Takes the shortest path

**Promise:** say what you want in plain words; tinyCode picks the workflow and tries the cheapest fix first.
**Evidence:** easy tasks finish in 2–3 calls with the project's own tests (TS gate, 2026-11-10).

| | Mechanism | ids |
|---|---|---|
| ● | Workflows (fix, test, ...) are tools the model calls | A5 |
| ● | Only fix and test are taken over by default | A3 |
| ● | One quick fix try built by code, then a second; no pick call with one candidate file | B1, B2, B6, B7 |
| ● | A failing test written first when a fix names none | B9 |
| ↑ | Plain-words router (natural wording routes 5 of 18 for research and plan) | A1 |
| ○ | A small-model router for unsure cases | A2 |

## 4. Edits that land

**Promise:** the model's edits apply and keep the code tidy.
**Evidence:** the rewrite nudge solved more of the tasks where it fired (4 of 5, 2026-11-04).

| | Mechanism | ids |
|---|---|---|
| ● | Edit size limit; edits off by one indent still applied; a mistyped path gets the right one | C6, C16, C17 |
| ● | An edit block with a repeated marker line (`=======`, `<<<<<<< SEARCH`, `>>>>>>> REPLACE`) is read once, not written into the file (2026-11-11/12; in the recorded replies, 8 of 254 doubled the `=======`, 12 of 322 a SEARCH or REPLACE line) | fix |
| ● | A whole-file rewrite gets a one-line nudge to edit instead | C21 |
| ● | The project's formatter runs on changed files | B10 |
| ○ | After a rewrite, says what was lost and how to get it back | E1 |

## 5. Never loses your best work

**Promise:** you end with the best version tinyCode reached, not the last one.

| | Mechanism | ids |
|---|---|---|
| ● | Best tree kept, offered back, and put back when a run gets worse or ends below it | B5, C12, C13 |
| \+ | Also offer going back to the start when the best version has the wrong design | E22 |
| ○ | Put the best back on a kill or time-out (partly built) | E3 |

## 6. Checks by running, not by believing

**Promise:** "done" means the project's checks pass, run by code, in Python and in TypeScript/JavaScript.
**Evidence:** TypeScript support passed its gate and is on by default (2026-11-10).
**Gap:** on build tasks the model's own tests passed while the hidden tests did not (2026-11-11). The acceptance check
meant to close it failed its first step: the checks the model wrote failed on correct code in 29 of 29 files.

| | Mechanism | ids |
|---|---|---|
| ● | Runs the project's own test command; reads pytest, jest, vitest and node:test | D8 (with D7, D9) |
| ● | A fix is "solved" only when a failing check turns green; a check that already passes stops with the reason (2026-11-12; before, one task was reported fixed with nothing changed) | fix |
| ○ | The whole project checked after each build step (`stages.wholeCheck`) | E25 |
| \+ | Time limits on tests the model runs itself | E24 |

## 7. Gets unstuck

**Promise:** when a run stops improving, tinyCode changes course instead of repeating itself.

| | Mechanism | ids |
|---|---|---|
| ● | Hands a failed quick try to Pi's loop with the best tree and a diagnosis | B4 |
| ● | Repeated calls blocked; step back after repeated failures; one nudge when it stops early | C4, C5, C15 |
| ● | A heartbeat line every minute, a notice when stuck | C19 |
| ↑ | Stuck rule (3 test runs without progress): too early for late breakthroughs; gets "start over" as a second exit | C14 → E22 |
| ○ | A fresh-context review after a failure, or when the loop stalls | B3, E2 |
| ○ | A time limit sized for a delegating agent | E10 |

## 8. From idea to app

**Promise:** research a question, plan an app, and build it task by task, each in a small context.
**Evidence:** off by default. Turned on, it first scored 4 of 9 against 6 of 9 without it (2026-11-11 morning). Since
then the plan review works: on the plan task where plans kept missing a file it went from 0 of 5 to 4 of 5 overnight.
/build finished its first task after a parser fix, then stopped at task 2. Two causes are fixed since (the task's files
reach the ladder; a partial build no longer says "stop"). /build is not yet re-measured.

| | Mechanism | ids |
|---|---|---|
| ↑ | /research, /plan, /build: off by default until the changes below are measured | A3 |
| \+ | Split into plan and build only when the task won't fit in one context (deferred: needs evidence) | E18 |
| \+ | Research looks locally first, and drops a source that fails (measured: finds and cites local pinned code 4 of 6 against 0; a cost bug fixed, re-measure pending) | E19 |
| ● | Plans read the files their tasks name before they are final (`stages.planReview`, **on by default since 2026-11-12**: typed /plan 12/15 against 9/15, no task worse; it may name a file the request protects). Checks are printed in plans while E21b is off | E21a |
| ○ | /build runs each task's own check from the plan (`stages.buildChecks`; not measured). Checks are printed in plans while this is off | E21b |
| ● | What a build step carries: investigated; the largest peaks follow a step-back (→ E27, E28) | E26 |
| ● | Recorded web answers for repeatable benches | E16 |

---

## Retired

| | What | ids |
|---|---|---|
| ✕ | An acceptance check written from the request (denied and removed 2026-11-12: the written checks failed on correct code in 29 of 29 files; its runner stays, for E21b's task checks) | E17 |
| ✕ | Research facts carry quotes checked by code (dropped 2026-11-12: did not help the task it was built for) | E20 |
| ✕ | Lifting Pi's 4096 clamp; a smaller tool set below 12k (with the 8k target) | E14, E15 |
| ✕ | Compact data formats for tool results (proposed: tool results are file text, not records) | E5, E6 |
| ✕ | A review after every edit (proposed: dropped in its design) | E9 |
| ✕ | Closed as done or not a feature: short report template (rest in E20), tokenizer check | E7, E11 |
