<p align="center"><img src="assets/logo.svg" width="96" alt="tinyCode logo"></p>

<h1 align="center">tinyCode</h1>

<p align="center">A <a href="https://github.com/earendil-works/pi">Pi</a> extension that keeps the context small, so local models finish coding tasks in a 16k window where plain Pi runs out of room.</p>

> **Preview — v1.0.1.** Works, but rough edges remain; see [Known issues](#known-issues-v101). Feedback welcome via GitHub issues.

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

## Results

Three tested setups: each a card with a model that fits it, a **16k context window**, the same five tasks for both
sides, three runs each, a 10-minute cap per run. **The runs are still in progress**: a `·` is a run not done yet, and
this table is updated as they finish.

| Card | Model (why) | Window | Pi alone | Pi + tinyCode |
|---|---|---|---|---|
| 16 GB (Tesla T4) | gpt-oss-20b (best coder that fits) | 16k | 3 of 9 | **6 of 9** |
| 16 GB (Tesla T4) | Qwen3.6-35B-A3B (popular reference) | 16k | 4 of 14 | **10 of 13** |
| 8 GB (Quadro P4000) | Nemotron-Nano-9B-v2 (best coder that fits) | 16k | 0 of 2 | **0 of 1** |

Each mark is one run, in order: ✓ pass with its time in seconds, ✗ fail, · not run yet (three runs per side):

| Task | What it asks (tests) | gpt-oss: Pi / +tinyCode | Qwen3.6: Pi / +tinyCode | Nemotron: Pi / +tinyCode |
|---|---|---|---|---|
| [connect](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/connect) | decide who won a game of Hex: an unbroken path of stones across a board of hexagons (10) | ✗ ✗ ✓26 / ✓72 ✓30 ✓28 | ✗ ✗ ✗ / ✓30 ✓76 ✓260 | ✗ · · / ✗ · · |
| [bowling](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/bowling) | score ten-pin bowling: strikes, spares, the tenth frame, and illegal rolls (31) | ✗ ✗ · / ✗ ✗ · | ✗ ✗ ✗ / ✗ ✗ ✓327 | ✗ · · / · · · |
| [dot-dsl](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/dot-dsl) | a small language for building graphs (nodes, edges, attributes) that rejects malformed input (12) | ✓64 ✓52 · / ✓44 ✓50 · | ✓76 ✗ ✗ / ✓198 ✓36 ✓70 | · · · / · · · |
| [paasio](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/paasio) | wrap files and sockets so they count bytes read, written and calls made (25) | ✗ ✗ · / ✗ ✓152 · | ✓46 ✓64 ✓48 / ✓204 ✓298 ✓377 | · · · / · · · |
| [sgf-parsing](https://github.com/Aider-AI/polyglot-benchmark/tree/main/python/exercises/practice/sgf-parsing) | parse SGF, the text format for recording games of Go, into a tree (23) | · · · / · · · | ✗ ✗ · / ✗ · · | · · · / · · · |
| **Total** | **solved, median time of the passes** | **3 of 9** (52 s) / **6 of 9** (47 s) | **4 of 14** (56 s) / **10 of 13** (201 s) | **0 of 2** (–) / **0 of 1** (–) |

Runs that stopped to ask a question instead of acting (no one answers in these runs, so they count as fails): Nemotron-Nano-9B-v2: Pi alone 2 of 2, Pi + tinyCode 0 of 1.

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

v1.1 aims at an 8k window (8 GB cards and laptops), v1.2 at bugs described in words, v1.3 at handing jobs to your local
machine from another agent: [ROADMAP.md](ROADMAP.md).

## Known issues (v1.0.1)

1. When both sides finish, tinyCode is often slower: its extra steps cost time on tasks that fit anyway.
2. Runs vary: the same task can pass in 30 s or hit the 10-minute cap. Steadier runs are on the roadmap.
3. Small models on 8 GB cards don't benefit yet; see the results.
4. `install.ps1` is untested on real Windows.
5. Results so far are from five tasks on one machine.

## Licence

Apache-2.0. tinyCode builds on Pi (MIT) and borrows ideas from [little-coder](https://github.com/itayinbarr/little-coder)
(Apache-2.0); credits are in [NOTICE](NOTICE).
