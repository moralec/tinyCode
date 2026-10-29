// /build: run .tinycode/plan.json one task at a time. The orchestrator (this file) keeps only the plan and one result
// line per finished task; every task is a separate job with a fresh context (spec + current outline + that task,
// never an earlier task's calls). Per task: write the task's test (edits to the test file only) -> confirm it fails ->
// /fix's ladder (runFix, with the Adaptive Ladder and rung 3) -> whole suite -> git commit -> mark done in plan.json.
// A task that fails every rung is marked `blocked` with the diagnosis and the build stops; the next /build resumes at
// the first task not done. Pure logic with injected dependencies, like fix.ts and plan.ts.
import { NOOP_PROGRESS, type Progress } from "../progress.ts";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { outline, repoFiles } from "../context/outline.ts";
import type { Message } from "../llm.ts";
import { applyReply } from "../protocol/apply.ts";
import { runTests } from "../testrun.ts";
import { restoreSnapshot, runFix, showFile, type ChatFn, type FixResult, type PiHandoff } from "./fix.ts";
import { CACHE_IGNORE, isCachePath, parseTaskFile } from "./cachefiles.ts";
import { isRelativePath, planMarkdown, validatePlan, type Plan, type PlanTask } from "./plan.ts";

export interface TaskResult {
  solved_by: string;
  calls: number;
  tokens: number;
  commit: string | null;
  /** the one line the orchestrator keeps for this task */
  line: string;
}
export interface BuildTask extends PlanTask {
  blocked?: string;
  result?: TaskResult;
}
export interface BuildPlan extends Plan {
  tasks: BuildTask[];
}

export interface BuildArgs {
  /** run only this task id (even if it is already done) */
  task?: number;
  /** answer yes to "init git?" when there is no UI to ask */
  yes: boolean;
}

/** `[--task N] [--yes]`. */
export function parseBuildArgs(raw: string): BuildArgs {
  const t = raw.match(/--task(?:=|\s+)(\d+)/);
  return { task: t ? Number(t[1]) : undefined, yes: /(^|\s)--yes\b/.test(raw) };
}

export const planFile = (cwd: string): string => join(cwd, ".tinycode", "plan.json");

/** Read plan.json (validated like /plan's reply) and keep each task's done/blocked/result state. */
export function loadPlan(cwd: string): { plan: BuildPlan; errors: [] } | { plan: null; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(planFile(cwd), "utf8"));
  } catch {
    return { plan: null, errors: ["no .tinycode/plan.json (run /plan first) or it is not valid JSON"] };
  }
  const v = validatePlan(raw);
  if (!v.plan) return { plan: null, errors: v.errors };
  const rawTasks = ((raw as { tasks?: unknown[] }).tasks ?? []) as Record<string, unknown>[];
  const tasks: BuildTask[] = v.plan.tasks.map((t, i) => {
    const r = rawTasks[i] ?? {};
    const out: BuildTask = { ...t, done: r.done === true };
    if (typeof r.blocked === "string") out.blocked = r.blocked;
    if (r.result && typeof r.result === "object") out.result = r.result as TaskResult;
    return out;
  });
  return { plan: { ...v.plan, tasks }, errors: [] };
}

export function savePlan(cwd: string, plan: BuildPlan): void {
  writeFileSync(planFile(cwd), JSON.stringify(plan, null, 2) + "\n");
  writeFileSync(join(cwd, ".tinycode", "PLAN.md"), planMarkdown(plan));
}

/** What the orchestrator holds: the spec, the task list, one result line per finished task. Nothing else. */
export function orchestratorContext(plan: BuildPlan): string {
  const lines = [`Spec: ${plan.spec}`, `Stack: ${plan.stack}`];
  for (const t of plan.tasks) {
    lines.push(`${t.id}. ${t.title}  [${t.files.join(", ")}]`);
    if (t.result) lines.push(`   ${t.result.line}`);
    else if (t.blocked) lines.push(`   blocked: ${t.blocked.slice(0, 120).replace(/\s+/g, " ")}`);
  }
  return lines.join("\n");
}

/** The test file a task's test is written to: a path named in `test` (or `files`) that looks like a test, else a default. */
export function testFileFor(task: PlanTask): string {
  const named = [...task.test.matchAll(/[\w./-]+\.(?:py|js|ts|mjs|cjs)\b/g)].map((m) => m[0]).filter(isRelativePath);
  const looksLikeTest = (p: string) => /test/i.test(p);
  return named.find(looksLikeTest) ?? task.files.map((f) => parseTaskFile(f).path).find((f) => looksLikeTest(f) && isRelativePath(f)) ?? `tests/test_task${task.id}.py`;
}

export const TEST_SYSTEM = `You write the test that defines when one task of a small software project is done. The test comes first: the code does not exist yet. Reply ONLY with edit blocks for the one test file named in the task, in exactly this format:

path/to/test_file.py
<<<<<<< SEARCH
exact lines copied from the file
=======
new lines
>>>>>>> REPLACE

To create the file, use an empty SEARCH. Edit no other file. No explanations.`;

/** /build declares one phase per task once the plan is read (`task 3/5: title`); a task's ladder shows as a nested `fix`. */
export const BUILD_PHASES: string[] = [];

export interface BuildDeps {
  /** progress display (src/progress.ts); absent = none */
  progress?: Progress;
  cwd: string;
  config: Config;
  chat: ChatFn;
  pi?: (h: PiHandoff) => Promise<{ turns: number }>;
  report: (line: string) => void;
  /** "init git?" question; absent without a UI */
  confirm?: (question: string) => Promise<boolean>;
  env?: Record<string, string | undefined>;
  runTests?: typeof runTests;
}

export interface BuildResult {
  /** per task run in this call, in order */
  ran: { id: number; status: "done" | "blocked"; solvedBy: string; calls: number; tokens: number }[];
  blocked: number | null;
  done: number;
  total: number;
  /** length of orchestratorContext() before the first task and after each task */
  contextChars: number[];
  /** git is in use: commits are made */
  committing: boolean;
  lines: string[];
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function isGitRepo(cwd: string): boolean {
  try {
    return git(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
}

/** Paths git reports as changed (modified, deleted, untracked; ignored ones are not listed), minus tinyCode state and caches. */
export function changedPaths(cwd: string): string[] {
  const out = execFileSync("git", ["status", "--porcelain", "-z", "-uall"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const parts = out.split("\0").filter(Boolean);
  const paths: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]!;
    const x = e[0];
    paths.push(e.slice(3));
    if (x === "R" || x === "C") i++; // the next entry is the origin
  }
  return paths.filter((p) => !isCachePath(p) && p !== ".tinycode" && !p.startsWith(".tinycode/"));
}

/** path -> content signature of everything dirty now; empty before the first commit (all of it then belongs to the build). */
export function dirtySignatures(cwd: string): Map<string, string> {
  const m = new Map<string, string>();
  try {
    git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
  } catch {
    return m;
  }
  for (const p of changedPaths(cwd)) {
    try {
      m.set(p, createHash("sha1").update(readFileSync(join(cwd, p))).digest("hex"));
    } catch {
      m.set(p, "gone");
    }
  }
  return m;
}

/** Without a .gitignore, add one for caches before the first commit. */
function ensureGitignore(cwd: string): void {
  const f = join(cwd, ".gitignore");
  if (!existsSync(f)) writeFileSync(f, CACHE_IGNORE.join("\n") + "\n");
}

/** Stage only the changed non-cache files (never `add -A`), commit them; returns the short hash, or null when nothing changed. */
function commitChanged(cwd: string, message: string, dirtyBefore: Map<string, string>): string | null {
  ensureGitignore(cwd);
  const now = dirtySignatures(cwd);
  const paths = changedPaths(cwd).filter((p) => dirtyBefore.get(p) !== (now.get(p) ?? "gone") || !dirtyBefore.has(p));
  if (!paths.length) return null;
  git(cwd, ["add", "-A", "--", ...paths]);
  const who: string[] = [];
  for (const [k, v] of [["user.name", "tinyCode"], ["user.email", "tinycode@localhost"]] as const) {
    let have = "";
    try {
      have = git(cwd, ["config", k]);
    } catch {
      have = "";
    }
    if (!have) who.push("-c", `${k}=${v}`);
  }
  git(cwd, [...who, "commit", "-q", "-m", message, "--", ...paths]);
  return git(cwd, ["rev-parse", "--short", "HEAD"]);
}

/** Content of each file a task lists (null = missing), to tell later whether the task created or changed it. */
function fileStates(cwd: string, task: PlanTask): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const e of task.files) {
    const { path } = parseTaskFile(e);
    try {
      m.set(path, readFileSync(join(cwd, path)).toString("latin1"));
    } catch {
      m.set(path, null);
    }
  }
  return m;
}

/** Why a task is not done although its test passes: a listed file is missing, or was not created or changed by this task. */
export function fileProblems(cwd: string, task: PlanTask, before: Map<string, string | null>): string[] {
  const now = fileStates(cwd, task);
  const out: string[] = [];
  for (const e of task.files) {
    const { path, readOnly } = parseTaskFile(e);
    if (now.get(path) === null) out.push(`task lists ${path} but it was not created`);
    else if (!readOnly && before.get(path) === now.get(path)) out.push(`task lists ${path} but it was not changed by this task`);
  }
  return out;
}

export async function runBuild(args: BuildArgs, deps: BuildDeps): Promise<BuildResult> {
  const { cwd, config: cfg } = deps;
  const env = deps.env ?? process.env;
  const tests = deps.runTests ?? runTests;
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    deps.report(l);
  };
  const result: BuildResult = { ran: [], blocked: null, done: 0, total: 0, contextChars: [], committing: false, lines };
  const loaded = loadPlan(cwd);
  if (!loaded.plan) {
    say(`/build: ${loaded.errors.join("; ")}`);
    return result;
  }
  const plan = loaded.plan;
  result.total = plan.tasks.length;
  const todo = args.task !== undefined ? plan.tasks.filter((t) => t.id === args.task) : plan.tasks.filter((t) => !t.done);
  if (args.task !== undefined && !todo.length) {
    say(`/build: no task ${args.task} in the plan`);
    return result;
  }
  if (!todo.length) {
    say(`/build: all ${plan.tasks.length} tasks are done`);
    result.done = plan.tasks.length;
    return result;
  }

  // git: commits need a repository; init one only after confirming (or --yes when there is no UI to ask).
  result.committing = isGitRepo(cwd);
  if (!result.committing) {
    const ok = deps.confirm ? await deps.confirm("This folder is not a git repository. Init one so each task is committed?") : args.yes;
    if (ok) {
      git(cwd, ["init", "-q"]);
      result.committing = true;
    } else say("note: no git repository, so no commits are made");
  }

  result.contextChars.push(orchestratorContext(plan).length);
  const pg = deps.progress ?? NOOP_PROGRESS;
  const labels = todo.map((t, k) => `task ${k + 1}/${todo.length}: ${t.title.slice(0, 40)}`);
  pg.declare(labels);
  for (const [k, task] of todo.entries()) {
    pg.step(labels[k]!);
    const wasBlocked = task.blocked !== undefined;
    delete task.blocked;
    say(`task ${task.id}: ${task.title}`);
    const dirtyBefore = result.committing ? dirtySignatures(cwd) : new Map<string, string>();
    const out = await runTask(task, plan, deps, env, tests, wasBlocked, say);
    if (out.ok) {
      let commit: string | null = null;
      if (result.committing) {
        try {
          commit = commitChanged(cwd, `tinycode: ${task.title}`, dirtyBefore);
        } catch (e) {
          say(`note: commit failed: ${(e as Error).message.split("\n")[0]}`);
        }
      }
      task.done = true;
      pg.touch();
      task.result = {
        solved_by: out.solvedBy,
        calls: out.calls,
        tokens: out.tokens,
        commit,
        line: `done: solved_by ${out.solvedBy}, ${out.calls} calls, ${out.tokens} tokens${commit ? `, commit ${commit}` : ""}`,
      };
      say(`task ${task.id} ${task.result.line}`);
    } else {
      task.done = false;
      task.blocked = out.why;
      say(`task ${task.id} blocked: ${out.why.slice(0, 300).replace(/\s+/g, " ")}`);
    }
    savePlan(cwd, plan);
    result.contextChars.push(orchestratorContext(plan).length);
    result.ran.push({ id: task.id, status: out.ok ? "done" : "blocked", solvedBy: out.solvedBy, calls: out.calls, tokens: out.tokens });
    if (!out.ok) {
      result.blocked = task.id;
      break;
    }
  }
  result.done = plan.tasks.filter((t) => t.done).length;
  say(
    result.blocked !== null
      ? `/build stopped at task ${result.blocked} (${result.done}/${result.total} done); run /build again to resume there`
      : `/build: ${result.done}/${result.total} tasks done`,
  );
  return result;
}

interface TaskOutcome {
  ok: boolean;
  why: string;
  solvedBy: string;
  calls: number;
  tokens: number;
}

/** One task in a fresh context: nothing from earlier tasks is passed except the files on disk. */
async function runTask(
  task: BuildTask,
  plan: BuildPlan,
  deps: BuildDeps,
  env: Record<string, string | undefined>,
  tests: typeof runTests,
  retry: boolean,
  say: (l: string) => void,
): Promise<TaskOutcome> {
  const { cwd, config: cfg } = deps;
  let calls = 0;
  let tokens = 0;
  const chat: ChatFn = async (step, messages, opts) => {
    const r = await deps.chat(step, messages, opts);
    tokens += r.usage.prompt_tokens + r.usage.completion_tokens;
    return r;
  };
  const stop = (why: string, solvedBy = "none"): TaskOutcome => ({ ok: false, why, solvedBy, calls, tokens });
  const testFile = testFileFor(task);
  const before = fileStates(cwd, task);
  // the task's test passing is not enough: every listed file must exist and have been created or changed here.
  // A failure of that check is reported to the ladder as the test's failure, with the reason as its text.
  const base = tests;
  tests = async (o) => {
    const r = await base(o);
    if (!r.ok || o.test === undefined) return r;
    const problems = fileProblems(cwd, task, before);
    return problems.length ? { ...r, ok: false, text: `FAIL: ${problems.join("; ")}\n${r.text}` } : r;
  };
  const header = `Project spec: ${plan.spec}\nStack: ${plan.stack}\nTask ${task.id}: ${task.title}\nFiles to touch: ${task.files.join(", ")} (each must exist when done; a file marked read-only may stay as it is)\nThe test that defines done: ${task.test}`;

  // 1. the test, written first (a blocked task keeps the test it already has)
  if (!(retry && existsSync(join(cwd, testFile)))) {
    const exists = existsSync(join(cwd, testFile));
    const msgs: Message[] = [
      { role: "system", content: TEST_SYSTEM },
      {
        role: "user",
        content:
          `Repository outline:\n${outline(cwd)}\n\n${header}\n\nWrite the test in ${testFile}.` +
          (exists ? `\n\nIt already exists:\n${showFile(cwd, testFile)}\nAdd this task's test to it.` : "") +
          "\n\nReply with edit blocks only.",
      },
    ];
    const others = repoFiles(cwd).filter((f) => f !== testFile);
    let wrote = false;
    for (let attempt = 0; attempt < 2 && !wrote; attempt++) {
      calls++;
      const r = await chat("edit", msgs, { workflow: "build", config: cfg, env });
      const res = await applyReply(r.text, { cwd, protected: others });
      // the protected list covers files that exist; a new file other than the test is removed again
      for (const p of res.applied) if (p !== testFile) rmSync(join(cwd, p), { force: true });
      wrote = res.applied.includes(testFile);
      if (!wrote) msgs.push({ role: "assistant", content: r.text }, { role: "user", content: `Nothing was written to ${testFile}. Reply with edit blocks for ${testFile} only.` });
    }
    if (!wrote) return stop(`could not write the test ${testFile}`);
    say(`  test written: ${testFile}`);
  }

  // 2. it must fail before the code exists
  const first = await tests({ cwd, test: testFile, config: cfg.test });
  if (first.ok) {
    say("  the test already passes; nothing to build for this task");
  } else {
    // 3. the ladder
    const fixTask = `${header}\n\nMake ${testFile} pass without editing it.`;
    let fix: FixResult;
    const fp = (deps.progress ?? NOOP_PROGRESS).nest("fix");
    try {
      fix = await runFix({ test: testFile, undo: false, task: fixTask }, { cwd, config: cfg, chat, pi: cfg.ladder.rung3 ? deps.pi : undefined, report: () => {}, env, runTests: tests, progress: fp });
    } catch (e) {
      return stop(`fix error: ${(e as Error).message}`);
    } finally {
      fp.end();
    }
    calls += fix.calls;
    say(`  fix: solved_by ${fix.solvedBy}, ${fix.calls} calls`);
    if (fix.solvedBy === "none") {
      restoreSnapshot(cwd, env); // a blocked task leaves the tree as it was before the ladder (its test stays)
      return stop(fix.diagnosis ?? "every rung failed and no diagnosis was produced");
    }
    // 4. no regressions
    const all = await tests({ cwd, config: cfg.test });
    if (!all.ok) return stop(`the whole suite fails after this task:\n${all.text}`, fix.solvedBy);
    return { ok: true, why: "", solvedBy: fix.solvedBy, calls, tokens };
  }
  const all = await tests({ cwd, config: cfg.test });
  if (!all.ok) return stop(`the whole suite fails:\n${all.text}`);
  return { ok: true, why: "", solvedBy: "already", calls, tokens };
}
