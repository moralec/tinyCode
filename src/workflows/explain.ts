// /explain <symbol, file or question>: "what does X do?", "how does Y work?" about this repo. No edits.
//   Code finds the target (--file, the router's hint, a file name in the question, else a definition of a named
//   symbol), then gathers it with numbered lines plus its callers and callees, capped near 4k tokens (outline.ts +
//   evidence.ts). ONE call answers in at most 200 words with file:line citations. Code then checks every citation:
//   the file must exist inside the repo and the line (or range) must be inside it. Bad ones are removed from the
//   answer and reported. Pure logic with injected dependencies; pure Node (no grep, no shell).
import { NOOP_PROGRESS, type Progress } from "../progress.ts";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { Config } from "../config.ts";
import { evidence, trackedFiles } from "../context/evidence.ts";
import { outline } from "../context/outline.ts";
import type { Message } from "../llm.ts";
import type { ChatFn } from "./fix.ts";
import { importers, importLines } from "./add.ts";

export const CONTEXT_CHARS = 16000; // ~4k tokens
export const MAX_WORDS = 200;
const BODY_LINES = 80;
const FILE_LINES = 120;

export const EXPLAIN_RULES = `You explain code in a repository to a developer. Answer only from the code shown below.
Reply in at most ${MAX_WORDS} words, plain sentences, no headings. Cite the code for every claim as path:line
(for example orders/dates.py:12), using the line numbers shown. Cite only lines you were shown. If the shown code
does not answer the question, say so in one sentence. Do not suggest changes.`;

export interface ExplainArgs {
  file?: string;
  question: string;
}

/** `[--file PATH] <question>`: the flag from the front only. */
export function parseExplainArgs(raw: string): ExplainArgs {
  let rest = raw.trim();
  const out: ExplainArgs = { question: "" };
  const m = rest.match(/^--file(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))\s*/);
  if (m) {
    out.file = m[1] ?? m[2] ?? m[3]!;
    rest = rest.slice(m[0].length);
  }
  out.question = rest.trim();
  return out;
}

const normpath = (p: string): string => normalize(p).split(sep).join("/").split("\\").join("/");
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function insideFile(cwd: string, p: string): boolean {
  if (!p || isAbsolute(p)) return false;
  const rel = relative(resolve(cwd), resolve(cwd, p));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  try {
    return statSync(join(cwd, p)).isFile();
  } catch {
    return false;
  }
}

function readLines(cwd: string, p: string): string[] | null {
  try {
    if (statSync(join(cwd, p)).size > 400_000) return null;
    const text = readFileSync(join(cwd, p), "utf8");
    const lines = text.split(/\r?\n/);
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    return lines;
  } catch {
    return null;
  }
}

const numbered = (lines: string[], from: number, to: number): string =>
  lines
    .slice(from - 1, to)
    .map((l, i) => `${from + i}: ${l}`)
    .join("\n");

const DEF = (name: string) =>
  new RegExp(`^\\s*(?:export\\s+)?(?:async\\s+)?(?:def|class|function|const|let|var|interface|type)\\s+${esc(name)}\\b`);

export interface Target {
  file: string;
  /** 1-based definition line of the symbol, when the target is a symbol */
  line?: number;
  symbol?: string;
}

/** The file as the target; when the question also names a symbol defined in it (not its own stem), the symbol. */
function inFile(cwd: string, file: string, q: string): Target {
  const lines = readLines(cwd, file) ?? [];
  const stem = file.slice(file.lastIndexOf("/") + 1).replace(/\.[^.]*$/, "");
  for (const sym of symbolCandidates(q)) {
    if (sym === stem) continue;
    const re = DEF(sym);
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) return { file, line: i + 1, symbol: sym };
  }
  return { file };
}

/** Candidate identifiers in the question, most specific (has _ or camelCase or a call paren) first. */
export function symbolCandidates(question: string): string[] {
  const ids = question.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? [];
  const score = (s: string) => (s.includes("_") ? 2 : /[a-z][A-Z]/.test(s) ? 2 : 0) + (question.includes(s + "(") ? 1 : 0);
  return [...new Set(ids)].map((s, i) => ({ s, i })).sort((a, b) => score(b.s) - score(a.s) || a.i - b.i).map((x) => x.s);
}

/** The file the question names (`--file`, then a path or base name in the text), else the file defining a named symbol. */
export function findTarget(cwd: string, args: ExplainArgs, files = trackedFiles(cwd)): Target | null {
  if (args.file) {
    const f = normpath(args.file);
    return insideFile(cwd, f) ? { file: f } : null;
  }
  const q = args.question;
  const byPath = files.filter((f) => new RegExp(`(?<![\\w/.-])${esc(f)}(?![\\w])`).test(q));
  if (byPath.length) return inFile(cwd, byPath.sort((a, b) => b.length - a.length)[0]!, q);
  const byBase = files.filter((f) => f.includes("/") && new RegExp(`(?<![\\w/.-])${esc(f.slice(f.lastIndexOf("/") + 1))}(?![\\w])`).test(q));
  const byBare = files.filter((f) => !f.includes("/") && new RegExp(`(?<![\\w/.-])${esc(f)}(?![\\w])`).test(q));
  const named = [...byBare, ...byBase];
  // a file named in the question wins; a symbol is then looked for only inside it
  if (named.length) return inFile(cwd, named[0]!, q);
  for (const sym of symbolCandidates(q)) {
    for (const f of files) {
      if (!/\.(py|js|ts|mjs|cjs|jsx|tsx|sh|scpt)$/.test(f)) continue;
      const lines = readLines(cwd, f);
      if (!lines) continue;
      const re = DEF(sym);
      const i = lines.findIndex((l) => re.test(l));
      if (i >= 0) return { file: f, line: i + 1, symbol: sym };
    }
  }
  return null;
}

/** The end of a definition that starts at `start` (1-based): the next line at the same or lesser indent, capped. */
function bodyEnd(lines: string[], start: number): number {
  const indent = (l: string) => l.length - l.trimStart().length;
  const base = indent(lines[start - 1]!);
  let end = start;
  for (let i = start; i < lines.length && i < start + BODY_LINES; i++) {
    const l = lines[i]!;
    if (l.trim() === "") continue;
    if (indent(l) <= base && !/^\s*[)}\]]/.test(l)) break;
    end = i + 1;
  }
  return end;
}

const CALL = /\b([A-Za-z_][A-Za-z0-9_]{2,})\s*\(/g;
const NOT_CALLS = new Set(["if", "for", "while", "return", "print", "def", "class", "function", "with", "assert", "len", "str", "int", "list", "dict", "set", "tuple", "range", "isinstance", "super", "sorted", "open", "catch", "switch", "await", "async", "import", "from", "not", "and", "elif", "else", "raise", "yield", "lambda", "map", "filter", "sum", "min", "max", "any", "all", "enumerate", "zip", "type", "getattr", "setattr", "hasattr", "require", "String", "Number", "Boolean", "Array", "Object", "Error", "Promise", "Map", "Set"]);

export interface Gathered {
  target: Target;
  text: string;
  /** files whose lines may be cited */
  chars: number;
}

/** Callers: lines in other places that mention the symbol (or import the file). Callees: repo definitions called from the body. */
export function gather(cwd: string, target: Target, question: string, cap = CONTEXT_CHARS): Gathered {
  const parts: string[] = [];
  let used = 0;
  const add = (title: string, body: string) => {
    if (!body.trim()) return;
    const room = cap - used - title.length - 8;
    if (room < 80) return;
    const b = body.length > room ? body.slice(0, room).replace(/\n[^\n]*$/, "") + "\n..." : body;
    const block = `${title}\n${b}`;
    parts.push(block);
    used += block.length + 2;
  };
  const lines = readLines(cwd, target.file) ?? [];
  const files = trackedFiles(cwd);
  let calleeNames: string[] = [];
  let callers: string[] = [];
  if (target.symbol && target.line) {
    const end = bodyEnd(lines, target.line);
    const ctxStart = Math.max(1, target.line - 2);
    add(`${target.file} lines ${ctxStart}-${end} (numbered):`, numbered(lines, ctxStart, end));
    const body = lines.slice(target.line, end).join("\n");
    calleeNames = [...new Set([...body.matchAll(CALL)].map((m) => m[1]!))].filter((n) => n !== target.symbol && !NOT_CALLS.has(n));
    const re = new RegExp(`\\b${esc(target.symbol)}\\b`);
    for (const f of files) {
      const ls = f === target.file ? lines : readLines(cwd, f);
      if (!ls || !/\.(py|js|ts|mjs|cjs|jsx|tsx|sh|scpt|md)$/.test(f)) continue;
      ls.forEach((l, i) => {
        if (f === target.file && i + 1 >= target.line! && i + 1 <= end) return;
        if (re.test(l) && callers.length < 8) callers.push(`${f}:${i + 1}: ${l.trim().slice(0, 140)}`);
      });
    }
  } else {
    const n = Math.min(lines.length, FILE_LINES);
    add(`${target.file} lines 1-${n} (numbered):`, numbered(lines, 1, n));
    const imps = importLines(lines.join("\n"));
    callers = importers(cwd, target.file, 6);
    calleeNames = [...new Set([...lines.slice(0, 400).join("\n").matchAll(CALL)].map((m) => m[1]!))].filter((x) => !NOT_CALLS.has(x));
    if (imps.length) add("Imports:", imps.join("\n"));
  }
  if (callers.length) add(target.symbol ? "Callers (other mentions):" : "Files that import it:", callers.join("\n"));
  // callees: where each called name is defined in the repo (path:line: signature)
  const defs: string[] = [];
  if (calleeNames.length) {
    const want = calleeNames.slice(0, 12);
    outer: for (const f of files) {
      if (!/\.(py|js|ts|mjs|cjs|jsx|tsx)$/.test(f)) continue;
      const ls = f === target.file ? lines : readLines(cwd, f);
      if (!ls) continue;
      for (const name of want) {
        const re = DEF(name);
        const i = ls.findIndex((l) => re.test(l));
        if (i >= 0 && !(f === target.file && target.line === i + 1)) {
          defs.push(`${f}:${i + 1}: ${ls[i]!.trim().slice(0, 140)}`);
          if (defs.length >= 8) break outer;
        }
      }
    }
  }
  if (defs.length) add("Callees defined in this repo:", defs.join("\n"));
  if (used < cap / 2) {
    // thin context: scored hits for the question's keywords, and the repo outline as a last resort
    const ev = evidence(cwd, question, { hitsCap: Math.max(0, Math.min(2500, cap - used)), outlineCap: 0 });
    if (ev.hits !== "(no matching lines)") add("Other matching lines:", ev.hits.trimEnd());
    if (!parts.length) add("Repository outline:", outline(cwd, Math.min(3000, cap - used)));
  }
  return { target, text: parts.join("\n\n"), chars: used };
}

const CITE = /([A-Za-z0-9_@~./\\-]*[A-Za-z0-9_-]\.[A-Za-z0-9]{1,8}):(\d+)(?:[-–](\d+))?/g;

export interface CitationCheck {
  answer: string;
  valid: string[];
  dropped: string[];
}

/** Check every `path:line` or `path:a-b` citation: the file must be a file inside the repo and the lines inside it. Bad ones are removed. */
export function checkCitations(cwd: string, answer: string): CitationCheck {
  const valid: string[] = [];
  const dropped: string[] = [];
  const cache = new Map<string, number | null>();
  const count = (f: string): number | null => {
    if (!cache.has(f)) cache.set(f, insideFile(cwd, f) ? (readLines(cwd, f)?.length ?? null) : null);
    return cache.get(f)!;
  };
  let out = answer.replace(CITE, (whole, file: string, a: string, b?: string) => {
    const f = normpath(file);
    const n = count(f);
    const from = Number(a);
    const to = b ? Number(b) : from;
    if (n !== null && from >= 1 && to >= from && to <= n) {
      valid.push(whole);
      return whole;
    }
    dropped.push(whole);
    return "";
  });
  if (dropped.length) {
    // tidy what a removed citation leaves behind: empty brackets, dangling "at", doubled spaces and commas
    out = out
      .replace(/\(\s*[,;]?\s*\)|\[\s*[,;]?\s*\]/g, "")
      .replace(/\(\s*[,;]\s*/g, "(")
      .replace(/\s*[,;]\s*\)/g, ")")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\s+([.,;:])/g, "$1");
  }
  return { answer: out.trim(), valid, dropped };
}

export function clampWords(text: string, max = MAX_WORDS): { text: string; cut: boolean } {
  const words = text.trim().split(/\s+/);
  if (words.length <= max) return { text: text.trim(), cut: false };
  return { text: words.slice(0, max).join(" ") + " ...", cut: true };
}

/** The phases /explain reports. */
export const EXPLAIN_PHASES = ["find target", "answer", "check citations"];

export interface ExplainDeps {
  progress?: Progress;
  cwd: string;
  config: Config;
  chat: ChatFn;
  report: (line: string) => void;
  env?: Record<string, string | undefined>;
}

export interface ExplainResult {
  ok: boolean;
  calls: number;
  target: Target | null;
  answer: string;
  citations: { valid: string[]; dropped: string[] };
  lines: string[];
}

export async function runExplain(args: ExplainArgs, deps: ExplainDeps): Promise<ExplainResult> {
  const { cwd } = deps;
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    deps.report(l);
  };
  const none = (target: Target | null = null): ExplainResult => ({ ok: false, calls: 0, target, answer: "", citations: { valid: [], dropped: [] }, lines });
  if (!args.question && !args.file) {
    say("usage: /explain [--file PATH] <symbol, file or question>");
    return none();
  }
  const pg = deps.progress ?? NOOP_PROGRESS;
  pg.step("find target");
  const question = args.question || `What does ${args.file} do?`;
  const target = findTarget(cwd, { ...args, question });
  if (!target) {
    say(`/explain: no file or symbol found for ${JSON.stringify(question.slice(0, 60))}; name a file or a function (or use --file PATH)`);
    return none();
  }
  const g = gather(cwd, target, question);
  say(`target: ${target.file}${target.line ? `:${target.line}` : ""}${target.symbol ? ` (${target.symbol})` : ""}`);
  const messages: Message[] = [
    { role: "system", content: EXPLAIN_RULES },
    { role: "user", content: `${g.text}\n\nQuestion: ${question}` },
  ];
  pg.step("answer");
  const r = await deps.chat("explain", messages, { workflow: "explain", config: deps.config, env: deps.env });
  pg.step("check citations");
  const checked = checkCitations(cwd, r.text);
  const clamped = clampWords(checked.answer);
  say(clamped.text);
  if (clamped.cut) say(`(answer cut to ${MAX_WORDS} words)`);
  if (checked.dropped.length) say(`citations dropped (not found): ${checked.dropped.join(", ")}`);
  if (!checked.valid.length) say("warning: the answer has no valid file:line citation");
  say(`citations: ${checked.valid.length} valid, ${checked.dropped.length} dropped`);
  say(`calls: 1 (context ${g.chars} chars)`);
  return { ok: checked.valid.length > 0, calls: 1, target, answer: clamped.text, citations: { valid: checked.valid, dropped: checked.dropped }, lines };
}
