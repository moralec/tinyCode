import assert from "node:assert/strict";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { codeRoutine, KNOWN_EXTS, plainRoutine, pyRoutine, routineFor, run, runAskedTests, scptRoutine, RoutineError } from "../../src/routines/index.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const PY = (process.env.TINYCODE_TEST_PYTHON ?? "python3");
const tmp = () => tmpDir("tinycode-rt-");
const mac = scptRoutine.available();
const SKIP = mac.ok ? false : "skipped: needs macOS";

test("registry picks by extension; unknown types use the plain routine", () => {
  assert.equal(routineFor("a/b.py"), pyRoutine);
  assert.equal(routineFor("X.PY"), pyRoutine);
  assert.equal(routineFor("s.scpt"), scptRoutine);
  assert.equal(routineFor("notes.md"), plainRoutine);
  assert.equal(routineFor("Makefile"), plainRoutine);
});

test("py routine: load, save, py_compile check ok and failing", async () => {
  const d = tmp();
  const f = join(d, "m.py");
  writeFileSync(f, "def a():\n    return 1\n");
  const l = await pyRoutine.load(f);
  assert.equal(l.text, "def a():\n    return 1\n");
  assert.equal(l.viewPath, f);
  await pyRoutine.save(f, "def a():\n    return 2\n");
  assert.equal(readFileSync(f, "utf8"), "def a():\n    return 2\n");
  const ok = await pyRoutine.check(f, { cwd: d, python: PY });
  assert.equal(ok.ok, true);
  await pyRoutine.save(f, "def a(:\n    return 2\n");
  const bad = await pyRoutine.check(f, { cwd: d, python: PY });
  assert.equal(bad.ok, false);
  assert.match(bad.out, /SyntaxError|invalid syntax/);
  assert.equal(existsSync(join(d, "__pycache__")), false, "py_compile leaves no .pyc in the project");
});

test("py routine: configured test runs after the compile", async () => {
  const d = tmp();
  const f = join(d, "m.py");
  writeFileSync(f, "x = 1\n");
  const pass = await pyRoutine.check(f, { cwd: d, python: PY, test: { command: `"${PY}" -c "import sys; sys.exit(0)"` } });
  assert.equal(pass.ok, true);
  const fail = await pyRoutine.check(f, { cwd: d, python: PY, test: { command: `"${PY}" -c "import sys; sys.exit(1)"` } });
  assert.equal(fail.ok, false);
  assert.match(fail.out, /^FAIL/);
});

test("plain routine: round trip, check = none; CRLF kept", async () => {
  const d = tmp();
  const f = join(d, "n.md");
  writeFileSync(f, "a\r\nb\r\n");
  const l = await plainRoutine.load(f);
  assert.equal(l.text, "a\nb\n");
  await plainRoutine.save(f, "a\nc\n");
  assert.equal(readFileSync(f, "utf8"), "a\r\nc\r\n");
  assert.equal((await plainRoutine.check(f, { cwd: d, python: PY })).ok, true);
});

test("scpt routine: unavailable off macOS with the why text", { skip: mac.ok ? "runs only where it is unavailable" : false }, () => {
  assert.deepEqual(scptRoutine.available(), { ok: false, why: "AppleScript routine needs macOS" });
});

test("scpt routine on macOS: compile, load, scripted edit, recompile, decompile shows it; bad edit leaves original", { skip: SKIP }, async () => {
  const d = tmp();
  const src = join(d, "hello.applescript");
  copyFileSync(join(ROOT, "test/fixtures/scpt/hello.applescript"), src);
  const f = join(d, "hello.scpt");
  const c = await run("osacompile", ["-o", f, src]);
  assert.equal(c.code, 0, c.out);

  const l = await scptRoutine.load(f);
  assert.match(l.text, /Hello, /);
  assert.ok(existsSync(l.viewPath) && l.viewPath.endsWith(".applescript"));

  await scptRoutine.save(f, l.text.replace("Hello, ", "Howdy, "));
  const after = await run("osadecompile", [f]);
  assert.match(after.out, /Howdy, /);
  assert.doesNotMatch(after.out, /Hello, /);
  assert.ok(existsSync(f + ".bak"), "backup kept as <file>.scpt.bak");
  const bak = await run("osadecompile", [f + ".bak"]);
  assert.match(bak.out, /Hello, /);
  assert.equal((await scptRoutine.check(f, { cwd: d, python: PY })).ok, true);

  const before = readFileSync(f);
  await assert.rejects(scptRoutine.save(f, 'on greet(\n  return "x" &\nend'), RoutineError);
  assert.ok(readFileSync(f).equals(before), "original intact after a compile failure");
  const names = (await import("node:fs")).readdirSync(d);
  assert.deepEqual(names.filter((n) => n.startsWith(".tinycode-")), [], "no temp dirs left");
});

test("py check: a repository py_compile.py next to the file is never imported (-I; security audit 2026-11-09)", async () => {
  const d = tmpDir("tc-pyshadow-");
  const mark = join(d, "SHADOW_RAN");
  writeFileSync(join(d, "py_compile.py"), `open(${JSON.stringify(mark)}, "w").write("1")\n`);
  writeFileSync(join(d, "a.py"), "x = 1\n");
  const r = await pyRoutine.check(join(d, "a.py"), { cwd: d, python: PY });
  assert.equal(r.ok, true);
  assert.equal(existsSync(mark), false);
  assert.equal(existsSync(join(d, "__pycache__")), false, "the .pyc still goes outside the project");
});

test("code routine: JS/TS files only with \"ts\" in languages; .tsx stays plain; KNOWN_EXTS unchanged", async () => {
  assert.equal(routineFor("a.ts"), plainRoutine);
  assert.equal(routineFor("a.ts", ["py", "ts"]), codeRoutine);
  assert.equal(routineFor("a.mjs", ["py", "ts"]), codeRoutine);
  assert.equal(routineFor("a.tsx", ["py", "ts"]), plainRoutine);
  assert.equal(routineFor("a.py", ["py", "ts"]), pyRoutine);
  assert.ok(!KNOWN_EXTS.includes(".ts"));
  const d = tmpDir("code-routine-");
  writeFileSync(join(d, "ok.js"), "export const a = 1;\n");
  writeFileSync(join(d, "bad.js"), "export const = ;\n");
  writeFileSync(join(d, "a.ts"), "export const a: number = 1;\n");
  assert.deepEqual(await codeRoutine.check(join(d, "ok.js"), { cwd: d, python: "python3" }), { ok: true, out: "syntax ok" });
  assert.equal((await codeRoutine.check(join(d, "bad.js"), { cwd: d, python: "python3" })).ok, false);
  assert.match((await codeRoutine.check(join(d, "a.ts"), { cwd: d, python: "python3" })).out, /no check for \.ts/);
});

test("runAskedTests: null when no test was asked for; a configured command runs", async () => {
  const d = tmpDir("asked-");
  assert.equal(await runAskedTests({ cwd: d, python: "python3" }), null);
  const r = await runAskedTests({ cwd: d, python: "python3", test: { command: "echo '1 passed in 0.01s'" } });
  assert.equal(r?.ok, true);
});
