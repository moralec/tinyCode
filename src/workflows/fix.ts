// /fix: the ladder. Port of our benchmark Pure logic with injected dependencies (model calls, test runner,
// the Pi hand-off), so unit tests run with scripted replies and no network or Pi.
//   rung 1  outline -> pick <= 5 files (json_schema) -> files -> one edit call -> apply -> test
//   rung 2  review call in a fresh context (test output, diff, evidence) -> diagnosis appended at the tail of the
//           rung-1 conversation -> one more edit call -> apply -> test
//   rung 3  restore the tree to its pre-ladder state, then hand the task (+ diagnosis) to Pi's guarded loop
// Every direct call goes through `chat(step, ...)` (lanes, fallback, call log); every reply is also saved to
// fix-replies.jsonl next to the call log, so later goldens are real model output.
import { NOOP_PROGRESS, type Progress } from "../progress.ts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { decide, logRun, readRuns } from "../adaptive.ts";
import type { Config } from "../config.ts";
import { evidence } from "../context/evidence.ts";
import { outline, repoFiles } from "../context/outline.ts";
import { lintPass, type LintOptions } from "../lint.ts";
import type { ChatOptions, ChatResult, Message } from "../llm.ts";
import { SESSION } from "../llm.ts";
import { logPath } from "../log.ts";
import { applyReply, type ApplyResult } from "../protocol/apply.ts";
import { SYSTEM } from "../protocol/prompts.ts";
import { failingNames, failureBlocks, firstErrorLine, parseCounts, runTests, type TestCounts, type TestRun } from "../testrun.ts";
import { runTestGen } from "./testgen.ts";

export const PICK_SCHEMA = {
  type: "object",
  properties: {
    files: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
    reason: { type: "string" },
  },
  required: ["files", "reason"],
};
export const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    diagnosis: { type: "string" },
    where: { type: "array", items: { type: "string" }, maxItems: 4 },
    next_step: { type: "string" },
  },
  required: ["diagnosis", "where", "next_step"],
};
export const REVIEW_SYSTEM =
  "Code change tried; test still fails. See test output, failing assertions, current files. Files shown are complete " +
  "current code. Say why fail, name exact path:line to change. Never call code incomplete when file shown. " +
  "Text ending \"[file cut here\" or \"[diff cut here\" cut for length; files on disk are complete. Short, concrete.";

export type SolvedBy = "rung1" | "rung2" | "pi" | "none";

export type ChatFn = (step: string, messages: Message[], opts?: ChatOptions) => Promise<ChatResult>;

export interface FixArgs {
  test?: string;
  /** a bug description with no failing test: write a reproduction first (default true; /add and /edit hand-overs set false) */
  reproduce?: boolean;
  undo: boolean;
  task: string;
}

/** `[--test PATH] [--undo] <task text>`: flags are read from the front only; the rest is the task. */
export function parseFixArgs(raw: string): FixArgs {
  let rest = raw.trim();
  let test: string | undefined;
  let undo = false;
  for (;;) {
    const t = rest.match(/^--test(?:=|\s+)(\S+)\s*/);
    if (t) {
      test = t[1].replace(/^["']|["']$/g, "");
      rest = rest.slice(t[0].length);
      continue;
    }
    const u = rest.match(/^--undo\b\s*/);
    if (u) {
      undo = true;
      rest = rest.slice(u[0].length);
      continue;
    }
    break;
  }
  return { test, undo, task: rest.trim() };
}

// ---------------------------------------------------------------- snapshot / undo

type Env = Record<string, string | undefined>;

const MAX_SNAPSHOT_FILE = 2_000_000;
const MAX_SNAPSHOT_TOTAL = 50_000_000;

/** Where the pre-ladder copy of the tree lives (outside the repo, one per working directory). */
export function undoDir(cwd: string, env: Env = process.env, slot = ""): string {
  const id = createHash("sha1").update(resolve(cwd)).digest("hex").slice(0, 12);
  return join(dirname(logPath(env)), "undo", id + slot);
}

const SOURCE_EXT = /\.(py|js|ts|sh)$/;
const TEST_FILE = /(^|\/)(tests?|__tests__)\/|(^|\/)test_[^/]*$|[._](test|spec)\.[a-z]+$|_test\.[a-z]+$|(^|\/)conftest\.py$/i;

/** The one non-test source file of the tree (repoFiles), or null when there are none or several. */
export function soleSource(cwd: string, test?: string | null): string | null {
  const src = repoFiles(cwd).filter((f) => SOURCE_EXT.test(f) && f !== test && !TEST_FILE.test(f) && !/(^|\/)__init__\.py$/.test(f));
  return src.length === 1 ? src[0]! : null;
}

/** The ladder's second snapshot: the best tree its rungs produced (see `better`). Never what `/fix --undo` restores. */
const BEST_SLOT = ".best";

interface Manifest {
  cwd: string;
  ts: string;
  /** every text file present when the snapshot was taken */
  files: string[];
}

/** Copy every text file of the tree (repoFiles) to the undo dir. Replaces any earlier snapshot of this cwd. */
export function takeSnapshot(cwd: string, env: Env = process.env, slot = ""): Manifest {
  const dir = undoDir(cwd, env, slot);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, "files"), { recursive: true });
  const files: string[] = [];
  let total = 0;
  for (const f of repoFiles(cwd)) {
    const abs = join(cwd, f);
    let size: number;
    try {
      size = statSync(abs).size;
    } catch {
      continue;
    }
    if (size > MAX_SNAPSHOT_FILE || total + size > MAX_SNAPSHOT_TOTAL) continue;
    total += size;
    const dst = join(dir, "files", f);
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, readFileSync(abs));
    files.push(f);
  }
  const manifest: Manifest = { cwd: resolve(cwd), ts: new Date().toISOString(), files };
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return manifest;
}

function readManifest(cwd: string, env: Env, slot = ""): Manifest | null {
  try {
    return JSON.parse(readFileSync(join(undoDir(cwd, env, slot), "manifest.json"), "utf8")) as Manifest;
  } catch {
    return null;
  }
}

/** Remove a directory the ladder created once only __pycache__ is left in it, then try its parents. */
function pruneEmptyDirs(cwd: string, rel: string): void {
  while (rel && rel !== ".") {
    const abs = join(cwd, rel);
    try {
      const left = readdirSync(abs).filter((n) => n !== "__pycache__");
      if (left.length) return;
      rmSync(abs, { recursive: true, force: true });
    } catch {
      return;
    }
    rel = dirname(rel);
  }
}

export interface RestoreResult {
  restored: string[];
  removed: string[];
}

/** Put the tree back as the snapshot saw it: changed files rewritten, files created since removed. null = no snapshot. */
export function restoreSnapshot(cwd: string, env: Env = process.env, slot = ""): RestoreResult | null {
  const m = readManifest(cwd, env, slot);
  if (!m) return null;
  const dir = join(undoDir(cwd, env, slot), "files");
  const restored: string[] = [];
  const removed: string[] = [];
  for (const f of m.files) {
    const abs = join(cwd, f);
    const want = readFileSync(join(dir, f));
    let have: Buffer | null = null;
    try {
      have = readFileSync(abs);
    } catch {
      have = null;
    }
    if (have === null || !have.equals(want)) {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, want);
      restored.push(f);
    }
  }
  const was = new Set(m.files);
  for (const f of repoFiles(cwd)) {
    if (!was.has(f)) {
      rmSync(join(cwd, f), { force: true });
      removed.push(f);
      pruneEmptyDirs(cwd, dirname(f));
    }
  }
  return { restored, removed };
}

/** Files that differ from the snapshot (changed or created since), relative to cwd, "/"-separated. */
export function changedSinceSnapshot(cwd: string, env: Env = process.env): string[] {
  const m = readManifest(cwd, env);
  if (!m) return [];
  const dir = join(undoDir(cwd, env), "files");
  const out: string[] = [];
  for (const f of new Set([...m.files, ...repoFiles(cwd)])) {
    let have: Buffer;
    try {
      have = readFileSync(join(cwd, f));
    } catch {
      continue; // deleted: nothing to format
    }
    let was: Buffer | null = null;
    if (m.files.includes(f)) {
      try {
        was = readFileSync(join(dir, f));
      } catch {
        was = null;
      }
    }
    if (!was || !was.equals(have)) out.push(f);
  }
  return out.sort();
}

/** A small unified-style diff against the snapshot, for trees that are not git repos (or have untracked changes). */
export function snapshotDiff(cwd: string, env: Env = process.env): string {
  const m = readManifest(cwd, env);
  if (!m) return "";
  const dir = join(undoDir(cwd, env), "files");
  const out: string[] = [];
  const names = new Set([...m.files, ...repoFiles(cwd)]);
  for (const f of [...names].sort()) {
    const read = (p: string) => {
      try {
        return readFileSync(p, "utf8").replace(/\r\n/g, "\n");
      } catch {
        return null;
      }
    };
    const before = m.files.includes(f) ? read(join(dir, f)) : null;
    const after = read(join(cwd, f));
    if (before === after) continue;
    const a = (before ?? "").split("\n");
    const b = (after ?? "").split("\n");
    let s = 0;
    while (s < a.length && s < b.length && a[s] === b[s]) s++;
    let ea = a.length;
    let eb = b.length;
    while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
      ea--;
      eb--;
    }
    out.push(`--- a/${f}`, `+++ b/${f}`, `@@ -${s + 1},${ea - s} +${s + 1},${eb - s} @@`);
    for (const l of a.slice(s, ea)) out.push("-" + l);
    for (const l of b.slice(s, eb)) out.push("+" + l);
  }
  return out.join("\n") + (out.length ? "\n" : "");
}

/** `git diff` of the working tree, or the snapshot diff when git gives nothing. */
export function workingDiff(cwd: string, env: Env = process.env): string {
  try {
    const out = execFileSync("git", ["diff", "--no-color", "--no-ext-diff"], {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (out.trim()) return out;
  } catch {
    // not a git repo
  }
  return snapshotDiff(cwd, env);
}

// ---------------------------------------------------------------- helpers

/** Python's `%s` of a list of strings: ['a', 'b'] (so the prompt text matches ladder.py). */
export const pyList = (xs: string[]): string => "[" + xs.map((x) => `'${x}'`).join(", ") + "]";

const normpath = (p: string): string => normalize(p).split(sep).join("/");

function insideCwd(cwd: string, p: string): boolean {
  if (!p || isAbsolute(p)) return false;
  const rel = relative(resolve(cwd), resolve(cwd, p));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function isFile(cwd: string, p: string): boolean {
  try {
    return insideCwd(cwd, p) && statSync(join(cwd, p)).isFile();
  } catch {
    return false;
  }
}

/** tc1.show: the file's path, then its text in a fence. */
export function showFile(cwd: string, p: string): string {
  return `${p}\n\`\`\`\n${readFileSync(join(cwd, p)).toString("utf8")}\`\`\``;
}

function formatFailed(res: ApplyResult): string {
  const parts = res.results.filter((r) => !r.ok).map((r) => `${r.path} (${r.reason})`);
  return parts.length ? parts.join(", ") : "none";
}

// ---------------------------------------------------------------- the ladder

/**
 * `a` is a strictly better test result than `b`: more tests pass, or as many pass and fewer fail with no test lost
 * (a tree that no longer imports reports 1 error out of 1, which is not better than 10 failing out of 10).
 */
export const better = (a: TestCounts, b: TestCounts): boolean =>
  a.passed > b.passed || (a.passed === b.passed && a.failed < b.failed && a.passed + a.failed >= b.passed + b.failed);

/**
 * What the model is told, once, when the ladder's best tree is kept: the counts, the still-failing tests (at most
 * `maxNames`), the first error line and the rule. Never the reviewer's prose: it describes an earlier tree.
 */
export function keptText(rung: number, now: TestCounts, lastText: string, maxNames = 8): string {
  const { names, total } = failingNames(lastText, maxNames);
  const more = Math.max(now.failed, total) - names.length;
  const err = firstErrorLine(lastText);
  return (
    `Kept rung ${rung} tree: ${now.passed}/${now.passed + now.failed} pass.` +
    (names.length ? ` Still fail: ${names.join(", ")}${more > 0 ? ` (+${more} more)` : ""}.` : "") +
    (err ? ` First error: ${err.replace(/[.\s]+$/, "")}.` : "") +
    " Edit only what fails. No rewrite."
  );
}

/** Starts the reviewer's part of a rung-3 hand-over text; `handoverText` finds the part to pass back by it. */
export const HANDOVER_MARK = "Reviewer diagnosis of last attempt:";

export interface PiHandoff {
  /** the first user message for Pi's loop */
  text: string;
  /** turn cap for this run (`ladder.loopTurnCap`) */
  turnCap: number;
  /** test counts of the tree the loop starts from (the ladder's kept tree, else the original); the loop's starting best */
  tree?: TestCounts | null;
}

/** The phases /fix reports, in order. */
export const FIX_PHASES = ["reproduce", "pick files", "edit", "review", "second edit", "loop"];

export interface FixDeps {
  /** progress display (src/progress.ts); absent = none */
  progress?: Progress;
  cwd: string;
  config: Config;
  chat: ChatFn;
  /** hand the task to Pi's loop and resolve when the run has ended; returns Pi's turn count. Absent = no rung 3. */
  pi?: (h: PiHandoff) => Promise<{ turns: number }>;
  report: (line: string) => void;
  env?: Env;
  runTests?: typeof runTests;
  /**
   * The caller (/add) already took a snapshot before its own first write: keep it as what `/fix --undo` restores.
   * The ladder still takes its own snapshot for its internal restores (rung 3) and puts the caller's back when it ends.
   */
  keepUndo?: boolean;
  /** test hook for the lint auto-fix runner */
  lint?: Pick<LintOptions, "exec" | "find">;
}

export interface FixResult {
  solvedBy: SolvedBy;
  /** direct model calls (pick, edit, review, edit) plus Pi's turns */
  calls: number;
  direct: number;
  piTurns: number;
  diagnosis: string | null;
  /** set when the described behaviour already works: the reproduction test (path and text) that passed; it was undone and nothing ran after it */
  notReproduced?: { test: string; text: string };
  /** the reproduction test the ladder ran with (the described bug was reproduced) */
  reproTest?: string;
  /** the text handed to Pi, when rung 3 ran */
  handoff: string | null;
  /** when the ladder's best tree was kept for rung 3 instead of the original: what the model is told (else null) */
  kept?: string | null;
  lines: string[];
}

/** A JSON string body (possibly cut off before its closing quote) as text. */
function jsonString(body: string): string {
  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    return body.replace(/\\n/g, " ").replace(/\\(.)/g, "$1");
  }
}

/** The review as text for the model: `Diagnosis / Where / Next step`. Tolerates JSON cut off by the token limit. */
export function formatReview(text: string): string {
  const show = (d: string, w: string[], n: string) => `Diagnosis: ${d}\nWhere: ${w.join(", ")}\nNext step: ${n}`;
  try {
    const j = JSON.parse(text) as { diagnosis?: string; where?: string[]; next_step?: string } | null;
    if (j && typeof j === "object" && !Array.isArray(j)) return show(j.diagnosis ?? "", j.where ?? [], j.next_step ?? "");
  } catch {
    // partial JSON or plain prose: pull out what is there
  }
  const field = (k: string): string | null => {
    const m = text.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`));
    return m ? jsonString(m[1]).trim() : null;
  };
  const diagnosis = field("diagnosis");
  const nextStep = field("next_step");
  const wm = text.match(/"where"\s*:\s*\[([^\]]*)/);
  const where = wm ? [...wm[1].matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => jsonString(x[1])) : [];
  if (diagnosis || nextStep || where.length) return show(diagnosis ?? "", where, nextStep ?? "");
  const whole = text.replace(/\s+/g, " ").trim();
  const flat = whole.length > 800 ? `${whole.slice(0, 800)} [review text cut here at 800 chars]` : whole;
  return /[A-Za-z0-9]{2}/.test(flat) ? flat : "(the review was cut off before it said anything)";
}

export function trunkModel(cfg: Config): string {
  const lane = cfg.lanes[cfg.steps.edit.lane];
  return lane ? lane.model : "";
}

function logReply(env: Env, rec: Record<string, unknown>): void {
  try {
    const p = join(dirname(logPath(env)), "fix-replies.jsonl");
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(rec) + "\n");
  } catch {
    // never break a workflow over a log
  }
}

/**
 * With a bug description and no failing test, first write a minimal reproduction from the description (as /test does:
 * test files only, expected to fail on the current code) and run it. It fails: the ladder continues with that test.
 * It passes: "couldn't reproduce", the test is shown and undone, and the run stops. Anything else (no target found,
 * no test routine, the test would not run): the ladder runs as it always did, without a test.
 */
async function reproduceFirst(args: FixArgs, deps: FixDeps): Promise<{ args: FixArgs; stop?: FixResult; calls: number; lines: string[] }> {
  const env = deps.env ?? process.env;
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    deps.report(l);
  };
  deps.progress?.step("reproduce");
  takeSnapshot(deps.cwd, env); // undone if the test passes; runLadder keeps it as the `/fix --undo` copy
  const r = await runTestGen(
    { expectFail: true, fresh: true, task: `a test that reproduces this bug (it must fail while the bug is there): ${args.task}` },
    { cwd: deps.cwd, config: deps.config, chat: deps.chat, report: say, env, runTests: deps.runTests, lint: deps.lint },
  );
  if (r.outcome === "unexpected-pass" && r.testFile) {
    const text = readFileSync(join(deps.cwd, r.testFile), "utf8");
    const allLines = text.split("\n");
    const shown = (allLines.length > 40 ? `[first ${allLines.length - 40} lines of the test not shown for length]\n` : "") + allLines.slice(-40).join("\n");
    restoreSnapshot(deps.cwd, env);
    say(`couldn't reproduce: the described behaviour already works (test: ${r.testFile})`);
    say(`the test that passed (undone):\n${shown}`);
    const stop: FixResult = { solvedBy: "none", calls: r.calls, direct: r.calls, piTurns: 0, diagnosis: null, notReproduced: { test: r.testFile, text: shown }, handoff: null, lines };
    return { args, stop, calls: r.calls, lines };
  }
  if (r.outcome === "expected-fail" && r.testFile) {
    say(`reproduced: the new test ${r.testFile} fails on the current code; the ladder continues with it`);
    return { args: { ...args, test: r.testFile }, calls: r.calls, lines };
  }
  restoreSnapshot(deps.cwd, env);
  say(`no reproduction test could be made (${r.outcome}); the ladder runs without one`);
  return { args, calls: r.calls, lines };
}

export async function runFix(args: FixArgs, deps: FixDeps): Promise<FixResult> {
  let repro: { calls: number; lines: string[] } | null = null;
  if (!args.test && !args.undo && args.reproduce !== false && args.task && !deps.keepUndo) {
    const r = await reproduceFirst(args, deps);
    if (r.stop) return r.stop;
    repro = r;
    args = r.args;
    deps = { ...deps, keepUndo: true }; // the snapshot taken before the reproduction test is what /fix --undo restores
  }
  const out = await runFixInner(args, deps);
  if (!repro) return out;
  return { ...out, calls: out.calls + repro.calls, direct: out.direct + repro.calls, reproTest: args.test, lines: [...repro.lines, ...out.lines] };
}

async function runFixInner(args: FixArgs, deps: FixDeps): Promise<FixResult> {
  if (!deps.keepUndo) return runLadder(args, deps);
  // Keep the earliest snapshot per run (S18): set the caller's aside, let the ladder snapshot as usual, put it back.
  const env = deps.env ?? process.env;
  const dir = undoDir(deps.cwd, env);
  const aside = `${dir}.earliest`;
  rmSync(aside, { recursive: true, force: true });
  let moved = false;
  try {
    renameSync(dir, aside);
    moved = true;
  } catch {
    // no earlier snapshot: the ladder's own stays, as before
  }
  try {
    return await runLadder(args, deps);
  } finally {
    if (moved) {
      rmSync(dir, { recursive: true, force: true });
      renameSync(aside, dir);
    }
  }
}

async function runLadder(args: FixArgs, deps: FixDeps): Promise<FixResult> {
  const { cwd, config: cfg } = deps;
  const env = deps.env ?? process.env;
  const test = args.test ? normpath(args.test) : undefined;
  const tests = deps.runTests ?? runTests;
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    deps.report(l);
  };
  const pg = deps.progress ?? NOOP_PROGRESS;
  let direct = 0;
  const call = async (step: string, msgs: Message[], opts: ChatOptions = {}): Promise<string> => {
    direct++;
    const r = await deps.chat(step, msgs, { ...opts, workflow: "fix", config: cfg, env });
    logReply(env, {
      ts: new Date().toISOString(),
      session: SESSION,
      step,
      model: r.model,
      cwd: resolve(cwd),
      task: args.task.slice(0, 200),
      n: direct,
      prompt_tokens: r.usage.prompt_tokens,
      completion_tokens: r.usage.completion_tokens,
      reply: r.text,
    });
    return r.text;
  };
  let lastRaw = "";
  const runTest = async (): Promise<TestRun> => {
    const t = await tests({ cwd, test, config: cfg.test });
    lastRaw = t.raw ?? "";
    return t;
  };
  const countsOf = (t: TestRun): TestCounts | null => t.counts ?? parseCounts(t.text);
  /** the original tree's test counts, and the best tree a rung left (kept for rung 3 when it beats the original) */
  let orig: TestCounts | null = null;
  let best: { rung: number; counts: TestCounts; text: string } | null = null;
  const noteAttempt = (rung: number, t: TestRun): void => {
    const c = countsOf(t);
    if (!c || !orig || !better(c, best?.counts ?? orig)) return;
    takeSnapshot(cwd, env, BEST_SLOT);
    best = { rung, counts: c, text: t.text };
  };
  let started: "ladder" | "pi" = "ladder";
  /** After a pass: the project's formatter/linter on the files the run changed; undone if the test then fails. */
  const lint = async (): Promise<void> => {
    await lintPass(
      { cwd, files: changedSinceSnapshot(cwd, env), env },
      { report: say, lint: deps.lint, verify: async () => (await runTest()).ok },
    );
  };
  const done = (solvedBy: SolvedBy, piTurns: number, diagnosis: string | null, handoff: string | null): FixResult => {
    const calls = direct + piTurns;
    rmSync(undoDir(cwd, env, BEST_SLOT), { recursive: true, force: true });
    logRun({ ts: new Date().toISOString(), model: trunk, started, solved_by: solvedBy }, env);
    say(`solved_by: ${solvedBy}`);
    say(`calls: ${calls}`);
    return { solvedBy, calls, direct, piTurns, diagnosis, handoff, lines };
  };

  const protectedPaths = test ? [test] : [];
  const trunk = trunkModel(cfg);
  takeSnapshot(cwd, env); // before the first write: `/fix --undo` restores this

  let diag: string | null = null;
  let msgs: Message[] = [];
  let reply = "";
  let out = "";
  let skipToPi: string | null = null;

  const plan = decide(cfg.ladder.mode, cfg.ladder.adaptive, trunk, readRuns(env));
  if (plan.start === "pi") {
    started = "pi";
    skipToPi = `rungs 1-2 skipped (Adaptive Ladder: ${plan.why}, ${plan.solved}/${plan.runs} rung 1-2 solves)`;
  } else {
    // ---- rung 1
    const head = ["Repository outline:\n" + outline(cwd)];
    const first = await runTest(); // also the original tree's count, for deciding what rung 3 starts from
    orig = countsOf(first);
    if (test && isFile(cwd, test)) head.push(showFile(cwd, test), "Test output now:\n" + first.text);
    msgs = [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content:
          head.join("\n\n") +
          "\n\nTask:\n" +
          args.task +
          '\n\nStep 1: JSON {"files": [max 5 outline paths to read or change], "reason": "..."}. ' +
          "Include files to create if folder exists.",
      },
    ];
    pg.step("pick files");
    // one source file and its tests (an Exercism exercise): no pick call, that file is the pick (dot-dsl 16k: 5 s saved)
    const only = cfg.ladder.skipSolePick ? soleSource(cwd, test) : null;
    const raw = only ? JSON.stringify({ files: [only], reason: "only source file" }) : await call("pick", msgs, { schema: PICK_SCHEMA, schemaName: "pick" });
    if (only) say(`pick skipped: ${only} is the only source file`);
    let picked: string[] = [];
    try {
      const j = JSON.parse(raw) as { files?: unknown };
      picked = (Array.isArray(j.files) ? j.files : []).filter((p): p is string => typeof p === "string").map(normpath).slice(0, 5);
    } catch {
      picked = [];
    }
    const have = picked.filter((p) => isFile(cwd, p));
    say(`picked: ${JSON.stringify(picked)}`);
    const missing = [...new Set(picked.filter((p) => !have.includes(p)))].sort();
    if (cfg.ladder.singleFileOnly.includes(trunk) && picked.length > 1) {
      skipToPi = `rung 1 skipped (${picked.length} files picked, singleFileOnly for ${trunk})`;
    } else {
      msgs.push(
        { role: "assistant", content: raw },
        {
          role: "user",
          content:
            have.map((p) => showFile(cwd, p)).join("\n\n") +
            (missing.length ? `\n\n(missing, create if needed: ${missing.join(", ")})` : "") +
            "\n\nStep 2: edit blocks only.",
        },
      );
      pg.step("edit");
      reply = await call("edit", msgs);
      let res = await applyReply(reply, { cwd, protected: protectedPaths });
      for (const f of res.applied) pg.touch(String(f));
      let t = await runTest();
      out = t.text;
      say(`rung1: applied ${pyList(res.applied)} failed ${pyList(res.failed)} pass ${t.ok}`);
      if (t.ok) {
        await lint();
        return done("rung1", 0, null, null);
      }
      noteAttempt(1, t);

      // ---- rung 2
      if (cfg.ladder.rung2) {
        pg.step("review");
        diag = await reviewCall(out, lastRaw, workingDiff(cwd, env), cwd, call, cfg.ladder);
        say(`review: ${JSON.stringify(diag)}`);
        msgs.push(
          { role: "assistant", content: reply },
          {
            role: "user",
            content:
              `Applied: ${res.applied.length ? pyList(res.applied) : "none"}. ` +
              `Not applied: ${formatFailed(res)}.\nTest:\n${out}\n\n` +
              `Reviewer:\n${diag}\n\n` +
              "Corrected edit blocks against current files.",
          },
        );
        pg.step("second edit");
        reply = await call("edit", msgs);
        res = await applyReply(reply, { cwd, protected: protectedPaths });
        for (const f of res.applied) pg.touch(String(f));
        t = await runTest();
        out = t.text;
        say(`rung2: applied ${pyList(res.applied)} failed ${pyList(res.failed)} pass ${t.ok}`);
        if (t.ok) {
          await lint();
          return done("rung2", 0, diag, null);
        }
        noteAttempt(2, t);
      }
    }
  }

  // ---- rung 3: Pi's loop, from the original tree
  if (!cfg.ladder.rung3 || !deps.pi) {
    say(skipToPi ?? "rung3: off");
    return done("none", 0, diag, null);
  }
  if (skipToPi) say(skipToPi);
  // keep the best tree the ladder produced when it beats the original; else start from the original
  const keep = cfg.ladder.keepBest ? (best as { rung: number; counts: TestCounts; text: string } | null) : null;
  const kept = keep && orig ? keptText(keep.rung, keep.counts, keep.text, cfg.ladder.keptFailNames) : null;
  const back = keep && kept ? restoreSnapshot(cwd, env, BEST_SLOT) : restoreSnapshot(cwd, env);
  if (kept) say(kept);
  else if (back && (back.restored.length || back.removed.length)) {
    say(`restored: ${pyList(back.restored)} removed ${pyList(back.removed)} (the loop starts from the original tree)`);
  }
  const state = kept ?? "Earlier attempts failed, edits undone; files as originally found.";
  const handoff = kept ? `${args.task}\n\n${kept}` : diag ? `${args.task}\n\n${state} ${HANDOVER_MARK}\n${diag}` : args.task;
  say("rung3: pi");
  pg.step("loop");
  const { turns } = await deps.pi({ text: handoff, turnCap: cfg.ladder.loopTurnCap, tree: kept && keep ? keep.counts : orig });
  const fin = await runTest();
  say(`rung3: ${turns} turns, pass ${fin.ok}`);
  if (fin.ok) await lint();
  return { ...done(fin.ok ? "pi" : "none", turns, diag, handoff), kept };
}

/** Cut `text` to at most `max` characters at a line boundary and say so, so a model never mistakes the cut for the end of the content. */
export function cutWithMarker(text: string, max: number, what = "diff", note = "files on disk are complete"): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const nl = head.lastIndexOf("\n");
  const kept = nl > 0 ? head.slice(0, nl) : head;
  return `${kept}\n[${what} cut here at ${kept.length} chars; ${note}]`;
}

/** The part of a rung-3 hand-over a failed `fix` tool call passes back to the model: the reviewer's diagnosis (or the whole text), cut at `max` characters with a marker. */
export function handoverText(handoff: string, max = 900): string {
  const i = handoff.indexOf(HANDOVER_MARK);
  return cutWithMarker(handoff.slice(i >= 0 ? i : 0), max, "hand-over", "length cut, work not incomplete");
}

/** Paths the working diff changed (`+++ b/path` lines), without duplicates; deleted files left out. */
export function diffFiles(diff: string): string[] {
  return [...new Set([...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1]!.trim()))];
}

/** A file's text with line numbers, whole, or its first `maxLines` lines and the cut marker line (cutWithMarker's wording). */
export function numberedFile(text: string, maxLines: number): string {
  const lines = text.replace(/\n$/, "").split("\n");
  const numbered = lines.map((l, i) => `${String(i + 1).padStart(4)}: ${l}`);
  if (lines.length <= maxLines) return numbered.join("\n");
  const head = numbered.slice(0, maxLines).join("\n");
  return cutWithMarker(numbered.join("\n"), head.length + 1, "file").replace(/cut here at \d+ chars/, `cut here at line ${maxLines} of ${lines.length}`);
}

/** The rung-2 review: a fresh context, JSON diagnosis (ladder.review). It reads the code, not search hits. */
async function reviewCall(
  testOut: string,
  rawOut: string,
  diff: string,
  cwd: string,
  call: (step: string, msgs: Message[], opts?: ChatOptions) => Promise<string>,
  lad: Config["ladder"],
): Promise<string> {
  const files = diffFiles(diff).filter((p) => isFile(cwd, p));
  const blocks = failureBlocks(rawOut, lad.reviewFailBlocks, 12);
  const shown = files.map((p) => `${p} (current, complete)\n\`\`\`\n${numberedFile(readFileSync(join(cwd, p), "utf8"), lad.reviewFileLines)}\n\`\`\``);
  const parts = [`Test output:\n${testOut}`];
  if (blocks) parts.push(`Failing assertions:\n${blocks}`);
  parts.push(shown.length ? `Files changed (current code):\n${shown.join("\n\n")}` : `Diff tried:\n${cutWithMarker(diff, lad.reviewDiffChars) || "(no change was applied)"}`);
  if (lad.reviewOutlineChars > 0) {
    const names = (testOut.match(/[A-Za-z_][\w/.]*\.py|[A-Za-z_]\w{3,}/g) ?? []).slice(0, 30).join(" ");
    parts.push(`Outline:\n${evidence(cwd, names, { hitsCap: 0, outlineCap: lad.reviewOutlineChars }).outline}`);
  }
  const text = await call(
    "review",
    [
      { role: "system", content: REVIEW_SYSTEM },
      { role: "user", content: parts.join("\n\n") },
    ],
    { schema: REVIEW_SCHEMA, schemaName: "review" },
  );
  return formatReview(text);
}

/** `/fix --undo`: restore the snapshot taken before the last /fix wrote anything. */
export function undoFix(cwd: string, env: Env = process.env): string {
  const r = restoreSnapshot(cwd, env);
  if (!r) return "nothing to undo: no /fix snapshot for this directory";
  return `undone: restored ${r.restored.length} file(s), removed ${r.removed.length} created file(s)`;
}
