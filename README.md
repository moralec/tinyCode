<p align="center"><img src="assets/logo.svg" width="96" alt="tinyCode logo"></p>

<h1 align="center">tinyCode</h1>

<p align="center">A <a href="https://github.com/earendil-works/pi">Pi</a> extension that keeps the context small, so local models finish coding tasks in a 16k window where plain Pi runs out of room.</p>

> **Preview — v1.1.0.** Works, but rough edges remain; see [Known issues](#known-issues-v110). Tried it? [Report a run](https://github.com/moralec/tinyCode/issues/new?template=report-a-run.yml): your card, model, window and what happened, good or bad.
>
> **New here? [Start here](docs/START-HERE.md):** install, first run, and the same task with plain Pi and with tinyCode.

## Why

On a local GPU the context window is the real limit. The KV cache grows with it and competes with the model for
memory, so a 16 GB card running a good model often has 16k of context to spare, not 128k. Coding agents fill that
window fast: every file read, test run and edit stays in the conversation and is sent again on every call. At 16k,
plain Pi regularly stops mid-task with the window full.

## Is it for you?

**It helps most when the window is the limit:** a 16k window, a mid-size model (tested: gpt-oss-20b and
Qwen3.6-35B-A3B), and a task with a failing test to fix.

**Where it doesn't help, yet:**
- On tasks that fit easily in the window, plain Pi is faster. tinyCode adds steps that only pay off when room is short.
- Small models on 8 GB cards don't benefit yet.
- Runs vary: the same task can pass in 30 s on one run and hit the 10-minute cap on the next.
- `/build` finishes only the first task of a plan on its own, and some requests go to the wrong workflow. The full
  list is in [Known issues](#known-issues-v110).

## What

tinyCode sits under Pi and keeps the window small, without changing how you work:

- **Old output is hidden** once it is no longer needed, while the files you are working on stay visible.
- **Save, clean, continue.** At natural milestones (the tests reach a new best, or an edit is confirmed by a test
  run), code writes a short note of where the work stands (tests passing, files touched, what still fails) and the
  history before it is replaced by that note. No model call is needed, and the full history stays in Pi's log.
- **The best state is kept.** The best test result reached is saved, so a run never ends below it.

It also takes over the two jobs it does faster than Pi on its own:

- **Fixing failing tests:** one quick, narrow try first; if that doesn't pass, Pi's own loop takes over.
- **Writing tests:** tests that must pass on today's code.

Everything else (questions, edits, new code, reviews) goes to Pi exactly as without tinyCode. The other workflows
are there as explicit commands (`/explain`, `/doc`, `/review`, …) but are not used automatically yet: in our tests
they were not better than plain Pi.

## What tinyCode does: eight capabilities

1. **Every call fits the window.** It doesn't run out of room: each call is put together for the step at hand and old
   tool output is dropped. Plain Pi ran out of window 8 times in our last two rounds; tinyCode never did.
2. **Fast on your machine.** It doesn't slow down as the run gets longer: the start of the prompt stays the same
   between calls, so your server reuses what it has already read.
3. **Takes the shortest path.** You don't have to pick a mode: say what you want in plain words, and it chooses the
   workflow and tries the cheapest fix first. On connect it finished in 30 s where plain Pi ran out of room.
4. **Edits that land.** An edit that is slightly off still applies, instead of failing and costing another round.
5. **Never loses your best work.** If a run gets worse towards the end, you keep the best version it reached.
6. **Checks by running, not by believing.** "Fixed" means fixed: it runs the tests itself, in Python and
   TypeScript/JavaScript, and only reports a fix when a failing test now passes.
7. **Gets unstuck.** It doesn't go round in circles: when a run stops improving, it changes approach instead of
   repeating itself.
8. **From idea to app.** Plans start from the code: `/plan` reads the files it will change before the plan is final,
   so plans are less likely to miss the file that needs the edit. 12 of 15 good plans, against 9 of 15.

Every mechanism behind these, with its status and evidence: [capabilities](docs/capabilities.md) (also as a
[PDF](docs/capabilities.pdf)).

## Results

Plain Pi against Pi + tinyCode on five public Python exercises, with a 16k window, three unattended runs per task
and side, and a 10-minute cap per run:

| Card | Model | Pi alone | Pi + tinyCode |
|---|---|---|---|
| 16 GB (Tesla T4) | gpt-oss-20b | 3 of 15 | **8 of 15** |
| 16 GB (Tesla T4) | Qwen3.6-35B-A3B | 4 of 15 | **10 of 15** |

- **Where plain Pi runs out of room, tinyCode finishes.** connect is the clearest case.
- **When both finish, plain Pi is often faster:** on paasio, about 50 s against 200 to 380 s.
- **Some tasks stay hard for both** at this size: bowling and sgf-parsing.
- **Small models on 8 GB are not there yet.**

Every run, per model: [docs/results.md](docs/results.md). Six newer tasks told as stories, with what plain Pi and
tinyCode each did: [See the difference](docs/guide/pi-vs-tinycode.md).

## Installation

You need a 16 GB GPU (or 24 GB or more of unified memory), a local model server such as llama.cpp's `llama-server`,
and `git`. On macOS and Linux:

```
git clone https://github.com/moralec/tinyCode && cd tinyCode
sh install.sh --trunk-context 16384 --small-context 16384
```

Already use Pi? `pi install npm:@moralec/tinycode` ([Getting started](docs/guide/getting-started.md#already-have-pi)
has the one setting to add).

**New here? [Start here](docs/START-HERE.md):** which model to run, starting the server, Windows, a first run, and the
same task with and without tinyCode.

## Roadmap

v1.1 covers every developer task at 16k and up (the 8k target was dropped), v1.2 aims at bugs described in words, and
v1.3 at handing jobs to your local machine from another agent: [ROADMAP.md](ROADMAP.md).

## Changelog

**Latest: v1.1.0.** Fixes, `/plan` reviews its plan by default, and the acceptance check is removed. Every release is
in [CHANGELOG.md](CHANGELOG.md).

## Known issues (v1.1.0)

1. Runs vary: the same task can pass in 30 s or hit the 10-minute cap. Steadier runs are on the roadmap.
2. `/build` finishes only the first task of a plan on its own; the model completes the rest by hand.
3. The router sends some requests to the wrong workflow: a symptom-only bug report, a rename, and questions about
   the project's own code (which never go to `/research`).
4. Small models on 8 GB cards don't benefit yet; see the results.
5. `install.ps1` is untested on real Windows.
6. The results above are from v1.0 ([docs/results.md](docs/results.md)). A full baseline of plain Pi against tinyCode on the new
   49-task benchmark comes next.

## Tried it?

Try it on a real task in your own project, then [report the run](https://github.com/moralec/tinyCode/issues/new?template=report-a-run.yml):
your card, model and window, the task, and what happened, good or bad. Those reports decide what gets worked on next.
Questions and ideas go to [Discussions](https://github.com/moralec/tinyCode/discussions).

## Licence

Apache-2.0. tinyCode builds on Pi (MIT) and borrows ideas from [little-coder](https://github.com/itayinbarr/little-coder)
(Apache-2.0); credits are in [NOTICE](NOTICE).
