#!/bin/sh
# tinyCode installer for Linux (x64, arm64) and macOS (arm64, x64). POSIX sh, no admin, idempotent, reversible.
#
#   sh install.sh [--endpoint URL] [--trunk-model M] [--small-model M] [--trunk-context N] [--small-context N]
#                 [--api-key-env VAR] [--force] [--check] [--uninstall [--purge]]
#
# What it does (mirrors install.ps1):
#   1. private Node 22 under ~/.local/opt (checksum verified), never the system Node
#   2. Pi 1.4.0 from npm into ~/.local/opt/tinycode/pi, wrapper ~/.local/bin/pi
#   3. the tinyCode extension copied to ~/.local/opt/tinycode/ext/<version>, linked into Pi's extensions folder
#   4. ~/.config/tinycode/config.json from the flags (only if absent, or with --force)
#   5. ~/.local/bin on PATH (marked block in ~/.zprofile on macOS, ~/.profile on Linux)
#   6. a manifest of everything created, and a health check
set -eu

NODE_VERSION="22.23.4"
PI_VERSION="1.4.0"
MARK_WRAPPER="# tinycode-wrapper"
MARK_BEGIN="# >>> tinycode >>>"
MARK_END="# <<< tinycode <<<"

ENDPOINT="http://127.0.0.1:8080/v1"
TRUNK_MODEL="tinycode-model"
SMALL_MODEL="tinycode-model"
TRUNK_CTX="32768"
SMALL_CTX="32768"
API_KEY_ENV=""
FORCE=0
MODE="install"
PURGE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --endpoint) ENDPOINT="${2:?--endpoint needs a URL}"; shift 2 ;;
    --trunk-model) TRUNK_MODEL="${2:?--trunk-model needs a name}"; shift 2 ;;
    --small-model) SMALL_MODEL="${2:?--small-model needs a name}"; shift 2 ;;
    --trunk-context) TRUNK_CTX="${2:?--trunk-context needs a number}"; shift 2 ;;
    --small-context) SMALL_CTX="${2:?--small-context needs a number}"; shift 2 ;;
    --api-key-env) API_KEY_ENV="${2:?--api-key-env needs a variable name}"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --check) MODE="check"; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown option: $1" >&2; exit 2 ;;
  esac
done

HERE=$(cd "$(dirname "$0")" && pwd)
OPT="$HOME/.local/opt"
TC="$OPT/tinycode"
NODE_DIR="$OPT/node-v$NODE_VERSION"
BIN="$HOME/.local/bin"
WRAPPER="$BIN/pi"
AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
EXT_LINK="$AGENT_DIR/extensions/tinycode"
CFG_DIR="$HOME/.config/tinycode"
CFG="${TINYCODE_CONFIG:-$CFG_DIR/config.json}"
STATE_DIR="$HOME/.local/state/tinycode"
MANIFEST="$TC/manifest.txt"
PI_CLI="$TC/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js"
UNAME_S=$(uname -s)

say() { printf '%s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

case "$UNAME_S" in
  Darwin) PROFILE="$HOME/.zprofile" ;;
  *) PROFILE="$HOME/.profile" ;;
esac

# ---- manifest -------------------------------------------------------------------------------------------------
# Lines: "rm <path>" (removed with everything under it), "dir <path>" (removed only if empty),
# "purge <path>" (removed only with --purge). Appended only when something is created, so a re-run changes nothing.
record() { # kind path
  [ -d "$TC" ] || return 0
  if ! grep -qxF "$1 $2" "$MANIFEST" 2>/dev/null; then printf '%s %s\n' "$1" "$2" >>"$MANIFEST"; fi
}
mkdir_rec() { # make a directory (and parents), recording each one we created, outermost first
  [ -d "$1" ] && return 0
  mkdir_rec "$(dirname "$1")"
  mkdir "$1"
  record dir "$1"
}

# ---- uninstall ------------------------------------------------------------------------------------------------
do_uninstall() {
  if [ ! -f "$MANIFEST" ]; then say "uninstall: no manifest at $MANIFEST, nothing to do"; return 0; fi
  tmp=$(mktemp)
  cp "$MANIFEST" "$tmp"
  # the wrapper only if it is ours
  if [ -f "$WRAPPER" ] && grep -qF "$MARK_WRAPPER" "$WRAPPER"; then rm -f "$WRAPPER"; say "removed $WRAPPER"; fi
  # the PATH block
  if [ -f "$PROFILE" ] && grep -qF "$MARK_BEGIN" "$PROFILE"; then
    p2=$(mktemp)
    awk -v b="$MARK_BEGIN" -v e="$MARK_END" '$0==b{skip=1;next} $0==e{skip=0;next} !skip{print}' "$PROFILE" >"$p2"
    cat "$p2" >"$PROFILE"; rm -f "$p2"
    grep -q '[^[:space:]]' "$PROFILE" || rm -f "$PROFILE"
    say "removed the PATH block from $PROFILE"
  fi
  # symlink first, then recorded trees
  if [ -L "$EXT_LINK" ]; then rm -f "$EXT_LINK"; say "removed $EXT_LINK"; fi
  while IFS= read -r line; do
    kind=${line%% *}; path=${line#* }
    case "$kind" in
      rm) if [ -e "$path" ] || [ -L "$path" ]; then rm -rf "$path"; say "removed $path"; fi ;;
      purge) if [ "$PURGE" = 1 ] && { [ -e "$path" ] || [ -L "$path" ]; }; then rm -rf "$path"; say "removed $path"; fi ;;
    esac
  done <"$tmp"
  # directories we created, innermost first
  awk '$1=="dir"{sub(/^dir /,""); print}' "$tmp" | sort -r | while IFS= read -r d; do
    rmdir "$d" 2>/dev/null && say "removed (empty) $d" || true
  done
  rm -f "$tmp"
  if [ "$PURGE" = 1 ] && [ -d "$STATE_DIR" ]; then rm -rf "$STATE_DIR"; say "removed $STATE_DIR"; fi
  if [ "$PURGE" = 0 ] && [ -f "$CFG" ]; then say "kept $CFG (use --purge to remove config and logs)"; fi
  say "uninstall: done"
}

# ---- health check ---------------------------------------------------------------------------------------------
FAILS=0
ok() { say "ok   $*"; }
fail() { say "FAIL $*"; FAILS=$((FAILS + 1)); }

cfg_get() { # print one value from the config via the private node: lane field
  "$TC/node/bin/node" -e '
    const fs = require("fs");
    const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const l = (c.lanes || {})[process.argv[2]];
    process.stdout.write(l ? String(l[process.argv[3]] || "") : "");
  ' "$CFG" "$1" "$2" 2>/dev/null || true
}

http_code() { # curl args...: prints the HTTP status (000 when the connection fails), one retry
  _c=$(curl -sS -o "$HC_BODY" -w '%{http_code}' --max-time 90 "$@" 2>/dev/null || true)
  case "$_c" in 200) ;; *) sleep 2; _c=$(curl -sS -o "$HC_BODY" -w '%{http_code}' --max-time 90 "$@" 2>/dev/null || true) ;; esac
  printf '%s' "${_c:-000}"
}

health() {
  FAILS=0
  HC_BODY=$(mktemp)
  [ -x "$WRAPPER" ] || { fail "pi wrapper missing at $WRAPPER (run the installer)"; rm -f "$HC_BODY"; return 1; }
  [ -f "$CFG" ] || { fail "config missing at $CFG"; rm -f "$HC_BODY"; return 1; }

  v=$("$WRAPPER" --version 2>&1 </dev/null | tail -1 || true)
  if [ "$v" = "$PI_VERSION" ]; then ok "pi --version = $v"; else fail "pi --version: expected $PI_VERSION, got '$v'"; fi

  lanes=""
  for ln in trunk small; do
    m=$(cfg_get $ln model)
    [ -n "$m" ] && lanes="$lanes $ln"
  done
  models=$(PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 "$WRAPPER" --list-models 2>&1 </dev/null || true)
  for ln in $lanes; do
    m=$(cfg_get $ln model); key=$(cfg_get $ln apiKeyEnv)
    if [ -n "$key" ]; then ok "pi --list-models: $ln lane uses a key ($key), not a tinycode/* provider model (skipped)"
    elif printf '%s\n' "$models" | grep -qF "$m"; then ok "pi --list-models shows tinycode/$m"
    else fail "pi --list-models does not show $m"; fi
  done

  for ln in $lanes; do
    m=$(cfg_get $ln model); base=$(cfg_get $ln baseUrl); key=$(cfg_get $ln apiKeyEnv)
    auth=""
    if [ -n "$key" ]; then
      eval "kv=\${$key:-}"
      [ -n "$kv" ] && auth="Authorization: Bearer $kv"
    fi
    if [ -n "$auth" ]; then code=$(http_code -H "$auth" "$base/models"); else code=$(http_code "$base/models"); fi
    listed=0
    if [ "$code" = "200" ]; then
      grep -qF "\"$m\"" "$HC_BODY" && listed=1
    else fail "GET $base/models returned HTTP $code"; continue
    fi
    payload="{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}],\"max_tokens\":1}"
    if [ -n "$auth" ]; then
      code=$(http_code -H "$auth" -H 'Content-Type: application/json' -d "$payload" "$base/chat/completions")
    else
      code=$(http_code -H 'Content-Type: application/json' -d "$payload" "$base/chat/completions")
    fi
    if [ "$listed" = 1 ]; then ok "GET $base/models lists $m"
    elif [ "$code" = "200" ]; then ok "GET $base/models does not list $m, but it answers a chat call (multi-lane servers list one lane)"
    else fail "GET $base/models does not list $m"; fi
    if [ "$code" = "200" ]; then ok "chat call to $ln lane ($m), max_tokens 1"; else fail "chat call to $ln lane ($m) returned HTTP $code"; fi
  done

  out=$(PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 "$WRAPPER" -p "/tinycode" 2>&1 </dev/null || true)
  if printf '%s\n' "$out" | grep -qF "tinyCode config"; then ok 'pi -p "/tinycode" shows the config'
  else fail "pi -p \"/tinycode\" did not show the config: $(printf '%s' "$out" | head -c 200)"; fi

  if command -v osascript >/dev/null 2>&1; then ok ".scpt routine: available (osascript found)"
  else ok ".scpt routine: not available here (macOS only; .py routine unaffected)"; fi
  rm -f "$HC_BODY"
  [ "$FAILS" = 0 ]
}

# ---- install steps --------------------------------------------------------------------------------------------
download() { # url dest
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
  else die "need curl or wget"; fi
}
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else die "need sha256sum or shasum"; fi
}

step_node() {
  if [ -x "$NODE_DIR/bin/node" ] && [ "$("$NODE_DIR/bin/node" -v)" = "v$NODE_VERSION" ]; then
    say "node: v$NODE_VERSION already at $NODE_DIR, nothing to do"
  else
    case "$UNAME_S-$(uname -m)" in
      Darwin-arm64) plat="darwin-arm64"; ext="tar.gz"; tflag="-xzf" ;;
      Darwin-x86_64) plat="darwin-x64"; ext="tar.gz"; tflag="-xzf" ;;
      Linux-x86_64) plat="linux-x64"; ext="tar.xz"; tflag="-xJf" ;;
      Linux-aarch64|Linux-arm64) plat="linux-arm64"; ext="tar.xz"; tflag="-xJf" ;;
      *) die "unsupported platform $UNAME_S-$(uname -m)" ;;
    esac
    name="node-v$NODE_VERSION-$plat"
    base="https://nodejs.org/dist/v$NODE_VERSION"
    work=$(mktemp -d)
    say "node: downloading $name.$ext"
    download "$base/$name.$ext" "$work/$name.$ext"
    download "$base/SHASUMS256.txt" "$work/SHASUMS256.txt"
    want=$(awk -v f="$name.$ext" '$2==f{print $1}' "$work/SHASUMS256.txt")
    [ -n "$want" ] || die "no checksum for $name.$ext in SHASUMS256.txt"
    got=$(sha256_of "$work/$name.$ext")
    [ "$want" = "$got" ] || die "checksum mismatch for $name.$ext (expected $want, got $got)"
    say "node: checksum verified"
    (cd "$work" && tar "$tflag" "$name.$ext")
    mkdir_rec "$OPT"
    mv "$work/$name" "$NODE_DIR"
    record rm "$NODE_DIR"
    rm -rf "$work"
    say "node: installed $NODE_DIR"
  fi
  if [ "$(readlink "$TC/node" 2>/dev/null || true)" = "$NODE_DIR" ]; then
    :
  else
    rm -f "$TC/node"; ln -s "$NODE_DIR" "$TC/node"
  fi
}

step_pi() {
  cur=""
  if [ -f "$TC/pi/node_modules/@earendil-works/pi-coding-agent/package.json" ]; then
    cur=$("$TC/node/bin/node" -p 'require(process.argv[1]).version' "$TC/pi/node_modules/@earendil-works/pi-coding-agent/package.json" 2>/dev/null || true)
  fi
  if [ "$cur" = "$PI_VERSION" ] && [ -f "$PI_CLI" ]; then
    say "pi: $PI_VERSION already installed, nothing to do"
  else
    say "pi: npm install @earendil-works/pi-coding-agent@$PI_VERSION"
    mkdir -p "$TC/pi"
    PATH="$TC/node/bin:$PATH" "$TC/node/bin/node" "$TC/node/lib/node_modules/npm/bin/npm-cli.js" install --prefix "$TC/pi" \
      "@earendil-works/pi-coding-agent@$PI_VERSION" --no-fund --no-audit --ignore-scripts >"$TC/npm.log" 2>&1 \
      || { tail -20 "$TC/npm.log" >&2; die "npm install of pi failed (log: $TC/npm.log)"; }
    rm -f "$TC/npm.log"
    [ -f "$PI_CLI" ] || die "pi installed but $PI_CLI is missing"
  fi

  want=$(printf '#!/bin/sh\n%s\nPATH="%s/node/bin:$PATH"\nexport PATH\nexec "%s/node/bin/node" "%s" "$@"\n' "$MARK_WRAPPER" "$TC" "$TC" "$PI_CLI")
  if [ -e "$WRAPPER" ] || [ -L "$WRAPPER" ]; then
    if grep -qF "$MARK_WRAPPER" "$WRAPPER" 2>/dev/null; then
      if [ "$(cat "$WRAPPER")" = "$want" ]; then say "wrapper: $WRAPPER up to date, nothing to do"; return 0; fi
    elif [ "$FORCE" = 0 ]; then
      die "$WRAPPER exists and is not a tinyCode wrapper; re-run with --force to replace it"
    fi
    rm -f "$WRAPPER"
  fi
  mkdir_rec "$BIN"
  printf '%s\n' "$want" >"$WRAPPER"
  chmod 755 "$WRAPPER"
  record rm "$WRAPPER"
  say "wrapper: wrote $WRAPPER"
}

step_extension() {
  ver=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$HERE/package.json" | head -1)
  [ -n "$ver" ] || die "cannot read the version from $HERE/package.json"
  dest="$TC/ext/$ver"
  same=0
  if [ -d "$dest" ] && diff -r "$HERE/extensions" "$dest/extensions" >/dev/null 2>&1 \
    && diff -r "$HERE/src" "$dest/src" >/dev/null 2>&1 && diff "$HERE/package.json" "$dest/package.json" >/dev/null 2>&1; then same=1; fi
  if [ "$same" = 1 ]; then
    say "extension: $ver already installed, nothing to do"
  else
    rm -rf "$dest"
    mkdir -p "$dest"
    cp "$HERE/package.json" "$dest/package.json"
    cp -R "$HERE/extensions" "$dest/extensions"
    cp -R "$HERE/src" "$dest/src"
    find "$dest" -name __pycache__ -prune -exec rm -rf {} + 2>/dev/null || true
    for old in "$TC"/ext/*; do [ "$old" = "$dest" ] || rm -rf "$old"; done
    say "extension: installed $dest"
  fi
  if [ "$(readlink "$EXT_LINK" 2>/dev/null || true)" = "$dest" ]; then
    say "extension link: $EXT_LINK up to date, nothing to do"
  else
    if [ -e "$EXT_LINK" ] && [ ! -L "$EXT_LINK" ]; then
      [ "$FORCE" = 1 ] || die "$EXT_LINK exists and is not a link; re-run with --force to replace it"
      rm -rf "$EXT_LINK"
    fi
    mkdir_rec "$(dirname "$EXT_LINK")"
    rm -f "$EXT_LINK"
    ln -s "$dest" "$EXT_LINK"
    record rm "$EXT_LINK"
    say "extension link: $EXT_LINK -> $dest"
  fi
}

json_ok() { case "$1" in *'"'*|*'\'*) return 1 ;; esac; }

step_config() {
  if [ -f "$CFG" ] && [ "$FORCE" = 0 ]; then say "config: $CFG exists, kept (use --force to rewrite), nothing to do"; return 0; fi
  for v in "$ENDPOINT" "$TRUNK_MODEL" "$SMALL_MODEL" "$API_KEY_ENV"; do json_ok "$v" || die "quotes and backslashes are not allowed in flag values"; done
  case "$TRUNK_CTX$SMALL_CTX" in *[!0-9]*|"") die "--trunk-context and --small-context must be numbers" ;; esac
  mkdir_rec "$(dirname "$CFG")"
  keyline=""
  [ -n "$API_KEY_ENV" ] && keyline=", \"apiKeyEnv\": \"$API_KEY_ENV\""
  existed=0; [ -f "$CFG" ] && existed=1
  cat >"$CFG" <<EOF
{
  "lanes": {
    "trunk": { "baseUrl": "$ENDPOINT", "model": "$TRUNK_MODEL", "contextWindow": $TRUNK_CTX$keyline },
    "small": { "baseUrl": "$ENDPOINT", "model": "$SMALL_MODEL", "contextWindow": $SMALL_CTX$keyline }
  }
}
EOF
  [ "$existed" = 1 ] || record purge "$CFG"
  say "config: wrote $CFG"
}

step_path() {
  case ":$PATH:" in *":$BIN:"*) say "path: $BIN already on PATH, nothing to do"; return 0 ;; esac
  if [ -f "$PROFILE" ] && grep -qF "$MARK_BEGIN" "$PROFILE"; then say "path: block already in $PROFILE, nothing to do"; return 0; fi
  existed=1; [ -f "$PROFILE" ] || existed=0
  # the block is removed by --uninstall; nothing in the manifest, so a file we created is deleted when it ends up empty
  printf '\n%s\nexport PATH="$HOME/.local/bin:$PATH"\n%s\n' "$MARK_BEGIN" "$MARK_END" >>"$PROFILE"
  say "path: added $BIN to PATH in $PROFILE (open a new shell)"
  [ "$existed" = 1 ] || say "path: created $PROFILE"
}

do_install() {
  command -v tar >/dev/null 2>&1 || die "need tar"
  [ -f "$HERE/package.json" ] && [ -d "$HERE/extensions" ] && [ -d "$HERE/src" ] || die "run install.sh from a tinyCode checkout ($HERE has no package.json/extensions/src)"
  if [ ! -d "$TC" ]; then
    created=""
    d="$OPT"
    while [ ! -d "$d" ]; do created="$d $created"; d=$(dirname "$d"); done
    mkdir -p "$OPT"
    mkdir "$TC"
    : >"$MANIFEST"
    for d in $created; do printf 'dir %s\n' "$d" >>"$MANIFEST"; done
    printf 'rm %s\n' "$TC" >>"$MANIFEST"
  fi
  step_node
  step_pi
  step_extension
  step_config
  step_path
  say "-- health check"
  if health; then say "install: done. Open a new shell, then run: pi"; else say "install: finished with failures above"; return 1; fi
}

case "$MODE" in
  install) do_install ;;
  check) if [ ! -d "$TC" ]; then die "tinyCode is not installed under $TC"; fi; health ;;
  uninstall) do_uninstall ;;
esac
