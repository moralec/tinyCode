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
import { runTests, type TestRun } from "../testrun.ts";

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
  "A code change was tried and the test still fails. From the test output, the diff and the search hits, say why " +
  "it failed and what to do differently. Be short and concrete; cite path:line.";

export type SolvedBy = "rung1" | "rung2" | "pi" | "none";

export type ChatFn = (step: string, messages: Message[], opts?: ChatOptions) => Promise<ChatResult>;

export interface FixArgs {
  test?: string;
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
export function undoDir(cwd: string, env: Env = process.env): string {
  const id = createHash("sha1").update(resolve(cwd)).digest("hex").slice(0, 12);
  return join(dirname(logPath(env)), "undo", id);
}

interface Manifest {
  cwd: string;
  ts: string;
  /** every text file present when the snapshot was taken */
  files: string[];
}

/** Copy every text file of the tree (repoFiles) to the undo dir. Replaces any earlier snapshot of this cwd. */
export function takeSnapshot(cwd: string, env: Env = process.env): Manifest {
  const dir = undoDir(cwd, env);
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

function readManifest(cwd: string, env: Env): Manifest | null {
  try {
    return JSON.parse(readFileSync(join(undoDir(cwd, env), "manifest.json"), "utf8")) as Manifest;
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
export function restoreSnapshot(cwd: string, env: Env = process.env): RestoreResult | null {
  const m = readManifest(cwd, env);
  if (!m) return null;
  const dir = join(undoDir(cwd, env), "files");
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

export interface PiHandoff {
  /** the first user message for Pi's loop */
  text: string;
  /** turn cap for this run (`ladder.loopTurnCap`) */
  turnCap: number;
}

/** The phases /fix reports, in order. */
export const FIX_PHASES = ["pick files", "edit", "review", "second edit", "loop"];

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
  /** the text handed to Pi, when rung 3 ran */
  handoff: string | null;
  lines: string[];
}

export function formatReview(text: string): string {
  try {
    const j = JSON.parse(text) as { diagnosis?: string; where?: string[]; next_step?: string };
    return `Diagnosis: ${j.diagnosis ?? ""}\nWhere: ${(j.where ?? []).join(", ")}\nNext step: ${j.next_step ?? ""}`;
  } catch {
    return text.slice(0, 800);
  }
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

export async function runFix(args: FixArgs, deps: FixDeps): Promise<FixResult> {
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
  const runTest = (): Promise<TestRun> => tests({ cwd, test, config: cfg.test });
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
    if (test && isFile(cwd, test)) {
      const first = await runTest();
      head.push(showFile(cwd, test), "Test output now:\n" + first.text);
    }
    msgs = [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content:
          head.join("\n\n") +
          "\n\nTask:\n" +
          args.task +
          '\n\nStep 1: reply with JSON {"files": [up to 5 paths from the outline to read or change], "reason": "..."}. ' +
          "Include files you need to create if their folder exists.",
      },
    ];
    pg.step("pick files");
    const raw = await call("pick", msgs, { schema: PICK_SCHEMA, schemaName: "pick" });
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
            (missing.length ? `\n\n(not found, create if needed: ${missing.join(", ")})` : "") +
            "\n\nStep 2: reply with edit blocks only.",
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

      // ---- rung 2
      if (cfg.ladder.rung2) {
        pg.step("review");
        diag = await reviewCall(out, workingDiff(cwd, env), cwd, call);
        say(`review: ${JSON.stringify(diag)}`);
        msgs.push(
          { role: "assistant", content: reply },
          {
            role: "user",
            content:
              `Edits applied: ${res.applied.length ? pyList(res.applied) : "none"}. ` +
              `Not applied (reason): ${formatFailed(res)}.\nTest:\n${out}\n\n` +
              `A reviewer looked at the failure:\n${diag}\n\n` +
              "Reply with corrected edit blocks against the files as they are now.",
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
      }
    }
  }

  // ---- rung 3: Pi's loop, from the original tree
  if (!cfg.ladder.rung3 || !deps.pi) {
    say(skipToPi ?? "rung3: off");
    return done("none", 0, diag, null);
  }
  if (skipToPi) say(skipToPi);
  const back = restoreSnapshot(cwd, env);
  if (back && (back.restored.length || back.removed.length)) {
    say(`restored: ${pyList(back.restored)} removed ${pyList(back.removed)} (the loop starts from the original tree)`);
  }
  const handoff = diag
    ? `${args.task}\n\nEarlier attempts failed and their edits were undone, so the files are as you first found them. ` +
      `A reviewer's diagnosis of the last attempt:\n${diag}`
    : args.task;
  say("rung3: pi");
  pg.step("loop");
  const { turns } = await deps.pi({ text: handoff, turnCap: cfg.ladder.loopTurnCap });
  const fin = await runTest();
  say(`rung3: ${turns} turns, pass ${fin.ok}`);
  if (fin.ok) await lint();
  return done(fin.ok ? "pi" : "none", turns, diag, handoff);
}

/** The rung-2 review: a fresh context, JSON diagnosis (ladder.review). */
async function reviewCall(
  testOut: string,
  diff: string,
  cwd: string,
  call: (step: string, msgs: Message[], opts?: ChatOptions) => Promise<string>,
): Promise<string> {
  const names = (testOut.match(/[A-Za-z_][\w/.]*\.py|[A-Za-z_]\w{3,}/g) ?? []).slice(0, 30).join(" ");
  const ev = evidence(cwd, names, { hitsCap: 4000, outlineCap: 1500 });
  const text = await call(
    "review",
    [
      { role: "system", content: REVIEW_SYSTEM },
      {
        role: "user",
        content:
          `Test output:\n${testOut}\n\nDiff tried:\n${diff.slice(0, 3000) || "(no change was applied)"}\n\n` +
          `Outline:\n${ev.outline}\n\nSearch hits:\n${ev.hits}`,
      },
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
