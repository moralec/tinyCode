import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { mergeConfig, type Config } from "../../src/config.ts";
import type { ExecFn } from "../../src/lint.ts";
import type { ChatResult, Message } from "../../src/llm.ts";
import { actionable, buildIndex, heuristic } from "../../src/router.ts";
import { classifyFailure, detectFramework, frameworkCommand, newTestPath, onlyGrew, parseTestArgs, runTestGen, testBlocksOnly , parseIntended, suspiciousAsserts } from "../../src/workflows/testgen.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const PY = (process.env.TINYCODE_TEST_PYTHON ?? "python3");
const cfg = (): Config => mergeConfig({ test: { python: PY } });

function scripted(replies: string[]) {
  const calls: { step: string; messages: Message[] }[] = [];
  let i = 0;
  const chat = async (step: string, messages: Message[]): Promise<ChatResult> => {
    calls.push({ step, messages: structuredClone(messages) });
    assert.ok(i < replies.length, `unexpected extra call #${i + 1} (${step})`);
    return { text: replies[i++]!, usage: { prompt_tokens: 10, cached_tokens: 0, completion_tokens: 5 }, ms: 1, lane: "trunk", model: "m", fellBack: false };
  };
  return { chat, calls };
}
const block = (path: string, search: string, replace: string) => `${path}\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n`;

const CALC = "def add(a, b):\n    return a + b\n\n\ndef clamp(x, lo, hi):\n    return max(lo, min(x, hi))\n\n\ndef half(x):\n    return x // 3\n";
function mk(files: Record<string, string>) {
  const d = mkdtempSync(join(tmpdir(), "tinycode-testgen-"));
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(join(d, f, ".."), { recursive: true });
    writeFileSync(join(d, f), t);
  }
  return { cwd: d, env: { TINYCODE_LOG: join(d, "..", "state-" + Math.random(), "calls.jsonl") } };
}
const py = (extra: Record<string, string> = {}) => mk({ "calc.py": CALC, "conftest.py": "", ...extra });
const read = (cwd: string, p: string) => readFileSync(join(cwd, p), "utf8");
const run = (cwd: string, env: Record<string, string>, chat: ReturnType<typeof scripted>["chat"], args: string, extra: object = {}) => {
  const lines: string[] = [];
  const p = runTestGen(parseTestArgs(args), { cwd, config: cfg(), chat, report: (l) => lines.push(l), env, ...extra });
  return p.then((r) => ({ r, lines }));
};

test("parseTestArgs: flags from the front, rest is the task", () => {
  assert.deepEqual(parseTestArgs("write tests for x --expect-fail"), { expectFail: false, task: "write tests for x --expect-fail" });
  assert.deepEqual(parseTestArgs("--expect-fail --file a/b.py --test=t.py write tests"), { expectFail: true, file: "a/b.py", test: "t.py", task: "write tests" });
});

test("detectFramework: pytest, unittest, node:test, jest, vitest from config and files; null for other languages", () => {
  const f = (files: Record<string, string>, target: string) => detectFramework(mk(files).cwd, target)?.name ?? null;
  assert.equal(f({ "a.py": "x=1\n" }, "a.py"), "pytest");
  assert.equal(f({ "a.py": "x=1\n", "pytest.ini": "[pytest]\n" }, "a.py"), "pytest");
  assert.equal(f({ "a.py": "x=1\n", "tests/test_a.py": "import unittest\nclass T(unittest.TestCase):\n    pass\n" }, "a.py"), "unittest");
  assert.equal(f({ "a.py": "x=1\n", "tests/test_a.py": "import pytest\ndef test_a():\n    pass\n" }, "a.py"), "pytest");
  assert.equal(f({ "a.js": "", "package.json": '{"devDependencies":{"vitest":"1"}}' }, "a.js"), "vitest");
  assert.equal(f({ "a.js": "", "package.json": '{"devDependencies":{"jest":"1"}}' }, "a.js"), "jest");
  assert.equal(f({ "a.js": "", "package.json": '{"scripts":{"test":"node --test"}}' }, "a.js"), "node:test");
  assert.equal(f({ "a.js": "", "a.test.js": "import test from 'node:test';\n" }, "a.js"), "node:test");
  assert.equal(f({ "a.rs": "" }, "a.rs"), null);
  assert.equal(frameworkCommand("jest", { python: "python3", command: null }, "a.test.js"), "npx jest a.test.js");
  assert.equal(frameworkCommand("vitest", { python: "python3", command: "make test" }, "a.test.js"), "make test");
  assert.equal(newTestPath("src/util.ts"), "src/util.test.ts");
  assert.equal(newTestPath("lib/calc.py"), "tests/test_calc.py");
});

test("classifyFailure: broken test vs behaviour mismatch", () => {
  assert.equal(classifyFailure("FAIL\nE   ModuleNotFoundError: No module named 'calcs'"), "own");
  assert.equal(classifyFailure("FAIL\nE   fixture 'tmpdir2' not found"), "own");
  assert.equal(classifyFailure("FAIL\nE   TypeError: half() takes 1 positional argument but 2 were given"), "own");
  assert.equal(classifyFailure("FAIL\nE   AssertionError: assert 3 == 4"), "mismatch");
  assert.equal(classifyFailure("FAIL\nE   KeyError: 'x'"), "mismatch");
});

test("test-files-only: blocks for code files are refused before applying; onlyGrew guards existing tests", () => {
  const r = testBlocksOnly(block("calc.py", "a", "b") + block("tests/test_calc.py", "", "def test_x():\n    pass\n") + block("/etc/x_test.py", "", "x"), "calc.py");
  assert.deepEqual(r.kept, ["tests/test_calc.py"]);
  assert.deepEqual(r.refused, ["calc.py", "/etc/x_test.py"]);
  assert.ok(onlyGrew("a\n\nb\n", "a\nnew\nb\nc\n"));
  assert.ok(!onlyGrew("a\nb\n", "a\nB\n"));
});

test("pass path: one call writes a test file, real pytest passes, code untouched, coverage not reported", async () => {
  const { cwd, env } = py();
  const s = scripted([block("tests/test_calc.py", "", "from calc import add, clamp\n\n\ndef test_add():\n    assert add(1, 2) == 3\n\n\ndef test_clamp():\n    assert clamp(9, 0, 5) == 5\n")]);
  const { r, lines } = await run(cwd, env, s.chat, "write tests for add and clamp in calc.py");
  assert.equal(r.outcome, "pass", lines.join("\n"));
  assert.equal(r.ok, true);
  assert.equal(r.calls, 1);
  assert.equal(r.framework, "pytest");
  assert.deepEqual(r.files, ["tests/test_calc.py"]);
  assert.equal(read(cwd, "calc.py"), CALC);
  assert.ok(lines.some((l) => l.startsWith("coverage: not reported")));
  assert.match(s.calls[0]!.messages[1]!.content, /Test framework: pytest/);
  assert.match(s.calls[0]!.messages[1]!.content, /def clamp/);
});

test("a reply that also edits the code: the code block is refused, the test is kept, calc.py is byte-identical", async () => {
  const { cwd, env } = py();
  const s = scripted([
    block("calc.py", "def half(x):\n    return x // 3", "def half(x):\n    return x // 2") + block("tests/test_calc.py", "", "from calc import add\n\n\ndef test_add():\n    assert add(2, 2) == 4\n"),
  ]);
  const { r, lines } = await run(cwd, env, s.chat, "write tests for add");
  assert.equal(r.outcome, "pass");
  assert.equal(read(cwd, "calc.py"), CALC);
  assert.ok(lines.some((l) => l.includes("refused (not a test file)")));
});

test("a failing test that exposes a real bug is reported as a possible bug: kept, code untouched, no retry", async () => {
  const { cwd, env } = py();
  const s = scripted([block("tests/test_calc.py", "", "from calc import half\n\n\ndef test_half():\n    assert half(10) == 5\n")]);
  const { r, lines } = await run(cwd, env, s.chat, "write tests for half");
  assert.equal(r.outcome, "possible-bug");
  assert.equal(r.ok, false);
  assert.equal(r.calls, 1);
  assert.equal(r.retried, false);
  assert.ok(lines.some((l) => l.includes("tests failing on current code: possible bug")));
  assert.ok(lines.some((l) => /assert 3 == 5/.test(l)), lines.join("\n"));
  assert.ok(existsSync(join(cwd, "tests/test_calc.py")));
  assert.equal(read(cwd, "calc.py"), CALC);
});

test("a test that fails for its own reasons gets exactly one retry, then passes", async () => {
  const { cwd, env } = py();
  const s = scripted([
    block("tests/test_calc.py", "", "from calcs import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n"),
    block("tests/test_calc.py", "from calcs import add", "from calc import add"),
  ]);
  const { r, lines } = await run(cwd, env, s.chat, "write tests for add");
  assert.equal(r.outcome, "pass", lines.join("\n"));
  assert.equal(r.calls, 2);
  assert.equal(r.retried, true);
  assert.match(s.calls[1]!.messages[1]!.content, /ModuleNotFoundError/);
});

test("still broken after the one retry: no third call, the new file is removed, outcome broken", async () => {
  const { cwd, env } = py();
  const bad = block("tests/test_calc.py", "", "from calcs import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n");
  const s = scripted([bad, block("tests/test_calc.py", "from calcs import add", "from calcz import add")]);
  const { r } = await run(cwd, env, s.chat, "write tests for add");
  assert.equal(r.outcome, "broken");
  assert.equal(r.calls, 2);
  assert.equal(existsSync(join(cwd, "tests/test_calc.py")), false);
});

test("an existing test is never weakened or removed: a rewrite that drops an assert is put back, the new test is not kept", async () => {
  const existing = "from calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n";
  const { cwd, env } = py({ "tests/test_calc.py": existing });
  const s = scripted([block("tests/test_calc.py", "    assert add(1, 2) == 3", "    assert add(1, 2) >= 0")]);
  const { r, lines } = await run(cwd, env, s.chat, "write tests for add");
  assert.equal(read(cwd, "tests/test_calc.py"), existing);
  assert.ok(lines.some((l) => l.includes("lost lines that were already there")));
  assert.equal(r.outcome, "not-applied");
});

test("adding to an existing test file keeps what was there", async () => {
  const existing = "from calc import add, clamp\n\n\ndef test_add():\n    assert add(1, 2) == 3\n";
  const { cwd, env } = py({ "tests/test_calc.py": existing });
  const s = scripted([block("tests/test_calc.py", "    assert add(1, 2) == 3", "    assert add(1, 2) == 3\n\n\ndef test_clamp_low():\n    assert clamp(-1, 0, 5) == 0")]);
  const { r } = await run(cwd, env, s.chat, "write tests for clamp");
  assert.equal(r.outcome, "pass");
  assert.ok(read(cwd, "tests/test_calc.py").includes("assert add(1, 2) == 3"));
  assert.ok(read(cwd, "tests/test_calc.py").includes("test_clamp_low"));
});

test("--expect-fail: failing tests are the goal; passing tests are reported as not catching it", async () => {
  const failing = block("tests/test_calc.py", "", "from calc import half\n\n\ndef test_half_is_half():\n    assert half(10) == 5\n");
  let w = py();
  let { r, lines } = await run(w.cwd, w.env, scripted([failing]).chat, "--expect-fail write tests for half: it should return half");
  assert.equal(r.outcome, "expected-fail");
  assert.equal(r.ok, true);
  assert.ok(lines.some((l) => l.includes("fail on current code, as expected")));
  w = py();
  ({ r, lines } = await run(w.cwd, w.env, scripted([block("tests/test_calc.py", "", "from calc import add\n\n\ndef test_add():\n    assert add(1, 1) == 2\n")]).chat, "--expect-fail write tests for add"));
  assert.equal(r.outcome, "unexpected-pass");
  assert.equal(r.ok, false);
});

test("coverage delta only when pytest-cov is installed (probe), never installed", async () => {
  const { cwd, env } = py();
  const cmds: string[] = [];
  let covRuns = 0;
  const exec: ExecFn = async (command) => {
    cmds.push(command);
    if (command.includes("import pytest_cov")) return { code: 0, out: "" };
    covRuns++;
    return { code: 0, out: `calc.py   10   2   80%\n` };
  };
  const s = scripted([block("tests/test_calc.py", "", "from calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n")]);
  const { r, lines } = await run(cwd, env, s.chat, "write tests for add", { exec });
  assert.equal(r.outcome, "pass");
  assert.deepEqual(r.coverage, [0, 80]);
  assert.ok(lines.includes("coverage of calc.py: 0% -> 80%"));
  assert.ok(cmds.every((c) => !/\binstall\b/.test(c)));
  // not installed: only the probe runs
  const w = py();
  const cmds2: string[] = [];
  const exec2: ExecFn = async (c) => (cmds2.push(c), { code: 1, out: "" });
  const o = await run(w.cwd, w.env, scripted([block("tests/test_calc.py", "", "from calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n")]).chat, "write tests for add", { exec: exec2 });
  assert.equal(o.r.coverage, null);
  assert.equal(cmds2.length, 1);
});

test("node:test: a real `node --test` run of tests written by the scripted call", async () => {
  const { cwd, env } = mk({
    "mathx.js": "export function triple(n) {\n  return n * 3;\n}\n",
    "package.json": '{"type":"module","scripts":{"test":"node --test"}}',
  });
  const s = scripted([
    block("mathx.test.js", "", "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { triple } from './mathx.js';\n\ntest('triple', () => {\n  assert.equal(triple(2), 6);\n});\n"),
  ]);
  const { r, lines } = await run(cwd, env, s.chat, "write tests for triple in mathx.js");
  assert.equal(r.framework, "node:test");
  assert.equal(r.outcome, "pass", lines.join("\n"));
  assert.equal(r.testFile, "mathx.test.js");
});

test("usage and no-target answers make no model call", async () => {
  const { cwd, env } = py();
  const s = scripted([]);
  assert.equal((await run(cwd, env, s.chat, "")).r.outcome, "usage");
  assert.equal((await run(cwd, env, s.chat, "write tests for the flux capacitor")).r.outcome, "no-target");
  assert.equal(s.calls.length, 0);
});

test("routing: 'write/add tests for X' goes to test; /add and others keep their routes", () => {
  const { cwd } = py();
  const names = buildIndex(cwd).names;
  for (const t of ["write tests for add", "add unit tests for calc.py", "please write some tests for clamp", "generate tests for calc.py", "add more tests for half"]) {
    const r = heuristic(t, names);
    assert.equal(r.workflow, "test", t);
    assert.equal(actionable(r), "test");
  }
  assert.equal(heuristic("write tests for calc.py", names).file, "calc.py");
  assert.equal(heuristic("add a function word_count that counts words", names).workflow, "add");
  assert.equal(heuristic("fix the failing test for half", names).workflow, "fix");
  assert.notEqual(heuristic("how do I write tests for flask apps?", names).workflow, "test");
  assert.notEqual(heuristic("add a test runner script", names).workflow, "test");
});

test("intended behaviour is asked in the same call and the tests encode it: a buggy half() is a possible bug, 1 call", async () => {
  const { cwd, env } = py();
  const s = scripted([
    "Intended behaviour:\n- half(x) returns x divided by 2, rounded down\n\n" + block("tests/test_calc.py", "", "from calc import half\n\n\ndef test_half():\n    assert half(10) == 5\n"),
  ]);
  const { r, lines } = await run(cwd, env, s.chat, "write tests for half");
  assert.equal(r.calls, 1);
  assert.equal(r.outcome, "possible-bug");
  assert.ok(lines.some((l) => l.includes("half(x) returns x divided by 2")));
  const prompt = s.calls[0]!.messages.map((m) => m.content).join("\n");
  assert.ok(/Intended behaviour:/.test(prompt) && /not from what the code does today/.test(prompt));
});

test("parseIntended and suspiciousAsserts", () => {
  assert.deepEqual(parseIntended("Intended behaviour:\n- a\n2. b\n\nx.py\n<<<<<<< SEARCH\n=======\n>>>>>>> REPLACE"), ["a", "b"]);
  assert.deepEqual(parseIntended("x.py\n<<<<<<< SEARCH\n=======\n>>>>>>> REPLACE"), []);
  const sus = suspiciousAsserts([
    '    assert slugify("Python & Java") == "python---java"',
    '    assert slugify("Hello World") == "hello-world"',
    '    assert parse("a,b") == []',
    "    assert parse(\"\") == []",
    "    assert count(xs) == len(xs) + 1",
  ]);
  assert.deepEqual(sus, ['assert slugify("Python & Java") == "python---java"', 'assert parse("a,b") == []', "assert count(xs) == len(xs) + 1"]);
});

test("a test that mirrors a repeated-separator output passes but is flagged as possibly locking in a bug", async () => {
  const { cwd, env } = mk({ "textutil.py": 'import re\n\n\ndef slugify(s):\n    return re.sub(r"[^a-z0-9]", "-", s.lower())\n', "conftest.py": "" });
  const s = scripted(["Intended behaviour:\n- one separator between words\n\n" + block("tests/test_textutil.py", "", 'from textutil import slugify\n\n\ndef test_slug():\n    assert slugify("Python & Java") == "python---java"\n')]);
  const { r, lines } = await run(cwd, env, s.chat, "write tests for slugify");
  assert.equal(r.outcome, "pass");
  assert.ok(lines.some((l) => l.startsWith("this test may lock in a bug:") && l.includes("python---java")), lines.join("\n"));
});

test("pre-existing failures are listed separately and do not mask a new failing test; pyc changes are not code changes", async () => {
  const { cwd, env } = py({
    "tests/test_calc.py": "from calc import add\n\n\ndef test_old_fail():\n    assert add(1, 1) == 3\n",
    "__pycache__/calc.cpython-39.pyc": "bytes",
  });
  const s = scripted([block("tests/test_calc.py", "def test_old_fail():\n    assert add(1, 1) == 3\n", "def test_old_fail():\n    assert add(1, 1) == 3\n\n\ndef test_half():\n    from calc import half\n    assert half(10) == 5\n")]);
  const { r, lines } = await run(cwd, env, s.chat, "write tests for half");
  assert.ok(lines.some((l) => /^1 tests were already failing before \/test/.test(l)), lines.join("\n"));
  assert.equal(r.outcome, "possible-bug");
  assert.ok(!lines.some((l) => l.includes("code files changed")));
});
