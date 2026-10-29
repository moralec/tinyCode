import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DEFAULTS, mergeConfig, type Config } from "../../src/config.ts";
import type { ChatResult, Message } from "../../src/llm.ts";
import { PICK_SCHEMA, REVIEW_SCHEMA, parseFixArgs, restoreSnapshot, runFix, takeSnapshot, undoFix, type PiHandoff } from "../../src/workflows/fix.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const PY = (process.env.TINYCODE_TEST_PYTHON ?? "python3");

interface Fixture {
  repo: string;
  test: string | null;
  replies: string[];
}
const fixture = (n: string): Fixture => JSON.parse(readFileSync(join(ROOT, "test/fixtures/fix", n + ".json"), "utf8"));

function setup(f: Fixture) {
  const dir = mkdtempSync(join(tmpdir(), "tinycode-fix-"));
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

const cfg = (over: unknown = {}): Config => mergeConfig({ test: { python: PY }, ...(over as object) });

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
  const r = await runFix(parseFixArgs("paginate is wrong. Fix it."), { cwd, config: cfg(), chat: s.chat, report: (l) => lines.push(l), env });
  assert.equal(r.solvedBy, "rung1");
  assert.equal(r.calls, 2);
  assert.deepEqual(s.calls.map((c) => c.step), ["pick", "edit"]);
  assert.equal(s.calls[0].schema, PICK_SCHEMA);
  assert.match(s.calls[0].messages[1].content, /^Repository outline:\npager\.py: def paginate\(items, page, size\)/);
  assert.match(s.calls[0].messages[1].content, /\n\nTask:\npaginate is wrong\. Fix it\.\n\nStep 1: reply with JSON/);
  assert.match(s.calls[1].messages[3].content, /^pager\.py\n```\ndef paginate/);
  assert.match(s.calls[1].messages[3].content, /Step 2: reply with edit blocks only\.$/);
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
  const r = await runFix(parseFixArgs(`--test ${f.test} Rendering an invoice crashes with KeyError: 'tax'.`), { cwd, config: cfg(), chat: s.chat, report: () => {}, env });
  assert.equal(r.solvedBy, "rung2");
  assert.equal(r.calls, 4);
  assert.deepEqual(s.calls.map((c) => c.step), ["pick", "edit", "review", "edit"]);
  assert.equal(s.calls[2].schema, REVIEW_SCHEMA);
  assert.equal(s.calls[2].messages.length, 2, "review is a fresh two-message context");
  assert.match(s.calls[2].messages[1].content, /Test output:\nFAIL .*\n[\s\S]*Diff tried:\n[\s\S]*taxes[\s\S]*Search hits:/);
  const last = s.calls[3].messages;
  assert.equal(last.length, 6);
  assert.equal(last[0].content, s.calls[1].messages[0].content, "same system prompt");
  assert.deepEqual(last.slice(0, 4), s.calls[1].messages.slice(0, 4), "rung-1 conversation is an unchanged prefix");
  assert.equal(last[4].content, f.replies[1]);
  assert.match(last[5].content, /^Edits applied: \['billing\/templates\.py'\]\. Not applied \(reason\): none\.\nTest:\nFAIL /);
  assert.match(last[5].content, /A reviewer looked at the failure:\nDiagnosis: The test still calls breakdown\(\)\['tax'\]/);
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
  const r = await runFix(parseFixArgs(`--test ${f.test} Fix the invoice.`), { cwd, config: cfg(), chat: s.chat, pi, report: (l) => lines.push(l), env });
  assert.deepEqual(treeAtHandoff, before, "Pi starts from the original tree");
  assert.ok(seen);
  const h = seen as PiHandoff;
  assert.match(h.text, /^Fix the invoice\./);
  assert.match(h.text, /Diagnosis: The test still calls breakdown\(\)\['tax'\]/);
  assert.match(h.text, /edits were undone/);
  assert.equal(h.turnCap, DEFAULTS.ladder.loopTurnCap);
  assert.equal(r.solvedBy, "pi");
  assert.equal(r.calls, 4 + 3);
  assert.ok(lines.some((l) => l.startsWith("restored: ")));
  assert.ok(lines.includes("rung3: pi"));
  // and when Pi fails too, the verdict is none
  const f2 = setup(f);
  const s2 = scripted(f.replies);
  const r2 = await runFix(parseFixArgs(`--test ${f.test} Fix the invoice.`), { cwd: f2.cwd, config: cfg(), chat: s2.chat, pi: async () => ({ turns: 1 }), report: () => {}, env: f2.env });
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
  const d = mkdtempSync(join(tmpdir(), "tinycode-fix-"));
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
