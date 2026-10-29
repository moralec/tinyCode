# tinyCode installer for Windows (x64, arm64). PowerShell 5.1 or newer, no admin, idempotent, reversible.
# Mirrors install.sh step for step.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1 [-Endpoint URL] [-TrunkModel M] [-SmallModel M]
#       [-TrunkContext N] [-SmallContext N] [-ApiKeyEnv VAR] [-Force] [-Check] [-Uninstall [-Purge]]
#
#   1. private Node 22 under ~\.local\opt (checksum verified), never a system Node
#   2. Pi 1.4.0 from npm into ~\.local\opt\tinycode\pi, wrapper ~\.local\bin\pi.cmd
#   3. the tinyCode extension copied to ~\.local\opt\tinycode\ext\<version>, joined (junction) into Pi's extensions folder
#   4. ~\.config\tinycode\config.json from the flags (only if absent, or with -Force)
#   5. ~\.local\bin added to the user PATH
#   6. a manifest of everything created, and a health check
# Pi on Windows runs the model's bash tool through Git Bash (https://git-scm.com/download/win); install it first.
param(
  [string]$Endpoint = 'http://127.0.0.1:8080/v1',
  [string]$TrunkModel = 'tinycode-model',
  [string]$SmallModel = 'tinycode-model',
  [int]$TrunkContext = 32768,
  [int]$SmallContext = 32768,
  [string]$ApiKeyEnv = '',
  [switch]$Force,
  [switch]$Check,
  [switch]$Uninstall,
  [switch]$Purge
)

$ErrorActionPreference = 'Stop'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
$ProgressPreference = 'SilentlyContinue'

$NodeVersion = '22.23.4'
$PiVersion = '1.4.0'
$MarkWrapper = 'REM tinycode-wrapper'

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Home_ = [Environment]::GetFolderPath('UserProfile')
$Opt = Join-Path $Home_ '.local\opt'
$TC = Join-Path $Opt 'tinycode'
$NodeDir = Join-Path $Opt "node-v$NodeVersion"
$Bin = Join-Path $Home_ '.local\bin'
$Wrapper = Join-Path $Bin 'pi.cmd'
$AgentDir = if ($env:PI_CODING_AGENT_DIR) { $env:PI_CODING_AGENT_DIR } else { Join-Path $Home_ '.pi\agent' }
$ExtLink = Join-Path $AgentDir 'extensions\tinycode'
$CfgDir = Join-Path $Home_ '.config\tinycode'
$Cfg = if ($env:TINYCODE_CONFIG) { $env:TINYCODE_CONFIG } else { Join-Path $CfgDir 'config.json' }
$StateDir = Join-Path $Home_ '.local\state\tinycode'
$Manifest = Join-Path $TC 'manifest.txt'
$PiCli = Join-Path $TC 'pi\node_modules\@earendil-works\pi-coding-agent\dist\bundle\cli.js'

function Say([string]$m) { Write-Host $m }
function Die([string]$m) { Write-Host "install.ps1: $m" -ForegroundColor Red; exit 1 }
$Utf8 = New-Object System.Text.UTF8Encoding($false)   # no BOM: Node's JSON.parse rejects one

# ---- manifest: "dir <p>" (removed only if empty), "rm <p>" (removed with everything under it), "purge <p>" --------
function Record([string]$kind, [string]$path) {
  if (-not (Test-Path -LiteralPath $TC)) { return }
  $line = "$kind $path"
  $have = @()
  if (Test-Path -LiteralPath $Manifest) { $have = Get-Content -LiteralPath $Manifest }
  if ($have -notcontains $line) { Add-Content -LiteralPath $Manifest -Value $line -Encoding ASCII }
}
function MkdirRec([string]$path) {
  if (Test-Path -LiteralPath $path) { return }
  MkdirRec (Split-Path -Parent $path)
  New-Item -ItemType Directory -Path $path | Out-Null
  Record 'dir' $path
}

# ---- native commands without PowerShell turning stderr into errors; stdin closed (pi hangs otherwise) ---------------
function RunPi([string[]]$piArgs, [int]$timeoutSec = 120) {
  $o = [IO.Path]::GetTempFileName(); $e = [IO.Path]::GetTempFileName(); $i = [IO.Path]::GetTempFileName()
  try {
    $quoted = ($piArgs | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
    $p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c', "`"`"$Wrapper`" $quoted`"") -NoNewWindow -PassThru `
      -RedirectStandardInput $i -RedirectStandardOutput $o -RedirectStandardError $e
    if (-not $p.WaitForExit($timeoutSec * 1000)) { try { $p.Kill() } catch { } }
    return ((Get-Content -LiteralPath $o -Raw) + (Get-Content -LiteralPath $e -Raw))
  } finally { Remove-Item -LiteralPath $o, $e, $i -Force -ErrorAction SilentlyContinue }
}

# ---- uninstall ---------------------------------------------------------------------------------------------------
function DoUninstall {
  if (-not (Test-Path -LiteralPath $Manifest)) { Say "uninstall: no manifest at $Manifest, nothing to do"; return }
  $lines = Get-Content -LiteralPath $Manifest
  if ((Test-Path -LiteralPath $Wrapper) -and ((Get-Content -LiteralPath $Wrapper -Raw) -match [regex]::Escape($MarkWrapper))) {
    Remove-Item -LiteralPath $Wrapper -Force; Say "removed $Wrapper"
  }
  # the PATH entry
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($user) {
    $kept = @($user -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ne $Bin.TrimEnd('\')) })
    if ($kept.Count -ne @($user -split ';' | Where-Object { $_ }).Count) {
      [Environment]::SetEnvironmentVariable('Path', ($kept -join ';'), 'User'); Say "removed $Bin from the user PATH"
    }
  }
  if (Test-Path -LiteralPath $ExtLink) { (Get-Item -LiteralPath $ExtLink).Delete(); Say "removed $ExtLink" }
  foreach ($line in $lines) {
    $kind, $path = $line -split ' ', 2
    if ($kind -eq 'rm' -or ($kind -eq 'purge' -and $Purge)) {
      if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force; Say "removed $path" }
    }
  }
  $dirs = $lines | Where-Object { $_ -like 'dir *' } | ForEach-Object { $_.Substring(4) } | Sort-Object -Descending
  foreach ($d in $dirs) {
    if ((Test-Path -LiteralPath $d) -and -not (Get-ChildItem -LiteralPath $d -Force | Select-Object -First 1)) {
      Remove-Item -LiteralPath $d -Force; Say "removed (empty) $d"
    }
  }
  if ($Purge -and (Test-Path -LiteralPath $StateDir)) { Remove-Item -LiteralPath $StateDir -Recurse -Force; Say "removed $StateDir" }
  if (-not $Purge -and (Test-Path -LiteralPath $Cfg)) { Say "kept $Cfg (use -Purge to remove config and logs)" }
  Say 'uninstall: done'
}

# ---- health check ------------------------------------------------------------------------------------------------
$script:Fails = 0
function Ok([string]$m) { Say "ok   $m" }
function Bad([string]$m) { Say "FAIL $m"; $script:Fails++ }

function Health {
  $script:Fails = 0
  if (-not (Test-Path -LiteralPath $Wrapper)) { Bad "pi wrapper missing at $Wrapper (run the installer)"; return $false }
  if (-not (Test-Path -LiteralPath $Cfg)) { Bad "config missing at $Cfg"; return $false }
  $c = Get-Content -LiteralPath $Cfg -Raw | ConvertFrom-Json

  $v = (RunPi @('--version')).Trim().Split("`n")[-1].Trim()
  if ($v -eq $PiVersion) { Ok "pi --version = $v" } else { Bad "pi --version: expected $PiVersion, got '$v'" }

  $lanes = @()
  foreach ($n in 'trunk', 'small') { if ($c.lanes.$n -and $c.lanes.$n.model) { $lanes += $n } }
  $env:PI_SKIP_VERSION_CHECK = '1'; $env:PI_TELEMETRY = '0'
  $models = RunPi @('--list-models')
  foreach ($n in $lanes) {
    $lane = $c.lanes.$n
    if ($lane.apiKeyEnv) { Ok "pi --list-models: $n lane uses a key ($($lane.apiKeyEnv)), not a tinycode/* provider model (skipped)" }
    elseif ($models.Contains($lane.model)) { Ok "pi --list-models shows tinycode/$($lane.model)" }
    else { Bad "pi --list-models does not show $($lane.model)" }
  }

  foreach ($n in $lanes) {
    $lane = $c.lanes.$n
    $headers = @{}
    if ($lane.apiKeyEnv) {
      $kv = [Environment]::GetEnvironmentVariable($lane.apiKeyEnv)
      if ($kv) { $headers['Authorization'] = "Bearer $kv" }
    }
    $listed = $false; $listOk = $true
    try {
      $r = Invoke-RestMethod -Uri "$($lane.baseUrl)/models" -Headers $headers -TimeoutSec 60 -UseBasicParsing
      $listed = [bool](@($r.data) | Where-Object { $_.id -eq $lane.model })
    } catch { $listOk = $false; Bad "GET $($lane.baseUrl)/models failed: $($_.Exception.Message)" }
    if (-not $listOk) { continue }
    $body = @{ model = $lane.model; messages = @(@{ role = 'user'; content = 'hi' }); max_tokens = 1 } | ConvertTo-Json -Depth 5 -Compress
    $chatOk = $false
    foreach ($try in 1, 2) {
      try {
        Invoke-RestMethod -Method Post -Uri "$($lane.baseUrl)/chat/completions" -Headers $headers -ContentType 'application/json' -Body $body -TimeoutSec 90 -UseBasicParsing | Out-Null
        $chatOk = $true; break
      } catch { $chatErr = $_.Exception.Message; Start-Sleep -Seconds 2 }
    }
    if ($listed) { Ok "GET $($lane.baseUrl)/models lists $($lane.model)" }
    elseif ($chatOk) { Ok "GET $($lane.baseUrl)/models does not list $($lane.model), but it answers a chat call (multi-lane servers list one lane)" }
    else { Bad "GET $($lane.baseUrl)/models does not list $($lane.model)" }
    if ($chatOk) { Ok "chat call to $n lane ($($lane.model)), max_tokens 1" } else { Bad "chat call to $n lane ($($lane.model)) failed: $chatErr" }
  }

  $out = RunPi @('-p', '/tinycode')
  if ($out.Contains('tinyCode config')) { Ok 'pi -p "/tinycode" shows the config' }
  else { Bad ('pi -p "/tinycode" did not show the config: ' + $out.Substring(0, [Math]::Min(200, $out.Length))) }

  Ok '.scpt routine: not available here (macOS only; .py routine unaffected)'
  return ($script:Fails -eq 0)
}

# ---- install steps -----------------------------------------------------------------------------------------------
function StepNode {
  $nodeExe = Join-Path $NodeDir 'node.exe'
  if ((Test-Path -LiteralPath $nodeExe) -and ((& $nodeExe -v) -eq "v$NodeVersion")) {
    Say "node: v$NodeVersion already at $NodeDir, nothing to do"; return
  }
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $name = "node-v$NodeVersion-win-$arch"
  $base = "https://nodejs.org/dist/v$NodeVersion"
  $work = Join-Path ([IO.Path]::GetTempPath()) ("tinycode-" + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $work | Out-Null
  try {
    Say "node: downloading $name.zip"
    Invoke-WebRequest -Uri "$base/$name.zip" -OutFile (Join-Path $work "$name.zip") -UseBasicParsing
    Invoke-WebRequest -Uri "$base/SHASUMS256.txt" -OutFile (Join-Path $work 'SHASUMS256.txt') -UseBasicParsing
    $want = $null
    foreach ($l in Get-Content (Join-Path $work 'SHASUMS256.txt')) { $f = $l -split '\s+'; if ($f.Length -ge 2 -and $f[1] -eq "$name.zip") { $want = $f[0] } }
    if (-not $want) { Die "no checksum for $name.zip in SHASUMS256.txt" }
    $got = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $work "$name.zip")).Hash.ToLower()
    if ($want.ToLower() -ne $got) { Die "checksum mismatch for $name.zip (expected $want, got $got)" }
    Say 'node: checksum verified'
    Expand-Archive -LiteralPath (Join-Path $work "$name.zip") -DestinationPath $work
    MkdirRec $Opt
    Move-Item -LiteralPath (Join-Path $work $name) -Destination $NodeDir
    Record 'rm' $NodeDir
    Say "node: installed $NodeDir"
  } finally { Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue }
}

function StepPi {
  $pkg = Join-Path $TC 'pi\node_modules\@earendil-works\pi-coding-agent\package.json'
  $cur = ''
  if (Test-Path -LiteralPath $pkg) { $cur = (Get-Content -LiteralPath $pkg -Raw | ConvertFrom-Json).version }
  if ($cur -eq $PiVersion -and (Test-Path -LiteralPath $PiCli)) { Say "pi: $PiVersion already installed, nothing to do" }
  else {
    Say "pi: npm install @earendil-works/pi-coding-agent@$PiVersion"
    New-Item -ItemType Directory -Force -Path (Join-Path $TC 'pi') | Out-Null
    $nodeExe = Join-Path $NodeDir 'node.exe'
    $npmCli = Join-Path $NodeDir 'node_modules\npm\bin\npm-cli.js'
    $log = Join-Path $TC 'npm.log'
    $env:PATH = "$NodeDir;$env:PATH"
    $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & $nodeExe $npmCli install --prefix (Join-Path $TC 'pi') "@earendil-works/pi-coding-agent@$PiVersion" --no-fund --no-audit --ignore-scripts *> $log
    $code = $LASTEXITCODE
    $ErrorActionPreference = $old
    if ($code -ne 0) { Get-Content $log -Tail 20 | Write-Host; Die "npm install of pi failed (log: $log)" }
    Remove-Item -LiteralPath $log -Force
    if (-not (Test-Path -LiteralPath $PiCli)) { Die "pi installed but $PiCli is missing" }
  }

  $want = "@echo off`r`n$MarkWrapper`r`nset `"PATH=$NodeDir;%PATH%`"`r`n`"$(Join-Path $NodeDir 'node.exe')`" `"$PiCli`" %*`r`n"
  if (Test-Path -LiteralPath $Wrapper) {
    $have = Get-Content -LiteralPath $Wrapper -Raw
    if ($have -match [regex]::Escape($MarkWrapper)) {
      if ($have -ceq $want) { Say "wrapper: $Wrapper up to date, nothing to do"; return }
    } elseif (-not $Force) { Die "$Wrapper exists and is not a tinyCode wrapper; re-run with -Force to replace it" }
    Remove-Item -LiteralPath $Wrapper -Force
  }
  MkdirRec $Bin
  [IO.File]::WriteAllText($Wrapper, $want, (New-Object System.Text.ASCIIEncoding))
  Record 'rm' $Wrapper
  Say "wrapper: wrote $Wrapper"
}

function SameTree([string]$a, [string]$b) {
  if (-not (Test-Path -LiteralPath $b)) { return $false }
  $fa = @(Get-ChildItem -LiteralPath $a -Recurse -File | ForEach-Object { $_.FullName.Substring($a.Length) })
  $fb = @(Get-ChildItem -LiteralPath $b -Recurse -File | ForEach-Object { $_.FullName.Substring($b.Length) })
  if (Compare-Object $fa $fb) { return $false }
  foreach ($f in $fa) { if ((Get-FileHash -LiteralPath ($a + $f)).Hash -ne (Get-FileHash -LiteralPath ($b + $f)).Hash) { return $false } }
  return $true
}

function StepExtension {
  $ver = (Get-Content -LiteralPath (Join-Path $Here 'package.json') -Raw | ConvertFrom-Json).version
  if (-not $ver) { Die "cannot read the version from $Here\package.json" }
  $dest = Join-Path $TC "ext\$ver"
  $same = (SameTree (Join-Path $Here 'extensions') (Join-Path $dest 'extensions')) -and (SameTree (Join-Path $Here 'src') (Join-Path $dest 'src')) `
    -and (Test-Path -LiteralPath (Join-Path $dest 'package.json')) `
    -and ((Get-FileHash (Join-Path $Here 'package.json')).Hash -eq (Get-FileHash (Join-Path $dest 'package.json')).Hash)
  if ($same) { Say "extension: $ver already installed, nothing to do" }
  else {
    if (Test-Path -LiteralPath $dest) { Remove-Item -LiteralPath $dest -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $dest | Out-Null
    Copy-Item -LiteralPath (Join-Path $Here 'package.json') -Destination $dest
    Copy-Item -LiteralPath (Join-Path $Here 'extensions') -Destination $dest -Recurse
    Copy-Item -LiteralPath (Join-Path $Here 'src') -Destination $dest -Recurse
    Get-ChildItem -LiteralPath $dest -Recurse -Directory -Filter '__pycache__' | Remove-Item -Recurse -Force
    Get-ChildItem -LiteralPath (Join-Path $TC 'ext') -Directory | Where-Object { $_.FullName -ne $dest } | Remove-Item -Recurse -Force
    Say "extension: installed $dest"
  }
  $item = Get-Item -LiteralPath $ExtLink -ErrorAction SilentlyContinue
  if ($item -and $item.LinkType -and ($item.Target -contains $dest -or $item.Target -eq $dest)) {
    Say "extension link: $ExtLink up to date, nothing to do"
  } else {
    if ($item) {
      if ($item.LinkType) { $item.Delete() }
      elseif ($Force) { Remove-Item -LiteralPath $ExtLink -Recurse -Force }
      else { Die "$ExtLink exists and is not a link; re-run with -Force to replace it" }
    }
    MkdirRec (Split-Path -Parent $ExtLink)
    New-Item -ItemType Junction -Path $ExtLink -Target $dest | Out-Null   # a junction needs no admin rights
    Record 'rm' $ExtLink
    Say "extension link: $ExtLink -> $dest"
  }
}

function StepConfig {
  if ((Test-Path -LiteralPath $Cfg) -and -not $Force) { Say "config: $Cfg exists, kept (use -Force to rewrite), nothing to do"; return }
  $existed = Test-Path -LiteralPath $Cfg
  $trunk = [ordered]@{ baseUrl = $Endpoint; model = $TrunkModel; contextWindow = $TrunkContext }
  $small = [ordered]@{ baseUrl = $Endpoint; model = $SmallModel; contextWindow = $SmallContext }
  if ($ApiKeyEnv) { $trunk['apiKeyEnv'] = $ApiKeyEnv; $small['apiKeyEnv'] = $ApiKeyEnv }
  # Windows has `python`/`py`, not `python3`: /fix runs the project's tests with test.python
  $json = ([ordered]@{ lanes = [ordered]@{ trunk = $trunk; small = $small }; test = [ordered]@{ python = 'python' } } | ConvertTo-Json -Depth 5)
  MkdirRec (Split-Path -Parent $Cfg)
  [IO.File]::WriteAllText($Cfg, $json + "`n", $Utf8)
  if (-not $existed) { Record 'purge' $Cfg }
  Say "config: wrote $Cfg"
}

function StepPath {
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $has = $user -and (@($user -split ';' | Where-Object { $_.TrimEnd('\') -eq $Bin.TrimEnd('\') }).Count -gt 0)
  if ($has) { Say "path: $Bin already on the user PATH, nothing to do" }
  else {
    $new = if ($user) { "$user;$Bin" } else { $Bin }
    [Environment]::SetEnvironmentVariable('Path', $new, 'User')
    Say "path: added $Bin to the user PATH (open a new terminal)"
  }
  if (-not (@($env:PATH -split ';') -contains $Bin)) { $env:PATH = "$Bin;$env:PATH" }
}

function DoInstall {
  if (-not ((Test-Path -LiteralPath (Join-Path $Here 'package.json')) -and (Test-Path -LiteralPath (Join-Path $Here 'extensions')) -and (Test-Path -LiteralPath (Join-Path $Here 'src')))) {
    Die "run install.ps1 from a tinyCode checkout ($Here has no package.json/extensions/src)"
  }
  if (-not (Test-Path -LiteralPath $TC)) {
    $created = @()
    $d = $Opt
    while (-not (Test-Path -LiteralPath $d)) { $created = @($d) + $created; $d = Split-Path -Parent $d }
    New-Item -ItemType Directory -Force -Path $Opt | Out-Null
    New-Item -ItemType Directory -Path $TC | Out-Null
    $lines = @($created | ForEach-Object { "dir $_" }) + "rm $TC"
    [IO.File]::WriteAllText($Manifest, (($lines -join "`n") + "`n"), (New-Object System.Text.ASCIIEncoding))
  }
  StepNode
  StepPi
  StepExtension
  StepConfig
  StepPath
  Say '-- health check'
  if (Health) { Say 'install: done. Open a new terminal, then run: pi' } else { Say 'install: finished with failures above'; exit 1 }
}

if ($Uninstall) { DoUninstall }
elseif ($Check) {
  if (-not (Test-Path -LiteralPath $TC)) { Die "tinyCode is not installed under $TC" }
  if (-not (Health)) { exit 1 }
}
else { DoInstall }
