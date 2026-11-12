# Start here

Welcome to **tinyCode**, an extension for [Pi](https://github.com/earendil-works/pi), the terminal coding agent. This
guide covers installing it, a first run, and the same task done with and without it.

## Before we begin…

Make sure you have:

1. **A GPU with 16 GB of memory, or 24 GB or more of unified memory** (Apple Silicon, AMD Strix Halo). 8 GB cards are
   not there yet.
2. **A local model server**, such as llama.cpp's `llama-server`, and **git**.

## Why use tinyCode?

1. **It fits small windows.** On a local GPU the context window is the real limit. tinyCode keeps what the model sees
   small, so tasks finish in 16k, where plain Pi often runs out of room.
2. **It checks by running.** "Fixed" means a failing test now passes, not that the model says so.
3. **It takes the shortest path.** Fixing failing tests and writing tests start with a quick, targeted step before the
   model's open-ended loop.
4. **It is measured.** Every feature was tested against plain Pi on the same model, and switched on only where it
   helped.

## Guide contents

1. **[Models](guide/models.md):** which model to run on your hardware, and how to start it.
2. **[Getting started](guide/getting-started.md):** install, check it works, first run.
3. **[Windows](guide/windows.md):** installing on Windows (untested so far).
4. **[See the difference](guide/pi-vs-tinycode.md):** six real tasks, with what plain Pi and tinyCode each did.

## Additional resources

- [README](../README.md): how it works, the results, and the known issues.
- [Capabilities](capabilities.md): every mechanism with its status and evidence ([PDF](capabilities.pdf)).
- [Results](results.md): every published run, per model.
- [CHANGELOG.md](../CHANGELOG.md): what changed in each release.
- [Releases](https://github.com/moralec/tinyCode/releases): notes, plus a PDF of every feature and its status.
- [ROADMAP.md](../ROADMAP.md): what comes next.

## Ready to go?

Pick your model on **[Models](guide/models.md)**, then head to **[Getting started](guide/getting-started.md)**.
