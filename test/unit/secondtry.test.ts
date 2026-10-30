// Issue #10: the second quick try (rung 1b) and window-sized quick tries (src/workflows/quickfit.ts).
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { deepMerge, DEFAULTS, mergeConfig, type Config } from "../../src/config.ts";
import type { ChatOptions, ChatResult, Message } from "../../src/llm.ts";
import { CODE_ONLY_RULE, SYSTEM } from "../../src/protocol/prompts.ts";
import { parseFixArgs, runFix, secondTryFit, secondTryText, type PiHandoff } from "../../src/workflows/fix.ts";
import { cutMiddle, estTokens, failingTestsCode, failingTestsOnly, fitHead, headText, type FitOpts, type QuickHead } from "../../src/workflows/quickfit.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const PY = (process.env.TINYCODE_TEST_PYTHON ?? "python3");
const ALLFAIL = JSON.parse(readFileSync(join(ROOT, "test/fixtures/fix/r2-03-allfail.json"), "utf8")) as { repo: string; test: string; replies: string[] };

function tree(cwd: string, rel = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(join(cwd, rel), { withFileTypes: true })) {
    if (e.name === "__pycache__" || e.name === ".pytest_cache") continue;
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, tree(cwd, r));
    else if (statSync(join(cwd, r)).isFile()) out[r] = readFileSync(join(cwd, r), "utf8");
  }
  return out;
}

interface Seen {
  step: string;
  messages: Message[];
  opts: ChatOptions;
  tree: Record<string, string>;
}
function scripted(cwd: string, replies: string[], finish?: string) {
  const calls: Seen[] = [];
  let i = 0;
  const chat = async (step: string, messages: Message[], o: ChatOptions = {}): Promise<ChatResult> => {
    calls.push({ step, messages: structuredClone(messages), opts: { maxTokens: o.maxTokens, seed: o.seed }, tree: tree(cwd) });
    assert.ok(i < replies.length, `unexpected extra call #${i + 1} (${step})`);
    return { text: replies[i++]!, usage: { prompt_tokens: 100, cached_tokens: 0, completion_tokens: 50 }, ms: 1, lane: "trunk", model: "gemma-4-12b", fellBack: false, ...(finish ? { finish } : {}) };
  };
  return { chat, calls };
}
function fakeTests(texts: string[]) {
  let i = 0;
  return async () => {
    const text = texts[Math.min(i++, texts.length - 1)]!;
    return { ok: text.startsWith("PASS"), text, code: text.startsWith("PASS") ? 0 : 1, timedOut: false };
  };
}
const FAIL10 = "FAIL 10 failed in 0.1s\n";
const FAIL4 = "FAIL 4 failed, 6 passed in 0.1s\nFAILED tests/test_task.py::test_tax - KeyError\nE   KeyError: 'tax'\n";
const FAIL2 = "FAIL 2 failed, 8 passed in 0.1s\n";
const PASS = "PASS 10 passed in 0.1s\n";
const cfg = (over: unknown = {}): Config => mergeConfig(deepMerge({ test: { python: PY }, ladder: { skipSolePick: false } }, over));

async function ladder(texts: string[], over: unknown = {}, replies = [ALLFAIL.replies[0]!, ALLFAIL.replies[1]!, "no blocks"]) {
  const dir = tmpDir("tinycode-2nd-");
  const cwd = join(dir, "repo");
  cpSync(join(ROOT, "test/fixtures/task-repos", ALLFAIL.repo), cwd, { recursive: true, filter: (s) => !s.includes("__pycache__") });
  const env = { TINYCODE_LOG: join(dir, "state", "calls.jsonl") };
  const before = tree(cwd);
  const s = scripted(cwd, replies, "stop");
  let seen: PiHandoff | null = null;
  let atHandoff: Record<string, string> = {};
  const lines: string[] = [];
  const r = await runFix(parseFixArgs(`--test ${ALLFAIL.test} Fix the invoice.`), {
    cwd, config: cfg(over), chat: s.chat, report: (l) => lines.push(l), env, runTests: fakeTests(texts) as never,
    pi: async (h) => { seen = h; atHandoff = tree(cwd); return { turns: 2 }; },
  });
  return { cwd, before, calls: s.calls, r, lines, seen: seen as PiHandoff | null, atHandoff };
}

test("defaults: second try on, 2048 reply tokens reserved, 2.6 chars per token; bad values refused", () => {
  assert.equal(DEFAULTS.ladder.secondTry, true);
  assert.equal(DEFAULTS.ladder.replyReserve, 2048);
  assert.equal(DEFAULTS.ladder.charsPerToken, 2.6);
  assert.equal(DEFAULTS.ladder.rung2, false, "rung 2 unchanged");
  assert.throws(() => mergeConfig({ ladder: { secondTry: "yes" } }), /ladder\.secondTry/);
  assert.throws(() => mergeConfig({ ladder: { replyReserve: 0 } }), /ladder\.replyReserve/);
  assert.throws(() => mergeConfig({ ladder: { charsPerToken: 0.5 } }), /ladder\.charsPerToken/);
});

test("second try from the best tree: rung 1 took 10 failing to 4; a fresh context with what still fails and the files now", async () => {
  const x = await ladder([FAIL10, FAIL4, PASS]);
  assert.deepEqual(x.calls.map((c) => c.step), ["pick", "edit", "edit"]);
  assert.equal(x.r.solvedBy, "rung1b");
  assert.equal(x.r.calls, 3);
  const c = x.calls[2]!;
  assert.equal(c.messages.length, 2, "fresh context");
  assert.equal(c.messages[0]!.content, SYSTEM);
  const u = c.messages[1]!.content;
  assert.match(u, /^Tree now: 6\/10 pass\. Still fail: test_tax \(\+3 more\)\. First error: KeyError: 'tax'\.\n\nFiles now:\n\nbilling\/invoice\.py\n```\n/);
  assert.match(u, /tax=0, \*\*breakdown/, "the file as rung 1 left it");
  assert.match(u, /\n\nEdit blocks only\. Fix what fails\. No rewrite\.$/);
  assert.ok(!u.includes("Repository outline") && !u.includes("tests/test_task.py\n```"), "no outline, no test file");
  assert.match(c.tree["billing/invoice.py"]!, /tax=0/, "the call is made on the best tree");
  assert.equal(c.opts.seed, undefined);
  assert.ok(x.lines.includes("rung1b: from the rung 1 tree (6/10 pass)"));
  assert.ok(x.lines.some((l) => /^rung1b: prompt 100 tok \(est \d+ of 32768\), reply 50 tok \(max 4096\), finish stop, tests 10\/10$/.test(l)));
  assert.ok(x.lines.some((l) => /^rung1: prompt 100 tok \(est \d+ of 32768\), reply 50 tok \(max 4096\), finish stop, tests 6\/10$/.test(l)));
  assert.equal(x.seen, null, "no Pi");
});

test("second try from the best tree: the still-failing tests' code is shown (dot-dsl 8k: names alone left a test case unfixed); passing tests left out; none when it would not fit", async () => {
  const ONE = "FAIL 1 failed, 1 passed in 0.1s\nFAILED tests/test_task.py::test_reduced - KeyError\nE   KeyError: 'tax'\n";
  const x = await ladder([FAIL10, ONE, PASS]);
  const u = x.calls[2]!.messages[1]!.content;
  assert.match(u, /^Tree now: 1\/2 pass\. Still fail: test_reduced\. First error: KeyError: 'tax'\.\n\nFailing tests:\n\ntests\/test_task\.py\n```\n/);
  assert.match(u, /def test_reduced\(\):\n    assert breakdown\(\[\(100\.0, 1\)\], "reduced"\)\["tax"\] == 5\.0/, "the failing test's body");
  assert.ok(!u.includes("def test_render"), "the passing test is left out");
  assert.match(u, /from billing\.pricing import breakdown/, "imports stay");
  assert.match(u, /# \[1 passing tests not shown\]\n```\n\nFiles now:\n\nbilling\/invoice\.py/);
  assert.equal(x.r.solvedBy, "rung1b");
});

test("secondTryFit: every failing test's code, else the first maxNames, else names only, whichever fits; null when nothing fits", () => {
  const sys = { role: "system" as const, content: SYSTEM };
  const out = "FAIL 3 failed, 1 passed in 0.1s\nFAILED t_test.py::T::test_one\nFAILED t_test.py::T::test_three\nFAILED t_test.py::test_top\nE   assert 1 == 2\n";
  const test = { path: "t_test.py", text: PYTEST + "\n" + "# padding\n".repeat(0) };
  const o = (window: number): FitOpts => ({ window, reserve: 100, stepMax: 4096, charsPerToken: 2.6 });
  const wide = secondTryFit(sys, { passed: 1, failed: 3 }, out, "a.py", test, 2, o(32768))!;
  assert.deepEqual(wide.cuts, []);
  const u = wide.msgs[1]!.content;
  assert.ok(u.includes("def test_one") && u.includes("def test_three") && u.includes("def test_top") && !u.includes("def test_two"));
  const all = wide.tokens;
  const names = secondTryFit(sys, { passed: 1, failed: 3 }, out, "a.py", null, 2, o(32768))!.tokens;
  const two = secondTryFit(sys, { passed: 1, failed: 3 }, out, "a.py", test, 2, o(all + 100 - 1))!;
  assert.deepEqual(two.cuts, ["some failing tests"]);
  assert.ok(two.msgs[1]!.content.includes("def test_three") && !two.msgs[1]!.content.includes("def test_top"));
  const none = secondTryFit(sys, { passed: 1, failed: 3 }, out, "a.py", test, 2, o(names + 100))!;
  assert.deepEqual(none.cuts, ["failing tests"]);
  assert.ok(!none.msgs[1]!.content.includes("Failing tests:"));
  assert.equal(secondTryFit(sys, { passed: 1, failed: 3 }, out, "a.py", test, 2, o(names + 99)), null);
});

test("second try, no gain in rung 1: a fresh sample of the rung-1 edit from the original tree with seed + 1", async () => {
  const x = await ladder([FAIL10, FAIL10, PASS], { lanes: { trunk: { temperature: 0.3, seed: 41 } } });
  assert.deepEqual(x.calls.map((c) => c.step), ["pick", "edit", "edit"]);
  assert.deepEqual(x.calls[2]!.messages, x.calls[1]!.messages, "the same rung-1 prompt");
  assert.equal(x.calls[2]!.opts.seed, 42);
  assert.equal(x.calls[1]!.opts.seed, undefined, "rung 1 uses the lane's own seed");
  assert.equal(x.calls[2]!.opts.maxTokens, x.calls[1]!.opts.maxTokens);
  assert.deepEqual(x.calls[2]!.tree, x.before, "sampled from the original tree");
  assert.equal(x.r.solvedBy, "rung1b");
  assert.ok(x.lines.includes("rung1b: a fresh sample of the rung-1 edit from the original tree, seed 42"));
  // no seed configured: temperature alone makes the sample differ, no seed sent
  const y = await ladder([FAIL10, FAIL10, PASS], { lanes: { trunk: { temperature: 0.3 } } });
  assert.equal(y.calls.length, 3);
  assert.equal(y.calls[2]!.opts.seed, undefined);
  assert.ok(y.lines.includes("rung1b: a fresh sample of the rung-1 edit from the original tree"));
});

test("second try, no gain at temperature 0: skipped (the sample would repeat rung 1), straight to Pi", async () => {
  const x = await ladder([FAIL10, FAIL10, FAIL10]);
  assert.deepEqual(x.calls.map((c) => c.step), ["pick", "edit"]);
  assert.ok(x.lines.some((l) => /^rung1b: skipped \(no rung beat the original, and at temperature 0/.test(l)));
  assert.ok(x.seen);
  assert.deepEqual(x.atHandoff, x.before);
});

test("second try fails: rung 3 as before, from the best tree; a second try that beats rung 1 is the one kept", async () => {
  const x = await ladder([FAIL10, FAIL4, FAIL4, PASS]);
  assert.deepEqual(x.calls.map((c) => c.step), ["pick", "edit", "edit"]);
  assert.ok(x.seen);
  assert.equal(x.r.kept, "Kept rung 1 tree: 6/10 pass. Still fail: test_tax (+3 more). First error: KeyError: 'tax'. Edit only what fails. No rewrite.");
  assert.match(x.atHandoff["billing/invoice.py"]!, /tax=0/);
  assert.equal(x.r.solvedBy, "pi");
  assert.equal(x.r.calls, 3 + 2);
  const y = await ladder([FAIL10, FAIL4, FAIL2, FAIL2]);
  assert.match(y.r.kept ?? "", /^Kept rung 1b tree: 8\/10 pass\./);
  // resample that fails, nothing gained anywhere: Pi from the original tree
  const z = await ladder([FAIL10, FAIL10, FAIL10, FAIL10], { lanes: { trunk: { temperature: 0.3, seed: 7 } } });
  assert.equal(z.calls.length, 3);
  assert.equal(z.r.kept, null);
  assert.deepEqual(z.atHandoff, z.before);
  // off: the old flow
  const off = await ladder([FAIL10, FAIL4, FAIL4], { ladder: { secondTry: false } }, ALLFAIL.replies.slice(0, 2));
  assert.deepEqual(off.calls.map((c) => c.step), ["pick", "edit"]);
  assert.ok(off.seen);
});

test("secondTryText: counts, names capped, first error, files, the rule", () => {
  const t = "FAIL 3 failed, 1 passed in 0.1s\nFAILED a.py::test_a\nFAILED a.py::test_b\nFAILED a.py::test_c\nE   assert 1 == 2\n";
  assert.equal(secondTryText({ passed: 1, failed: 3 }, t, "x.py\n```\nx\n```", 2), "Tree now: 1/4 pass. Still fail: test_a, test_b (+1 more). First error: assert 1 == 2.\n\nFiles now:\n\nx.py\n```\nx\n```\n\nEdit blocks only. Fix what fails. No rewrite.");
  assert.equal(secondTryText({ passed: 1, failed: 1 }, t, "x.py", 2, "t.py\n```\ndef test_a(): ...\n```"), "Tree now: 1/2 pass. Still fail: test_a, test_b (+1 more). First error: assert 1 == 2.\n\nFailing tests:\n\nt.py\n```\ndef test_a(): ...\n```\n\nFiles now:\n\nx.py\n\nEdit blocks only. Fix what fails. No rewrite.");
});

// ---- window sizing

const PYTEST = [
  "import unittest",
  "",
  "class T(unittest.TestCase):",
  "    def helper(self):",
  "        return 1",
  "",
  "    def test_one(self):",
  "        self.assertEqual(1, 1)",
  "",
  "    @unittest.skip('x')",
  "    def test_two(self):",
  "        self.assertEqual(2, 2)",
  "",
  "    def test_three(self):",
  "        self.assertEqual(3, 3)",
  "",
  "def test_top():",
  "    assert True",
  "",
].join("\n");

test("failingTestsOnly: passing test bodies (and their decorators) left out with a marker; helpers stay", () => {
  const only = failingTestsOnly("t_test.py", PYTEST, ["T::test_three", "t_test.py::test_top"])!;
  assert.match(only, /def helper\(self\):\n        return 1/);
  assert.match(only, /def test_three\(self\):\n        self\.assertEqual\(3, 3\)/);
  assert.match(only, /def test_top\(\):/);
  assert.ok(!only.includes("test_one") && !only.includes("test_two") && !only.includes("@unittest.skip"));
  assert.match(only, /# \[2 passing tests not shown\]\n$/);
  assert.equal(failingTestsOnly("t_test.py", PYTEST, ["test_one", "test_two", "test_three", "test_top"]), null, "every test fails: nothing to leave out");
  assert.equal(failingTestsOnly("t_test.py", PYTEST, ["test_nowhere"]), null);
  assert.equal(failingTestsOnly("t.test.js", PYTEST, ["test_one"]), null, "Python only");
});

const SRC = "x.py\n```\n" + "def f():\n    return 1\n".repeat(20) + "```\n\nStep 2: edit blocks only.";
const HEAD: QuickHead = {
  outline: "x.py: def f()\n".repeat(200),
  test: { path: "t_test.py", text: PYTEST + "\n# padding\n".repeat(150) },
  failing: ["test_three"],
  testOut: "FAIL 1 failed, 3 passed in 0.1s\n" + "FAILED t_test.py::T::test_three - assert\n".repeat(30),
  task: "Make f return 3. ".repeat(100) + "\nEdit x.py so that the tests pass.",
};
const build = (h: string): Message[] => [{ role: "system", content: SYSTEM }, { role: "user", content: h }, { role: "assistant", content: '{"files":["x.py"]}' }, { role: "user", content: SRC }];
const opts = (window: number): FitOpts => ({ window, reserve: 2048, stepMax: 4096, charsPerToken: 2.6 });
const size = (h: QuickHead): number => estTokens(build(headText(h)), 2.6);

test("window fit: a prompt that fits is sent whole, max_tokens = the room left, at most the step cap", () => {
  const whole = size(HEAD);
  const big = fitHead(HEAD, build, opts(32768))!;
  assert.deepEqual(big.cuts, []);
  assert.equal(big.tokens, whole);
  assert.equal(big.maxTokens, 4096, "never above the edit step's cap");
  const tight = fitHead(HEAD, build, opts(whole + 2048 + 100))!;
  assert.deepEqual(tight.cuts, []);
  assert.equal(tight.maxTokens, 2048 + 100, "the room left in the window");
  assert.equal(headText({ ...HEAD }), build(headText(HEAD))[1]!.content);
});

test("window fit: shrinks the outline first, then the test file to its failing tests, then the test output, then the task", () => {
  const noOutline = size({ ...HEAD, outline: null });
  const f1 = fitHead(HEAD, build, opts(noOutline + 2048))!;
  assert.deepEqual(f1.cuts, ["outline"]);
  assert.ok(!f1.msgs[1]!.content.includes("Repository outline"));
  assert.ok(f1.tokens + 2048 <= noOutline + 2048 && f1.maxTokens === 2048);
  const f2 = fitHead(HEAD, build, opts(noOutline + 2048 - 50))!;
  assert.deepEqual(f2.cuts, ["outline", "passing tests"]);
  assert.match(f2.msgs[1]!.content, /def test_three/);
  assert.ok(!f2.msgs[1]!.content.includes("def test_one"));
  assert.match(f2.msgs[1]!.content, /# \[3 passing tests not shown\]/);
  const fewTests = size({ ...HEAD, outline: null, test: { ...HEAD.test!, text: failingTestsOnly("t_test.py", HEAD.test!.text, ["test_three"])! } });
  const f3 = fitHead(HEAD, build, opts(fewTests + 2048 - 50))!;
  assert.deepEqual(f3.cuts, ["outline", "passing tests", "test output"]);
  assert.match(f3.msgs[1]!.content, /Test output now:\nFAIL 1 failed, 3 passed in 0\.1s\n\[test output cut for room; failing tests shown above\]/);
  const f4 = fitHead(HEAD, build, opts(f3.tokens + 2048 - 100))!;
  assert.deepEqual(f4.cuts, ["outline", "passing tests", "test output", "task text"]);
  assert.match(f4.msgs[1]!.content, /\[task text cut here for room\]\n[\s\S]*Edit x\.py so that the tests pass\.\n\nStep 1: JSON/, "the ask at the end stays");
  assert.ok(f4.tokens + 2048 <= f3.tokens + 2048 - 100);
  for (const f of [f1, f2, f3, f4]) assert.equal(f.msgs[3]!.content, SRC, "the source file is never cut");
  // the pick call keeps its outline
  const p = fitHead(HEAD, (h) => [{ role: "system", content: SYSTEM }, { role: "user", content: h }], { ...opts(noOutline + 2048 - 50), keepOutline: true })!;
  assert.ok(!p.cuts.includes("outline") && p.msgs[1]!.content.startsWith("Repository outline:"));
});

test("window fit: the source file alone leaves too little room: null (quick tries skipped)", () => {
  const huge = (h: string): Message[] => [...build(h).slice(0, 3), { role: "user", content: "x.py\n```\n" + "y = 1\n".repeat(3000) + "```" }];
  assert.equal(fitHead(HEAD, huge, opts(8192)), null);
  assert.equal(cutMiddle("abc", 10), "abc");
});

test("small window in the ladder: the edit call gets max_tokens = room left; a source that does not fit goes to Pi with no edit call", async () => {
  const x = await ladder([FAIL10, PASS], { lanes: { trunk: { contextWindow: 4096 } }, ladder: { replyReserve: 1024 } }, ALLFAIL.replies.slice(0, 2));
  const e = x.calls[1]!;
  const est = estTokens(e.messages, 2.6);
  assert.equal(e.opts.maxTokens, 4096 - est);
  assert.ok(e.opts.maxTokens! >= 1024 && e.opts.maxTokens! < 4096);
  assert.equal(x.r.solvedBy, "rung1");
  // the picked file alone does not fit: no edit call, Pi's loop from the original tree
  const y = await ladder([FAIL10], { lanes: { trunk: { contextWindow: 1500 } }, ladder: { replyReserve: 1024 } }, ALLFAIL.replies.slice(0, 1));
  assert.deepEqual(y.calls.map((c) => c.step), ["pick"]);
  assert.ok(y.lines.some((l) => /^quick tries skipped \(billing\/invoice\.py with the shortest task text leave less than 1024 reply tokens in the 1500-token window\)$/.test(l)), y.lines.join("\n"));
  assert.ok(y.seen);
  assert.deepEqual(y.atHandoff, y.before);
});

// ---- replay: the recorded bowling rung-1 prompt at 8k (P4000, gemma-4-12b; test/fixtures/fix/bowling-8k.json)

interface Bowling {
  recorded: { window: number; prompt_chars: number; prompt_tokens: number; completion_tokens: number; finish: string };
  source: { path: string; text: string };
  test: { path: string; text: string };
  testOut: string;
  task: string;
  messages: Message[];
}
const BOWL = JSON.parse(readFileSync(join(ROOT, "test/fixtures/fix/bowling-8k.json"), "utf8")) as Bowling;

async function bowling(window: number) {
  const dir = tmpDir("tinycode-bowl-");
  const cwd = join(dir, "work");
  mkdirSync(cwd);
  writeFileSync(join(cwd, BOWL.source.path), BOWL.source.text);
  writeFileSync(join(cwd, BOWL.test.path), BOWL.test.text);
  const s = scripted(cwd, ["no blocks"], "stop");
  const lines: string[] = [];
  await runFix({ ...parseFixArgs(`--test ${BOWL.test.path} ${BOWL.task}`), reproduce: false }, {
    cwd, config: mergeConfig({ test: { python: PY }, lanes: { trunk: { contextWindow: window, temperature: 0.3, seed: 3088661603 } }, ladder: { secondTry: false, rung3: false } }),
    chat: s.chat, report: (l) => lines.push(l), env: { TINYCODE_LOG: join(dir, "state", "calls.jsonl") }, runTests: fakeTests([BOWL.testOut]) as never,
  });
  return { call: s.calls[0]!, lines };
}

test("replay bowling 8k: the recorded 7.1k-token rung-1 prompt is rebuilt exactly at 32k, and at 8k it fits with the reply reserve", async () => {
  const chars = (ms: Message[]) => ms.reduce((n, m) => n + m.content.length, 0);
  const wide = await bowling(32768);
  // recorded before the code-only rule (operator 2026-10-30): the system text is the one difference
  const recorded = BOWL.messages.map((m) => (m.role === "system" ? { ...m, content: m.content.replace("No explanations.", `No explanations. ${CODE_ONLY_RULE}`) } : m));
  assert.deepEqual(wide.call.messages, recorded, "same prompt as recorded when the window is wide");
  assert.equal(chars(wide.call.messages), BOWL.recorded.prompt_chars + CODE_ONLY_RULE.length + 1);
  // the recorded prompt read at 2.62 chars per token: 18582 chars, 7082 tokens; 1110 reply tokens fit, finish length
  const ratio = BOWL.recorded.prompt_chars / BOWL.recorded.prompt_tokens;
  assert.ok(BOWL.recorded.prompt_tokens + 2048 > BOWL.recorded.window, "the old prompt left less than the reserve");
  const narrow = await bowling(8192);
  const sent = narrow.call.messages;
  const real = Math.ceil(chars(sent) / ratio) + 8 * sent.length; // what the server would count, at the recorded ratio
  assert.ok(real + 2048 <= 8192, `predicted ${real} tokens + 2048 reserve must fit 8192`);
  assert.ok(narrow.call.opts.maxTokens! <= 8192 - real, "max_tokens never asks past the window");
  assert.ok(narrow.call.opts.maxTokens! >= 2048);
  const u = sent[1]!.content;
  assert.ok(!u.startsWith("Repository outline"), "outline left out");
  assert.match(u, /\[test output cut for room; failing tests shown above\]/);
  assert.match(u, /def test_an_unstarted_game_cannot_be_scored/, "all 31 tests fail: every body stays");
  assert.match(u, /Edit bowling\.py so that the tests in bowling_test\.py pass\. Don't change the test file\./, "the task is whole");
  assert.equal(sent[3]!.content, BOWL.messages[3]!.content, "the source file as recorded");
  assert.ok(narrow.lines.includes("rung1 fit: cut outline, test output (est " + narrow.lines.find((l) => l.startsWith("rung1 fit:"))!.match(/est (\d+)/)![1] + " of 8192 tok, 2048 kept for the reply)"));
  console.log(`bowling rung-1 prompt: ${chars(BOWL.messages)} chars (${BOWL.recorded.prompt_tokens} tok recorded) -> ${chars(sent)} chars (~${real} tok at the recorded ratio), max_tokens ${narrow.call.opts.maxTokens}`);
});

test("failingTestsOnly: a failing name that is not a test of the file (cut off in a capped output): nothing left out", () => {
  assert.equal(failingTestsOnly("t_test.py", PYTEST, ["test_three", "test_tw"]), null);
});

test("failingTestsCode: the failing tests' code; the whole file when every test fails; null for an unknown name or a non-Python file", () => {
  assert.equal(failingTestsCode("t_test.py", PYTEST, ["test_three"]), failingTestsOnly("t_test.py", PYTEST, ["test_three"]));
  assert.equal(failingTestsCode("t_test.py", PYTEST, ["test_one", "T::test_two", "test_three", "test_top"]), PYTEST, "all fail: the file");
  assert.equal(failingTestsCode("t_test.py", PYTEST, ["test_nope"]), null);
  assert.equal(failingTestsCode("t.test.js", "x", ["a"]), null);
});
