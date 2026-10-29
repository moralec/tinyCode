<p align="center"><img src="assets/logo.svg" width="96" alt="tinyCode logo"></p>

<h1 align="center">tinyCode</h1>

<p align="center">A <a href="https://github.com/earendil-works/pi">Pi</a> extension for coding with small local models, built to spend as few tokens as possible on every call.</p>

> **Preview — v0.1.** Works, but rough edges remain; see [Known issues](#known-issues-v01). Feedback welcome via GitHub issues.

## Why

Coding agents work by trial and error: the model reads a file, runs the tests, reads another, and everything it saw
stays in the conversation and is sent again on every call. With a small model on a modest GPU, that growing
conversation is most of the cost and most of the wait.

tinyCode moves the routine part of the work from the model to code, and gives the model only what each step needs.
Big jobs become a series of small ones, each in a fresh context.

To decide what to build, we mapped the activities developers most often ask coding assistants and CLI agents for,
from published studies of real use (tens of thousands of real chat messages, plus developer surveys): changing
code, fixing bugs, explaining code, writing tests, documenting, planning, adding new code, committing, and general
questions. Each one got its own workflow, designed for a small context: code gathers exactly what that kind of job
needs, the model makes one or two narrow calls, and code checks the result.

## What

You work in Pi exactly as you would with any coding assistant: type what you want in plain language. Behind the
scenes, tinyCode recognises the kind of job and runs it its own way, with code doing the routine work and the model
doing only the thinking.

```
> the monthly report puts every day in its own bucket, can you fix it?
  I'll find why the monthly report groups by day and fix it.
  ✓ pick files · ✓ edit · ✓ tests
  Fixed: the date helper used the day instead of the month (orders/dates.py). Tests pass. (2 calls, 17 s)
```

It says in one sentence what it's about to do, shows its progress, and reports the result in plain words. It asks first
only before irreversible steps you didn't ask for (such as committing). Anything that isn't a coding job (a question, a
chat) goes to Pi as usual. The commands are there if you'd rather be explicit:

### Commands

| Command | What it's for |
|---|---|
| `/add` | Add new code (a function, an option, an endpoint) together with a test that proves it works. |
| `/edit` | Change existing code as described, with file-type checks (Python compiles, AppleScript recompiles on macOS). |
| `/fix` | Make a failing test pass, or fix a described bug. |
| `/explain` | Explain code in this project, with every file and line reference checked. |
| `/test` | Write tests for existing code. They must pass on today's code; a failure that looks like a bug is reported, never papered over. |
| `/doc` | Add comments and docstrings without touching the code, or write a project overview / update README sections from summaries of every file. |
| `/review` | Review your current changes, one hunk at a time, and list findings with file and line. |
| `/commit` | Write a commit message from your changes and commit after you confirm. |
| `/ask` | Answer a general question in one call, without touching the project. |
| `/research` | Answer "is there a library for X?" or "how do others do Y?" from GitHub and the web, in a separate context, with links. |
| `/plan` | Turn "I want to build X" into a short spec and a list of small tasks, each with a test. |
| `/build` | Work through the plan one task at a time: write the test, make it pass, run the suite, commit. |

One command per common activity, each optimised for a low-context setup. After any edit, your project's own
formatter and linter run if you have them set up.

## How

Why it stays fast and small on modest hardware:

- **The ladder.** Every fix starts with a checklist: code runs the test, outlines the project and lets the model
  pick the files, and the model answers with small find-and-replace edits. That's usually two calls. If it fails, a
  separate call reviews the error and the attempt, and the checklist tries once more. Only then does Pi's full loop
  take over, from a clean copy.
- **Adaptive Ladder.** tinyCode learns which approach is most efficient for your model. Models that rarely succeed
  at the checklist start in the loop, and get retried now and then.
- **Subagents, everywhere.** Research, side questions and each build task run in their own context, and only the
  result returns. The main conversation grows by answers, never by search output.
- **Prompts that stay the same from call to call**, so llama.cpp's prompt cache does most of the reading.
- **Limits on the loop:** repeated calls are stopped, long tool output is trimmed, and old output is hidden.

## Early numbers

Ten coding tasks where the task text never names the file to change (hidden bugs, multi-file features, a refactor,
a config fix, planted bugs in two real projects). Each task has a test that decides pass or fail. One run per cell,
tasks written by us: read it as direction, not proof.

| Gemma 4 12B on a 16 GB T4 | passed | calls per task | prompt tokens per task | typical time |
|---|---|---|---|---|
| **tinyCode ladder** | **10/10** | **3** | **about 6,000** | **20 s** |
| Pi on its own | 7/10 | 21 | about 144,000 | 83 s |

With Qwen 3.5 4B on an 8 GB card, both pass 9–10 of 10, and most tasks need the loop, which is what the Adaptive
Ladder learns. Setup: llama.cpp `llama-server`, temperature 0, thinking off, 30 calls or 30 minutes per task.
A fuller benchmark (repeated runs plus a third-party task set) is coming.

Pi alone against Pi with tinyCode on nine public Python exercises (Aider's polyglot benchmark), two models, updated as runs finish: [bench/RESULTS.md](bench/RESULTS.md).

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

Start either with the same alias, so tinyCode's setup doesn't change:

```
llama-server -m <model file> -a tinycode-model -ngl 99 -c 32768 -np 1 -fa on --jinja --reasoning-budget 0 --port 8080
```

### Using it

Run `pi` in your project and ask in plain language: tinyCode says what it's about to do, then does it. Or use the
commands above (`/fix`, `/edit`, `/review`, ...). `/tinycode` prints the effective configuration and `/tinycode stats`
the calls per step. It runs in auto mode by default; `/dev on` turns on diagnostics (router hints, events, per-call
tokens) and `/dev off` turns them off.

## Known issues (v0.1)

1. README updates can "correct" statements that were already right: review the diff before keeping it.
2. `/fix` without a failing test may search a long time when the described bug isn't there.
3. `install.ps1` is untested on real Windows.
4. Some plain-language requests run in Pi's general loop instead of a workflow, which is slower.
5. With small models, tool choice is weaker when the request is ambiguous; naming the file helps.
6. Results so far are from our own small benchmark on one machine.

## Licence

Apache-2.0. tinyCode builds on Pi (MIT) and borrows ideas from [little-coder](https://github.com/itayinbarr/little-coder)
(Apache-2.0); credits are in [NOTICE](NOTICE).
