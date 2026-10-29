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

Our own benchmark, run while designing tinyCode. Small samples (one run per cell, tasks written by us), so read it as
direction, not proof. The full harness will be published with the first release.

### Setup

| | |
|---|---|
| Models | **Gemma 4 12B** (instruct, IQ4_XS GGUF) and **Qwen 3.5 4B** (Q8_0 GGUF) |
| Hardware | NVIDIA Tesla T4 16 GB (Gemma, 32k context per slot) and Quadro P4000 8 GB (Qwen) |
| Server | llama.cpp `llama-server`, OpenAI-compatible API, prompt cache on |
| Settings | temperature 0, thinking off, one task at a time |
| Limits | 30 calls or 30 minutes per task |
| Check | each task has a pytest test that decides pass or fail |

### Contenders

- **One call:** code sends the failing test and the files it imports; the model answers with find-and-replace edits; one retry.
- **Checklist:** code outlines the project, the model picks up to five files, then edits; one retry.
- **Ladder** (tinyCode's design): the checklist first; if it fails, a review in a fresh context says what to do
  differently and the checklist tries once more; only then Pi's own loop.
- **Pi:** bare Pi 1.4 with its four tools, exploring on its own.

### Round 1: ten easy tasks

Small Python repos: bug fixes, a small feature, a rename across three files, an environment-variable override, a
bug two imports away in a 2,000-line repo. Every contender passed almost everything, so tokens told the story.

| Gemma 4 12B | passed | calls per task | prompt tokens per task |
|---|---|---|---|
| One call | 10/10 | 1.0 | about 800 |
| Pi | 10/10 | 7.7 | about 15,700 (80 % served from cache) |

### Round 2: ten harder tasks

None of the task texts names the file to change:

1. A monthly report groups orders by day of month instead of by month (the bug is in a date helper).
2. A word counter splits contractions into two words.
3. An invoice crashes on a missing field; fix the cause, not the symptom.
4. Add a CSV export registered like the existing formats, with its own setting.
5. Add priorities to a to-do app: a new field, old files still load, sorting, validation.
6. Move helpers into a new module, rename a function, update every user, delete the old module.
7. An upload limit disagrees with the documentation; the fix belongs in the config file.
8. Add a list helper and write its tests (no test given; a hidden test checks it).
9. A planted bug in a real web app of ours (about 2,000 lines).
10. A planted bug in the scheduler of a real job queue of ours.

| Gemma 4 12B | passed | calls per task | prompt tokens per task | typical time |
|---|---|---|---|---|
| One call | 6/10 | 1.3 | about 1,500 | 14 s |
| Checklist | 9/10 | 2.1 | about 4,800 | 19 s |
| **Ladder** | **10/10** | **3.1** | **about 5,900** | **20 s** |
| Pi | 7/10 | 20.8 | about 144,000 | 83 s |

On Gemma the ladder solved 8 tasks at the first rung, 1 after the review and 1 in Pi's loop. Pi's three failures
all hit the 30-call limit.

| Qwen 3.5 4B | passed | calls per task | prompt tokens per task | typical time |
|---|---|---|---|---|
| One call | 4/10 | 1.6 | about 1,700 | 15 s |
| Checklist | 5/10 | 2.7 | about 5,300 | 17 s |
| Ladder | 8 of 9 so far | 11.1 | | 49 s |
| Pi | 10/10 | 11.3 | about 54,000 | 68 s |

The small model makes more wrong first edits, so it leans on the loop: Pi's trial and error suits it, and the
ladder reaches its last rung more often there.

## Requirements (planned)

- [Pi](https://github.com/earendil-works/pi) 1.4 or later, Node 22.19 or later (the installer can install a private copy)
- An OpenAI-compatible endpoint, such as llama.cpp's `llama-server`
- macOS, Linux or Windows: the code is written to be cross-platform, with an installer for each (`install.sh`, `install.ps1`). Windows support will be claimed once automated tests pass on it.

## Licence

Apache-2.0. tinyCode builds on Pi (MIT) and borrows ideas from [little-coder](https://github.com/itayinbarr/little-coder) (Apache-2.0); credits will be listed in `NOTICE` with the first release.
