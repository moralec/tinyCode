<p align="center"><img src="assets/logo.svg" width="96" alt="tinyCode logo"></p>

<h1 align="center">tinyCode</h1>

<p align="center">A <a href="https://github.com/earendil-works/pi">Pi</a> extension that keeps the context small, so local models finish coding tasks in a 16k window where plain Pi runs out of room (on a 16 GB card today; 8 GB cards are not there yet).</p>

> **Preview — v1.1.0.** Works, but rough edges remain; see [Known issues](#known-issues-v110). Feedback welcome via GitHub issues.
>
> **New here? [Start here](docs/START-HERE.md):** install, first run, and the same task with plain Pi and with tinyCode.

## Why

On a local GPU the context window is the real limit. The KV cache grows with it and competes with the model for
memory, so a 16 GB card running a good model often has 16k of context to spare, not 128k. Coding agents fill that
window fast: every file read, test run and edit stays in the conversation and is sent again on every call. At 16k,
plain Pi regularly stops mid-task with the window full.

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

## How it works

tinyCode sits on top of Pi and helps a small local model finish coding tasks in a small context window. When you ask
for something, it first decides what kind of job it is and sends it to the matching workflow, or leaves it to plain
Pi when unsure **(routing)**. For a fix, it tries a cheap shortcut first: code gathers the right files and failing
tests, asks the model for one edit, and applies and tests it straight away **(the quick try)**. If that does not solve
it, Pi's own loop takes over: the model reads, edits and runs tests turn after turn. tinyCode watches that loop so it
keeps its best result, undoes edits that make things worse, and is nudged when it is stuck **(loop steadiness)**. All
the time, tinyCode keeps what the model reads small enough to fit the window: tool output is capped, old results are
hidden, and the history is folded into a note at milestones **(window budget)**. It makes sure edits land when
they are slightly off **(edit robustness)**, and it reports the result in a short, fixed shape a person or another
agent can act on **(handoff)**.

```
request → routing → quick try → loop steadiness → handoff
            └──── window budget and edit robustness, throughout ────┘
```

Each of these six families is a set of features with its own switch. We are measuring them one family at a time,
each feature on its own, starting where runs are lost today (loop steadiness), and the results will be published
here as they come in.

## Results

We ran the same five coding tasks with plain Pi and with Pi + tinyCode on three tested setups: each a card with a
model that fits it, a **16k context window**, three unattended runs per task and side, and a 10-minute cap per run.
**The runs are still in progress**: a `·` marks a run not done yet, and the tables are updated as they finish.

| Card | Model (why we picked it) | Pi alone | Pi + tinyCode |
|---|---|---|---|
| 16 GB (Tesla T4) | gpt-oss-20b (best coder that fits) | 3 of 15 | **8 of 15** |
| 16 GB (Tesla T4) | Qwen3.6-35B-A3B (popular reference) | 4 of 15 | **10 of 15** |
| 16 GB (Tesla T4) | Nemotron-Nano-9B-v2 (best coder for 8 GB cards; run here for speed) | 0 of 1 | **0 of 0** |

In the tables below each mark is one run, in order: ✓ pass with its time in seconds, ✗ fail, · not run yet.

### 16 GB · gpt-oss-20b

Tesla T4, MXFP4, 12.1 GB, 16k window, 16-bit cache. Fast: about 50 tokens/s on the T4. In some runs with plain Pi it wrote the solution and stopped without running the tests; tinyCode's fix workflow runs them and keeps going. bowling stayed out of reach for both.

| Task | What (tests) | Pi alone | Pi + tinyCode |
|---|---|---|---|
| [connect](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/connect) | Hex game winner (10) | ✗ ✗ ✓26 | ✓72 ✓30 ✓28 |
| [bowling](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/bowling) | bowling scorer (31) | ✗ ✗ ✗ | ✗ ✗ ✗ |
| [dot-dsl](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/dot-dsl) | graph-building DSL (12) | ✓64 ✓52 ✗ | ✓44 ✓50 ✓60 |
| [paasio](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/paasio) | I/O byte counters (25) | ✗ ✗ ✗ | ✗ ✓152 ✗ |
| [sgf-parsing](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/sgf-parsing) | Go game-record parser (23) | ✗ ✗ ✗ | ✓154 ✗ ✗ |
| **Total** | solved (median s) | **3 of 15** (52 s) | **8 of 15** (55 s) |

### 16 GB · Qwen3.6-35B-A3B

Tesla T4, UD-IQ3_XXS, 13.2 GB, 16k window, 16-bit cache. Talkative: on connect, plain Pi's own explanations filled the 16k window (up to 3.6k tokens in one reply). tinyCode passed connect and dot-dsl in every run; on paasio both pass every run, and plain Pi is four to six times faster.

| Task | What (tests) | Pi alone | Pi + tinyCode |
|---|---|---|---|
| [connect](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/connect) | Hex game winner (10) | ✗ ✗ ✗ | ✓30 ✓76 ✓260 |
| [bowling](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/bowling) | bowling scorer (31) | ✗ ✗ ✗ | ✗ ✗ ✓327 |
| [dot-dsl](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/dot-dsl) | graph-building DSL (12) | ✓76 ✗ ✗ | ✓198 ✓36 ✓70 |
| [paasio](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/paasio) | I/O byte counters (25) | ✓46 ✓64 ✓48 | ✓204 ✓298 ✓377 |
| [sgf-parsing](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/sgf-parsing) | Go game-record parser (23) | ✗ ✗ ✗ | ✗ ✗ ✗ |
| **Total** | solved (median s) | **4 of 15** (56 s) | **10 of 15** (201 s) |

### 16 GB · Nemotron-Nano-9B-v2

Tesla T4, Q4_K_M, 6.5 GB, 16k window, 16-bit cache. An 8 GB-class model, run on the 16 GB card for speed; the test on an 8 GB card follows when our new card arrives. On the slower 8 GB card it ran out the clock: with plain Pi it often asked for the files instead of reading them (counted below), and with tinyCode most of its edits failed to match the file exactly.

| Task | What (tests) | Pi alone | Pi + tinyCode |
|---|---|---|---|
| [connect](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/connect) | Hex game winner (10) | ✗ · · | · · · |
| [bowling](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/bowling) | bowling scorer (31) | · · · | · · · |
| [dot-dsl](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/dot-dsl) | graph-building DSL (12) | · · · | · · · |
| [paasio](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/paasio) | I/O byte counters (25) | · · · | · · · |
| [sgf-parsing](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/sgf-parsing) | Go game-record parser (23) | · · · | · · · |
| **Total** | solved (median s) | **0 of 1** (–) | **0 of 0** (–) |

Runs that stopped to ask a question instead of acting (they count as fails): Pi alone 1 of 1, Pi + tinyCode 0 of 0.

**How we picked the models.** For each card, the best coder in our model list that fits it, by public coding scores
with thinking off: gpt-oss-20b (16 GB) and Nemotron-Nano-9B-v2 (8 GB). Qwen3.6-35B-A3B is there as a widely used
reference. On 8 GB we also tried gemma-4-12B and Qwen3.5-4B; tinyCode did not help them in our runs.

**The tasks.** Five Python exercises from Aider's polyglot benchmark, each "write the implementation from an empty stub
so the given tests pass". They are the ones where plain Pi needed more than 14k of context when it had 32k.

**Why unattended runs.** Each run is one request with its tests and no follow-up, which is how a larger cloud agent
would hand a job to a local model: a clear task, a test that defines "done", and nobody to answer questions. A run that
stops to ask counts as a fail. This is the use case on our [roadmap](ROADMAP.md) (v1.3, local delegate).

What the runs show so far:

- **Where plain Pi runs out of room, tinyCode finishes.** connect is the clearest case: on both 16 GB models plain Pi
  fails it in most runs, while tinyCode has passed every run so far.
- **When both finish, plain Pi is often faster** (paasio on Qwen3.6: about 50 s against 200 to 380 s), though not always
  (dot-dsl on gpt-oss).
- **Some tasks stay hard for both** at this size: bowling and sgf-parsing.
- **Small models on 8 GB are not there yet.** In the first runs, Nemotron with plain Pi asked for the files instead of
  reading them, and with tinyCode it struggled with exact-text edits.

Method and every run (tests, time, calls, peak context, generated tokens): [bench/RESULTS.md](bench/RESULTS.md).

## Installation

You need an OpenAI-compatible endpoint (llama.cpp's `llama-server` is the one we use) and `git`. The installer sets up
a private copy of Node (if needed), [Pi](https://github.com/earendil-works/pi) 1.4 and tinyCode, writes your settings,
and checks that the endpoint answers. Nothing is installed globally.

**macOS and Linux**

```
git clone https://github.com/moralec/tinyCode && cd tinyCode
sh install.sh
```

**Windows** (untested so far — please report): in PowerShell,

```
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

See [docs/WINDOWS.md](docs/WINDOWS.md) for prerequisites (Git for Windows, Python with pytest).

The defaults are endpoint `http://127.0.0.1:8080/v1` and a model named `tinycode-model`. Override with flags, for
example `sh install.sh --endpoint http://127.0.0.1:11434/v1 --trunk-model qwen2.5-coder:14b --small-model qwen2.5-coder:7b`
(`install.ps1` takes `-Endpoint`, `-TrunkModel`, `-SmallModel`). `--check` re-runs the health check, `--uninstall`
removes everything (add `--purge` to delete your settings and logs too). Open a new terminal afterwards.

### Models

Which model for what, from our runs on a 16 GB card:

- **Working with Pi yourself: gpt-oss-20b.** It solved a little less, but about four times faster (median 55 s per
  solved task), which matters when you are waiting.
- **Handing jobs to a local model from another agent: Qwen3.6-35B-A3B.** It solved the most (10 of 15 with tinyCode),
  slower but steadier; nobody is waiting on a delegated job.

The models in the tested setups, with the file each run used:

| Card | Model | File |
|---|---|---|
| 16 GB | gpt-oss-20b | MXFP4 GGUF of [openai/gpt-oss-20b](https://huggingface.co/openai/gpt-oss-20b), about 12 GB; reasoning effort low |
| 16 GB | Qwen3.6-35B-A3B | `UD-IQ3_XXS` from [unsloth/Qwen3.6-35B-A3B-GGUF](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF), about 13 GB |
| 8 GB | Nemotron-Nano-9B-v2 | `Q4_K_M` from [bartowski/nvidia_NVIDIA-Nemotron-Nano-9B-v2-GGUF](https://huggingface.co/bartowski/nvidia_NVIDIA-Nemotron-Nano-9B-v2-GGUF), about 6.5 GB; thinking off via its no-think chat template |

Start the model with the same alias, so tinyCode's setup doesn't change. The results use a 16k window; a larger one
works too, and tinyCode then rarely needs to step in:

```
llama-server -m <model file> -a tinycode-model -ngl 99 -c 16384 -np 1 -fa on --jinja --reasoning-budget 0 --port 8080
```

Tell tinyCode the window you chose, so it can size its milestones: `sh install.sh --trunk-context 16384 --small-context 16384`
(`install.ps1 -TrunkContext 16384 -SmallContext 16384`).

### Using it

Run `pi` in your project and work as you normally would. When you ask to make failing tests pass, or to write
tests, tinyCode runs its own workflow; everything else goes to Pi as usual, with tinyCode keeping the context small
underneath. The other workflows are available as explicit commands: `/edit`, `/add`, `/explain`, `/doc`, `/review`,
`/commit`, `/ask`, `/research`, `/plan`, `/build`. `/tinycode` prints the effective configuration and `/tinycode stats`
the calls per step; `/dev on` turns on diagnostics (events, per-call tokens) and `/dev off` turns them off.

## Roadmap

v1.1 covers every developer task at 16k and up (the 8k target was dropped), v1.2 aims at bugs described in words, and
v1.3 at handing jobs to your local machine from another agent: [ROADMAP.md](ROADMAP.md).

## What's new in v1.1.0

Every change in this release was measured against the same local model, and switched on only where the numbers said
so. The full notes are on the [v1.1.0 release](https://github.com/moralec/tinyCode/releases/tag/v1.1.0), with the
capabilities PDF (every mechanism and its status).

- **"Fixed" means a failing check turned green.** If the tests already pass before any change, `/fix` says so instead
  of reporting a fix.
- **`/plan` reviews its plan by default.** Plans read the files they will change before they are final: 12 of 15
  good plans against 9 of 15. Set `stages.planReview` to `false` to turn it off.
- **Edits with a repeated marker line** (`=======`, `<<<<<<< SEARCH`, `>>>>>>> REPLACE`) are read once.
- **`/build`** offers each task the files it must create, and says how many tasks are left.
- **Removed:** the acceptance check written from the request. A config with an `acceptance` block is refused: delete
  the block.
- The benchmark grew from 27 to 54 tasks, including three real bugs from a 100,000-line open-source project.

## Security fixes (v1.0.4)

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

## Known issues (v1.1.0)

1. Runs vary: the same task can pass in 30 s or hit the 10-minute cap. Steadier runs are on the roadmap.
2. `/build` finishes only the first task of a plan on its own; the model completes the rest by hand.
3. The router sends some requests to the wrong workflow: a symptom-only bug report, a rename, and questions about
   the project's own code (which never go to `/research`).
4. Small models on 8 GB cards don't benefit yet; see the results.
5. `install.ps1` is untested on real Windows.
6. The results above are from earlier releases. A full baseline of plain Pi against tinyCode on the new 49-task
   benchmark comes next.

## Licence

Apache-2.0. tinyCode builds on Pi (MIT) and borrows ideas from [little-coder](https://github.com/itayinbarr/little-coder)
(Apache-2.0); credits are in [NOTICE](NOTICE).
