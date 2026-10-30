import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { mergeConfig, type Config } from "../../src/config.ts";
import type { ChatResult, Message } from "../../src/llm.ts";
import { actionable, buildIndex, heuristic, route } from "../../src/router.ts";
import { ADD_RULES, importers, parseAddArgs, runAdd, testPathFor } from "../../src/workflows/add.ts";
import { runEdit } from "../../src/workflows/edit.ts";
import { PICK_SCHEMA } from "../../src/workflows/fix.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const PY = (process.env.TINYCODE_TEST_PYTHON ?? "python3");
const cfg = (): Config => mergeConfig({ test: { python: PY }, ladder: { skipSolePick: false } }); // the scripted replies include the pick

function scripted(replies: string[]) {
  const calls: { step: string; messages: Message[]; schema?: object }[] = [];
  let i = 0;
  const chat = async (step: string, messages: Message[], opts?: { schema?: object }): Promise<ChatResult> => {
    calls.push({ step, messages: structuredClone(messages), schema: opts?.schema });
    assert.ok(i < replies.length, `unexpected extra call #${i + 1} (${step})`);
    return { text: replies[i++]!, usage: { prompt_tokens: 10, cached_tokens: 0, completion_tokens: 5 }, ms: 1, lane: "trunk", model: "gemma-4-12b", fellBack: false };
  };
  return { chat, calls };
}
const block = (path: string, search: string, replace: string) => `${path}\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n`;

function mk(files: Record<string, string>) {
  const d = tmpDir("tinycode-add-");
  const cwd = join(d, "repo");
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(join(cwd, f, ".."), { recursive: true });
    writeFileSync(join(cwd, f), t);
  }
  return { cwd, env: { TINYCODE_LOG: join(d, "state", "calls.jsonl") } };
}
const slug = () => {
  const d = tmpDir("tinycode-add-");
  const cwd = join(d, "repo");
  cpSync(join(ROOT, "test/fixtures/task-repos/t03-slugify"), cwd, { recursive: true, filter: (s) => !s.includes("__pycache__") });
  return { cwd, env: { TINYCODE_LOG: join(d, "state", "calls.jsonl") } };
};

test("parseAddArgs: flags from the front, rest is the task", () => {
  assert.deepEqual(parseAddArgs("add a thing --test x"), { task: "add a thing --test x" });
  assert.deepEqual(parseAddArgs("--file a/b.py --test=t.py add a thing"), { file: "a/b.py", test: "t.py", task: "add a thing" });
});

test("task 1, new function: one call writes code + test, both applied, test passes, lint reported", async () => {
  const { cwd, env } = slug();
  const s = scripted([
    block("textutil.py", "def title_case(text):", "def word_count(text):\n    return len(text.split())\n\n\ndef title_case(text):") +
      block("tests/test_textutil.py", "", "from textutil import word_count\n\n\ndef test_word_count():\n    assert word_count('a b  c') == 3\n"),
  ]);
  const lines: string[] = [];
  // a ruff configured; the fake tool appends a trailing comment line to prove it ran on the changed files only
  writeFileSync(join(cwd, "ruff.toml"), "");
  const ran: string[] = [];
  const r = await runAdd({ file: "textutil.py", task: "add a function word_count(text) that counts words" }, {
    cwd, config: cfg(), chat: s.chat, report: (l) => lines.push(l), env,
    lint: { find: (t) => (t === "ruff" ? "ruff" : null), exec: async (c) => (ran.push(c), { code: 0, out: "" }) },
  });
  assert.equal(r.ok, true);
  assert.equal(r.calls, 1);
  assert.deepEqual(s.calls.map((c) => c.step), ["edit"]);
  assert.equal(s.calls[0].messages[0].content, ADD_RULES);
  const u = s.calls[0].messages[1].content;
  assert.match(u, /^Repository outline:/);
  assert.match(u, /textutil\.py\n```\nimport re/);
  assert.match(u, /a test for it in tests\/test_textutil\.py \(a new file\)/);
  assert.match(readFileSync(join(cwd, "textutil.py"), "utf8"), /def word_count/);
  assert.equal(r.test, "tests/test_textutil.py");
  assert.deepEqual(r.files, ["tests/test_textutil.py", "textutil.py"]);
  assert.ok(lines.some((l) => /^test tests\/test_textutil\.py: pass/.test(l)));
  assert.deepEqual(ran, ["ruff check --fix --quiet tests/test_textutil.py textutil.py", "ruff format --quiet tests/test_textutil.py textutil.py"]);
  assert.ok(lines.some((l) => /^lint: ruff check --fix on 2 file\(s\): no change/.test(l)));
});

test("task 2, new CLI option: pick call chooses the file, callers and imports in the prompt", async () => {
  const { cwd, env } = mk({
    "greet.py": "import argparse\n\n\ndef build_parser():\n    p = argparse.ArgumentParser()\n    p.add_argument('--name', default='world')\n    return p\n\n\ndef main(argv=None):\n    a = build_parser().parse_args(argv)\n    msg = f'hello {a.name}'\n    print(msg)\n    return msg\n",
    "run.py": "from greet import main\n\nmain()\n",
    "tests/test_greet.py": "from greet import main\n\n\ndef test_default():\n    assert main([]) == 'hello world'\n",
  });
  const s = scripted([
    JSON.stringify({ files: ["greet.py", "run.py"], reason: "cli lives in greet.py" }),
    block("greet.py", "    p.add_argument('--name', default='world')", "    p.add_argument('--name', default='world')\n    p.add_argument('--shout', action='store_true')") +
      block("greet.py", "    msg = f'hello {a.name}'", "    msg = f'hello {a.name}'\n    if a.shout:\n        msg = msg.upper()") +
      block("tests/test_greet.py", "def test_default():\n    assert main([]) == 'hello world'\n", "def test_default():\n    assert main([]) == 'hello world'\n\n\ndef test_shout():\n    assert main(['--shout']) == 'HELLO WORLD'\n"),
  ]);
  const r = await runAdd({ task: "add a --shout option to the CLI that upper-cases the greeting" }, { cwd, config: cfg(), chat: s.chat, report: () => {}, env });
  assert.equal(r.ok, true);
  assert.equal(r.calls, 2);
  assert.deepEqual(s.calls.map((c) => c.step), ["pick", "edit"]);
  assert.equal(s.calls[0].schema, PICK_SCHEMA);
  const u = s.calls[1].messages[1].content;
  assert.match(u, /Files that import greet\.py:\nrun\.py:1: from greet import main/);
  assert.match(u, /Imports already in greet\.py:\nimport argparse/);
  assert.match(u, /tests\/test_greet\.py\n```\nfrom greet import main/, "the existing test file is shown");
  assert.match(u, /\(it exists; add to it\)/);
  assert.equal(r.target, "greet.py");
  assert.match(readFileSync(join(cwd, "tests/test_greet.py"), "utf8"), /test_default[\s\S]*test_shout/);
});

test("task 3, new endpoint: router table gets a /health route and a test", async () => {
  const { cwd, env } = mk({
    "app.py": "ROUTES = {}\n\n\ndef route(path):\n    def deco(fn):\n        ROUTES[path] = fn\n        return fn\n    return deco\n\n\n@route('/ping')\ndef ping(req):\n    return 200, {'pong': True}\n\n\ndef handle(path, req=None):\n    fn = ROUTES.get(path)\n    return fn(req) if fn else (404, {'error': 'not found'})\n",
  });
  const s = scripted([
    block("app.py", "def handle(path, req=None):", "@route('/health')\ndef health(req):\n    return 200, {'status': 'ok'}\n\n\ndef handle(path, req=None):") +
      block("tests/test_app.py", "", "from app import handle\n\n\ndef test_health():\n    assert handle('/health') == (200, {'status': 'ok'})\n"),
  ]);
  const r = await runAdd({ file: "app.py", task: "add a GET /health endpoint returning status ok" }, { cwd, config: cfg(), chat: s.chat, report: () => {}, env });
  assert.equal(r.ok, true);
  assert.equal(r.calls, 1);
  assert.equal(r.fix, undefined);
});

test("failing new test: hands over to /fix's ladder with the test protected; the ladder's pass counts", async () => {
  const { cwd, env } = slug();
  const s = scripted([
    block("textutil.py", "def title_case(text):", "def word_count(text):\n    return len(text.split(' '))\n\n\ndef title_case(text):") +
      block("tests/test_textutil.py", "", "from textutil import word_count\n\n\ndef test_word_count():\n    assert word_count('a b  c') == 3\n"),
    JSON.stringify({ files: ["textutil.py"], reason: "word_count splits on one space" }),
    block("textutil.py", "return len(text.split(' '))", "return len(text.split())"),
  ]);
  const lines: string[] = [];
  const r = await runAdd({ file: "textutil.py", task: "add word_count(text)" }, { cwd, config: cfg(), chat: s.chat, report: (l) => lines.push(l), env });
  assert.deepEqual(s.calls.map((c) => c.step), ["edit", "pick", "edit"]);
  assert.equal(r.ok, true);
  assert.equal(r.fix?.solvedBy, "rung1");
  assert.ok(lines.some((l) => /the test fails: handing over to \/fix's ladder on tests\/test_textutil\.py/.test(l)));
  assert.match(s.calls[1].messages[1].content, /\(\/add put new code in textutil\.py with the test tests\/test_textutil\.py/);
  assert.match(s.calls[1].messages[1].content, /tests\/test_textutil\.py\n```\nfrom textutil import word_count/);
  assert.match(readFileSync(join(cwd, "textutil.py"), "utf8"), /text\.split\(\)\)/);
});

test("nothing applied: straight to the ladder; no target found: says so, no calls beyond pick", async () => {
  const { cwd, env } = mk({ "textutil.py": "def title_case(text):\n    return text.title()\n", "tests/test_ok.py": "def test_ok():\n    assert True\n" });
  const s = scripted(["I would add a function.", JSON.stringify({ files: ["textutil.py"], reason: "x" }), block("textutil.py", "def title_case(text):", "def zed(text):\n    return text\n\n\ndef title_case(text):")]);
  const r = await runAdd({ file: "textutil.py", task: "add zed" }, { cwd, config: cfg(), chat: s.chat, report: () => {}, env });
  assert.equal(r.fix?.solvedBy, "rung1");
  const s2 = scripted([JSON.stringify({ files: ["nope.py"], reason: "x" })]);
  const lines: string[] = [];
  const r2 = await runAdd({ task: "add a thing" }, { cwd: slug().cwd, config: cfg(), chat: s2.chat, report: (l) => lines.push(l), env });
  assert.equal(r2.ok, false);
  assert.equal(r2.target, null);
  assert.ok(lines.some((l) => /name it with --file/.test(l)));
});

test("helpers: testPathFor, importers", () => {
  const { cwd } = mk({ "pkg/util.py": "x = 1\n", "pkg/__init__.py": "", "main.py": "from pkg.util import x\n", "tests/test_util.py": "" });
  assert.equal(testPathFor(cwd, "pkg/util.py"), "tests/test_util.py");
  assert.equal(testPathFor(cwd, "pkg/other.py"), "tests/test_other.py");
  assert.equal(testPathFor(cwd, "web/app.js"), null);
  assert.equal(testPathFor(cwd, "web/app.js", "web\\app.test.js"), "web/app.test.js");
  assert.deepEqual(importers(cwd, "pkg/util.py"), ["main.py:1: from pkg.util import x"]);
});

test("routing: new-thing language goes to add (confirmed, file optional); changes to existing code stay edit", async () => {
  const names = new Map([["textutil.py", "textutil.py"], ["slugify", "textutil.py"]]);
  for (const t of ["add a function that counts words", "implement a new CLI option --shout", "add an endpoint for health checks", "create a new helper to parse dates"]) {
    const r = heuristic(t, names);
    assert.equal(r.workflow, "add", t);
    assert.equal(r.confident, true);
    assert.equal(actionable(r), "add");
  }
  assert.equal(heuristic("add a function word_count to textutil.py", names).file, "textutil.py");
  assert.equal(heuristic("rename slugify to make_slug", names).workflow, "edit");
  assert.equal(heuristic("add the parameter to slugify", names).workflow, "edit");
  assert.equal(heuristic("fix the new function, it crashes", names).workflow, "fix");
  // S18: a general how-to question is not an /add request; it goes to /ask (was "none" before /ask existed)
  assert.equal(heuristic("how do I add a function?", names).workflow, "ask");
  const idx = buildIndex(slug().cwd);
  const r = await route("add a function that counts words", idx, async () => assert.fail("code decides"));
  assert.equal(r.workflow, "add");
});

test("lint wired into /edit: runs on the edited file only, reported", async () => {
  const { cwd, env } = slug();
  writeFileSync(join(cwd, "pyproject.toml"), "[tool.black]\n");
  const s = scripted([block("textutil.py", "return \" \".join(w.capitalize() for w in text.split())", "return \" \".join(w.capitalize() for w in text.split(' '))")]);
  const ran: string[] = [];
  const lines: string[] = [];
  const r = await runEdit({ path: "textutil.py", instruction: "split on single spaces in title_case" }, {
    cwd, config: cfg(), chat: s.chat, report: (l) => lines.push(l), env,
    lint: { find: (t) => (t === "black" ? "black" : null), exec: async (c) => (ran.push(c), { code: 0, out: "" }) },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(ran, ["black --quiet textutil.py"]);
  assert.ok(lines.some((l) => /^lint: black on 1 file\(s\): no change/.test(l)));
});

test("lint wired into /fix: after a rung-1 pass, on the files the ladder changed only", async () => {
  const { cwd, env } = slug();
  writeFileSync(join(cwd, "ruff.toml"), "");
  const { runFix, parseFixArgs } = await import("../../src/workflows/fix.ts");
  const s = scripted([
    JSON.stringify({ files: ["textutil.py"], reason: "x" }),
    block("textutil.py", 'return re.sub(r"[^a-z0-9]", "-", text)', 'return re.sub(r"[^a-z0-9]+", "-", text).strip("-")'),
  ]);
  const ran: string[] = [];
  const lines: string[] = [];
  const r = await runFix(parseFixArgs("--test tests/test_task.py slugify keeps repeated dashes"), {
    cwd, config: cfg(), chat: s.chat, report: (l) => lines.push(l), env,
    lint: { find: (t) => (t === "ruff" ? "ruff" : null), exec: async (c) => (ran.push(c), { code: 0, out: "" }) },
  });
  assert.equal(r.solvedBy, "rung1");
  assert.deepEqual(ran, ["ruff check --fix --quiet textutil.py", "ruff format --quiet textutil.py"]);
  assert.ok(lines.some((l) => /^lint: ruff check --fix on 1 file/.test(l)));
});

const testBlock = (body: string) => block("tests/test_textutil.py", "", body);
const WC = block("textutil.py", "def title_case(text):", "def word_count(text):\n    return len(text.split())\n\n\ndef title_case(text):");

test("code edit does not apply but the test was written: ladder fails -> everything is undone, with the reason", async () => {
  const { cwd, env } = slug();
  const before = readFileSync(join(cwd, "textutil.py"), "utf8");
  const s = scripted([
    block("textutil.py", "def no_such_anchor(text):", "def word_count(text):\n    return 1") + testBlock("from textutil import word_count\n\n\ndef test_wc():\n    assert word_count('a b') == 2\n"),
    JSON.stringify({ files: ["textutil.py"], reason: "x" }),
    "no blocks here",
    JSON.stringify({ diagnosis: "d", where: [], next_step: "n" }),
    "still nothing",
  ]);
  const lines: string[] = [];
  const r = await runAdd({ file: "textutil.py", task: "add word_count" }, { cwd, config: cfg(), chat: s.chat, report: (l) => lines.push(l), env });
  assert.equal(r.ok, false);
  assert.equal(r.fix?.solvedBy, "none");
  assert.ok(lines.some((l) => /the code edit didn't apply to textutil\.py: the SEARCH text was not found/.test(l)));
  assert.deepEqual(r.undone?.removed, ["tests/test_textutil.py"]);
  assert.deepEqual(r.files, []);
  assert.equal(readFileSync(join(cwd, "textutil.py"), "utf8"), before);
  assert.equal(existsSync(join(cwd, "tests/test_textutil.py")), false, "the new test is gone");
});

test("hand-over that ends without a passing test restores a changed target too", async () => {
  const { cwd, env } = slug();
  const before = readFileSync(join(cwd, "textutil.py"), "utf8");
  const s = scripted([
    block("textutil.py", "def title_case(text):", "def word_count(text):\n    return -1\n\n\ndef title_case(text):") + testBlock("from textutil import word_count\n\n\ndef test_wc():\n    assert word_count('a b') == 2\n"),
    JSON.stringify({ files: ["textutil.py"], reason: "x" }),
    "no blocks",
    JSON.stringify({ diagnosis: "d", where: [], next_step: "n" }),
    "no blocks",
  ]);
  const r = await runAdd({ file: "textutil.py", task: "add word_count" }, { cwd, config: cfg(), chat: s.chat, report: () => {}, env });
  assert.equal(r.ok, false);
  assert.equal(readFileSync(join(cwd, "textutil.py"), "utf8"), before);
  assert.equal(existsSync(join(cwd, "tests/test_textutil.py")), false);
  assert.ok(r.undone?.restored.includes("textutil.py"));
});

test("new test fails at collection: one retry with the error, then it passes", async () => {
  const { cwd, env } = slug();
  const s = scripted([
    WC + testBlock("from textutil import word_cnt\n\n\ndef test_wc():\n    assert word_cnt('a b') == 2\n"),
    block("tests/test_textutil.py", "from textutil import word_cnt\n\n\ndef test_wc():\n    assert word_cnt('a b') == 2", "from textutil import word_count\n\n\ndef test_wc():\n    assert word_count('a b') == 2"),
  ]);
  const r = await runAdd({ file: "textutil.py", task: "add word_count" }, { cwd, config: cfg(), chat: s.chat, report: () => {}, env });
  assert.equal(r.ok, true);
  assert.equal(r.calls, 2);
  assert.equal(r.fix, undefined);
  const last = s.calls[1].messages;
  assert.equal(last[2].role, "assistant");
  assert.match(last[3].content, /fails before any test runs[\s\S]*ImportError|cannot import/);
});

test("new test still fails at collection after the retry: undone, no ladder", async () => {
  const { cwd, env } = slug();
  const before = readFileSync(join(cwd, "textutil.py"), "utf8");
  const bad = testBlock("def test_wc(:\n    pass\n");
  const s = scripted([WC + bad, block("tests/test_textutil.py", "def test_wc(:\n    pass", "def test_wc(:\n    pass2")]);
  const lines: string[] = [];
  const r = await runAdd({ file: "textutil.py", task: "add word_count" }, { cwd, config: cfg(), chat: s.chat, report: (l) => lines.push(l), env });
  assert.equal(r.ok, false);
  assert.equal(r.fix, undefined);
  assert.equal(s.calls.length, 2);
  assert.equal(readFileSync(join(cwd, "textutil.py"), "utf8"), before);
  assert.equal(existsSync(join(cwd, "tests/test_textutil.py")), false);
  assert.ok(lines.some((l) => /still fails at collection/.test(l)));
});
