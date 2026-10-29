// /review [git-diff-args]: map over diff hunks, one small call each (step "hunk", sequential: one slot per lane),
// then merge by code: drop findings outside the hunk, dedupe, sort by severity. Pure logic with injected
// dependencies (hunks, file reader, chat), like fix.ts and edit.ts.
//   Writes findings.json and review-replies.jsonl (every raw reply) next to the call log.
import { NOOP_PROGRESS, type Progress } from "../progress.ts";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "../config.ts";
import { pyOutline } from "../context/outline.ts";
import { gitHunks, type Hunk } from "../context/diff.ts";
import type { Message } from "../llm.ts";
import { logPath } from "../log.ts";
import type { ChatFn } from "./fix.ts";

export const MAX_HUNKS = 40;
export const CONTEXT_LINES = 20;
export const LOCKFILES = new Set([
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "poetry.lock", "Pipfile.lock", "Cargo.lock", "composer.lock",
  "Gemfile.lock", "go.sum", "uv.lock", "bun.lockb",
]);

export type Severity = "high" | "medium" | "low";
const RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2 };

export const HUNK_SCHEMA = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          line: { type: "integer" },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          issue: { type: "string" },
          fix: { type: "string" },
        },
        required: ["line", "severity", "issue", "fix"],
      },
    },
  },
  required: ["findings"],
};

export const REVIEW_RUBRIC = `You review one hunk of a code change for real defects.
Each line of the hunk starts with its line number in the new file (removed lines have none), then ' ', '+' or '-'.
Report only defects the change introduces or leaves in the shown code: wrong results, wrong format strings or
constants, off-by-one, inverted conditions, unhandled errors, resource leaks, broken callers of changed behaviour.
Do not report style, naming, missing tests or missing comments. Use the docstrings and names as the intended behaviour.
Reply with JSON: {"findings":[{"line":<new-file line number>,"severity":"high|medium|low","issue":"<one sentence>","fix":"<one sentence>"}]}
At most 3 findings. If the hunk has no defect, reply {"findings":[]}.`;

export interface Finding {
  file: string;
  line: number;
  severity: Severity;
  issue: string;
  fix: string;
}

export interface ReviewArgs {
  /** extra arguments for `git diff` */
  diffArgs: string[];
}

export function parseReviewArgs(raw: string): ReviewArgs {
  return { diffArgs: raw.trim() ? raw.trim().split(/\s+/) : [] };
}

/** Last new-file line number the hunk covers (context + added lines). */
export function hunkEnd(h: Hunk): number {
  let n = h.newStart;
  let last = h.newStart - 1;
  for (const l of h.lines) {
    if (l[0] === " " || l[0] === "+") last = n++;
  }
  return Math.max(last, h.newStart);
}

/** The hunk as the model sees it: new-file line numbers on context and added lines. */
export function numberedHunk(h: Hunk): string {
  let n = h.newStart;
  const out: string[] = [];
  for (const l of h.lines) {
    if (l[0] === "\\") continue;
    if (l[0] === "-") out.push(`     ${l}`);
    else out.push(`${String(n++).padStart(4)} ${l}`);
  }
  return out.join("\n");
}

const size = (h: Hunk) => h.lines.length;

export interface Selection {
  hunks: Hunk[];
  skippedLock: number;
  skippedCap: number;
}

/** Drop lockfiles, then keep the MAX_HUNKS largest (in original order). */
export function selectHunks(all: Hunk[], max = MAX_HUNKS): Selection {
  const base = (f: string) => f.split("/").pop() ?? f;
  const keep = all.filter((h) => !LOCKFILES.has(base(h.file)));
  const skippedLock = all.length - keep.length;
  if (keep.length <= max) return { hunks: keep, skippedLock, skippedCap: 0 };
  const idx = keep.map((h, i) => ({ i, s: size(h) })).sort((a, b) => b.s - a.s || a.i - b.i).slice(0, max).map((x) => x.i).sort((a, b) => a - b);
  return { hunks: idx.map((i) => keep[i]!), skippedLock, skippedCap: keep.length - max };
}

/** One line about the file: its Python outline, or its name and line count. */
export function fileLine(file: string, text: string | null): string {
  if (text === null) return `${file}: (not readable)`;
  if (file.endsWith(".py")) {
    const { parts } = pyOutline(text);
    return `${file}: ${parts.join("; ") || "-"}`.slice(0, 600);
  }
  const n = text === "" ? 0 : text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
  return `${file} (${n} lines)`;
}

const SEV = new Set(["high", "medium", "low"]);

/** Parse one hunk reply into raw findings; tolerant of fences. Returns [] when it is not the expected JSON. */
export function parseFindings(text: string): { line: number; severity: Severity; issue: string; fix: string }[] {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return [];
  let j: unknown;
  try {
    j = JSON.parse(m[0]);
  } catch {
    return [];
  }
  const arr = (j as { findings?: unknown }).findings;
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const f of arr) {
    const x = f as Record<string, unknown>;
    const line = typeof x.line === "number" ? Math.trunc(x.line) : Number.NaN;
    if (!Number.isFinite(line) || typeof x.issue !== "string" || !x.issue.trim()) continue;
    const severity = (typeof x.severity === "string" && SEV.has(x.severity) ? x.severity : "low") as Severity;
    out.push({ line, severity, issue: x.issue.trim(), fix: typeof x.fix === "string" ? x.fix.trim() : "" });
  }
  return out.slice(0, 3);
}

/** Merge per-hunk findings: drop lines outside their hunk, dedupe (file, line, issue prefix), sort by severity. */
export function mergeFindings(per: { hunk: Hunk; raw: ReturnType<typeof parseFindings> }[]): Finding[] {
  const seen = new Set<string>();
  const out: Finding[] = [];
  for (const { hunk, raw } of per) {
    const end = hunkEnd(hunk);
    for (const f of raw) {
      if (f.line < hunk.newStart || f.line > end) continue;
      const key = `${hunk.file}\u0000${f.line}\u0000${f.issue.slice(0, 30).toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ file: hunk.file, line: f.line, severity: f.severity, issue: f.issue, fix: f.fix });
    }
  }
  return out.sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
}

/** The phases /review reports. */
export const REVIEW_PHASES = ["read diff", "review hunks", "merge"];

export interface ReviewDeps {
  progress?: Progress;
  cwd: string;
  config: Config;
  chat: ChatFn;
  report: (line: string) => void;
  env?: Record<string, string | undefined>;
  /** override for tests */
  hunks?: Hunk[];
  readFile?: (file: string) => string | null;
}

export interface ReviewResult {
  findings: Finding[];
  calls: number;
  hunks: number;
  skipped: number;
  lines: string[];
  /** where findings.json was written, or null when nothing was reviewed */
  file: string | null;
}

export async function runReview(args: ReviewArgs, deps: ReviewDeps): Promise<ReviewResult> {
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    deps.report(l);
  };
  const pg = deps.progress ?? NOOP_PROGRESS;
  pg.step("read diff");
  const all = deps.hunks ?? gitHunks(deps.cwd, [`-U${CONTEXT_LINES}`, ...args.diffArgs]);
  const sel = selectHunks(all);
  const skipped = sel.skippedLock + sel.skippedCap;
  if (!sel.hunks.length) {
    say("/review: no changes to review");
    return { findings: [], calls: 0, hunks: 0, skipped, lines, file: null };
  }
  const read =
    deps.readFile ??
    ((f: string) => {
      try {
        return readFileSync(join(deps.cwd, f), "utf8");
      } catch {
        return null;
      }
    });
  const per: { hunk: Hunk; raw: ReturnType<typeof parseFindings> }[] = [];
  const replyLog = join(dirname(logPath(deps.env ?? process.env)), "review-replies.jsonl");
  let calls = 0;
  for (const [k, h] of sel.hunks.entries()) {
    pg.step("review hunks", k + 1, sel.hunks.length);
    const messages: Message[] = [
      { role: "system", content: REVIEW_RUBRIC },
      {
        role: "user",
        content: `File: ${fileLine(h.file, read(h.file))}\nHunk ${h.header}\n${numberedHunk(h)}\n\nReview this hunk.`,
      },
    ];
    calls++;
    const r = await deps.chat("hunk", messages, { workflow: "review", config: deps.config, env: deps.env, schema: HUNK_SCHEMA, schemaName: "hunk_findings" });
    try {
      mkdirSync(dirname(replyLog), { recursive: true });
      appendFileSync(replyLog, JSON.stringify({ ts: new Date().toISOString(), file: h.file, header: h.header, model: r.model, prompt_tokens: r.usage.prompt_tokens, reply: r.text }) + "\n");
    } catch {
      // the reply log must not break a review
    }
    per.push({ hunk: h, raw: parseFindings(r.text) });
  }
  pg.step("merge");
  const findings = mergeFindings(per);
  const file = join(dirname(logPath(deps.env ?? process.env)), "findings.json");
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify({ hunks: sel.hunks.length, skipped, findings }, null, 2) + "\n");
  } catch {
    // printing still works
  }
  for (const f of findings) say(`${f.file}:${f.line} ${f.severity} ${f.issue}${f.fix ? ` (fix: ${f.fix})` : ""}`);
  if (!findings.length) say("no findings");
  if (skipped) say(`skipped ${skipped} hunk${skipped === 1 ? "" : "s"} (${sel.skippedLock} lockfile, ${sel.skippedCap} over the ${MAX_HUNKS}-hunk cap)`);
  say(`reviewed ${sel.hunks.length} hunks in ${calls} calls`);
  return { findings, calls, hunks: sel.hunks.length, skipped, lines, file };
}
