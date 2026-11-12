import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { MAX_CHECKS, runAcceptance, validateAcceptance, type AcceptCheck } from "../../src/acceptance.ts";
import { ConfigError, mergeConfig } from "../../src/config.ts";

const ROOT = join(import.meta.dirname, "..", "..");
const VENDOR = (process.env.TINYCODE_TEST_PYTHON ?? "python3");
const has = (p: string) => spawnSync(p, ["--version"], { stdio: "ignore" }).status === 0;
const PY = existsSync(VENDOR) ? VENDOR : has("python3") ? "python3" : has("python") ? "python" : null;
const noPy = PY ? false : "needs a Python interpreter";
const tmp = () => tmpDir("tc-accept-");
const run = (checks: AcceptCheck[], cwd = tmp(), extra: Record<string, unknown> = {}) => runAcceptance({ checks }, { cwd, python: PY ?? "python3", stepSeconds: 5, ...extra });
const py = (code: string, more: Record<string, unknown> = {}) => ({ argv: ["{python}", "-c", code], ...more });

const goodSet = (): unknown => ({
  checks: [
    { name: "file flag", steps: [{ argv: ["{python}", "-m", "habits", "--file", "f.json", "add", "run"], env: { HABITS_FILE: "e.json" }, exit: 0, stdout: "added run", files: { "f.json": "run" }, absent: ["e.json"] }] },
    { name: "reads input", writeFiles: { "in.csv": "a,b\n1,2\n" }, steps: [{ argv: ["{python}", "-m", "csv2json", "in.csv"], exit: 0, stdoutHas: ['"a": "1"'] }] },
  ],
});

test("validateAcceptance: a good set; bad checks are dropped one by one with a reason", () => {
  const ok = validateAcceptance(goodSet());
  assert.equal(ok.checks.length, 2);
  assert.deepEqual(ok.errors, []);
  const bad = (step: Record<string, unknown>, extra: Record<string, unknown> = {}) => validateAcceptance({ checks: [{ name: "x", steps: [{ argv: ["{python}", "-m", "p"], ...step }], ...extra }, (goodSet() as { checks: unknown[] }).checks[0]] });
  const r1 = bad({ argv: ["python3", "-m", "p"] });
  assert.equal(r1.checks.length, 1);
  assert.match(r1.errors[0]!, /argv\[0\] must be \{python\}/);
  assert.match(bad({ argv: ["{python}", "-c", "x".repeat(601)] }).errors[0]!, /over 600/);
  assert.equal(bad({ argv: ["{python}", "-c", "x".repeat(600)] }).checks.length, 2, "600 is allowed");
  assert.match(bad({ argv: ["{python}", "-m", "y".repeat(401)] }).errors[0]!, /over 400/);
  for (const p of ["../x", "/etc/passwd", "C:\\x", "a/../../x", "\\\\server\\x"]) {
    assert.equal(bad({ files: { [p]: "" } }).checks.length, 1, `files ${p}`);
    assert.equal(bad({ absent: [p] }).checks.length, 1, `absent ${p}`);
    assert.equal(bad({}, { writeFiles: { [p]: "x" } }).checks.length, 1, `writeFiles ${p}`);
  }
  assert.match(bad({ env: { "bad-name": "1" } }).errors[0]!, /env name/);
  assert.match(bad({ env: { lower: "1" } }).errors[0]!, /env name/);
  assert.match(bad({ exit: 1.5 }).errors[0]!, /exit/);
  assert.match(bad({}, { writeFiles: { a: "1", b: "2", c: "3", d: "4", e: "5" } }).errors[0]!, /more than 4/);
  const nine = validateAcceptance({ checks: Array.from({ length: 9 }, (_, i) => ({ name: `c${i}`, steps: [{ argv: ["{python}", "-c", "print(1)"], stdout: "1" }] })) });
  assert.equal(nine.checks.length, MAX_CHECKS);
  assert.match(nine.errors[0]!, /check 9: more than 8/);
  assert.deepEqual(validateAcceptance({ checks: [] }).checks, []);
  assert.deepEqual(validateAcceptance(null).checks, []);
  assert.deepEqual(validateAcceptance({ checks: [{ name: "x", steps: [] }] }).checks, []);
});

test("runAcceptance: exit, exact stdout (\\r\\n and trailing spaces on either side), stdoutHas, stderrHas, files, absent", { skip: noPy }, async () => {
  const r = await run([
    { name: "exit", steps: [py("import sys; sys.exit(3)", { exit: 0 })] },
    { name: "crlf", steps: [py("import sys; sys.stdout.write('a  \\r\\nb\\r\\n\\r\\n')", { stdout: "a\nb   \n" })] },
    { name: "differs", steps: [py("print('run  2')", { stdout: "run  1" })] },
    { name: "has", steps: [py("import sys; print('xx ok yy'); print('bad', file=sys.stderr)", { stdoutHas: ["ok"], stderrHas: ["bad"] })] },
    { name: "lacks", steps: [py("print('nope')", { stdoutHas: ["ok"] })] },
    { name: "files", steps: [py("open('f.json','w').write('run')", { files: { "f.json": "run", "g.json": "" } })] },
    { name: "absent", steps: [py("open('e.json','w').write('1')", { absent: ["e.json"] })] },
  ]);
  assert.equal(r.total, 7);
  assert.equal(r.passed, 2, JSON.stringify(r.failed));
  const why = Object.fromEntries(r.failed.map((f) => [f.name, f.why]));
  assert.equal(why.exit, "exit 3, expected 0");
  assert.equal(why.differs, 'stdout differs: expected "run  1", got "run  2"');
  assert.match(why.lacks!, /^stdout lacks "ok", got "nope"/);
  assert.equal(why.files, "g.json missing");
  assert.equal(why.absent, "e.json exists");
  assert.equal(r.ok, false);
  assert.ok(r.failed.every((f) => f.command.startsWith("python -c")));
});

test("runAcceptance: writeFiles before step 1; steps share a folder, checks do not; folder removed; PYTHONPATH; env; setup steps", { skip: noPy }, async () => {
  const cwd = tmp();
  mkdirSync(join(cwd, "pkg"));
  writeFileSync(join(cwd, "pkg", "__init__.py"), "X = 41\n");
  const r = await run([
    { name: "input", writeFiles: { "in/a.txt": "hello" }, steps: [py("print(open('in/a.txt').read())", { stdout: "hello" })] },
    { name: "shared", steps: [py("open('s.txt','w').write('1')"), py("import os; print(os.path.exists('s.txt'))", { stdout: "True" })] },
    { name: "isolated", steps: [py("import os; print(os.path.exists('s.txt') or os.path.exists('in'))", { stdout: "False" })] },
    { name: "path", steps: [py("import pkg; print(pkg.X + 1)", { stdout: "42" })] },
    { name: "env", steps: [py("import os; print(os.environ['HABITS_FILE'], os.environ['NO_COLOR'], os.environ['FORCE_COLOR'])", { env: { HABITS_FILE: "e.json" }, stdout: "e.json 1 0" })] },
    { name: "stdin", steps: [py("import sys; print(sys.stdin.read().upper())", { stdin: "abc", stdout: "ABC" })] },
  ], cwd);
  assert.equal(r.passed, 6, JSON.stringify(r.failed));
  assert.equal(r.ok, true);
  assert.equal(existsSync(join(cwd, ".tinycode", "acceptance-run")), false, "run folder removed");
});

test("runAcceptance: no stdin = end-of-file at once; timeout; a grandchild holding the pipe still finishes within 2 s", { skip: noPy }, async () => {
  const t0 = Date.now();
  const r = await run([
    { name: "eof", steps: [py("import sys; print(repr(sys.stdin.read()))", { stdout: "''" })] },
    { name: "slow", steps: [py("import time; time.sleep(30)", { exit: 0 })] },
    // the child exits at once; its grandchild (own session) keeps stdout open for 30 s
    { name: "escaped", steps: [py("import subprocess, sys; subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], start_new_session=True); print('done')", { stdout: "done" })] },
  ], tmp(), { stepSeconds: 1 });
  const why = Object.fromEntries(r.failed.map((f) => [f.name, f.why]));
  assert.equal(why.slow, "timed out after 1s");
  assert.equal(why.eof, undefined, JSON.stringify(r.failed));
  assert.equal(why.escaped, undefined, JSON.stringify(r.failed));
  assert.ok(Date.now() - t0 < 12_000, `took ${Date.now() - t0} ms`);
});

test("runAcceptance: a missing interpreter is unavailable, not a failure; output over 8 KB; the total limit", async () => {
  const gone = await runAcceptance({ checks: [{ name: "x", steps: [py("print(1)", { stdout: "1" })] }] }, { cwd: tmp(), python: join(tmp(), "no-such-python") });
  assert.equal(gone.ok, false);
  assert.deepEqual(gone.failed, []);
  assert.match(gone.unavailable!, /not found \(set test\.python\)/);
  if (!PY) return;
  const big = await run([{ name: "big", steps: [py("print('x' * 20000)", { stdout: "x".repeat(20000) })] }]);
  assert.equal(big.failed[0]?.why, "output over 8 KB");
  const lim = await run([
    { name: "first", steps: [py("import time; time.sleep(0.3)")] },
    { name: "second", steps: [py("print(1)", { stdout: "1" })] },
  ], tmp(), { totalMs: 100 });
  assert.equal(lim.passed, 1);
  assert.match(lim.failed[0]!.why, /^not run/);
});



test("config: the removed acceptance block (E17, denied 2026-11-12) is refused with a clear message", () => {
  for (const block of [{ enabled: true }, { enabled: false }, { maxNudges: 2 }, {}])
    assert.throws(() => mergeConfig({ acceptance: block }), (e: unknown) => e instanceof ConfigError && /^acceptance: removed on 2026-11-12/.test(e.message), JSON.stringify(block));
  assert.equal("acceptance" in mergeConfig({}), false);
});
