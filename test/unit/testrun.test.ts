import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { fileURLToPath } from "node:url";
import { bashTestSeconds, explainTimeout, isTestCommand, TestClock } from "../../src/testrun.ts";
import { checkFor, namesTargets, failingNames, failureBlocks, fill, firstErrorLine, NOT_RECOGNISED, NOT_TS, noScript, notInstalled, parseCounts, runTests, scriptRunner, shellQuote, testCommand, trimTestOutput, type Runner } from "../../src/testrun.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PY = (process.env.TINYCODE_TEST_PYTHON ?? "python3");
const R201 = join(ROOT, "test/fixtures/task-repos/r2-01-orders-monthly");

test("trimTestOutput: PASS line and FAIL block", () => {
  assert.deepEqual(trimTestOutput("..\n2 passed in 0.01s\n", 0), { ok: true, text: "PASS 2 passed in 0.01s" });
  const out = [
    "F", "=== FAILURES ===", "def test_x():", ">       assert f() == 1", "E       assert 2 == 1",
    "tests/test_a.py:4: AssertionError", "=== short test summary info ===",
    "FAILED tests/test_a.py::test_x - assert 2 == 1", "1 failed in 0.02s",
  ].join("\n");
  const r = trimTestOutput(out, 1);
  assert.equal(r.ok, false);
  assert.match(r.text, /^FAIL 1 failed in 0.02s\nFAILED tests\/test_a.py::test_x/);
  assert.match(r.text, /First error:\n/);
  assert.ok(trimTestOutput("x".repeat(9000) + "\nError: boom", 1).text.length <= 3200);
});

test("testCommand: config command wins; default is python -m pytest", () => {
  assert.equal(testCommand({ python: "python3", command: "npm test" }), "npm test");
  assert.equal(testCommand({ python: "python3", command: null }, "tests/t.py"), "python3 -m pytest -q -p no:cacheprovider tests/t.py");
  assert.match(testCommand({ python: "C:\\Program Files\\Py\\python.exe", command: null }), process.platform === "win32" ? /^"C:\\Program Files/ : /^'C:\\Program Files/);
});

test("shellQuote: POSIX single quotes keep $(), backticks and ; as text; Windows double quotes (security audit 2026-11-09)", () => {
  assert.equal(shellQuote("tests/test_a.py", false), "tests/test_a.py");
  assert.equal(shellQuote("t.py;id", false), "'t.py;id'");
  assert.equal(shellQuote("a$(id)`x`.py", false), "'a$(id)`x`.py'");
  assert.equal(shellQuote("it's.py", false), "'it'\\''s.py'");
  assert.equal(shellQuote("C:\\Program Files\\py.exe", true), '"C:\\Program Files\\py.exe"');
  assert.equal(testCommand({ python: "python3", command: null }, "t.py;touch x"), "python3 -m pytest -q -p no:cacheprovider 't.py;touch x'");
});

test("runTests on r2-01: FAIL naming tests/test_task.py", { skip: !existsSync(R201) || !existsSync(PY) }, async () => {
  const dir = join(tmpDir("tinycode-tr-"), "repo");
  cpSync(R201, dir, { recursive: true });
  const r = await runTests({ cwd: dir, config: { python: PY, command: null } });
  assert.equal(r.ok, false);
  assert.match(r.text, /^FAIL/);
  assert.match(r.text, /tests\/test_task\.py/);
});

test("runTests: shell command, exit code, and timeout", async () => {
  const dir = tmpDir("tinycode-tr-");
  writeFileSync(join(dir, "ok.js"), "console.log('1 passed in 0.01s')");
  const ok = await runTests({ cwd: dir, config: { python: "x", command: `"${process.execPath}" ok.js` } });
  assert.equal(ok.ok, true);
  assert.equal(ok.text, "PASS 1 passed in 0.01s");
  writeFileSync(join(dir, "slow.js"), "setTimeout(()=>{}, 60000)");
  const slow = await runTests({ cwd: dir, config: { python: "x", command: `"${process.execPath}" slow.js` }, timeoutMs: 400 });
  assert.equal(slow.timedOut, true);
  assert.match(slow.text, /^FAIL tests timed out/);
});

test("parseCounts: pytest, jest, unittest summaries; unknown output is null", async () => {
  const { parseCounts } = await import("../../src/testrun.ts");
  assert.deepEqual(parseCounts("..F\n4 failed, 6 passed in 0.52s\n"), { passed: 6, failed: 4 });
  assert.deepEqual(parseCounts("10 passed in 1.00s"), { passed: 10, failed: 0 });
  assert.deepEqual(parseCounts("1 failed, 2 passed, 1 error in 0.2s"), { passed: 2, failed: 2 });
  assert.deepEqual(parseCounts("FAIL 3 failed in 0.1s\n"), { passed: 0, failed: 3 });
  assert.deepEqual(parseCounts("Tests:       4 failed, 6 passed, 10 total\nTime: 1s"), { passed: 6, failed: 4 });
  assert.deepEqual(parseCounts("Ran 10 tests in 0.003s\n\nFAILED (failures=3, errors=1)"), { passed: 6, failed: 4 });
  assert.deepEqual(parseCounts("Ran 5 tests in 0.003s\n\nOK"), { passed: 5, failed: 0 });
  assert.equal(parseCounts("no tests ran in 0.01s"), null);
  assert.equal(parseCounts("FAIL"), null);
});

// ---------------------------------------------------------------- languages-and-oracles, slice a (design §1-§2)

const RUNNERS = join(ROOT, "test/fixtures/runners");
const fx = (name: string) => readFileSync(join(RUNNERS, name), "utf8");
const CFG = { python: "python3", command: null };

/** A temp repo from {path: text}. */
function repo(files: Record<string, string>): string {
  const d = tmpDir("checkfor-");
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(d, p, ".."), { recursive: true });
    writeFileSync(join(d, p), t);
  }
  return d;
}
const pkg = (test: string) => JSON.stringify({ scripts: { test } });
const bin = (dir: string, runner: string) => ({ [`${dir ? dir + "/" : ""}node_modules/.bin/${runner}`]: "" });

test("checkFor rule 1-2: a configured command wins (custom, {test} filled); a .py test is today's pytest", () => {
  const d = repo({ "package.json": pkg("jest") });
  assert.deepEqual(checkFor(d, "t/a b.ts", ["py", "ts"], { python: "python3", command: "make test T={test}" }), { runner: "custom", command: "make test T='t/a b.ts'", dir: "." });
  assert.deepEqual(checkFor(d, "tests/test_x.py", ["py", "ts"], CFG), { runner: "pytest", command: testCommand(CFG, "tests/test_x.py"), dir: "." });
});

test("checkFor rule 3: the project's own script; one test only when it calls the runner directly; jest by path", () => {
  const d = repo({ "package.json": pkg("vitest run"), ...bin("", "vitest"), "src/date.ts": "", "src/date.test.ts": "" });
  assert.deepEqual(checkFor(d, "src/date.test.ts", ["py", "ts"], CFG), { runner: "vitest", command: "npm test --silent -- src/date.test.ts", dir: "." });
  assert.deepEqual(checkFor(d, undefined, ["py", "ts"], CFG), { runner: "vitest", command: "npm test --silent", dir: "." });
  const j = repo({ "package.json": pkg("jest --ci"), ...bin("", "jest") });
  assert.equal((checkFor(j, "app/[id]/x.test.js", ["py", "ts"], CFG) as { command: string }).command, "npm test --silent -- --runTestsByPath 'app/[id]/x.test.js'");
  // a script that names its own files runs whole: one more path would run that test twice (TS gate affine-cipher, 28/32)
  const named = repo({ "package.json": pkg("jest ./*"), ...bin("", "jest") });
  assert.deepEqual(checkFor(named, "x.spec.js", ["py", "ts"], CFG), { runner: "jest", command: "npm test --silent", dir: ".", note: "ran the whole suite: the test script names its own files" });
  const chained = repo({ "package.json": pkg("tsc && vitest run"), ...bin("", "vitest") });
  assert.equal((checkFor(chained, "a.test.ts", ["py", "ts"], CFG) as { note?: string }).note, "ran the whole suite: the test script does more than call one runner");
  const unknown = repo({ "package.json": pkg("mocha") });
  assert.deepEqual(checkFor(unknown, "a.test.js", ["py", "ts"], CFG), { runner: "npm", command: "npm test --silent", dir: ".", note: "ran the whole suite: the test script does more than call one runner" });
  const node = repo({ "package.json": pkg("node --import tsx --test") });
  assert.deepEqual(checkFor(node, "a.test.ts", ["py", "ts"], CFG), { runner: "node:test", command: "npm test --silent -- a.test.ts", dir: "." });
});

test("checkFor rule 3: nearest package.json with a real script, walking up; placeholder and --watch are no script; R1, R3", () => {
  const ws = repo({ "package.json": pkg("jest"), ...bin("", "jest"), "packages/a/package.json": JSON.stringify({ name: "a" }), "packages/a/x.test.ts": "" });
  assert.deepEqual(checkFor(ws, "packages/a/x.test.ts", ["py", "ts"], CFG), { runner: "jest", command: "npm test --silent -- --runTestsByPath packages/a/x.test.ts", dir: "." });
  const sub = repo({ "web/package.json": pkg("vitest run"), ...bin("web", "vitest"), "web/src/a.test.ts": "" });
  assert.deepEqual(checkFor(sub, "web/src/a.test.ts", ["py", "ts"], CFG), { runner: "vitest", command: "npm test --silent -- src/a.test.ts", dir: "web" });
  const placeholder = repo({ "package.json": pkg('echo "Error: no test specified" && exit 1') });
  assert.deepEqual(checkFor(placeholder, "a.test.js", ["py", "ts"], CFG), { none: noScript(".") });
  const watch = repo({ "package.json": pkg("jest --watch") });
  assert.deepEqual(checkFor(watch, undefined, ["py", "ts"], CFG), { none: noScript(".") });
  const bare = repo({ "src/a.test.ts": "" });
  assert.deepEqual(checkFor(bare, "src/a.test.ts", ["py", "ts"], CFG), { none: noScript("src") });
  const missing = repo({ "package.json": pkg("vitest run") });
  assert.deepEqual(checkFor(missing, "a.test.ts", ["py", "ts"], CFG), { none: notInstalled("vitest", ".") });
  const pyTool = repo({ "package.json": JSON.stringify({ devDependencies: { prettier: "3" } }), "app.py": "" });
  assert.deepEqual(checkFor(pyTool, undefined, ["py", "ts"], CFG), { none: noScript(".") }, "a Python repo with a tooling package.json and ts on");
});

test("checkFor rules 4-5: with ts off, a JS-only repo gets NOT_TS; mixed, empty and Python repos keep pytest", () => {
  const js = repo({ "package.json": pkg("jest"), "a.js": "" });
  assert.deepEqual(checkFor(js, undefined, ["py"], CFG), { none: NOT_TS });
  assert.deepEqual(checkFor(js, "a.test.js", ["py"], CFG), { none: NOT_TS });
  const mixed = repo({ "package.json": pkg("jest"), "scripts/seed.py": "" });
  assert.deepEqual(checkFor(mixed, undefined, ["py"], CFG), { runner: "pytest", command: testCommand(CFG), dir: "." });
  assert.deepEqual(checkFor(repo({}), undefined, ["py"], CFG), { runner: "pytest", command: testCommand(CFG), dir: "." });
  const mixedOn = repo({ "package.json": pkg("jest"), ...bin("", "jest"), "scripts/seed.py": "" });
  assert.equal((checkFor(mixedOn, undefined, ["py", "ts"], CFG) as { runner: Runner }).runner, "jest", "CUJ 3: the TS app's suite, not pytest");
});

test("fill: every {test} quoted; with no test the placeholder and the space before it go", () => {
  assert.equal(fill("vitest run {test}", "a b.ts"), "vitest run 'a b.ts'");
  assert.equal(fill("run {test} && echo {test}", "$(x).ts"), "run '$(x).ts' && echo '$(x).ts'");
  assert.equal(fill("{test}", "a.ts"), "a.ts");
  assert.equal(fill("vitest run {test}", undefined), "vitest run");
  assert.equal(fill("npm test", "a.ts"), "npm test", "no placeholder: as written");
});

test("scriptRunner: first word jest or vitest, or node --test; anything else is npm", () => {
  assert.equal(scriptRunner("jest ./*"), "jest");
  assert.equal(scriptRunner("vitest run --config v.ts"), "vitest");
  assert.equal(scriptRunner("node --test"), "node:test");
  assert.equal(scriptRunner("node --import tsx --test"), "node:test");
  assert.equal(scriptRunner("NODE_OPTIONS=--x jest"), "npm");
  assert.equal(scriptRunner("react-scripts test"), "npm");
});

const CASES: [string, Runner, { passed: number; failed: number }][] = [
  ["jest-29.7.0", "jest", { passed: 1, failed: 1 }],
  ["vitest-2.1.9", "vitest", { passed: 1, failed: 1 }],
  ["node-spec-26", "node:test", { passed: 1, failed: 1 }],
  ["node-tap-26", "node:test", { passed: 1, failed: 1 }],
];
for (const [name, runner, failCounts] of CASES) {
  test(`readers on ${name} (raw: counts, blocks; kept: names, first error), also as "npm"`, () => {
    for (const r of [runner, "npm" as Runner]) {
      const fail = fx(`${name}-fail.txt`);
      const pass = fx(`${name}-pass.txt`);
      assert.deepEqual(parseCounts(fail, r), failCounts);
      assert.deepEqual(parseCounts(pass, r), { passed: 2, failed: 0 });
      const kept = trimTestOutput(fail, 1, r);
      assert.equal(kept.ok, false);
      assert.match(kept.text, /^FAIL \S/);
      assert.deepEqual(parseCounts(kept.text, r), failCounts, "the kept text's first line still gives the counts");
      const names = failingNames(kept.text, 10);
      assert.equal(names.total, 1);
      assert.match(names.names[0]!, /multiplies two numbers/);
      assert.match(firstErrorLine(kept.text) ?? "", /5|6|equal/i);
      assert.match(failureBlocks(fail, 3, 12, r), /multiplies two numbers/);
      const ok = trimTestOutput(pass, 0, r);
      assert.equal(ok.ok, true);
      assert.match(ok.text, /^PASS \S/);
      assert.ok(!ok.text.includes("\n"), "a pass keeps only the summary");
    }
  });
}

test("readers: unrecognised JS output keeps its tail and says so; pytest output is read as before", () => {
  const t = trimTestOutput("something odd\nexit 1", 1, "npm");
  assert.match(t.text, /^FAIL /);
  assert.ok(t.text.endsWith(NOT_RECOGNISED));
  assert.equal(parseCounts("something odd", "npm"), null);
  const py = "FAILED t.py::test_a - assert 1 == 2\n1 failed, 1 passed in 0.10s";
  assert.deepEqual(trimTestOutput(py, 1), trimTestOutput(py, 1, "pytest"));
  assert.deepEqual(parseCounts(py), { passed: 1, failed: 1 });
  assert.equal(parseCounts("Tests: 0 total\nTest Suites: 1 failed, 1 total", "jest")?.failed, 1, "a suite that fails to load counts as failed");
  assert.deepEqual(parseCounts("Test Suites: 1 failed, 1 passed, 2 total\nTests:       3 passed, 3 total", "jest"), { passed: 3, failed: 1 }, "a broken suite beside passing ones is not all green");
  assert.deepEqual(parseCounts(" Test Files  1 failed | 1 passed (2)\n      Tests  3 passed (3)", "vitest"), { passed: 3, failed: 1 }, "vitest: a file that fails to load is not all green");
});

test("runTests: none spawns nothing; JS runs say what ran; pytest text has no ran line", async () => {
  const js = repo({ "package.json": pkg("jest") });
  const none = await runTests({ cwd: js, config: CFG });
  assert.equal(none.none, NOT_TS);
  assert.equal(none.ok, false);
  assert.equal(none.text, `FAIL ${NOT_TS}`);
  const echo = repo({ "package.json": pkg("node --test") });
  writeFileSync(join(echo, "a.test.mjs"), "import { test } from 'node:test';\ntest('one', () => {});\n");
  const r = await runTests({ cwd: echo, config: CFG, langs: ["py", "ts"], test: "a.test.mjs" });
  assert.equal(r.runner, "node:test");
  assert.equal(r.ok, true);
  assert.deepEqual(r.counts, { passed: 1, failed: 0 });
  assert.ok(r.text.endsWith("(ran: npm test --silent -- a.test.mjs in .)"));
  const custom = await runTests({ cwd: echo, config: { python: "python3", command: "echo '1 passed in 0.01s'" } });
  assert.ok(!custom.text.includes("(ran:"));
});

test("namesTargets: files or globs after the runner; flags, flag values and vitest subcommands are not", () => {
  for (const s of ["jest ./*", "jest --ci ./*", "jest src", "vitest run src", "node --test test/", "node --test a.test.js", "jest --testPathPattern=x src"]) assert.equal(namesTargets(s), true, s);
  for (const s of ["jest", "jest --ci", "jest --config jest.config.js", "vitest run", "vitest", "node --test", "node --import tsx --test"]) assert.equal(namesTargets(s), false, s);
});

// ---- E24: test time limits (docs/designs/loop-guards-2/design.md)

test("isTestCommand: the design's table, plus the runner forms", () => {
  const yes = [
    "cd sub && npm test 2>&1", "timeout 60 pytest -q", "npx pytest", "py -m pytest", "npm test", "npm run test", "pnpm test", "yarn test",
    "npx jest --ci", "pnpm exec vitest run", "yarn mocha", "jest", "vitest run", "pytest tests/", "node --test", "tsx --test a.test.ts",
    "python -m pytest -x", "python3 -m unittest discover", "CI=1 npm test", "cd a; FORCE_COLOR=0 npx vitest | tail -20", "ls && timeout 30s python3 -m pytest",
  ];
  const no = ["echo npm test", "cat test_x.py", "npm install", "node script.js", "python3 main.py", "grep -r pytest .", "npm run build", "", "cd tests"];
  for (const s of yes) assert.equal(isTestCommand(s), true, s);
  for (const s of no) assert.equal(isTestCommand(s), false, s);
});

test("TestClock: 300 s with no run; 30 s floor; 300 s ceiling; a crash does not set it; back-off after a timeout; longest kept; reset", () => {
  const c = new TestClock();
  const clean = (ms: number) => ({ timedOut: false, counts: { passed: 3, failed: 1 }, ms });
  assert.equal(c.limitMs(10), 300_000, "no run: 300 s");
  c.record(clean(200));
  assert.equal(c.limitMs(10), 30_000, "0.2 s clean: the 30 s floor");
  assert.equal(c.limitMs(0), 300_000, "scale 0 = off");
  const big = new TestClock();
  big.record(clean(40_000));
  assert.equal(big.limitMs(10), 300_000, "40 s clean: the 300 s ceiling");
  const crash = new TestClock();
  crash.record({ timedOut: false, counts: null, ms: 400 });
  crash.record({ timedOut: false, counts: { passed: 0, failed: 0 }, ms: 400 });
  assert.equal(crash.limitMs(10), 300_000, "a 0.4 s crash with no counts (or no test) never sets the clock: a 40 s run is not killed");
  c.record(clean(5_000));
  assert.equal(c.limitMs(10), 50_000, "the longest clean run");
  c.record(clean(100));
  assert.equal(c.limitMs(10), 50_000, "longest kept, not last");
  c.record({ timedOut: true, counts: null, ms: 50_000 });
  assert.equal(c.limitMs(10), 300_000, "after a timeout: 300 s");
  c.record(clean(9_000));
  assert.equal(c.limitMs(10), 90_000, "a clean back-off run sets a longer maximum");
  c.reset();
  assert.equal(c.limitMs(10), 300_000, "reset");
  assert.equal(bashTestSeconds({ bashTestSeconds: 0, testTimeScale: 10 }, c), 0, "off");
  assert.equal(bashTestSeconds({ bashTestSeconds: 120, testTimeScale: 0 }, c), 120);
  c.record(clean(200));
  assert.equal(bashTestSeconds({ bashTestSeconds: 120, testTimeScale: 10 }, c), 30, "the scaled limit when smaller");
});

test("runTests reports ms; explainTimeout says why a scaled limit ended a run", async () => {
  const dir = tmpDir("tinycode-tr-ms-");
  writeFileSync(join(dir, "ok.js"), "setTimeout(()=>console.log('1 passed in 0.01s'), 50)");
  const ok = await runTests({ cwd: dir, config: { python: "x", command: `"${process.execPath}" ok.js` } });
  assert.equal(typeof ok.ms, "number");
  assert.ok((ok.ms as number) >= 40, `ms ${ok.ms}`);
  assert.equal(
    explainTimeout("FAIL tests timed out after 30s\ntail", 30_000, 10, 200),
    "FAIL tests timed out after 30s (10x the longest clean run, 0.2s): likely an endless loop. The next run gets 300s.\ntail",
  );
  assert.equal(explainTimeout("FAIL tests timed out after 300s", 300_000, 10, 0), "FAIL tests timed out after 300s", "the unscaled limit: unchanged");
});
