import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { deepMerge, DEFAULTS, mergeConfig, type Config } from "../../src/config.ts";
import type { ChatResult, Message } from "../../src/llm.ts";
import { better, formatReview, PICK_SCHEMA, REVIEW_SCHEMA, parseFixArgs, restoreSnapshot, runFix, soleSource, takeSnapshot, undoFix, type PiHandoff } from "../../src/workflows/fix.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const PY = (process.env.TINYCODE_TEST_PYTHON ?? "python3");

interface Fixture {
  repo: string;
  test: string | null;
  replies: string[];
}
const fixture = (n: string): Fixture => JSON.parse(readFileSync(join(ROOT, "test/fixtures/fix", n + ".json"), "utf8"));

function setup(f: Fixture) {
  const dir = tmpDir("tinycode-fix-");
  const cwd = join(dir, "repo");
  cpSync(join(ROOT, "test/fixtures/task-repos", f.repo), cwd, { recursive: true, filter: (s) => !s.includes("__pycache__") });
  const env = { TINYCODE_LOG: join(dir, "state", "calls.jsonl") };
  return { dir, cwd, env };
}

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

function scripted(replies: string[]) {
  const calls: { step: string; messages: Message[]; schema?: object }[] = [];
  let i = 0;
  const chat = async (step: string, messages: Message[], o?: { schema?: object }): Promise<ChatResult> => {
    calls.push({ step, messages: structuredClone(messages), schema: o?.schema });
    assert.ok(i < replies.length, `unexpected extra call #${i + 1} (${step})`);
    return { text: replies[i++], usage: { prompt_tokens: 10, cached_tokens: 0, completion_tokens: 5 }, ms: 1, lane: "trunk", model: "gemma-4-12b", fellBack: false };
  };
  return { chat, calls };
}

// the scripted replies include the pick: the sole-source skip is off here and tested on its own
const cfg = (over: unknown = {}): Config => mergeConfig(deepMerge({ test: { python: PY }, ladder: { skipSolePick: false } }, over));

test("parseFixArgs: flags from the front, rest is the task", () => {
  assert.deepEqual(parseFixArgs("--test tests/test_task.py Fix the bug.\nSecond line"), { test: "tests/test_task.py", undo: false, task: "Fix the bug.\nSecond line" });
  assert.deepEqual(parseFixArgs("--undo"), { test: undefined, undo: true, task: "" });
  assert.deepEqual(parseFixArgs("plain task mentioning --test later"), { test: undefined, undo: false, task: "plain task mentioning --test later" });
});

test("rung 1 pass on t01-paginate: 2 calls, tc1 message layout, undo restores", async () => {
  const f = fixture("t01-rung1");
  const { cwd, env } = setup(f);
  const before = tree(cwd);
  const s = scripted(f.replies);
  const lines: string[] = [];
  const r = await runFix({ ...parseFixArgs("paginate is wrong. Fix it."), reproduce: false }, { cwd, config: cfg(), chat: s.chat, report: (l) => lines.push(l), env });
  assert.equal(r.solvedBy, "rung1");
  assert.equal(r.calls, 2);
  assert.deepEqual(s.calls.map((c) => c.step), ["pick", "edit"]);
  assert.equal(s.calls[0].schema, PICK_SCHEMA);
  assert.match(s.calls[0].messages[1].content, /^Repository outline:\npager\.py: def paginate\(items, page, size\)/);
  assert.match(s.calls[0].messages[1].content, /\n\nTask:\npaginate is wrong\. Fix it\.\n\nStep 1: JSON/);
  assert.match(s.calls[1].messages[3].content, /^pager\.py\n```\ndef paginate/);
  assert.match(s.calls[1].messages[3].content, /Step 2: edit blocks only\.$/);
  assert.ok(lines.includes("solved_by: rung1") && lines.includes("calls: 2"));
  assert.match(readFileSync(join(cwd, "pager.py"), "utf8"), /\(page - 1\) \* size/);
  assert.equal(readFileSync(join(env.TINYCODE_LOG, "../fix-replies.jsonl"), "utf8").trim().split("\n").length, 2);
  assert.match(undoFix(cwd, env), /restored 1 file/);
  assert.deepEqual(tree(cwd), before);
});

test("rung 2 pass on r2-03: 4 calls, review in a fresh context, diagnosis at the tail", async () => {
  const f = fixture("r2-03-rung2");
  const { cwd, env } = setup(f);
  const s = scripted(f.replies);
  const r = await runFix(parseFixArgs(`--test ${f.test} Rendering an invoice crashes with KeyError: 'tax'.`), { cwd, config: cfg({ ladder: { rung2: true } }), chat: s.chat, report: () => {}, env });
  assert.equal(r.solvedBy, "rung2");
  assert.equal(r.calls, 4);
  assert.deepEqual(s.calls.map((c) => c.step), ["pick", "edit", "review", "edit"]);
  assert.equal(s.calls[2].schema, REVIEW_SCHEMA);
  assert.equal(s.calls[2].messages.length, 2, "review is a fresh two-message context");
  const rv = s.calls[2].messages[1].content;
  assert.match(rv, /Test output:\nFAIL .*\n[\s\S]*Failing assertions:\n[\s\S]*\nE /);
  assert.match(rv, /Files changed \(current code\):\nbilling\/\S+ \(current, complete\)\n```\n\s+1: [\s\S]*taxes/);
  assert.ok(!rv.includes("Search hits") && !rv.includes("Diff tried"));
  assert.match(s.calls[2].messages[0].content, /Never call code incomplete when file shown/);
  const last = s.calls[3].messages;
  assert.equal(last.length, 6);
  assert.equal(last[0].content, s.calls[1].messages[0].content, "same system prompt");
  assert.deepEqual(last.slice(0, 4), s.calls[1].messages.slice(0, 4), "rung-1 conversation is an unchanged prefix");
  assert.equal(last[4].content, f.replies[1]);
  assert.match(last[5].content, /^Applied: \['billing\/templates\.py'\]\. Not applied: none\.\nTest:\nFAIL /);
  assert.match(last[5].content, /Reviewer:\nDiagnosis: The test still calls breakdown\(\)\['tax'\]/);
});

test("all rungs fail: tree restored before Pi, handoff carries the diagnosis, Pi's pass counts", async () => {
  const f = fixture("r2-03-allfail");
  const { cwd, env } = setup(f);
  const before = tree(cwd);
  const s = scripted(f.replies);
  let seen: PiHandoff | null = null;
  let treeAtHandoff: Record<string, string> = {};
  const pi = async (h: PiHandoff) => {
    seen = h;
    treeAtHandoff = tree(cwd);
    writeFileSync(join(cwd, "billing/pricing.py"), readFileSync(join(cwd, "billing/pricing.py"), "utf8").replace('"taxes": taxes', '"tax": taxes'));
    writeFileSync(join(cwd, "billing/templates.py"), readFileSync(join(cwd, "billing/templates.py"), "utf8"));
    return { turns: 3 };
  };
  const lines: string[] = [];
  const r = await runFix(parseFixArgs(`--test ${f.test} Fix the invoice.`), { cwd, config: cfg({ ladder: { rung2: true } }), chat: s.chat, pi, report: (l) => lines.push(l), env });
  assert.deepEqual(treeAtHandoff, before, "Pi starts from the original tree");
  assert.ok(seen);
  const h = seen as PiHandoff;
  assert.match(h.text, /^Fix the invoice\./);
  assert.match(h.text, /Diagnosis: The test still calls breakdown\(\)\['tax'\]/);
  assert.match(h.text, /edits undone/);
  assert.equal(h.turnCap, DEFAULTS.ladder.loopTurnCap);
  assert.equal(r.solvedBy, "pi");
  assert.equal(r.calls, 4 + 3);
  assert.ok(lines.some((l) => l.startsWith("restored: ")));
  assert.ok(lines.includes("rung3: pi"));
  // and when Pi fails too, the verdict is none
  const f2 = setup(f);
  const s2 = scripted(f.replies);
  const r2 = await runFix(parseFixArgs(`--test ${f.test} Fix the invoice.`), { cwd: f2.cwd, config: cfg({ ladder: { rung2: true } }), chat: s2.chat, pi: async () => ({ turns: 1 }), report: () => {}, env: f2.env });
  assert.equal(r2.solvedBy, "none");
});

test("no Pi available / rung3 off: solved_by none, tree left as the ladder left it", async () => {
  const f = fixture("r2-03-allfail");
  const { cwd, env } = setup(f);
  const s = scripted(f.replies);
  const r = await runFix(parseFixArgs(`--test ${f.test} Fix the invoice.`), { cwd, config: cfg(), chat: s.chat, report: () => {}, env });
  assert.equal(r.solvedBy, "none");
  assert.equal(r.handoff, null);
});

test("singleFileOnly: a trunk listed there with > 1 picked file skips to rung 3 (no edit call)", async () => {
  const f = fixture("r2-03-twofiles");
  const { cwd, env } = setup(f);
  const before = tree(cwd);
  const s = scripted(f.replies);
  let handed: PiHandoff | null = null;
  const c = cfg({ lanes: { trunk: { baseUrl: "http://x/v1", model: "qwen3.5-4b" } }, ladder: { singleFileOnly: ["qwen3.5-4b"] } });
  const lines: string[] = [];
  const r = await runFix(parseFixArgs(`--test ${f.test} Fix the invoice.`), {
    cwd, config: c, chat: s.chat, report: (l) => lines.push(l), env,
    pi: async (h) => { handed = h; return { turns: 2 }; },
  });
  assert.deepEqual(s.calls.map((x) => x.step), ["pick"]);
  assert.ok(handed);
  assert.equal((handed as PiHandoff).text, "Fix the invoice.", "no diagnosis: the review never ran");
  assert.ok(lines.some((l) => l.startsWith("rung 1 skipped")));
  assert.equal(r.solvedBy, "none");
  assert.equal(r.calls, 1 + 2);
  assert.deepEqual(tree(cwd), before);
});

test("ladder.mode pi goes straight to the loop with zero direct calls", async () => {
  assert.equal(DEFAULTS.ladder.mode, "auto");
  const f = fixture("r2-03-twofiles");
  const { cwd, env } = setup(f);
  const s = scripted([]);
  const c = cfg({ lanes: { trunk: { baseUrl: "http://x/v1", model: "qwen3.5-4b" } }, ladder: { mode: "pi" } });
  let handed: PiHandoff | null = null;
  const r = await runFix(parseFixArgs("--test tests/test_task.py Fix the invoice."), {
    cwd, config: c, chat: s.chat, report: () => {}, env,
    pi: async (h) => { handed = h; return { turns: 5 }; },
  });
  assert.equal(s.calls.length, 0);
  assert.equal((handed as PiHandoff | null)?.text, "Fix the invoice.");
  assert.equal(r.direct, 0);
  assert.equal(r.calls, 5);
});

test("undo with no snapshot says so", () => {
  const d = tmpDir("tinycode-fix-");
  assert.match(undoFix(d, { TINYCODE_LOG: join(d, "s", "calls.jsonl") }), /nothing to undo/);
});

test("restore removes files the ladder created and the directory it made", () => {
  const f = fixture("t01-rung1");
  const { cwd, env } = setup(f);
  takeSnapshot(cwd, env);
  mkdirSync(join(cwd, "core/__pycache__"), { recursive: true });
  writeFileSync(join(cwd, "core/currency.py"), "x = 1\n");
  writeFileSync(join(cwd, "pager.py"), "changed\n");
  const r = restoreSnapshot(cwd, env);
  assert.deepEqual(r, { restored: ["pager.py"], removed: ["core/currency.py"] });
  assert.equal(existsSync(join(cwd, "core")), false);
  assert.match(readFileSync(join(cwd, "pager.py"), "utf8"), /def paginate/);
});

// ---- no failing test: reproduce the described bug first (as /test does), then the ladder
const tblock = (path: string, search: string, replace: string) => `${path}\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n`;
function slugRepo() {
  const dir = tmpDir("tinycode-fix-");
  const cwd = join(dir, "repo");
  cpSync(join(ROOT, "test/fixtures/task-repos/t03-slugify"), cwd, { recursive: true, filter: (s) => !s.includes("__pycache__") });
  return { cwd, env: { TINYCODE_LOG: join(dir, "state", "calls.jsonl") } };
}
const INTENDED = "Intended behaviour:\n- title_case capitalises each word\n\n";

test("no failing test, behaviour already works: couldn't reproduce, test shown and undone, ladder never starts", async () => {
  const { cwd, env } = slugRepo();
  const before = tree(cwd);
  const s = scripted([INTENDED + tblock("tests/test_textutil_repro.py", "", "from textutil import title_case\n\n\ndef test_title_case_lower():\n    assert title_case('abc def') == 'Abc Def'\n")]);
  const lines: string[] = [];
  const r = await runFix({ ...parseFixArgs("title_case does not capitalise lowercase words"), }, { cwd, config: cfg(), chat: s.chat, pi: async () => assert.fail("no Pi"), report: (l) => lines.push(l), env });
  assert.equal(s.calls.length, 1, "one test-writing call, no ladder calls");
  assert.equal(r.solvedBy, "none");
  assert.equal(r.notReproduced?.test, "tests/test_textutil_repro.py");
  assert.match(r.notReproduced!.text, /def test_title_case_lower/);
  assert.ok(lines.some((l) => /^couldn't reproduce: the described behaviour already works \(test: tests\/test_textutil_repro\.py\)/.test(l)));
  assert.ok(lines.some((l) => /def test_title_case_lower/.test(l)), "the test is shown");
  assert.deepEqual(tree(cwd), before, "the test is undone");
});

test("no failing test, bug reproduced: the ladder continues with the reproduction test as its test", async () => {
  const { cwd, env } = slugRepo();
  const s = scripted([
    INTENDED + tblock("tests/test_textutil_repro.py", "", "from textutil import slugify\n\n\ndef test_slug_collapses():\n    assert slugify('a  b') == 'a-b'\n"),
    JSON.stringify({ files: ["textutil.py"], reason: "slugify" }),
    tblock("textutil.py", '    return re.sub(r"[^a-z0-9]", "-", text)', '    return re.sub(r"[^a-z0-9]+", "-", text)'),
  ]);
  const lines: string[] = [];
  const r = await runFix(parseFixArgs("slugify keeps repeated dashes"), { cwd, config: cfg(), chat: s.chat, report: (l) => lines.push(l), env });
  assert.deepEqual(s.calls.map((c) => c.step), ["edit", "pick", "edit"]);
  assert.equal(r.solvedBy, "rung1");
  assert.equal(r.reproTest, "tests/test_textutil_repro.py");
  assert.equal(r.calls, 3);
  assert.ok(lines.some((l) => /^reproduced: the new test tests\/test_textutil_repro\.py fails/.test(l)));
  assert.match(s.calls[1].messages[1].content, /tests\/test_textutil_repro\.py/);
  // /fix --undo takes the tree back to before the reproduction test, too
  assert.match(undoFix(cwd, env), /undone/);
  assert.equal(existsSync(join(cwd, "tests/test_textutil_repro.py")), false);
  assert.match(readFileSync(join(cwd, "textutil.py"), "utf8"), /\[\^a-z0-9\]"/);
});

test("no failing test, no reproduction possible: the ladder runs as before, without a test", async () => {
  const dir = tmpDir("tinycode-fix-");
  mkdirSync(join(dir, "r"));
  writeFileSync(join(dir, "r", "notes.txt"), "hello\n");
  const s = scripted([JSON.stringify({ files: ["notes.txt"], reason: "x" }), "no blocks"]);
  const r = await runFix(parseFixArgs("fix the typo in the notes"), { cwd: join(dir, "r"), config: cfg({ ladder: { rung2: false } }), chat: s.chat, report: () => {}, env: { TINYCODE_LOG: join(dir, "state", "calls.jsonl") } });
  assert.deepEqual(s.calls.map((c) => c.step), ["pick", "edit"]);
  assert.equal(r.notReproduced, undefined);
});

// ---- F2: a review cut off by the token limit

test("formatReview: whole JSON, cut-off JSON, and prose never come out as a bare brace", () => {
  assert.equal(formatReview('{"diagnosis":"d","where":["a.py:1","b.py:2"],"next_step":"n"}'), "Diagnosis: d\nWhere: a.py:1, b.py:2\nNext step: n");
  const cut = formatReview('{"diagnosis": "The loop never\\nends because \\"x\\" is reset", "where": ["a.py:12", "b.py');
  assert.match(cut, /^Diagnosis: The loop never\nends because "x" is reset\nWhere: a\.py:12\nNext step: $/);
  assert.equal(formatReview('{"diagnosis": "cut here and'), "Diagnosis: cut here and\nWhere: \nNext step: ");
  assert.equal(formatReview("It fails because\nthe key is wrong."), "It fails because the key is wrong.");
  assert.notEqual(formatReview("{"), "{");
  assert.match(formatReview("{"), /cut off/);
  assert.equal(DEFAULTS.limits.maxTokens.review, 600);
});

// ---- F4: keep the ladder's best tree when it beats the original

function fakeTests(texts: string[]) {
  let i = 0;
  return async () => {
    const text = texts[Math.min(i++, texts.length - 1)];
    return { ok: text.startsWith("PASS"), text, code: text.startsWith("PASS") ? 0 : 1, timedOut: false };
  };
}
const FAIL10 = "FAIL 10 failed in 0.1s\n";
const FAIL4 = "FAIL 4 failed, 6 passed in 0.1s\n";

// rung 3's starting tree after rungs 1-2; the second quick try (rung 1b) is off here and tested in secondtry.test.ts
async function allFail(texts: string[], ladder: Record<string, unknown> = {}) {
  const f = fixture("r2-03-allfail");
  const { cwd, env } = setup(f);
  const before = tree(cwd);
  let atHandoff: Record<string, string> = {};
  let seen: PiHandoff | null = null;
  const pi = async (h: PiHandoff) => {
    seen = h;
    atHandoff = tree(cwd);
    return { turns: 1 };
  };
  const lines: string[] = [];
  const r = await runFix(parseFixArgs(`--test ${f.test} Fix the invoice.`), { cwd, config: cfg({ ladder: { rung2: true, secondTry: false, ...ladder } }), chat: scripted(f.replies).chat, pi, report: (l) => lines.push(l), env, runTests: fakeTests(texts) as never });
  return { cwd, env, before, atHandoff, seen: seen as PiHandoff | null, r, lines };
}

test("ladder progress is kept: rung 1 took 10 failing to 4, rung 2 changed nothing: rung 3 starts from rung 1's tree", async () => {
  const x = await allFail([FAIL10, FAIL4, FAIL4, FAIL4]);
  assert.match(x.atHandoff["billing/invoice.py"], /tax=0/, "rung 1's edit is in the tree Pi starts from");
  assert.notDeepEqual(x.atHandoff, x.before);
  const want = "Kept rung 1 tree: 6/10 pass. Edit only what fails. No rewrite.";
  assert.equal(x.r.kept, want);
  assert.equal(x.seen!.text.split("\n\n").slice(1).join("\n\n"), want, "task, then the kept text once");
  assert.ok(!x.seen!.text.includes("Diagnosis"), "the reviewer's prose describes an earlier tree");
  assert.ok(!x.seen!.text.includes("were undone"));
  assert.ok(x.lines.includes(want));
  // /fix --undo still goes back to the original
  assert.match(undoFix(x.cwd, x.env), /restored/);
  assert.deepEqual(tree(x.cwd), x.before);
});

test("ladder.keepBest false: rung 1 took 10 failing to 4, yet Pi starts from the original tree, edits undone", async () => {
  const x = await allFail([FAIL10, FAIL4, FAIL4, FAIL4], { keepBest: false });
  assert.deepEqual(x.atHandoff, x.before, "clean code for Pi's own reasoning");
  assert.equal(x.r.kept, null);
  assert.match(x.seen!.text, /edits undone/);
});

test("ladder progress: no better than the original, or counts unreadable: the original tree, as before", async () => {
  for (const texts of [[FAIL10, FAIL10, FAIL10, FAIL10], ["FAIL", "FAIL 3 odd", "FAIL", "FAIL"], [FAIL4, FAIL10, FAIL10, FAIL10]]) {
    const x = await allFail(texts);
    assert.deepEqual(x.atHandoff, x.before, JSON.stringify(texts));
    assert.equal(x.r.kept, null);
    assert.match(x.seen!.text, /edits undone/);
  }
});

test("ladder progress: a later rung that beats the first is the one kept", async () => {
  const x = await allFail([FAIL10, FAIL4, "FAIL 2 failed, 8 passed in 0.1s\n", "FAIL"]);
  assert.match(x.r.kept ?? "", /^Kept rung 2 tree: 8\/10 pass\./);
});

test("better: more passing wins; fewer failing only counts when no test was lost", () => {
  assert.equal(better({ passed: 6, failed: 4 }, { passed: 0, failed: 10 }), true);
  assert.equal(better({ passed: 0, failed: 1 }, { passed: 0, failed: 10 }), false); // collection error: 1 error of 1
  assert.equal(better({ passed: 0, failed: 9 }, { passed: 0, failed: 10 }), false); // a test went missing
  assert.equal(better({ passed: 2, failed: 3 }, { passed: 2, failed: 4 }), false); // a test went missing
  assert.equal(better({ passed: 4, failed: 6 }, { passed: 4, failed: 6 }), false);
});

// ---- F8: a cut diff says it is cut
import { cutWithMarker, handoverText, REVIEW_SYSTEM } from "../../src/workflows/fix.ts";

test("cutWithMarker: short text untouched; long text cut at a line with a marker saying the files are complete", () => {
  assert.equal(cutWithMarker("a\nb", 100), "a\nb");
  const diff = Array.from({ length: 1000 }, (_, i) => `+line ${i}`).join("\n");
  const cut = cutWithMarker(diff, 3000);
  const lines = cut.split("\n");
  assert.match(lines.at(-1)!, /^\[diff cut here at \d+ chars; files on disk are complete\]$/);
  assert.ok(lines.slice(0, -1).every((l) => /^\+line \d+$/.test(l)), "cut at a line boundary, no half line");
  assert.ok(cut.length <= 3000 + 100);
  assert.equal(DEFAULTS.ladder.reviewDiffChars, 3000);
  assert.throws(() => mergeConfig({ ladder: { reviewDiffChars: 0 } }), /ladder\.reviewDiffChars/);
  assert.match(REVIEW_SYSTEM, /cut for length; files on disk are complete/);
  assert.match(REVIEW_SYSTEM, /Files shown are complete current code/);
});

test("handoverText: the reviewer's diagnosis, cut with a marker when long", () => {
  assert.equal(handoverText("task\n\nReviewer diagnosis of last attempt:\nshort"), "Reviewer diagnosis of last attempt:\nshort");
  assert.match(handoverText("Reviewer diagnosis of last attempt: " + "word ".repeat(400)), /\[hand-over cut here at \d+ chars; /);
});

// ---- hand-over of a kept tree, review prompt

import { keptText, diffFiles, numberedFile } from "../../src/workflows/fix.ts";
import { failingNames, failureBlocks, firstErrorLine } from "../../src/testrun.ts";

const PYTEXT = [
  "FAIL 3 failed, 28 passed in 0.5s",
  "FAILED test_b.py::test_one - assert 1 == 2",
  "FAILED test_b.py::test_two - KeyError",
  "FAILED test_b.py::test_three",
  "First error:",
  ">   assert score(x) == 5",
  "E   assert 4 == 5",
  "E    +  where 4 = score(x)",
].join("\n");

test("keptText: counts, failing names (capped), first error line, the rule; no prose", () => {
  assert.equal(
    keptText(2, { passed: 28, failed: 3 }, PYTEXT),
    "Kept rung 2 tree: 28/31 pass. Still fail: test_one, test_two, test_three. First error: assert 4 == 5. Edit only what fails. No rewrite.",
  );
  const capped = keptText(2, { passed: 28, failed: 3 }, PYTEXT, 2);
  assert.match(capped, /Still fail: test_one, test_two \(\+1 more\)\./);
  assert.match(keptText(1, { passed: 1, failed: 1 }, "FAIL"), /^Kept rung 1 tree: 1\/2 pass\. Edit only what fails\. No rewrite\.$/);
  assert.deepEqual(failingNames(PYTEXT, 8), { names: ["test_one", "test_two", "test_three"], total: 3 });
  assert.equal(firstErrorLine(PYTEXT), "assert 4 == 5");
  assert.equal(DEFAULTS.ladder.keptFailNames, 8);
  assert.throws(() => mergeConfig({ ladder: { keptFailNames: 0 } }), /ladder\.keptFailNames/);
  assert.throws(() => mergeConfig({ ladder: { reviewFileLines: 0 } }), /ladder\.reviewFileLines/);
  assert.throws(() => mergeConfig({ ladder: { reviewFailBlocks: 0 } }), /ladder\.reviewFailBlocks/);
  assert.throws(() => mergeConfig({ ladder: { reviewOutlineChars: -1 } }), /ladder\.reviewOutlineChars/);
});

test("kept tree: hand-over names the failing tests once, with no reviewer prose", async () => {
  const FAIL_NAMES = "FAIL 3 failed, 7 passed in 0.1s\nFAILED t/test_a.py::test_x - boom\nFAILED t/test_a.py::test_y\nFirst error:\nE   KeyError: 'tax'\n";
  const x = await allFail([FAIL10, FAIL_NAMES, FAIL_NAMES, FAIL_NAMES]);
  assert.equal(x.r.kept, "Kept rung 1 tree: 7/10 pass. Still fail: test_x, test_y (+1 more). First error: KeyError: 'tax'. Edit only what fails. No rewrite.");
  assert.equal(x.seen!.text.split("test_x").length, 2, "names appear once in the hand-over");
  assert.ok(!x.seen!.text.includes("Diagnosis") && !x.seen!.text.includes("Reviewer"));
  assert.ok(!(x.r.handoff ?? "").includes("Reviewer"));
});

test("diffFiles and numberedFile: changed paths, whole file numbered, cut with the marker line", () => {
  assert.deepEqual(diffFiles("--- a/x.py\n+++ b/x.py\n@@\n+a\n--- a/y.py\n+++ /dev/null\n+++ b/x.py\n"), ["x.py"]);
  assert.equal(numberedFile("a\nb\n", 5), "   1: a\n   2: b");
  const cut = numberedFile(Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n"), 3);
  assert.equal(cut, "   1: l0\n   2: l1\n   3: l2\n[file cut here at line 3 of 10; files on disk are complete]");
});

test("failureBlocks: per failing test the > line, E lines and location; capped", () => {
  const raw = [
    "=== FAILURES ===",
    "____ test_one ____",
    "",
    "    def test_one():",
    ">       assert f() == 2",
    "E       assert 1 == 2",
    "",
    "t.py:5: AssertionError",
    "____ test_two ____",
    ">       g()",
    "E       KeyError: 'a'",
    "=== short test summary info ===",
    "E   not in a block",
  ].join("\n");
  assert.equal(failureBlocks(raw, 6, 12), "test_one\n>       assert f() == 2\nE       assert 1 == 2\nt.py:5: AssertionError\n\ntest_two\n>       g()\nE       KeyError: 'a'");
  assert.equal(failureBlocks(raw, 1, 2), "test_one\n>       assert f() == 2");
  assert.equal(failureBlocks("no sections", 6, 12), "");
});

test("review prompt: full changed file (capped), failing assertions from raw output, no search hits", async () => {
  const f = fixture("r2-03-allfail");
  const { cwd, env } = setup(f);
  const s = scripted(f.replies);
  const raw = "____ test_one ____\n>   assert a\nE   assert 1 == 2\n";
  const tests = async () => ({ ok: false, text: "FAIL 1 failed, 0 passed in 0.1s\n", raw, code: 1, timedOut: false });
  await runFix(parseFixArgs(`--test ${f.test} Fix the invoice.`), { cwd, config: cfg({ ladder: { rung2: true, reviewFileLines: 2, reviewOutlineChars: 0 } }), chat: s.chat, pi: async () => ({ turns: 0 }), report: () => {}, env, runTests: tests as never });
  const rv = s.calls.find((c) => c.step === "review")!.messages[1].content;
  assert.match(rv, /Failing assertions:\ntest_one\n>   assert a\nE   assert 1 == 2\n/);
  assert.match(rv, /\(current, complete\)\n```\n\s+1: [^\n]*\n\s+2: [^\n]*\n\[file cut here at line 2 of \d+; files on disk are complete\]\n```/);
  assert.ok(!rv.includes("Search hits") && !rv.includes("Outline:"));
});

test("rung 1, one source file (t01-paginate: pager.py + its test): no pick call, the edit call sees the same layout", async () => {
  const f = fixture("t01-rung1");
  const { cwd, env } = setup(f);
  assert.equal(soleSource(cwd), "pager.py");
  const s = scripted(f.replies.slice(1)); // no pick reply needed
  const lines: string[] = [];
  const r = await runFix({ ...parseFixArgs("paginate is wrong. Fix it."), reproduce: false }, { cwd, config: mergeConfig({ test: { python: PY } }), chat: s.chat, report: (l) => lines.push(l), env });
  assert.equal(r.solvedBy, "rung1");
  assert.deepEqual(s.calls.map((c) => c.step), ["edit"]);
  assert.equal(r.calls, 1);
  assert.deepEqual(JSON.parse(String(s.calls[0]!.messages[2]!.content)).files, ["pager.py"]);
  assert.match(String(s.calls[0]!.messages[3]!.content), /pager\.py/);
  assert.ok(lines.some((l) => /pick skipped: pager\.py/.test(l)));
});

test("soleSource: tests, conftest and __init__ do not count; two sources or none = null", () => {
  const d = tmpDir("tinycode-sole-");
  writeFileSync(join(d, "a.py"), "x = 1\n");
  writeFileSync(join(d, "a_test.py"), "");
  writeFileSync(join(d, "test_utils.py"), "");
  writeFileSync(join(d, "conftest.py"), "");
  writeFileSync(join(d, "README.md"), "");
  assert.equal(soleSource(d), "a.py");
  writeFileSync(join(d, "b.py"), "");
  assert.equal(soleSource(d), null);
  assert.equal(soleSource(tmpDir("tinycode-sole-empty-")), null);
  assert.equal(DEFAULTS.ladder.skipSolePick, true);
  assert.throws(() => mergeConfig({ ladder: { skipSolePick: "yes" } }), /skipSolePick/);
});
