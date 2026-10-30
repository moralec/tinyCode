import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { mergeConfig } from "../../src/config.ts";
import type { ChatResult, Message } from "../../src/llm.ts";
import { loadPlan, orchestratorContext, parseBuildArgs, runBuild, testFileFor, type BuildPlan } from "../../src/workflows/build.ts";
import type { PiHandoff } from "../../src/workflows/fix.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const PY = (process.env.TINYCODE_TEST_PYTHON ?? "python3");
const cfg = () => mergeConfig({ test: { python: PY }, ladder: { skipSolePick: false, rung2: true } }); // the scripted replies include the pick and the rung-2 review

const block = (path: string, body: string) => `${path}\n<<<<<<< SEARCH\n=======\n${body}\n>>>>>>> REPLACE`;
const edit = (path: string, search: string, replace: string) => `${path}\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE`;
const pick = JSON.stringify({ files: ["calc.py"], reason: "the function lives there" });
const review = JSON.stringify({ diagnosis: "sub returns a sum", where: ["calc.py:4"], next_step: "subtract" });

const T1 = block("tests/test_add.py", "from calc import add\n\ndef test_add():\n    assert add(1, 2) == 3");
const C1 = block("calc.py", "def add(a, b):\n    return a + b");
const T2 = block("tests/test_sub.py", "from calc import sub\n\ndef test_sub():\n    assert sub(5, 2) == 3");
const C2bad = edit("calc.py", "def add(a, b):\n    return a + b", "def add(a, b):\n    return a + b\n\ndef sub(a, b):\n    return a + b");
const C2good = edit("calc.py", "def add(a, b):\n    return a + b", "def add(a, b):\n    return a + b\n\ndef sub(a, b):\n    return a - b");
const T3 = block("tests/test_mul.py", "from calc import mul\n\ndef test_mul():\n    assert mul(2, 3) == 6");
const C3 = edit("calc.py", "def add(a, b):\n    return a + b", "def add(a, b):\n    return a + b\n\ndef mul(a, b):\n    return a * b");

function project(): { cwd: string; env: Record<string, string> } {
  const dir = tmpDir("tinycode-build-");
  const cwd = join(dir, "proj");
  mkdirSync(join(cwd, ".tinycode"), { recursive: true });
  const task = (id: number, title: string, test: string) => ({ id, title, files: ["calc.py"], test, done: false });
  const plan = {
    spec: "A tiny calculator module with add, sub and mul.",
    stack: "python, pytest",
    tasks: [task(1, "add two numbers", "tests/test_add.py: add(1, 2) is 3"), task(2, "subtract", "tests/test_sub.py: sub(5, 2) is 3"), task(3, "multiply", "tests/test_mul.py: mul(2, 3) is 6")],
  };
  writeFileSync(join(cwd, ".tinycode/plan.json"), JSON.stringify(plan, null, 2));
  return { cwd, env: { TINYCODE_LOG: join(dir, "state", "calls.jsonl") } };
}

function scripted(replies: string[]) {
  const calls: { step: string; messages: Message[] }[] = [];
  let i = 0;
  const chat = async (step: string, messages: Message[]): Promise<ChatResult> => {
    calls.push({ step, messages: structuredClone(messages) });
    assert.ok(i < replies.length, `unexpected extra call #${i + 1} (${step})`);
    return { text: replies[i++], usage: { prompt_tokens: 10, cached_tokens: 0, completion_tokens: 5 }, ms: 1, lane: "trunk", model: "gemma-4-12b", fellBack: false };
  };
  return { chat, calls, left: () => replies.length - i };
}

const deps = (p: ReturnType<typeof project>, chat: ReturnType<typeof scripted>["chat"], extra: object = {}) => ({
  cwd: p.cwd, config: cfg(), chat, report: () => {}, env: p.env, confirm: async () => true, ...extra,
});
const gitLog = (cwd: string) => execFileSync("git", ["log", "--format=%s"], { cwd, encoding: "utf8" }).trim().split("\n");

test("parseBuildArgs and testFileFor", () => {
  assert.deepEqual(parseBuildArgs("--task 2"), { task: 2, yes: false });
  assert.deepEqual(parseBuildArgs("--yes"), { task: undefined, yes: true });
  assert.equal(testFileFor({ id: 1, title: "t", files: ["a.py"], test: "tests/test_a.py checks x", done: false }), "tests/test_a.py");
  assert.equal(testFileFor({ id: 4, title: "t", files: ["a.py", "t/test_b.py"], test: "it works", done: false }), "t/test_b.py");
  assert.equal(testFileFor({ id: 4, title: "t", files: ["a.py"], test: "it works", done: false }), "tests/test_task4.py");
});

test("3-task plan: one commit per task, orchestrator context grows only by one result line, each task starts fresh", async () => {
  const p = project();
  const s = scripted([T1, pick, C1, T2, pick, C2good, T3, pick, C3]);
  const r = await runBuild({ yes: false }, deps(p, s.chat));
  assert.equal(s.left(), 0);
  assert.deepEqual(r.ran.map((x) => [x.id, x.status, x.solvedBy, x.calls]), [[1, "done", "rung1", 3], [2, "done", "rung1", 3], [3, "done", "rung1", 3]]);
  assert.equal(r.done, 3);
  assert.deepEqual(gitLog(p.cwd), ["tinycode: multiply", "tinycode: subtract", "tinycode: add two numbers"]);
  const plan = loadPlan(p.cwd).plan as BuildPlan;
  assert.ok(plan.tasks.every((t) => t.done && t.result?.commit && t.result.tokens === 45));
  // orchestrator context: after each task it grows by exactly that task's result line (plus its newline and indent)
  assert.equal(r.contextChars.length, 4);
  for (let i = 0; i < 3; i++) assert.equal(r.contextChars[i + 1] - r.contextChars[i], plan.tasks[i].result!.line.length + 4);
  assert.ok(!orchestratorContext(plan).includes("def add"), "no code or replies in the orchestrator context");
  // each task's calls: same shape (2 messages for the test, 2 for the pick), never an earlier task's text
  const byTask = [s.calls.slice(0, 3), s.calls.slice(3, 6), s.calls.slice(6, 9)];
  for (const [n, calls] of byTask.entries()) {
    assert.deepEqual(calls.map((c) => c.messages.length), [2, 2, 4]);
    const all = calls.map((c) => c.messages.map((m) => m.content).join("\n")).join("\n");
    assert.ok(all.includes(`Task ${n + 1}:`));
    for (let k = 1; k <= 3; k++) if (k !== n + 1) assert.ok(!all.includes(`Task ${k}:`), `task ${n + 1} sees task ${k}`);
    assert.ok(all.includes("A tiny calculator"), "spec is in every task context");
  }
});

test("resume after a blocked task: stops with the diagnosis, next /build retries that task and continues", async () => {
  const p = project();
  const s1 = scripted([T1, pick, C1, T2, pick, C2bad, review, C2bad]);
  const lines: string[] = [];
  const r1 = await runBuild({ yes: false }, deps(p, s1.chat, { report: (l: string) => lines.push(l) }));
  assert.equal(r1.blocked, 2);
  assert.deepEqual(r1.ran.map((x) => x.status), ["done", "blocked"]);
  const mid = loadPlan(p.cwd).plan as BuildPlan;
  assert.deepEqual(mid.tasks.map((t) => t.done), [true, false, false]);
  assert.match(mid.tasks[1].blocked!, /sub returns a sum/);
  assert.ok(lines.some((l) => /stopped at task 2 \(1\/3 done\)/.test(l)));
  assert.equal(gitLog(p.cwd).length, 1);
  assert.equal(readFileSync(join(p.cwd, "calc.py"), "utf8").includes("def sub"), false, "the failed edits were undone");
  assert.ok(existsSync(join(p.cwd, "tests/test_sub.py")), "the task's test stays");
  // resume: task 1 is skipped, task 2 reuses its test (no test-writing call), then task 3 runs
  const s2 = scripted([pick, C2good, T3, pick, C3]);
  const r2 = await runBuild({ yes: false }, deps(p, s2.chat));
  assert.equal(s2.left(), 0);
  assert.deepEqual(r2.ran.map((x) => [x.id, x.status, x.calls]), [[2, "done", 2], [3, "done", 3]]);
  assert.equal(s2.calls[0].step, "pick", "no test rewrite for the retried task");
  assert.equal(r2.blocked, null);
  const end = loadPlan(p.cwd).plan as BuildPlan;
  assert.ok(end.tasks.every((t) => t.done) && end.tasks[1].blocked === undefined);
  assert.equal(gitLog(p.cwd).length, 3);
  // a finished plan is a no-op; --task N reruns one task
  const s3 = scripted([]);
  const r3 = await runBuild({ yes: false }, deps(p, s3.chat));
  assert.deepEqual(r3.ran, []);
  assert.equal(r3.done, 3);
});

test("rung 3 passing marks the task done with solved_by pi (a passing rung 3 is not a failure)", async () => {
  const p = project();
  const s = scripted([T1, pick, C2bad, review, C2bad]);
  let seen: PiHandoff | null = null;
  const pi = async (h: PiHandoff) => {
    seen = h;
    writeFileSync(join(p.cwd, "calc.py"), "def add(a, b):\n    return a + b\n");
    return { turns: 4 };
  };
  const r = await runBuild({ task: 1, yes: false }, deps(p, s.chat, { pi }));
  assert.ok(seen);
  assert.match((seen as PiHandoff).text, /sub returns a sum/);
  assert.deepEqual(r.ran.map((x) => [x.id, x.status, x.solvedBy, x.calls]), [[1, "done", "pi", 1 + 4 + 4]]);
  assert.equal(r.blocked, null);
  assert.equal(r.done, 1);
});

test("no plan: a message, no calls; no git and no confirm: no commits unless --yes", async () => {
  const lines: string[] = [];
  const empty = tmpDir("tinycode-build-");
  const r = await runBuild({ yes: false }, { cwd: empty, config: cfg(), chat: async () => { throw new Error("no call"); }, report: (l) => lines.push(l) });
  assert.match(lines[0], /no \.tinycode\/plan\.json/);
  assert.equal(r.total, 0);
  const p = project();
  const s = scripted([T1, pick, C1]);
  const r2 = await runBuild({ task: 1, yes: false }, { cwd: p.cwd, config: cfg(), chat: s.chat, report: () => {}, env: p.env });
  assert.equal(r2.committing, false);
  assert.ok(!existsSync(join(p.cwd, ".git")));
});

test("a task is not done when a listed file was never created: handed to the ladder with that reason, then created", async () => {
  const p = project();
  const plan = JSON.parse(readFileSync(join(p.cwd, ".tinycode/plan.json"), "utf8"));
  plan.tasks[0] = { id: 1, title: "tracker", files: ["calc.py", "tracker.py"], test: "tests/test_add.py: add(1, 2) is 3", done: false };
  writeFileSync(join(p.cwd, ".tinycode/plan.json"), JSON.stringify(plan));
  const Ctrk = block("tracker.py", "def track():\n    return 1");
  // test written; test passes only once calc.py exists (C1) but tracker.py is missing -> ladder sees the reason, writes tracker.py
  const s = scripted([T1, pick, C1, pick, Ctrk]);
  const r = await runBuild({ yes: false, task: 1 }, deps(p, s.chat));
  const seen = s.calls.map((c) => c.messages.map((m) => m.content).join("\n")).join("\n");
  assert.ok(seen.includes("task lists tracker.py but it was not created"), "reason reaches the ladder");
  assert.equal(r.ran[0]!.status, "done");
  assert.ok(existsSync(join(p.cwd, "tracker.py")));
});

test("a task whose listed file is never created is blocked, not committed", async () => {
  const p = project();
  const plan = JSON.parse(readFileSync(join(p.cwd, ".tinycode/plan.json"), "utf8"));
  plan.tasks[0] = { id: 1, title: "tracker", files: ["calc.py", "tracker.py"], test: "tests/test_add.py: add(1, 2) is 3", done: false };
  writeFileSync(join(p.cwd, ".tinycode/plan.json"), JSON.stringify(plan));
  const noop = JSON.stringify({ files: ["calc.py"], reason: "x" });
  const s = scripted([T1, pick, C1, review, ...Array(30).fill(noop)]);
  const config = mergeConfig({ test: { python: PY }, ladder: { rung3: false } } as never);
  const r = await runBuild({ yes: false, task: 1 }, deps(p, s.chat, { config })).catch((e: Error) => e);
  assert.ok(!(r instanceof Error) || /unexpected extra call/.test(r.message));
  const res = r instanceof Error ? null : r;
  if (res) {
    assert.equal(res.ran[0]!.status, "blocked");
    assert.equal(loadPlan(p.cwd).plan!.tasks[0]!.done, false);
    assert.throws(() => gitLog(p.cwd));
  }
});

test("read-only files may stay unchanged; an unchanged non-read-only file fails the task", async () => {
  const { fileProblems } = await import("../../src/workflows/build.ts");
  const d = tmpDir("tinycode-fp-");
  writeFileSync(join(d, "a.py"), "x");
  writeFileSync(join(d, "b.py"), "y");
  const t = { id: 1, title: "t", files: ["a.py", "b.py (read-only)", "c.py"], test: "t", done: false };
  const before = new Map<string, string | null>([["a.py", "x"], ["b.py", "y"], ["c.py", null]]);
  assert.deepEqual(fileProblems(d, t, before), ["task lists a.py but it was not changed by this task", "task lists c.py but it was not created"]);
});

test("commit stages only the task's changed files, adds a cache .gitignore, never commits .pyc", async () => {
  const p = project();
  writeFileSync(join(p.cwd, "unrelated.txt"), "not mine");
  const s = scripted([T1, pick, C1]);
  // a stray bytecode file appears; plan has only task 1
  mkdirSync(join(p.cwd, "__pycache__"), { recursive: true });
  writeFileSync(join(p.cwd, "__pycache__/calc.cpython-39.pyc"), "bytes");
  execFileSync("git", ["init", "-q"], { cwd: p.cwd });
  await runBuild({ yes: false, task: 1 }, deps(p, s.chat));
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", "HEAD"], { cwd: p.cwd, encoding: "utf8" });
  assert.ok(!files.includes(".pyc") && !files.includes("__pycache__"));
  assert.ok(files.includes("calc.py") && files.includes(".gitignore"));
  assert.ok(readFileSync(join(p.cwd, ".gitignore"), "utf8").includes("__pycache__/"));
  assert.ok(files.includes("unrelated.txt"), "no commits yet: everything is the build's");
});
