// /commit [--yes] [hint]: a conventional commit message for what is staged. Code reads `git diff --staged` (git is
// always spawned, never a shell string). Nothing staged: it shows the unstaged changes and asks to stage all; without a UI
// (-p mode) only with --yes. ONE call on the small lane writes the message; code validates the format (conventional
// subject of at most 72 characters, a blank line, a body) with one retry that appends the reason. The message is shown,
// confirmed, written to a temp file and committed with `git commit -F` (hooks run; never --no-verify).
// If this run staged everything and the commit does not happen, the staging is undone.
import { NOOP_PROGRESS, type Progress } from "../progress.ts";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { Message } from "../llm.ts";
import type { ChatFn } from "./fix.ts";

export const SUBJECT_MAX = 72;
export const DIFF_CHARS = 12000;
export const TYPES = ["feat", "fix", "docs", "style", "refactor", "perf", "test", "build", "ci", "chore", "revert"] as const;

export const COMMIT_RULES = `Write a git commit message for the staged change below.
Conventional Commits:
<type>(<optional scope>): <subject>

<body>
type: ${TYPES.join(", ")}. Subject imperative, lower case after colon, no trailing period, max ${SUBJECT_MAX} chars in all.
Blank line, then body of 1-5 short lines: what changed and why, wrapped near 72 chars.
Only what the diff shows. Reply message only: no code fences, quotes, commentary.`;

export interface CommitArgs {
  yes: boolean;
  hint: string;
}

/** `[--yes] [hint text]`: the flag from the front only; the rest is an optional hint for the message. */
export function parseCommitArgs(raw: string): CommitArgs {
  let rest = raw.trim();
  let yes = false;
  for (;;) {
    const m = rest.match(/^(--yes|-y)\b\s*/);
    if (!m) break;
    yes = true;
    rest = rest.slice(m[0].length);
  }
  return { yes, hint: rest.trim() };
}

const SUBJECT_RE = new RegExp(`^(?:${TYPES.join("|")})(?:\\([A-Za-z0-9_./,-]+\\))?!?: \\S`);

export interface MessageCheck {
  ok: boolean;
  /** the cleaned message (fences and wrapping quotes removed, trailing space trimmed) */
  message: string;
  reason: string;
}

/** Strip fences and wrapping quotes, then check subject, blank line and body. Pure. */
export function validateMessage(raw: string): MessageCheck {
  let t = raw.replace(/\r\n?/g, "\n").trim();
  const fence = t.match(/^```[A-Za-z]*\n([\s\S]*?)\n?```$/);
  if (fence) t = fence[1]!.trim();
  if (/^(["'`]).*\1$/s.test(t) && t.length > 1) t = t.slice(1, -1).trim();
  t = t.split("\n").map((l) => l.replace(/\s+$/, "")).join("\n");
  const lines = t.split("\n");
  const subject = lines[0] ?? "";
  const fail = (reason: string): MessageCheck => ({ ok: false, message: t, reason });
  if (!subject) return fail("the message is empty");
  if (!SUBJECT_RE.test(subject)) return fail(`the subject must look like "<type>(<scope>): <subject>" with type one of ${TYPES.join(", ")}`);
  if (subject.length > SUBJECT_MAX) return fail(`the subject is ${subject.length} characters; the limit is ${SUBJECT_MAX}`);
  if (subject.endsWith(".")) return fail("the subject must not end with a period");
  if (lines.length < 3 || lines[1] !== "") return fail("a blank line must follow the subject, then a body");
  if (!lines.slice(2).some((l) => l.trim())) return fail("the body is empty; add one to five lines saying what changed and why");
  return { ok: true, message: t + "\n", reason: "" };
}

export interface GitResult {
  code: number | null;
  out: string;
  err: string;
}
export type GitFn = (cwd: string, args: string[]) => Promise<GitResult>;

export const gitSpawn: GitFn = (cwd, args) =>
  new Promise((resolve) => {
    let child;
    try {
      child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      resolve({ code: null, out: "", err: (e as Error).message });
      return;
    }
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ code: null, out, err: err + e.message }));
    child.on("close", (code) => resolve({ code, out, err }));
  });

/** The staged diff for the small model: the stat first, then each file's diff trimmed so every file shows. Pure. */
export function diffForModel(stat: string, diff: string, cap = DIFF_CHARS): string {
  const files = diff.split(/\n(?=diff --git )/).filter((f) => f.trim());
  const head = `Staged files:\n${stat.trim()}\n\nDiff:\n`;
  const room = Math.max(1000, cap - head.length);
  const per = Math.floor(room / Math.max(1, files.length));
  const parts = files.map((f) => (f.length > per ? f.slice(0, per).replace(/\n[^\n]*$/, "") + "\n[... diff of this file cut ...]" : f));
  return head + parts.join("\n");
}

/** The phases /commit reports. */
export const COMMIT_PHASES = ["read diff", "write message", "commit"];

export interface CommitDeps {
  progress?: Progress;
  cwd: string;
  config: Config;
  chat: ChatFn;
  report: (line: string) => void;
  /** a UI's yes/no; absent in -p mode, where --yes stands in for every confirmation */
  confirm?: (question: string) => Promise<boolean>;
  git?: GitFn;
  env?: Record<string, string | undefined>;
}

export type CommitOutcome = "committed" | "nothing" | "declined" | "refused" | "failed";
export interface CommitResult {
  outcome: CommitOutcome;
  calls: number;
  message: string;
  staged: boolean;
}

export async function runCommit(args: CommitArgs, deps: CommitDeps): Promise<CommitResult> {
  const { cwd } = deps;
  const git = deps.git ?? gitSpawn;
  const say = deps.report;
  const pg = deps.progress ?? NOOP_PROGRESS;
  pg.step("read diff");
  let calls = 0;
  let stagedByUs = false;
  const res = (outcome: CommitOutcome, message = ""): CommitResult => ({ outcome, calls, message, staged: stagedByUs });
  const unstage = async () => {
    if (!stagedByUs) return;
    await git(cwd, ["reset", "-q"]);
    say("unstaged again: this run had staged everything");
    stagedByUs = false;
  };
  const ask = async (q: string): Promise<boolean> => {
    if (args.yes) return true;
    if (!deps.confirm) return false;
    try {
      return await deps.confirm(q);
    } catch {
      return false;
    }
  };

  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0 || inside.out.trim() !== "true") {
    say("/commit: not a git repository (or git is not installed)");
    return res("failed");
  }
  let staged = await git(cwd, ["diff", "--staged", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"]);
  if (staged.code !== 0) {
    say(`/commit: git diff --staged failed: ${staged.err.trim().slice(0, 200)}`);
    return res("failed");
  }
  if (!staged.out.trim()) {
    const status = await git(cwd, ["status", "--porcelain"]);
    const changes = status.out.split("\n").filter((l) => l.trim());
    if (!changes.length) {
      say("nothing to commit: no staged and no unstaged changes");
      return res("nothing");
    }
    say("nothing is staged. Changes in the working tree:");
    for (const l of changes.slice(0, 20)) say(`  ${l}`);
    if (changes.length > 20) say(`  ... and ${changes.length - 20} more`);
    if (!args.yes && !deps.confirm) {
      say("not staging in this mode without --yes: stage with git add, or run /commit --yes");
      return res("nothing");
    }
    if (!(await ask(`stage all ${changes.length} change(s) and commit?`))) {
      say("not staged; nothing committed");
      return res("declined");
    }
    const add = await git(cwd, ["add", "-A"]);
    if (add.code !== 0) {
      say(`/commit: git add -A failed: ${add.err.trim().slice(0, 200)}`);
      return res("failed");
    }
    stagedByUs = true;
    staged = await git(cwd, ["diff", "--staged", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/"]);
    if (!staged.out.trim()) {
      say("nothing to commit after staging");
      await unstage();
      return res("nothing");
    }
  }
  const stat = await git(cwd, ["diff", "--staged", "--no-color", "--stat"]);
  const user = `${diffForModel(stat.out, staged.out)}${args.hint ? `\n\nHint from the developer: ${args.hint}` : ""}`;
  const msgs: Message[] = [
    { role: "system", content: COMMIT_RULES },
    { role: "user", content: user },
  ];
  const call = async (): Promise<string> => {
    calls++;
    pg.step("write message", calls, 2);
    return (await deps.chat("commit", msgs, { workflow: "commit", config: deps.config, env: deps.env })).text;
  };
  let reply = await call();
  let check = validateMessage(reply);
  if (!check.ok) {
    say(`message refused (${check.reason}); retrying once`);
    msgs.push({ role: "assistant", content: reply }, { role: "user", content: `Message refused: ${check.reason}. Corrected message only.` });
    reply = await call();
    check = validateMessage(reply);
  }
  if (!check.ok) {
    say(`message refused again (${check.reason}); nothing committed`);
    say(reply.trim().slice(0, 400));
    await unstage();
    return res("refused");
  }
  say("commit message:");
  for (const l of check.message.trimEnd().split("\n")) say(`  ${l}`);
  if (!(await ask("commit with this message?"))) {
    say(deps.confirm || args.yes ? "not committed" : "not committing in this mode without --yes");
    await unstage();
    return res("declined", check.message);
  }
  pg.step("commit");
  const dir = mkdtempSync(join(tmpdir(), "tinycode-commit-"));
  try {
    const file = join(dir, "COMMIT_EDITMSG");
    writeFileSync(file, check.message);
    const c = await git(cwd, ["commit", "-F", file]);
    if (c.code !== 0) {
      say(`git commit failed (exit ${c.code}); hooks and git's own message follow, nothing was committed`);
      say((c.out + c.err).trim().slice(0, 1500));
      await unstage();
      return res("failed", check.message);
    }
    const first = c.out.split("\n").find((l) => l.trim()) ?? "";
    pg.touch("git commit");
    say(`committed: ${first.trim()}`);
    say(`calls: ${calls}`);
    return res("committed", check.message);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
