// design plan-build-fit in /build: E21's task checks (through the check runner, injected) and E25's whole-project check
// with one repair (stages.wholeCheck). Temp git repos, scripted chat.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { mergeConfig } from "../../src/config.ts";
import type { ChatResult, Message } from "../../src/llm.ts";
import { changedPaths, checkSet, loadPlan, runBuild, type BuildPlan } from "../../src/workflows/build.ts";
import type { AcceptanceApi, AcceptRun, AcceptSet } from "../../src/workflows/acceptapi.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const PY = (process.env.TINYCODE_TEST_PYTHON ?? "python3");
const cfg = (over: Record<string, unknown> = {}) => mergeConfig({ test: { python: PY }, ladder: { skipSolePick: false, rung2: true }, ...over });

const block = (path: string, body: string) => `${path}\n<<<<<<< SEARCH\n=======\n${body}\n>>>>>>> REPLACE`;
const edit = (path: string, search: string, replace: string) => `${path}\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;
const pick = JSON.stringify({ files: ["calc.py"], reason: "the function lives there" });
const review = JSON.stringify({ diagnosis: "not done yet", where: ["calc.py:1"], next_step: "finish it" });
const ADD = "def add(a, b):\n    return a + b";
const T1 = block("tests/test_add.py", "from calc import add\n\ndef test_add():\n    assert add(1, 2) == 3");
const C1 = block("calc.py", ADD);
const T2 = block("tests/test_sub.py", "from calc import sub\n\ndef test_sub():\n    assert sub(5, 2) == 3");
const C2 = edit("calc.py", ADD, `${ADD}\n\ndef sub(a, b):\n    return a - b`);
/** task 2's code that also breaks add: test_sub passes, the whole suite does not */
const C2breaks = edit("calc.py", ADD, "def add(a, b):\n    return 0\n\ndef sub(a, b):\n    return a - b");
const FIXADD = edit("calc.py", "def add(a, b):\n    return 0", ADD);
const STILLBAD = edit("calc.py", "def add(a, b):\n    return 0", "def add(a, b):\n    return 1");
const MUL = (search: string) => edit("calc.py", search, `${search}\n\ndef mul(a, b):\n    return a * b`);

type Task = { id: number; title: string; files: string[]; test: string; check?: string; expect?: string; done: boolean };
function project(tasks: Task[], files: Record<string, string> = {}): { cwd: string; env: Record<string, string> } {
  const dir = tmpDir("tinycode-wholecheck-");
  const cwd = join(dir, "proj");
  mkdirSync(join(cwd, ".tinycode"), { recursive: true });
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(cwd, p, ".."), { recursive: true });
    writeFileSync(join(cwd, p), t);
  }
  // a plan needs 3 tasks: done fillers pad it (skipped by /build)
  const pad = [8, 9].slice(0, Math.max(0, 3 - tasks.length)).map((id) => ({ id, title: "set up", files: ["README.md"], test: "none", done: true }));
  writeFileSync(join(cwd, ".tinycode/plan.json"), JSON.stringify({ spec: "A tiny calculator.", stack: "python, pytest", tasks: [...tasks, ...pad] }, null, 2));
  return { cwd, env: { TINYCODE_LOG: join(dir, "state", "calls.jsonl") } };
}
const task = (id: number, title: string, test: string, over: Partial<Task> = {}): Task => ({ id, title, files: ["calc.py"], test, done: false, ...over });
const TASK1 = (over: Partial<Task> = {}) => task(1, "add two numbers", "tests/test_add.py: add(1, 2) is 3", over);
const TASK2 = (over: Partial<Task> = {}) => task(2, "subtract", "tests/test_sub.py: sub(5, 2) is 3", over);

function scripted(replies: string[]) {
  const calls: { step: string; messages: Message[] }[] = [];
  let i = 0;
  const chat = async (step: string, messages: Message[]): Promise<ChatResult> => {
    calls.push({ step, messages: structuredClone(messages) });
    assert.ok(i < replies.length, `unexpected extra call #${i + 1} (${step})`);
    return { text: replies[i++]!, usage: { prompt_tokens: 10, cached_tokens: 0, completion_tokens: 5 }, ms: 1, lane: "trunk", model: "gemma-4-12b", fellBack: false };
  };
  return { chat, calls, left: () => replies.length - i };
}
const noPi = async () => assert.fail("the repair never runs Pi's loop");
const deps = (p: ReturnType<typeof project>, chat: ReturnType<typeof scripted>["chat"], extra: object = {}) => ({
  cwd: p.cwd, config: cfg(), chat, report: () => {}, env: p.env, confirm: async () => true, ...extra,
});
const gitLog = (cwd: string) => execFileSync("git", ["log", "--format=%s"], { cwd, encoding: "utf8" }).trim().split("\n");
const gitStatus = (cwd: string) => execFileSync("git", ["status", "--porcelain", "-uall"], { cwd, encoding: "utf8" }).trim();
const calc = (cwd: string) => {
  try {
    return readFileSync(join(cwd, "calc.py"), "utf8");
  } catch {
    return "";
  }
};
const run = (o: Partial<AcceptRun>): AcceptRun => ({ ok: false, total: 1, passed: 0, failed: [], ms: 1, ...o });

/** A stub of the check runner: task checks are answered by a function of the tree; every run is logged. */
function stubApi(o: { check: (set: AcceptSet, cwd: string) => AcceptRun }) {
  const log: string[] = [];
  const api: AcceptanceApi = {
    run: async (set, opts) => {
      log.push(String(set.request));
      return o.check(set, opts.cwd);
    },
  };
  return { api, log };
}

test("checkSet: a check becomes a one-check, one-step set with {python}; expect becomes stdoutHas", () => {
  assert.deepEqual(checkSet({ id: 3, title: "t", files: [], test: "", check: 'python -m habits add "read a book"', expect: "added", done: false })!.checks, [
    { name: "task 3", steps: [{ argv: ["{python}", "-m", "habits", "add", "read a book"], exit: 0, stdoutHas: ["added"] }] },
  ]);
  assert.deepEqual(checkSet({ id: 1, title: "t", files: [], test: "", check: "python3 -m x", done: false })!.checks[0]!.steps, [{ argv: ["{python}", "-m", "x"], exit: 0 }]);
  assert.equal(checkSet({ id: 1, title: "t", files: [], test: "", done: false }), null);
});

test("E21: a task whose test passes and whose own check fails is fed back to the ladder; the header shows the check", async () => {
  const p = project([TASK1({ check: "python -m calc", expect: "cli ok" })]);
  const s = scripted([T1, pick, C1, review, block("calc.py", `${ADD}\n# cli`)]);
  const { api, log } = stubApi({ check: (_s, cwd) => (calc(cwd).includes("# cli") ? run({ ok: true, passed: 1 }) : run({ failed: [{ name: "task 1", command: "python -m calc", why: 'stdout lacks "cli ok"' }] })) });
  const r = await runBuild({ yes: false }, deps(p, s.chat, { config: cfg({ stages: { buildChecks: true } }), acceptance: api }));
  assert.equal(s.left(), 0);
  assert.deepEqual(r.ran.map((x) => [x.status, x.solvedBy]), [["done", "rung2"]]);
  assert.match(s.calls[0]!.messages[1]!.content, /\nCheck: python -m calc \(expects "cli ok"\)\n/);
  assert.ok(s.calls.slice(3).some((c) => c.messages.some((m) => m.content.includes('FAIL: check of task 1: stdout lacks "cli ok"'))), "the check's failure is the test's failure text");
  assert.deepEqual(log, ["task 1 check", "task 1 check"], "run after the first pass (fails) and after the fix (passes)");
  // buildChecks off: the same plan's check is neither shown nor run
  const p2 = project([TASK1({ check: "python -m calc", expect: "cli ok" })]);
  const s2 = scripted([T1, pick, C1]);
  const st2 = stubApi({ check: () => assert.fail("not run with buildChecks off") });
  const r2 = await runBuild({ yes: false }, deps(p2, s2.chat, { acceptance: st2.api }));
  assert.equal(r2.blocked, null);
  assert.ok(!s2.calls[0]!.messages[1]!.content.includes("Check:"));
});

test("E21: an unavailable interpreter counts as not run (one line), never as failed", async () => {
  const p = project([TASK1({ check: "python -m calc" })]);
  const s = scripted([T1, pick, C1]);
  const lines: string[] = [];
  const { api } = stubApi({ check: () => run({ unavailable: "python3 not found (set test.python)" }) });
  const r = await runBuild({ yes: false }, deps(p, s.chat, { config: cfg({ stages: { buildChecks: true } }), acceptance: api, report: (l: string) => lines.push(l) }));
  assert.equal(r.blocked, null);
  assert.equal(lines.filter((l) => /check of task 1 not run: python3 not found/.test(l)).length, 1);
});

// Addendum 2: E21 is split. stages.planReview is /plan's side only; stages.buildChecks owns every /build read.
/** two tasks, task 1 with a check that fails once task 2's code is in: which checks /build runs and shows under `stages` */
async function splitRun(stages: object) {
  const p = project([TASK1({ check: "python -m calc", expect: "only add" }), TASK2()]);
  const s = scripted([T1, pick, C1, T2, pick, C2]);
  const lines: string[] = [];
  const st = stubApi({ check: (_s, cwd) => (calc(cwd).includes("def sub") ? run({ failed: [{ name: "task 1", command: "x", why: "stdout differs" }] }) : run({ ok: true, passed: 1 })) });
  const r = await runBuild({ yes: false }, deps(p, s.chat, { config: cfg({ stages }), acceptance: st.api, report: (l: string) => lines.push(l) }));
  assert.equal(s.left(), 0);
  assert.equal(r.blocked, null);
  return {
    header: s.calls[0]!.messages[1]!.content,
    checkShown: s.calls.some((c) => c.messages.some((m) => m.content.includes("\nCheck: "))),
    log: st.log,
    stale: r.ran.map((x) => x.stale ?? []),
    staleLines: lines.filter((l) => l.startsWith("  stale-check?")),
  };
}

test("E21 split: planReview on, buildChecks off: /build runs no task check, shows no Check: line, and (wholeCheck) no stale-check pass", async () => {
  for (const stages of [{ planReview: true }, { planReview: true, wholeCheck: true }]) {
    const r = await splitRun(stages);
    assert.equal(r.checkShown, false, JSON.stringify(stages));
    assert.deepEqual(r.log, [], `no check run under ${JSON.stringify(stages)}`);
    assert.deepEqual(r.stale, [[], []]);
    assert.deepEqual(r.staleLines, []);
  }
});

test("E21 split: buildChecks on, planReview off, with a saved plan's check: it runs, Check: is shown, and (wholeCheck) the stale pass runs", async () => {
  const r = await splitRun({ buildChecks: true });
  assert.match(r.header, /\nCheck: python -m calc \(expects "only add"\)\n/);
  assert.deepEqual(r.log, ["task 1 check"], "the task's own check, after its test passes");
  assert.deepEqual(r.stale, [[], []], "no stale pass without wholeCheck");
  const w = await splitRun({ buildChecks: true, wholeCheck: true });
  assert.equal(w.checkShown, true);
  assert.deepEqual(w.log, ["task 1 check", "task 1 check"], "own check, then the stale pass after task 2");
  assert.deepEqual(w.stale, [[], [1]]);
  assert.deepEqual(w.staleLines, ["  stale-check? task 1: stdout differs"]);
});

test("E21 split: both on behave as planReview on did before the split (= buildChecks on alone)", async () => {
  for (const extra of [{}, { wholeCheck: true }]) {
    const both = await splitRun({ planReview: true, buildChecks: true, ...extra });
    assert.deepEqual(both, await splitRun({ buildChecks: true, ...extra }));
    assert.equal(both.checkShown, true);
  }
  const w = await splitRun({ planReview: true, buildChecks: true, wholeCheck: true });
  assert.deepEqual([w.log, w.stale, w.staleLines], [["task 1 check", "task 1 check"], [[], [1]], ["  stale-check? task 1: stdout differs"]]);
});

test("E21 split, grep gate: planReview is read only in src/workflows/plan.ts and src/config.ts", () => {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "node_modules") walk(rel);
      } else if (/\.[cm]?[jt]s$/.test(e.name) && /\bplanReview\b/.test(readFileSync(join(ROOT, rel), "utf8"))) found.push(rel);
    }
  };
  walk("src");
  walk("extensions");
  assert.deepEqual(found.sort(), ["src/config.ts", "src/workflows/plan.ts"], "a build-side use belongs to stages.buildChecks");
});

test("E21 stateful check: a runner that, like src/acceptance.ts, gives each run a fresh folder lets a file-writing check pass twice, with nothing new in git status", async () => {
  const p = project([TASK1()], { "habits/__init__.py": "", "habits/__main__.py": "import os\nif os.path.exists('h.json'):\n    print('already there')\nelse:\n    open('h.json', 'w').write('[]')\n    print('added read')\n" });
  execFileSync("git", ["init", "-q"], { cwd: p.cwd });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "add", "-A"], { cwd: p.cwd });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"], { cwd: p.cwd });
  let n = 0;
  // the shape of the check runner: .tinycode/acceptance-run/<n>/, PYTHONPATH = the project, stdin closed, no shell, removed after
  const runner: AcceptanceApi["run"] = async (set, opts) => {
    const dir = join(opts.cwd, ".tinycode", "acceptance-run", String(++n));
    mkdirSync(dir, { recursive: true });
    try {
      const st = set.checks[0]!.steps[0]!;
      const argv = st.argv.map((a) => (a === "{python}" ? opts.python : a));
      const out = spawnSync(argv[0]!, argv.slice(1), { cwd: dir, env: { ...process.env, PYTHONPATH: opts.cwd }, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
      const ok = out.status === (st.exit ?? 0) && (st.stdoutHas ?? []).every((x) => out.stdout.replace(/\r\n/g, "\n").includes(x));
      return run({ ok, passed: ok ? 1 : 0, failed: ok ? [] : [{ name: "c", command: argv.join(" "), why: out.stdout.trim() }] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const set = checkSet({ id: 1, title: "t", files: [], test: "", check: "python -m habits add read", expect: "added read", done: false })!;
  for (let i = 0; i < 2; i++) assert.equal((await runner(set, { cwd: p.cwd, python: PY, stepSeconds: 20 })).ok, true, `run ${i + 1}`);
  // what /build would commit (caches excluded, as changedPaths does): nothing; h.json never reaches the project
  assert.deepEqual(changedPaths(p.cwd), [], "a check leaves no file in the project");
  assert.ok(!gitStatus(p.cwd).split("\n").some((l) => l && !l.includes("__pycache__")), "only Python's bytecode cache, which /build never stages");
});

test("E25: a suite failure gets one repair with no rung 3; a pass is solved_by repair:<rung>, a failure blocks with the output", async () => {
  const p = project([TASK1(), TASK2()]);
  const s = scripted([T1, pick, C1, T2, pick, C2breaks, pick, FIXADD]);
  const lines: string[] = [];
  const r = await runBuild({ yes: false }, deps(p, s.chat, { config: cfg({ stages: { wholeCheck: true } }), pi: noPi, report: (l: string) => lines.push(l) }));
  assert.equal(s.left(), 0);
  assert.deepEqual(r.ran.map((x) => [x.id, x.status, x.solvedBy, x.calls]), [[1, "done", "rung1", 3], [2, "done", "repair:rung1", 5]]);
  const repairPick = s.calls[6]!.messages.map((m) => m.content).join("\n");
  assert.match(repairPick, /Task 2 \(subtract\) broke the whole-project check: the whole suite fails/);
  assert.match(repairPick, /Earlier checks now failing: none/);
  assert.match(repairPick, /Make the suite pass without editing tests\./);
  assert.deepEqual(gitLog(p.cwd), ["tinycode: subtract", "tinycode: add two numbers"]);
  assert.ok(lines.includes("  repair: solved_by rung1, 2 calls"));
  // the repair fails: blocked with the output, the repair's edits undone
  const q = project([TASK1(), TASK2()]);
  const s2 = scripted([T1, pick, C1, T2, pick, C2breaks, pick, STILLBAD, review, STILLBAD]);
  const r2 = await runBuild({ yes: false }, deps(q, s2.chat, { config: cfg({ stages: { wholeCheck: true } }), pi: noPi }));
  assert.equal(s2.left(), 0);
  assert.equal(r2.blocked, 2);
  const plan = loadPlan(q.cwd).plan as BuildPlan;
  assert.match(plan.tasks[1]!.blocked!, /^the whole-project check fails after this task \(one repair tried\):\nthe whole suite fails:/);
  assert.match(calc(q.cwd), /return 0/, "the tree is as the task left it");
});

test("E25: an earlier task's check that now fails is stale-check? on the result line, and no repair", async () => {
  const p = project([TASK1({ check: "python -m calc", expect: "only add" }), TASK2()]);
  const s = scripted([T1, pick, C1, T2, pick, C2]);
  const lines: string[] = [];
  const st = stubApi({ check: (_s, cwd) => (calc(cwd).includes("def sub") ? run({ failed: [{ name: "task 1", command: "x", why: "stdout differs" }] }) : run({ ok: true, passed: 1 })) });
  const r = await runBuild({ yes: false }, deps(p, s.chat, { config: cfg({ stages: { wholeCheck: true, buildChecks: true } }), acceptance: st.api, report: (l: string) => lines.push(l) }));
  assert.equal(s.left(), 0);
  assert.equal(r.blocked, null);
  assert.deepEqual(r.ran.map((x) => x.stale ?? []), [[], [1]]);
  assert.ok(lines.includes("  stale-check? task 1: stdout differs"));
  assert.match((loadPlan(p.cwd).plan as BuildPlan).tasks[1]!.result!.line, /, stale-check\? task 1$/);
});

test("E25: the `already` path runs the whole-project check too", async () => {
  const p = project([TASK1({ files: ["calc.py (read-only)"] })], { "calc.py": `${ADD}\n`, "tests/test_mul.py": "from calc import mul\n\ndef test_mul():\n    assert mul(2, 3) == 6\n" });
  const s = scripted([T1, pick, MUL(ADD)]);
  const r = await runBuild({ yes: false }, deps(p, s.chat, { config: cfg({ stages: { wholeCheck: true } }), pi: noPi }));
  assert.equal(s.left(), 0);
  assert.deepEqual(r.ran.map((x) => [x.status, x.solvedBy]), [["done", "repair:rung1"]]);
  // off: the same tree blocks as today
  const q = project([TASK1({ files: ["calc.py (read-only)"] })], { "calc.py": `${ADD}\n`, "tests/test_mul.py": "from calc import mul\n\ndef test_mul():\n    assert mul(2, 3) == 6\n" });
  const r2 = await runBuild({ yes: false }, deps(q, scripted([T1]).chat));
  assert.equal(r2.blocked, 1);
  assert.match((loadPlan(q.cwd).plan as BuildPlan).tasks[0]!.blocked!, /^the whole suite fails:/);
});

test("every switch off: the check runner, though injected, is never called; calls, commits and result as today", async () => {
  const p = project([TASK1({ check: "python -m calc" }), TASK2()]);
  const s = scripted([T1, pick, C1, T2, pick, C2]);
  const st = stubApi({ check: () => assert.fail("no check") });
  const r = await runBuild({ yes: false }, deps(p, s.chat, { acceptance: st.api }));
  assert.equal(s.left(), 0);
  assert.deepEqual(st.log, []);
  assert.deepEqual(r.ran.map((x) => Object.keys(x)), [["id", "status", "solvedBy", "calls", "tokens"], ["id", "status", "solvedBy", "calls", "tokens"]]);
  assert.deepEqual(gitLog(p.cwd), ["tinycode: subtract", "tinycode: add two numbers"]);
});
