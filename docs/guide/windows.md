# Windows

tinyCode runs on Windows through the same installer, in PowerShell. **Windows is untested so far:** please report
what you find.

## Before you install

Make sure you have:

1. **Windows 10 or 11** with PowerShell 5.1 or newer. You don't need admin rights.
2. **[Git for Windows](https://git-scm.com/download/win).** Pi runs the model's shell commands through Git Bash.
3. **Python 3 with pytest**, if your projects are Python: `python -m pip install pytest`.
4. **Your model server**, started as described on [Models](models.md).

## Install

Open PowerShell in the tinyCode folder:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -TrunkContext 16384 -SmallContext 16384
```

It prints one line per step, then a health check in which every line should say `ok`. Open a **new** terminal
afterwards: the installer adds `%USERPROFILE%\.local\bin` to your PATH. Your settings are in
`%USERPROFILE%\.config\tinycode\config.json`.

### If something fails

1. **`HTTP 000` in the health check:** the server is unreachable. Start it, then re-run with `-Endpoint <url> -Force`.
2. **pytest not found during `/fix`:** set `"test": { "python": "py" }`, or give a full path, in the config file.
3. **A model name does not match:** it must be exactly what your server lists in `/v1/models`.
4. **To check again:** `.\install.ps1 -Check`. **To remove everything:** `.\install.ps1 -Uninstall`.

## First run

```powershell
pi --model tinycode/tinycode-model
```

Then continue with [First run](getting-started.md#first-run) on the Getting started page.

## Reporting a problem

Open a GitHub issue with:
- what the installer printed;
- your Windows and PowerShell versions;
- your graphics card and memory;
- the model you used.

Never post API keys.

**Next:** [See the difference](pi-vs-tinycode.md), or back to [Start here](../START-HERE.md).
