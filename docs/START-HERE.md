# Start here

tinyCode is an extension for [Pi](https://github.com/earendil-works/pi), a terminal coding agent. It keeps what the
model sees small and well chosen, so a local model can finish coding tasks inside a 16k context window, where plain
Pi often runs out of room. This guide covers installing it, checking it works, and running the same task with plain
Pi and with tinyCode so you can see the difference yourself.

## 1. What you need

- **A GPU with 16 GB of memory, or a machine with unified memory (Apple Silicon, AMD Strix Halo) with 24 GB or
  more**, so the model and a 16k window fit. Our tested models need about 12-13 GB for the model itself. On unified
  memory the system shares that memory, and macOS limits how much of it the GPU may use, so 16 GB of unified memory
  is not enough. Our results come from a 16 GB card; we have not tested unified memory.
- **Our tested models:** gpt-oss-20b (faster) and Qwen3.6-35B-A3B (solves the most). The README's Models section has
  the exact files.
- **8 GB cards are not there yet.** The models that fit 8 GB (for example Nemotron-Nano-9B-v2, gemma-4-12B) were
  not helped by tinyCode in our runs. The memory left for context is often about 8k, and Pi reserves 4k of that for
  the reply.
- **An OpenAI-compatible server** for the model. We use llama.cpp's `llama-server`.
- **git**, plus **Python 3 with pytest** if your projects are Python (`/fix` and `/test` run your tests).

## 2. Start the model server

Give the model the alias `tinycode-model`, so the installer's defaults just work:

```
llama-server -m <model file> -a tinycode-model -ngl 99 -c 16384 -np 1 -fa on --jinja --reasoning-budget 0 --port 8080
```

Leave it running. Check it answers with `curl http://127.0.0.1:8080/v1/models`.

## 3. Install

**macOS and Linux:**

```
git clone https://github.com/moralec/tinyCode && cd tinyCode
sh install.sh --trunk-context 16384 --small-context 16384
```

**Windows** (untested so far, please report what you find), in PowerShell:

```
powershell -ExecutionPolicy Bypass -File .\install.ps1 -TrunkContext 16384 -SmallContext 16384
```

The installer does the following, and installs nothing globally:
- puts a private copy of Node (only if needed) and Pi 1.4 under `~/.local/opt/tinycode`;
- creates a `pi` command in `~/.local/bin`;
- links tinyCode into Pi's extensions;
- writes `~/.config/tinycode/config.json`;
- checks that your server answers.

**Open a new terminal afterwards**, so `~/.local/bin` is on your PATH.

**Using another endpoint or model name:** `sh install.sh --endpoint http://127.0.0.1:11434/v1 --trunk-model <name>`.

**Checking and removing:** `sh install.sh --check` repeats the checks, and `sh install.sh --uninstall` removes
everything (add `--purge` to delete your settings and logs too).

## 4. First run

In any project folder:

```
pi --model tinycode/tinycode-model
```

tinyCode registers your server's model as `tinycode/<model name>`. Name it as above, or pick it with Pi's model
picker (`/model`). Type `/tinycode` to see the settings in effect. Then work as you normally would with Pi. A few things to try:
- **"Make the failing tests pass"**, or `/fix <what is wrong>`. tinyCode runs its fix workflow: a quick targeted
  edit first, then Pi's own loop with what it learned.
- **`/test <file or function>`** writes tests and runs them.
- **`/plan <what to build>`** writes a numbered plan. Before the plan is final, the model reads the files the plan's
  tasks will change.
- **`/explain <file or function>`**, **`/review`** and **`/doc`** answer from the code, with `file:line` references.

`/tinycode stats` shows the calls per step, and `/dev on` adds per-call diagnostics.

## 5. See the difference: the same task with plain Pi and with tinyCode

This is the task from our published results where the difference is clearest. It is `connect`, a public Exercism
exercise from the [Aider polyglot benchmark](https://github.com/Aider-AI/polyglot-benchmark).

**Get the task, twice:**

```
git clone --depth 1 https://github.com/Aider-AI/polyglot-benchmark
cp -r polyglot-benchmark/python/exercises/practice/connect connect-pi
cp -r polyglot-benchmark/python/exercises/practice/connect connect-tinycode
```

**Give plain Pi a way to reach your server.** With extensions off, tinyCode's model entry is gone too, so add a
provider for plain Pi in `~/.pi/agent/models.json` (create the file if it does not exist):

```json
{
  "providers": {
    "local": {
      "baseUrl": "http://127.0.0.1:8080/v1",
      "api": "openai-completions",
      "apiKey": "none",
      "compat": { "supportsDeveloperRole": false, "supportsStore": false, "supportsReasoningEffort": false, "maxTokensField": "max_tokens" },
      "models": [{ "id": "tinycode-model", "name": "tinycode-model", "reasoning": false, "contextWindow": 16384, "maxTokens": 4096 }]
    }
  }
}
```

**The same request for both** (it is what our benchmark sends):

```
cat > prompt.txt <<'EOF'
Edit connect.py so that the tests in connect_test.py pass. Don't change the test file.
EOF
```

You can also paste the exercise's `.docs/instructions.md` above that line, as the benchmark does.

**Plain Pi** (`--no-extensions` turns tinyCode off):

```
cd connect-pi
pi --no-extensions --provider local --model tinycode-model -p "$(cat ../prompt.txt)"
python3 -m pytest connect_test.py -q
```

**Pi with tinyCode:**

```
cd ../connect-tinycode
pi --model tinycode/tinycode-model -p "$(cat ../prompt.txt)"
python3 -m pytest connect_test.py -q
```

**What we saw** (Qwen3.6-35B-A3B, a 16k window, one 16 GB card, one recorded run; your numbers will differ from run
to run):

| | Plain Pi | Pi + tinyCode |
|---|---|---|
| Result | ran out of context, 8 of 10 tests passing | **all 10 tests pass** |
| Time | 170 s | **30 s** |
| Model calls | 8 | **3** |
| Prompt tokens sent | 49.7k | **7.2k** |

How each one got there:
- **Plain Pi** read the test file and the code, wrote a first solution, and ran the tests: 2 failed. It then explored
  the hex-grid geometry with several inline Python scripts, and rewrote the whole file again. By then the
  conversation filled the 16k window, and the model's reply was cut off.
- **tinyCode** recognised "make the tests pass" and ran its fix workflow. Its first targeted edit made all 10 tests
  pass. The model then ran the tests once to confirm, and stopped.

Not every task looks like this. When a task fits easily, plain Pi is often faster, because tinyCode's extra steps
cost time. The README's Results section has the full tables.

## 6. Where next

- [README](../README.md): why tinyCode exists, how it works, the results, and the known issues.
- [The latest release](https://github.com/moralec/tinyCode/releases): notes, plus a PDF of every mechanism and its status.
- [ROADMAP.md](../ROADMAP.md): what comes next.
- Issues and feedback: GitHub issues. Please include your card, model and window.
