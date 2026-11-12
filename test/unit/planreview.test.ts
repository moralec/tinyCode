// design plan-build-fit, E21 (stages.planReview): the read set, the review call, optional checks; byte-for-byte off.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { mergeConfig } from "../../src/config.ts";
import type { ChatOptions, ChatResult, Message } from "../../src/llm.ts";
import { checkProblem, parsePlan, PLAN_SCHEMA, PLAN_SCHEMA_CHECKS, PLAN_SYSTEM, PLAN_SYSTEM_CHECKS, planMarkdown, planReadSet, reviewScopeProblem, runPlan, validatePlan, type Plan } from "../../src/workflows/plan.ts";
import { runAcceptance } from "../../src/acceptance.ts";
import { checkSet } from "../../src/workflows/build.ts";
import { repoFiles } from "../../src/context/outline.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const FIX = join(ROOT, "test/fixtures/plan3");
const DRAFT = readFileSync(join(FIX, "draft.json"), "utf8");
const REQUEST = readFileSync(join(FIX, "request.md"), "utf8").trim();
const reply = (o: unknown): ChatResult => ({ text: typeof o === "string" ? o : JSON.stringify(o), usage: { prompt_tokens: 300, cached_tokens: 0, completion_tokens: 200 }, ms: 1, lane: "trunk", model: "m", fellBack: false });

function plan3(): string {
  const d = tmpDir("tc-planreview-");
  cpSync(join(FIX, "repo"), d, { recursive: true });
  return d;
}

function scripted(replies: unknown[]) {
  const calls: { step: string; messages: Message[]; opts: Record<string, unknown> }[] = [];
  let i = 0;
  const chat = async (step: string, messages: Message[], o: ChatOptions = {}): Promise<ChatResult> => {
    const opts = o as Record<string, unknown>;
    const { config: _c, env: _e, ...rest } = opts;
    calls.push({ step, messages: structuredClone(messages), opts: rest });
    assert.ok(i < replies.length, `unexpected extra call #${i + 1}`);
    return reply(replies[i++]);
  };
  return { chat, calls, left: () => replies.length - i };
}

const on = (extra: object = {}) => mergeConfig({ stages: { planReview: true }, ...extra });
const CHECK = { check: "python -m exporter.cli --list-formats", expect: "json(.json)" };
/** the recorded draft with settings.py added to task 5 and a check on every task: what a good review returns */
function goodReview(): Record<string, unknown> {
  const d = JSON.parse(DRAFT) as { tasks: Record<string, unknown>[] };
  d.tasks = d.tasks.map((t) => ({ ...t, ...CHECK, files: t.id === 5 ? [...(t.files as string[]), "exporter/settings.py"] : t.files }));
  return d;
}

test("byte-for-byte off: with every switch off the plan call (messages, schema, options), plan.json, PLAN.md and result equal today's snapshot", async () => {
  const snap = JSON.parse(readFileSync(join(FIX, "off-snapshot.json"), "utf8"));
  for (const kind of ["existing", "empty"] as const) {
    const cwd = kind === "existing" ? plan3() : tmpDir("tc-planreview-empty-");
    const s = scripted([DRAFT]);
    // planReview is on by default since 2026-11-12 (E21a accepted): this test is the switch set off
    const r = await runPlan({ request: REQUEST }, { cwd, config: mergeConfig({ stages: { planReview: false } }), chat: s.chat, report: () => {} });
    assert.deepEqual(JSON.parse(JSON.stringify(s.calls)), snap[kind].calls, kind);
    assert.equal(readFileSync(join(cwd, ".tinycode/plan.json"), "utf8"), snap[kind].planJson, kind);
    assert.equal(readFileSync(join(cwd, ".tinycode/PLAN.md"), "utf8"), snap[kind].planMd, kind);
    assert.deepEqual({ calls: r.calls, errors: r.errors }, snap[kind].result);
    assert.equal(r.review, undefined);
  }
  // the old constants are untouched; the new ones only add
  assert.equal(PLAN_SYSTEM_CHECKS.startsWith(PLAN_SYSTEM + "\n"), true);
  assert.deepEqual(Object.keys(PLAN_SCHEMA.properties.tasks.items.properties), ["id", "title", "files", "test"]);
  assert.deepEqual(Object.keys(PLAN_SCHEMA_CHECKS.properties.tasks.items.properties), ["id", "title", "files", "test", "check", "expect"]);
  assert.deepEqual(PLAN_SCHEMA_CHECKS.properties.tasks.items.required, ["id", "title", "files", "test"]);
});

test("plan-3 read set: the recorded draft brings in exporter/settings.py and cli.py's settings.EXTENSIONS line, within budget", () => {
  const cwd = plan3();
  const draft = validatePlan(JSON.parse(DRAFT)).plan!;
  const rs = planReadSet(cwd, draft, ["py", "ts"], 8000);
  assert.deepEqual(rs.files, [
    "exporter/formats/__init__.py", "exporter/cli.py", // named and existing, in task order
    "exporter/formats/json_fmt.py", "exporter/formats/text_fmt.py", "exporter/__init__.py", "exporter/settings.py", // imports
    "tests/test_formats.py", // importers
  ]);
  assert.deepEqual(rs.listed, []);
  assert.match(rs.text, /exporter\/settings\.py\n```\nEXTENSIONS/);
  assert.match(rs.text, /settings\.EXTENSIONS\[n\]/);
  assert.ok(rs.text.length < 3000, `read set ${rs.text.length} chars`);
  console.log(`plan-3 read set: ${rs.files.length} files, ${rs.text.length} chars`);
});

test("read set budget: a long file is cut at 150 lines with a marker; a file that does not fit is listed by name; nothing named = empty", () => {
  const cwd = tmpDir("tc-planreview-budget-");
  mkdirSync(join(cwd, "pkg"));
  writeFileSync(join(cwd, "pkg/__init__.py"), "");
  writeFileSync(join(cwd, "pkg/big.py"), Array.from({ length: 400 }, (_, i) => `X${i} = ${i}`).join("\n") + "\n");
  writeFileSync(join(cwd, "pkg/user.py"), "from pkg import big\n" + "# padding padding padding\n".repeat(300));
  const draft: Plan = { spec: "s", stack: "py", tasks: [{ id: 1, title: "t", files: ["pkg/big.py"], test: "t", done: false }] };
  const rs = planReadSet(cwd, draft, ["py"], 2500);
  assert.deepEqual(rs.files, ["pkg/big.py"]);
  assert.match(rs.text, /X149 = 149\n\.\.\. \(cut: 250 more lines\)/);
  assert.ok(!rs.text.includes("X150 ="));
  assert.deepEqual(rs.listed, ["pkg/user.py"]);
  assert.match(rs.text, /Not shown \(over the budget\): pkg\/user\.py$/);
  const none = planReadSet(cwd, { ...draft, tasks: [{ ...draft.tasks[0]!, files: ["pkg/new.py"] }] }, ["py"], 8000);
  assert.deepEqual(none, { files: [], listed: [], text: "" });
});

test("planReview on: an empty folder makes 1 call, with the checks prompt and schema; a draft check is kept", async () => {
  const cwd = tmpDir("tc-planreview-empty-");
  const draft = { spec: "A habit tracker.", stack: "Python", tasks: [1, 2, 3].map((id) => ({ id, title: `t${id}`, files: [`habits/m${id}.py`, "habits/__main__.py"], test: "x", check: "python -m habits list", expect: "no habits" })) };
  const s = scripted([draft]);
  const lines: string[] = [];
  const r = await runPlan({ request: "a habit tracker" }, { cwd, config: on(), chat: s.chat, report: (l) => lines.push(l) });
  assert.equal(r.calls, 1);
  assert.equal(r.review, "no review call: empty folder");
  assert.equal(s.calls[0]!.messages[0]!.content, PLAN_SYSTEM_CHECKS);
  assert.deepEqual(s.calls[0]!.opts.schema, PLAN_SCHEMA_CHECKS);
  assert.equal(r.plan!.tasks[0]!.check, "python -m habits list", "a -m target the plan creates is accepted");
  assert.ok(lines.includes('   check: python -m habits list (expects "no habits")'));
  assert.match(readFileSync(join(cwd, ".tinycode/PLAN.md"), "utf8"), /   - check: python -m habits list \(expects "no habits"\)/);
});

test("planReview on, plan-3: the review sees the read set and is used when it keeps every draft file and the task count", async () => {
  const cwd = plan3();
  const s = scripted([DRAFT, goodReview()]);
  const lines: string[] = [];
  const r = await runPlan({ request: REQUEST }, { cwd, config: on(), chat: s.chat, report: (l) => lines.push(l) });
  assert.equal(r.calls, 2);
  assert.equal(r.review, "used");
  const rv = s.calls[1]!.messages;
  assert.equal(rv.length, 4, "appended to the draft's conversation: the draft reply, then the review prompt");
  assert.equal(rv[2]!.role, "assistant");
  assert.match(rv[3]!.content, /^Files your tasks touch, and files linked to them:/);
  assert.match(rv[3]!.content, /settings\.EXTENSIONS\[n\]/);
  assert.match(rv[3]!.content, /Corrected JSON only\.$/);
  assert.deepEqual(s.calls[1]!.opts.schema, PLAN_SCHEMA_CHECKS);
  const saved = JSON.parse(readFileSync(join(cwd, ".tinycode/plan.json"), "utf8")) as Plan;
  assert.ok(saved.tasks[4]!.files.includes("exporter/settings.py"));
  assert.ok(saved.tasks.every((t) => t.check === CHECK.check && t.expect === CHECK.expect));
  assert.ok(lines.some((l) => /^plan review used \(7 file\(s\) read\)/.test(l)));
});

test("planReview on: a review that drops a draft file or has fewer tasks is not used; invalid twice keeps the draft", async () => {
  const dropped = goodReview();
  (dropped.tasks as Record<string, unknown>[])[0]!.files = ["exporter/formats/csv.py"];
  const fewer = goodReview();
  fewer.tasks = (fewer.tasks as unknown[]).slice(0, 5);
  const noFiles = goodReview();
  (noFiles.tasks as Record<string, unknown>[])[0]!.files = [];
  for (const [replies, why, calls] of [
    [[DRAFT, dropped], /not used: a file was dropped \(exporter\/formats\/csv_fmt\.py\)/, 2],
    [[DRAFT, fewer], /not used: fewer tasks \(5 < 6\)/, 2],
    [[DRAFT, noFiles, noFiles], /not used: invalid twice: task 1: files is empty/, 3],
  ] as const) {
    const cwd = plan3();
    const s = scripted([...replies]);
    const lines: string[] = [];
    const r = await runPlan({ request: REQUEST }, { cwd, config: on(), chat: s.chat, report: (l) => lines.push(l) });
    assert.equal(r.calls, calls);
    assert.match(r.review!, why);
    assert.ok(lines.some((l) => why.test(l)));
    const saved = JSON.parse(readFileSync(join(cwd, ".tinycode/plan.json"), "utf8")) as Plan;
    assert.equal(saved.tasks.length, 6);
    assert.deepEqual(saved.tasks[0]!.files, ["exporter/formats/csv_fmt.py"], "the draft is kept");
    assert.ok(saved.tasks.every((t) => t.check === undefined));
  }
});

test("checkProblem: what a check may be", () => {
  const known = new Set(["exporter/cli.py", "exporter/__init__.py", "habits/__main__.py"]);
  const bad: [string, RegExp][] = [
    ["pytest tests/x.py", /first word must be python/],
    ["python a | grep b", /may not hold/],
    ["python -c $(rm x)", /may not hold/],
    ["python a\npython b", /one line/],
    ["python " + "a".repeat(194), /over 200/],
    ["python -m exporter --list-formats", /-m exporter: no such module in the repo or the plan/],
    ["node x.js", /Python-only in v1/],
    ['python -m "exporter.cli', /open quote/],
    ['python -c "a(1)" | x', /outside double quotes/],
    ['python -c "print(\\"x\\")"', /no escape/],
    ['python -c "a(\'x\'', /open quote/],
    ["python -m pytest tests/test_formats.py -k csv", /-m pytest: no such module/],
  ];
  for (const [check, why] of bad) assert.match(checkProblem({ check }, known) ?? "", why, check);
  assert.equal(checkProblem({ check: "python -m exporter.cli --list-formats", expect: "csv(.csv)" }, known), null);
  assert.equal(checkProblem({ check: "python -m habits list" }, known), null);
  assert.equal(checkProblem({ check: 'python3 -m habits add "read a book"' }, known), null);
  // Addendum 1: inside double quotes any character is literal (no shell); a quoted word may join unquoted text
  assert.equal(checkProblem({ check: `python -c "from exporter import cli; assert cli.main(['--list-formats']) == 0"` }, known), null);
  assert.equal(checkProblem({ check: 'python -m habits a"b|c"' }, known), null);
  assert.match(checkProblem({ check: "python -m habits list", expect: "x".repeat(201) }, known)!, /expect is over 200/);
});

test("checks: a draft with one bad check keeps the plan and drops only that check; the review (required) refuses it", () => {
  const raw = JSON.parse(DRAFT);
  raw.tasks = raw.tasks.map((t: Record<string, unknown>, i: number) => ({ ...t, ...CHECK, ...(i === 2 ? { check: "pytest tests/test_formats.py" } : {}) }));
  const files = ["exporter/cli.py", "exporter/__init__.py"];
  const v = validatePlan(raw, { checks: "optional", files });
  assert.ok(v.plan);
  assert.deepEqual(v.dropped, ['task 3: check dropped: the first word must be python or python3, got "pytest"']);
  assert.equal(v.plan.tasks[2]!.check, undefined);
  assert.equal(v.plan.tasks[3]!.check, CHECK.check);
  // the review (required): a check fault is listed apart and its check dropped; the plan stands (Addendum 1)
  const req = validatePlan(raw, { checks: "required", files });
  assert.ok(req.plan);
  assert.deepEqual(req.checkErrors, ['task 3: the first word must be python or python3, got "pytest"']);
  assert.equal(req.plan.tasks[2]!.check, undefined);
  // ignore (today's): checks are not read at all
  assert.equal(validatePlan(raw).plan!.tasks[0]!.check, undefined);
  assert.deepEqual(Object.keys(validatePlan(raw).plan!.tasks[0]!), ["id", "title", "files", "test", "done"]);
  // a TS check is dropped even in the review
  raw.tasks[2].check = "node x.js";
  const ts = validatePlan(raw, { checks: "required", files });
  assert.ok(ts.plan);
  assert.deepEqual(ts.dropped, ["task 3: check dropped: checks are Python-only in v1"]);
  assert.match(planMarkdown(v.plan), /   - check: python -m exporter\.cli --list-formats \(expects "json\(\.json\)"\)/);
});

test("Addendum 1: a review whose only faults are checks is used at once (no retry), its bad checks dropped and counted", async () => {
  const cwd = plan3();
  const rv = goodReview();
  const ts = rv.tasks as Record<string, unknown>[];
  ts[0]!.check = "python -m pytest tests/test_formats.py -k csv";
  delete ts[1]!.check;
  const s = scripted([DRAFT, rv]);
  const lines: string[] = [];
  const r = await runPlan({ request: REQUEST }, { cwd, config: on(), chat: s.chat, report: (l) => lines.push(l) });
  assert.equal(r.calls, 2, "no retry for check faults");
  assert.equal(r.review, "used");
  assert.match(s.calls[1]!.messages[3]!.content, /A check runs in an empty folder with the project importable/);
  const saved = JSON.parse(readFileSync(join(cwd, ".tinycode/plan.json"), "utf8")) as Plan;
  assert.ok(saved.tasks[4]!.files.includes("exporter/settings.py"), "the review's files are kept");
  assert.equal(saved.tasks[0]!.check, undefined);
  assert.equal(saved.tasks[1]!.check, undefined);
  assert.equal(saved.tasks[2]!.check, CHECK.check);
  assert.ok(lines.some((l) => /^task 1: check dropped: -m pytest: no such module/.test(l)));
  assert.ok(lines.some((l) => /^task 2: no check: check is missing/.test(l)));
  assert.ok(lines.some((l) => /^plan review used \(7 file\(s\) read; 2 check\(s\) dropped\)/.test(l)));
});

test("Addendum 1: a quoted -c check that imports the project passes through the real runner, from its empty folder", async () => {
  const cwd = plan3();
  const check = `python -c "from exporter import formats; print(' '.join(formats.names()))"`;
  assert.equal(checkProblem({ check, expect: "json text" }, new Set(["exporter/cli.py"])), null);
  const set = checkSet({ id: 1, title: "t", files: ["exporter/cli.py"], test: "x", check, expect: "json text", done: false });
  const run = await runAcceptance(set!, { cwd, python: process.env.TINYCODE_TEST_PYTHON ?? "python3", stepSeconds: 20 });
  assert.equal(run.unavailable, undefined);
  assert.deepEqual(run.failed, []);
  assert.equal(run.ok, true);
});

// Addendum 1, the committed replay: each arm-C run's draft and first review reply from the 2026-11-11 GPU round
// (bench/matrix/runs-pbf), through the real validator and scope rule. Every one was refused by the old check rules.
test("Addendum 1 replay: the recorded reviews are kept on plan-3 (5/5, settings.py named) and refused by scope on plan-2 r2", () => {
  const dir = join(ROOT, "test/fixtures/plan-reviews");
  const repos: Record<string, string> = { "plan-2": "plan-2-todo-due", "plan-3": "plan-3-exporter" };
  const used: string[] = [];
  for (const f of readdirSync(dir).sort()) {
    const { draft, review } = JSON.parse(readFileSync(join(dir, f), "utf8")) as { draft: string; review: string };
    const files = repoFiles(join(ROOT, "bench/matrix/tasks", repos[f.slice(0, 6)]!, "repo"), ["py"]);
    const d = parsePlan(draft, { checks: "optional", files });
    const rv = parsePlan(review, { checks: "required", files });
    assert.ok(d.plan, `${f}: draft`);
    assert.ok(rv.plan, `${f}: the review has no structural fault: ${rv.errors.join("; ")}`);
    const scope = reviewScopeProblem(d.plan, rv.plan);
    if (!scope) used.push(f.replace(/\.json$/, ""));
    if (f.startsWith("plan-3")) assert.ok(rv.plan.tasks.some((t) => t.files.some((x) => x.startsWith("exporter/settings.py"))), `${f}: settings.py`);
  }
  assert.deepEqual(used.filter((u) => u.startsWith("plan-3")), ["plan-3-exporter-r1", "plan-3-exporter-r2", "plan-3-exporter-r3", "plan-3-exporter-r4", "plan-3-exporter-r5"]);
  assert.deepEqual(used.filter((u) => u.startsWith("plan-2")), ["plan-2-todo-due-r1", "plan-2-todo-due-r3", "plan-2-todo-due-r4", "plan-2-todo-due-r5"]);
});
