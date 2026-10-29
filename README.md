<p align="center"><img src="assets/logo.svg" width="96" alt="tinyCode logo"></p>

<h1 align="center">tinyCode</h1>

<p align="center">A <a href="https://github.com/earendil-works/pi">Pi</a> extension for coding with small local models, built to spend as few tokens as possible on every call.</p>

> **Work in progress.** Nothing to install yet. The first release is being built now; this page will say when it is ready.

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
  fix: monthly report groups by day instead of month — run it? [y/N] y
  ✓ fixed in orders/dates.py (2 calls, 17 s) — tests pass
```

It always says in one line what it understood and waits for your yes. Anything that isn't a coding job (a
question, a chat) goes to Pi as usual. The commands are there if you'd rather be explicit:

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
The full method and task list come with the first release.

## Installation

Not available yet: the first release is being built and tested now.

When it ships, one command installs a private copy of Node (if needed), Pi and tinyCode, asks for your model
endpoint, and checks that it answers:

- **macOS and Linux:** `install.sh`
- **Windows:** `install.ps1` (support will be claimed once automated tests pass on Windows)

You will need an OpenAI-compatible endpoint, such as llama.cpp's `llama-server`, and [Pi](https://github.com/earendil-works/pi)
1.4 or later (the installer can set it up).

## Licence

Apache-2.0. tinyCode builds on Pi (MIT) and borrows ideas from [little-coder](https://github.com/itayinbarr/little-coder)
(Apache-2.0); credits will be listed in `NOTICE` with the first release.
