<p align="center"><img src="assets/logo.svg" width="96" alt="tinyCode logo"></p>

<h1 align="center">tinyCode</h1>

<p align="center">A <a href="https://github.com/earendil-works/pi">Pi</a> extension for coding with small local models, built to spend as few tokens as possible on every call.</p>

> **Work in progress.** Nothing to install yet. The first release is being built now; this page will say when it is ready.

## Why

Coding agents send the model a growing conversation: every file read and every test run stays in the context and is sent again on each call. On a small model with a slow card, that is most of the cost.

tinyCode moves the routine decisions from the model to code:

- **Code builds the context.** It reads the failing test, follows imports and outlines the project, then gives the model only what the step needs.
- **One call per step where possible.** The model answers with small find-and-replace edits; code applies them and runs the tests.
- **Branching.** Side questions run in a separate call, and only the answer, with file and line references, returns to the main conversation.
- **An escalation ladder.** A checklist first; if it fails, a short review in a fresh context says what to do differently; only then Pi's own loop.
- **Adaptive Ladder.** tinyCode learns which approach is the most efficient to solve tasks for your model. Every
  model starts on the cheap checklist; if it rarely solves tasks there, tinyCode starts that model in the loop
  instead, and retries the checklist now and then so a model can win it back. No per-model settings.
- **Cache-friendly prompts** that keep llama.cpp's prompt cache warm.

You keep using Pi as usual. Plain requests are matched to a workflow, tinyCode says in one line what it understood, and it runs after you confirm.

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
