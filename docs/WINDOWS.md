# tinyCode on Windows

tinyCode is an extension for [Pi](https://pi.dev) (a terminal coding agent) that makes small local models useful:
`/fix` walks a ladder (one cheap edit call, a short review, then Pi's own loop), `/edit` changes one file, `/review`
reads a diff hunk by hunk. Windows support is **untested so far** (v1.0 preview). Please report what breaks, including things that look like your own mistake.

## What you need

- Windows 10 or 11, PowerShell 5.1 (built in) or newer. No admin rights.
- **Git for Windows** (https://git-scm.com/download/win). Pi runs the model's shell commands through Git Bash.
- **Python 3 with pytest** on PATH as `python` (`python -m pip install pytest`), only for the sample task below and
  for Python projects.
- **Your own model endpoint** that speaks the OpenAI chat API (`/v1/chat/completions`):
  - llama.cpp `llama-server`: `http://127.0.0.1:8080/v1`, or
  - Ollama: `http://127.0.0.1:11434/v1` (model names as `ollama list` prints them), or
  - a cloud key (see "Cloud key" at the end).

  tinyCode names two lanes: `trunk` (does the edits; a 7B-14B coder or instruct model is the target) and `small`
  (routing and short side questions; may be the same model as the trunk).
- Network access to nodejs.org and npmjs.org during the install (it downloads a private Node 22 and Pi 1.4.0).
  Nothing is installed globally and your own Node, if any, is never used.

## Recommended model

Two options, from our own measurements (one GPU, same coding request):

| | Preferred | Smaller alternative |
|---|---|---|
| Model | Qwen3.6-35B-A3B | gemma-4-12B-it |
| File | `Qwen3.6-35B-A3B-UD-IQ3_XXS.gguf` (~13 GB) | `gemma-4-12b-it-IQ4_XS.gguf` (~6.4 GB) |
| Hugging Face repo | `unsloth/Qwen3.6-35B-A3B-GGUF` | `unsloth/gemma-4-12b-it-GGUF` |
| Memory in use (32k context) | ~13–14 GB | ~7–8 GB |
| Why | fastest of four models we tried, about 2× gemma's output speed, equally accurate | half the memory; accurate but slower |

Use the preferred one if it fits (a 16 GB graphics card, or integrated graphics that can borrow that much system
memory); otherwise the smaller one. Start it with the same alias either way, so tinyCode's setup doesn't change:

```
llama-server -m <model file> -a tinycode-model -ngl 99 -c 32768 -np 1 -fa on --jinja --reasoning-budget 0 --port 8080
```

Install with `install.ps1 --endpoint http://127.0.0.1:8080/v1`, both models `tinycode-model`. When you report a problem, say which
model you used, your graphics (name and memory, or "integrated"), and the tokens per second llama-server prints.

## Install

Open PowerShell in the tinyCode folder and run (replace the endpoint and the model names with yours):

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 `
  -Endpoint http://127.0.0.1:11434/v1 -TrunkModel qwen2.5-coder:14b -SmallModel qwen2.5-coder:7b
```

It prints one line per step, then a health check where every line should say `ok`:
`pi --version`, both models listed by `pi --list-models`, the endpoint's `/models`, one 1-token chat call per lane,
and `pi -p "/tinycode"`. Some servers list only one model in `/models`; that is reported as `ok` if the chat call works.
Open a **new** terminal afterwards (the installer adds `%USERPROFILE%\.local\bin` to your user PATH).

Re-running the installer is safe (it says `nothing to do`). Check again any time with `.\install.ps1 -Check`.
Your settings live in `%USERPROFILE%\.config\tinycode\config.json`. The installer never overwrites it unless you
pass `-Force`. Remove everything with `.\install.ps1 -Uninstall` (add `-Purge` to delete your config and logs too).

## Try it

```powershell
pi            # opens Pi with tinyCode loaded
```

Inside Pi: `/tinycode` prints the effective configuration; `/tinycode stats` prints calls per step.

### One `/fix` on a sample task

Make a small project with a bug (run this in any empty folder):

```powershell
mkdir sample; cd sample; mkdir mathx, tests
Set-Content mathx\__init__.py ''
Set-Content mathx\stats.py "def mean(xs):`n    return sum(xs) / (len(xs) + 1)`n"
Set-Content tests\test_stats.py "from mathx.stats import mean`n`ndef test_mean():`n    assert mean([2, 4, 6]) == 4`n"
git init -q; git add -A; git commit -q -m start
python -m pytest -q          # fails: 3.0 != 4
pi
```

In Pi type:

```
/fix --test tests/test_stats.py mean() returns the wrong value, fix it
```

You should see a few lines (outline, picked files, the edit applied, test result) ending in `solved_by: rung1` and
`calls: 2`. Run `python -m pytest -q` again: it should pass. `/fix --undo` restores the files as they were.

Also try, in the same repo: `/review` (after changing a file, it reviews your diff) and a plain sentence such as
`fix the failing test in mathx`: tinyCode asks one confirmation line before running `/fix`; answer `n` and Pi
behaves as it normally would.

## If something fails

- `FAIL ... HTTP 000` in the health check: the endpoint is unreachable from this machine. Start your server, fix the
  URL with `-Endpoint ... -Force`.
- `pytest` not found during `/fix`: set `"test": { "python": "py" }` (or a full path) in the config file.
- Model names must match the server exactly (`ollama list`, or the id in `/v1/models`).

## Reporting a problem

Open an issue on GitHub and include:

1. The text the installer printed, including the health check.
2. The output of `/tinycode stats` after a `/fix`.
3. Windows version, PowerShell version (`$PSVersionTable.PSVersion`), your endpoint type, and the models you used.
4. What you expected, what happened, and anything awkward: path problems, quoting, Git Bash prompts, slow steps.

The files in `%USERPROFILE%\.local\state\tinycode\` (`calls.jsonl`, `fix-runs.jsonl`) can help. `fix-replies.jsonl`
holds the files the model saw: attach it only if the task was the sample project, never from your own code.
Do not post API keys. tinyCode reads keys only from the environment variable you name.

## Cloud key (optional)

```powershell
$env:OPENAI_API_KEY = '...'   # set it in your environment; the installer never sees the value
.\install.ps1 -Endpoint https://api.openai.com/v1 -TrunkModel <model> -SmallModel <model> -ApiKeyEnv OPENAI_API_KEY
```

The direct steps (`/fix` rungs 1-2, `/edit`, `/review`, routing) send the key from that variable. Lanes that use a
key are not registered as a `tinycode/*` model in Pi, so rung 3 and plain chat use whatever model you picked in Pi
itself (`/login`, `/model`). This path has not been tested yet; please report how it goes.
