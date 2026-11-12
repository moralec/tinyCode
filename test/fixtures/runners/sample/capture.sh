#!/bin/sh
# Record the runner fixtures: each sample in a temp copy with bench/pairs/js/node_modules, failing as written, then
# passing (mul fixed). Output: ../<runner>-<version>-<fail|pass>.txt. node:test twice: spec (default) and TAP.
set -e
HERE=$(cd "$(dirname "$0")" && pwd)
JS=$(cd "$HERE/../../../../bench/pairs/js" && pwd)
ver() { node -e "console.log(require('$JS/package-lock.json').packages['node_modules/$1'].version)"; }
NODEV=$(node -p 'process.versions.node.split(".")[0]')
run() { # dir name script-override
  T=$(mktemp -d); cp -r "$HERE/$1/." "$T/"; ln -s "$JS/node_modules" "$T/node_modules"
  [ -n "$3" ] && node -e "const p=require('$T/package.json');p.scripts.test='$3';require('fs').writeFileSync('$T/package.json',JSON.stringify(p))"
  (cd "$T" && NO_COLOR=1 FORCE_COLOR=0 npm test --silent > "$HERE/../$2-fail.txt" 2>&1 || true)
  sed -i 's/return a + b;\n}$//' "$T/math.js"; node -e "const f='$T/math.js';const fs=require('fs');fs.writeFileSync(f,fs.readFileSync(f,'utf8').replace(/(mul\(a, b\) \{\n  return a) \+ b/,'\$1 * b'))"
  (cd "$T" && NO_COLOR=1 FORCE_COLOR=0 npm test --silent > "$HERE/../$2-pass.txt" 2>&1 || true)
  sed -i "s#$T#<dir>#g" "$HERE/../$2-fail.txt" "$HERE/../$2-pass.txt"
  rm -rf "$T"
}
run jest "jest-$(ver jest)"
run vitest "vitest-$(ver vitest)"
run node "node-spec-$NODEV"
run node "node-tap-$NODEV" "node --test --test-reporter=tap"
