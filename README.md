<p align="center"><img src="assets/logo.svg" width="96" alt="tinyCode logo"></p>

<h1 align="center">tinyCode</h1>

<p align="center">A <a href="https://github.com/earendil-works/pi">Pi</a> extension that keeps the context small, so local models finish coding tasks in a 16k window where plain Pi runs out of room.</p>

> **Preview — v1.0.** Works, but rough edges remain; see [Known issues](#known-issues-v10). Feedback welcome via GitHub issues.

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

Qwen3.6-35B-A3B on one 16 GB T4, **16k context window**, the same tasks and prompts for both. The five tasks are the
Aider polyglot Python exercises where plain Pi needed more than 14k of context when it had 32k; with 32k, Pi alone
solves all five. At 16k:

| Task | Pi alone | Pi + tinyCode |
|---|---|---|
| connect | ✗ context full (4 failed, 6 passed) | ✗ time cap (1 failed, 9 passed) |
| bowling | ✗ context full (6 failed, 25 passed) | ✓ 557 s |
| dot-dsl | ✓ 38 s | ✓ 236 s |
| paasio | ✗ reply cut (window full) (1 failed, 24 passed) | ✓ 347 s |
| sgf-parsing | ✗ context full (17 failed, 6 passed) | ✓ 539 s |
| **solved** | **1 of 5 runs** | **4 of 5 runs** |

One run per task so far, a 10-minute cap per run; repeat runs are being added ([#1](https://github.com/moralec/tinyCode/issues/1)). Where plain Pi ran out of room, tinyCode kept the window under its limit and finished, but slowly: 6 to 9 minutes. Where both finish, plain Pi is faster (dot-dsl: 38 s against 236 s). Making those runs shorter is the next step.

Method and every run: [bench/RESULTS.md](bench/RESULTS.md).

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

Two models we recommend, from our own measurements on one GPU:

| | Preferred | Smaller |
|---|---|---|
| Model | Qwen3.6-35B-A3B | gemma-4-12b-it |
| File | `UD-IQ3_XXS` from [unsloth/Qwen3.6-35B-A3B-GGUF](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF), about 13 GB | `IQ4_XS` from [unsloth/gemma-4-12b-it-GGUF](https://huggingface.co/unsloth/gemma-4-12b-it-GGUF), about 6.4 GB |

Start either with the same alias, so tinyCode's setup doesn't change. The results above use a 16k window; a larger one
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

## Known issues (v1.0)

1. After a milestone the model re-reads the files it needs, so a run with several milestones takes longer than one
   without.
2. On tasks plain Pi also finishes, tinyCode is slower so far (dot-dsl at 16k: 236 s against 38 s).
3. `install.ps1` is untested on real Windows.
4. Results so far are from five tasks on one machine and one model.

## Licence

Apache-2.0. tinyCode builds on Pi (MIT) and borrows ideas from [little-coder](https://github.com/itayinbarr/little-coder)
(Apache-2.0); credits are in [NOTICE](NOTICE).
