# Roadmap

Each release makes one claim, measured the same way: Pi alone against Pi with tinyCode, the same tasks and prompts,
every run recorded. A claim goes into the README only when the runs back it. Issues for each item are under the
matching [milestone](https://github.com/moralec/tinyCode/milestones).

## v1.0 — a small window (released)

**Claim:** finishes coding tasks in a 16k context window where plain Pi runs out of room.

- [x] Old output hidden once it is no longer needed; the files being worked on stay visible
- [x] Save, clean, continue: at milestones (tests reach a new best, an edit confirmed by a test run) code writes a short
      note and the history before it is replaced by it, with no model call
- [x] The best test result is kept; a run never ends below it
- [x] Takes over fixing failing tests (one quick try, then Pi's loop) and writing tests; everything else is plain Pi
- [x] Routing by code only, no extra model call
- [ ] Three runs per task at 16k on each tested setup (in progress)

## v1.1 — smaller cards

**Claim:** works at an 8k window, so 8 GB cards and laptops can run it.

- [ ] The same tasks at 8k, Pi alone against tinyCode
- [ ] Read less: one function instead of a whole file
- [ ] Test output cut to the failing assertion
- [ ] Pi's loop starts with what the quick try already read, instead of reading it again
- [ ] A second quick try with a fresh sample before Pi's loop (hit-or-miss tasks like connect)
- [ ] The Adaptive Ladder learns each model's window habits: talkative replies, reasoning in code comments, reply length (#11)
- [ ] The installer suggests a context window for your card

## v1.2 — bugs described in words

**Claim:** fixes a bug from its description, not only from a failing test.

- [ ] Reproduce first: write a test that shows the bug, then fix it
- [ ] Lint, type checks and builds count as milestones, not only tests

## v1.3 — local delegate

**Claim:** another agent can hand coding jobs to your local machine.

- [ ] A headless entry point and a job format ("make these tests pass, report back")

## Later, each only with evidence

- [ ] `/explain`, `/review`, `/doc` re-tested on a mid-size project at 8k; used automatically only if they beat plain Pi there
- [ ] More models and long multi-request sessions
