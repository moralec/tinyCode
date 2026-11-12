# Changelog

The notes for each release, newest first. Downloads and the capabilities PDF are on the
[releases page](https://github.com/moralec/tinyCode/releases).

## v1.1.0 (2026-11-12)

A release built around measurement: each change was run against plain Pi on the same local model, and switched on
only where the numbers said so.

**Upgrading:**
- `/plan` now reviews its plan by default (`stages.planReview: true`). Set it to `false` for the old behaviour.
- The `acceptance` config block is removed. A config that still sets it is refused with a message: delete the block.
- The new switch `stages.buildChecks` (off) runs each plan task's own check inside `/build`. It is not measured yet.

**Fixes:**
- "Fixed" means a failing check turned green. If the tests already pass before any change, `/fix` says so instead of
  reporting a fix.
- Edit blocks with a repeated marker line (`=======`, `<<<<<<< SEARCH`, `>>>>>>> REPLACE`) are read once.
- `/build` offers each task the files it must create, and says how many tasks are left instead of telling the model to
  stop.

**Measured:**
- Plans read the files they will change before they are final, now on by default: 12 of 15 good plans against 9 of
  15.
- Removed: the acceptance check written from the request. The checks the model wrote failed even on correct code.
- Dropped: research that quotes its facts. It did not help its target task.
- Still off: research that looks in the project first is promising but used 71% more tokens; the cause is fixed and
  it gets re-measured.
- Parked: keeping trimmed context after a step-back. Step-backs are now rare.

**Benchmark:** grew from 27 to 54 tasks, including three real bugs from a 100,000-line open-source project. The grader
for written answers was fixed.

## v1.0.4 (2026-11-10)

A source-only security review found places where tinyCode trusted the project it works on more than it should. All of
them are fixed in this release, each with a regression test:

- Files tinyCode writes (`docs/overview.html`, `README.md`, `.tinycode/`, `/doc` edits, `.scpt` backups) no longer
  follow a symlink committed in the project; a symlink there is refused.
- Python syntax checks run isolated (`-I`), so a project file named after a standard module is never imported.
- `/doc`'s "comments only" check no longer lets an f-string or code hidden in a JavaScript regex through.
- Formatters run without a shell, so file names are never shell text. In workflows that run no project code (`/doc`,
  `/edit` without a test) only ruff and black from your PATH run; the project's own tool binaries, prettier and eslint
  run only where tinyCode already runs the project's tests.
- `/test` no longer deletes an existing file when it undoes a failed attempt.
- `/research` checks every redirect and where a name resolves before it fetches, so it cannot be bounced to your own
  machine or network.

Still good practice: treat an unfamiliar repository with the same care as running its tests, because `/fix` and `/test`
do run them.

## v1.0.3

The context-file limit follows the model's window.

## v1.0.2

A context-file digest, forgiving edits, and the message order strict chat templates need.

## v1.0.1

Steadier runs and three tested setups.

## v1.0

The small-window release.

## v0.1

The first preview.
