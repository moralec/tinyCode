# Getting started

This page covers installing tinyCode, checking that it works, and your first run.

## Installation

Start your model with the alias `tinycode-model` and a 16k window, and leave it running:

```
llama-server -m <model file> -a tinycode-model -ngl 99 -c 16384 -np 1 -fa on --jinja --reasoning-budget 0 --port 8080
```

Then install tinyCode (macOS and Linux):

```
git clone https://github.com/moralec/tinyCode && cd tinyCode
sh install.sh --trunk-context 16384 --small-context 16384
```

What the installer does:
- installs Pi 1.4, and Node if you need it, under `~/.local/opt/tinycode`;
- creates a `pi` command;
- links tinyCode into Pi, and checks that your server answers.

Nothing is installed globally. **Open a new terminal afterwards.** On Windows, see [Windows](windows.md). Which model to
run: see [Models](models.md).

### Already have Pi?

Install tinyCode as a Pi package instead:

```
pi install npm:@moralec/tinycode
```

It expects the server at `http://127.0.0.1:8080/v1` with the model `tinycode-model`. If your window is 16k, tell it in
`~/.config/tinycode/config.json`:

```json
{ "lanes": { "trunk": { "contextWindow": 16384 }, "small": { "contextWindow": 16384 } } }
```

### Troubleshooting installation

1. Check that the server answers: `curl http://127.0.0.1:8080/v1/models`.
2. Run `sh install.sh --check`. It repeats the installer's checks and says which one fails.
3. Using another address or model name? Run `sh install.sh --endpoint <url> --trunk-model <name>`.
4. To start over, run `sh install.sh --uninstall`, then install again.

## First run

In any project folder:

```
pi --model tinycode/tinycode-model
```

Type `/tinycode` to see the settings in effect. Then work as you normally would. Things to try:
- **"Make the failing tests pass"** fixes code with a quick targeted edit first.
- **`/test <file>`** writes tests and runs them.
- **`/plan <what to build>`** writes a plan. The model reads the files the plan will change before the plan is final.
- **`/explain <file>`** explains code with `file:line` references.

## Ready to learn more?

**[See the difference](pi-vs-tinycode.md)**: six real tasks, with what plain Pi and tinyCode each did.
