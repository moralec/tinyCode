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
- **Cache-friendly prompts** that keep llama.cpp's prompt cache warm.

You keep using Pi as usual. Plain requests are matched to a workflow, tinyCode says in one line what it understood, and it runs after you confirm.

## Early numbers

From our own small benchmark (ten coding tasks, one run per cell, tasks written by us), a 12B model on a 16 GB card:

| | passed | calls per task | typical time |
|---|---|---|---|
| tinyCode-style checklist | 9/10 | about 2 | under 20 s |
| plain agent loop | 7/10 | about 21 | about 80 s |

Small sample; the release will publish the full method.

## Requirements (planned)

- [Pi](https://github.com/earendil-works/pi) 1.4 or later, Node 22.19 or later (the installer can install a private copy)
- An OpenAI-compatible endpoint, such as llama.cpp's `llama-server`
- macOS or Linux

## Licence

Apache-2.0. tinyCode builds on Pi (MIT) and borrows ideas from [little-coder](https://github.com/itayinbarr/little-coder) (Apache-2.0); credits will be listed in `NOTICE` with the first release.
