// /doc: comments and docstrings (S17). Follows add.ts, testgen.ts and explain.ts.
//   /doc [--file PATH] [--all] <task>        docstrings/comments for a file or one symbol (this file)
//   /doc readme [options]                    docs/overview.html or README sections (docreadme.ts)
// Comments mode. Code finds the file (explain.ts's findTarget), lists its functions, classes and methods that have no
// doc yet (context/strip.ts) and groups them into batches (6 symbols or ~9k characters). ONE call per batch returns
// SEARCH/REPLACE blocks. Code then enforces "comments only", block by block, on the text in memory:
//   * the code with every comment and docstring stripped (language-aware for Python and JS/TS) must be identical to the
//     original's: a block that changes one code byte is refused, the others are kept;
//   * a block that creates files, names another file, matches twice or grows the text by more than 1500 characters is
//     refused;
//   * one retry per batch when blocks were refused or none applied, naming the reasons.
// After the batches the result must compile (python: py_compile; JS/TS: `node --check`, TS after Node strips its types); a
// failure leaves the file untouched. Only then the file is written and the project's lint auto-fix runs.
// Other file types are refused (no way to promise "comments only"); .jsx/.tsx too. Pure logic with injected
// dependencies; pure Node (no Unix tools). No model call here ever sees more than the symbols of its batch.
import { NOOP_PROGRESS, type Progress } from "../progress.ts";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, normalize, sep } from "node:path";
import type { Config } from "../config.ts";
import { langOf, listSymbols, sameCode, type Lang, type Sym } from "../context/strip.ts";
import { lintPass, type LintOptions } from "../lint.ts";
import type { Message } from "../llm.ts";
import { applyEdit } from "../protocol/apply.ts";
import { cleanPath, normalizeEol, parseBlocks } from "../protocol/blocks.ts";
import { findTarget } from "./explain.ts";
import type { ChatFn } from "./fix.ts";
import { findReadme, parseReadmeArgs, readmeSections, runReadme, type ReadmeArgs, type ReadmeFound, type ReadmeResult } from "./docreadme.ts";

export const BATCH_SYMBOLS = 6;
export const BATCH_CHARS = 9000;
export const MAX_DOC_GROWTH = 1500;
const SNIPPET_LINES = 40;

export const DOC_RULES = `You add documentation to code. Reply ONLY with edit blocks, one per symbol, in exactly this format:

path/to/file
<<<<<<< SEARCH
exact lines copied from the file: the def/class/function line(s) and the first line of the body
=======
the same lines with the documentation added
>>>>>>> REPLACE

You may add or improve comments and docstrings ONLY. Never change, add, remove, reorder, rename or reformat any code,
not even whitespace. SEARCH must match the file exactly and be unique (include the first body line). Python: a
docstring right after the def/class line, indented like the body: one summary line, then Args/Returns only when they
are not obvious. JavaScript/TypeScript: a /** ... */ comment on the lines above the declaration, same indent, with
@param/@returns only when not obvious. Say what the code does, from the code shown; do not invent behaviour. No
explanations outside the blocks.`;

export interface DocArgs {
  mode: "comments" | "readme";
  file?: string;
  /** also re-document symbols that already have a doc: not offered; reserved for `--all` = the whole file, not one symbol */
  all: boolean;
  task: string;
  readme: ReadmeArgs;
}

/** `[readme|overview] ...` or `[--file PATH] [--all] <task>`: flags from the front only. */
export function parseDocArgs(raw: string): DocArgs {
  const rest = raw.trim();
  const rm = rest.match(/^(?:readme|overview)\b\s*/i);
  if (rm) return { mode: "readme", all: false, task: "", readme: parseReadmeArgs(rest.slice(rm[0].length)) };
  const out: DocArgs = { mode: "comments", all: false, task: "", readme: parseReadmeArgs("") };
  let r = rest;
  for (;;) {
    const a = r.match(/^--all\s*/);
    if (a) {
      out.all = true;
      r = r.slice(a[0].length);
      continue;
    }
    const m = r.match(/^--file(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))\s*/);
    if (m) {
      out.file = m[1] ?? m[2] ?? m[3]!;
      r = r.slice(m[0].length);
      continue;
    }
    break;
  }
  out.task = r.trim();
  return out;
}

/**
 * Routed text ("update the readme", "write the overview", "add docstrings to x.py") to the mode it means.
 * `found` is the README the project has (findReadme): undefined = not looked up (the older behaviour: named headings update, else the overview);
 * with it, by intent:
 *   overview / "document this project"            -> the overview page
 *   README mentioned, a README exists             -> check its sections (the ones named, else all) and update the stale ones, after asking
 *   README mentioned, no README exists            -> offer to create README.md from the overview content
 */
export function docArgsFromText(text: string, readmeHeadings: string[] = [], found?: ReadmeFound | null): DocArgs {
  const low = text.toLowerCase();
  if (/\b(readme|overview|document (this|the) project)\b/.test(low) && !/\b(docstrings?|doc comments?|jsdoc)\b/.test(low)) {
    const named = readmeHeadings.filter((h) => h.trim() && low.includes(h.trim().toLowerCase()));
    const args = parseReadmeArgs(named.length ? `--update ${named.map((h) => `"${h}"`).join(",")}` : "");
    if (found !== undefined) {
      const overview = /\b(overview|document (this|the) project)\b/.test(low) && !/\breadme\b/.test(low);
      if (!overview && found) {
        if (!args.update) args.update = ["all"];
        args.ask = true;
      } else if (!overview) {
        args.create = true;
        args.ask = true;
      }
    }
    return { mode: "readme", all: false, task: text, readme: args };
  }
  return { mode: "comments", all: false, task: text, readme: parseReadmeArgs("") };
}

const STRIP_TS =
  "const m=require('node:module'),fs=require('node:fs');if(typeof m.stripTypeScriptTypes!=='function')process.exit(3);" +
  "try{fs.writeFileSync(process.argv[2],m.stripTypeScriptTypes(fs.readFileSync(process.argv[1],'utf8'))) }catch(e){if(e&&e.code==='ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX'){console.error(String(e.message));process.exit(3)}console.error(String((e&&e.message)||e));process.exit(1)}";

export interface CompileResult {
  ok: boolean;
  /** true when the check could not run (no interpreter): the file is written anyway and the line says so */
  skipped?: boolean;
  message: string;
}
export type CompileFn = (lang: Lang, path: string, text: string) => Promise<CompileResult>;

/** py_compile for Python; `node --check` for JS/TS (a .ts file has its types stripped by Node first, because --check does not read TypeScript). */
export function makeCompile(python: string): CompileFn {
  return async (lang, path, text) => {
    const dir = mkdtempSync(join(tmpdir(), "tinycode-doc-"));
    try {
      const run = (cmd: string, args: string[]) => spawnSync(cmd, args, { cwd: dir, encoding: "utf8", timeout: 60_000, windowsHide: true });
      const verdict = (r: ReturnType<typeof run>): CompileResult => {
        if (r.error) return { ok: true, skipped: true, message: `${(r.error as Error).message}` };
        return r.status === 0 ? { ok: true, message: "" } : { ok: false, message: `${r.stderr || r.stdout}`.trim().split("\n").slice(-6).join("\n") };
      };
      if (lang === "py") {
        const f = join(dir, basename(path));
        writeFileSync(f, text);
        return verdict(run(python, ["-c", "import sys,py_compile; py_compile.compile(sys.argv[1], cfile=sys.argv[2], doraise=True)", f, join(dir, "out.pyc")]));
      }
      const ext = extname(path).toLowerCase();
      if (ext === ".ts" || ext === ".mts" || ext === ".cts") {
        // `node --check` does not read TypeScript: strip the types first (Node's own stripper, which also rejects
        // TypeScript syntax errors), then syntax-check the JavaScript that is left
        const src = join(dir, "c" + ext);
        const out = join(dir, ext === ".cts" ? "c.cjs" : "c.mjs");
        writeFileSync(src, text);
        const s = run(process.execPath, ["--no-warnings", "-e", STRIP_TS, src, out]);
        if (s.error || s.status === 3) return { ok: true, skipped: true, message: (s.stderr || "this Node cannot strip TypeScript types (needs 22.13+)").toString().trim().split("\n")[0] ?? "type stripping unavailable" };
        if (s.status !== 0) return { ok: false, message: `${s.stderr || s.stdout}`.trim().split("\n").slice(-6).join("\n") };
        return verdict(run(process.execPath, ["--check", out]));
      }
      const names = ext === ".mjs" ? ["c.mjs"] : ext === ".cjs" ? ["c.cjs"] : ["c.js", "c.mjs"];
      let last: CompileResult = { ok: false, message: "" };
      for (const n of names) {
        writeFileSync(join(dir, n), text);
        last = verdict(run(process.execPath, ["--check", join(dir, n)]));
        if (last.ok) return last;
      }
      return last;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

export interface GuardResult {
  text: string;
  applied: number;
  refused: string[];
}

/** Apply a reply's blocks to `text` in memory; each block must leave the stripped code identical to `original`'s. */
export function applyDocBlocks(reply: string, path: string, original: string, text: string, lang: Lang): GuardResult {
  const refused: string[] = [];
  let cur = text;
  let applied = 0;
  const want = normalize(path).split(sep).join("/");
  const blocks = parseBlocks(reply);
  if (!blocks.length) refused.push("the reply held no edit block");
  for (const b of blocks) {
    const name = cleanPath(b.path);
    const label = b.search.split("\n").find((l) => l.trim())?.trim().slice(0, 60) ?? "(empty)";
    if (normalize(name).split(sep).join("/") !== want) {
      refused.push(`${label}: names ${name}, only ${path} may change`);
      continue;
    }
    if (!b.search.trim()) {
      refused.push(`block with an empty SEARCH: files are never created or appended to`);
      continue;
    }
    if (cur.split(b.search).length > 2) {
      refused.push(`${label}: SEARCH matches more than once, add the first body line to make it unique`);
      continue;
    }
    const next = applyEdit(cur, b.search, b.replace);
    if (next === null) {
      refused.push(`${label}: SEARCH not found, copy the lines exactly`);
      continue;
    }
    if (next.length - cur.length > MAX_DOC_GROWTH) {
      refused.push(`${label}: the added documentation is over ${MAX_DOC_GROWTH} characters`);
      continue;
    }
    if (!sameCode(lang, original, next)) {
      refused.push(`${label}: this changes code, not only comments and docstrings`);
      continue;
    }
    if (next !== cur) applied++;
    cur = next;
  }
  return { text: cur, applied, refused };
}

const snippet = (lines: string[], s: Sym): string => lines.slice(s.line - 1, Math.min(s.end, s.line - 1 + SNIPPET_LINES)).join("\n");

/** Symbols still without a doc, grouped into batches of keys. */
export function batchSymbols(text: string, lang: Lang, only?: string): { batches: string[][]; wanted: Sym[] } {
  const lines = text.split("\n");
  let wanted = listSymbols(lang, text).filter((s) => !s.hasDoc);
  if (only) wanted = wanted.filter((s) => s.kind !== "module" && (s.name === only || s.name.endsWith("." + only)));
  const batches: string[][] = [];
  let cur: string[] = [];
  let chars = 0;
  for (const s of wanted) {
    const n = snippet(lines, s).length;
    if (cur.length && (cur.length >= BATCH_SYMBOLS || chars + n > BATCH_CHARS)) {
      batches.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(s.key);
    chars += n;
  }
  if (cur.length) batches.push(cur);
  return { batches, wanted };
}

/** The phases `/doc` (comments and docstrings) reports; `/doc readme` has README_PHASES in docreadme.ts. */
export const DOC_PHASES = ["find target", "document symbols", "check", "write"];

export interface DocDeps {
  progress?: Progress;
  /** a UI's yes/no for the offer before a README check or creation */
  confirm?: (question: string) => Promise<boolean>;
  cwd: string;
  config: Config;
  chat: ChatFn;
  report: (line: string) => void;
  env?: Record<string, string | undefined>;
  compile?: CompileFn;
  /** test hook for the lint auto-fix runner */
  lint?: Pick<LintOptions, "exec" | "find">;
}

export interface DocResult {
  ok: boolean;
  calls: number;
  file: string | null;
  /** names of the symbols that got a doc */
  documented: string[];
  refused: string[];
  changed: boolean;
  lines: string[];
  reason?: string;
}

export async function runDocComments(args: DocArgs, deps: DocDeps): Promise<DocResult> {
  const { cwd, config: cfg } = deps;
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    deps.report(l);
  };
  const pg = deps.progress ?? NOOP_PROGRESS;
  pg.step("find target");
  const res = (ok: boolean, reason: string, file: string | null, calls = 0, documented: string[] = [], refused: string[] = [], changed = false): DocResult => ({ ok, calls, file, documented, refused, changed, lines, reason });
  if (!args.file && !args.task) {
    say("usage: /doc [--file PATH] <file, symbol or task>   |   /doc readme [--update SECTION[,SECTION]] [--out DIR] [--max-files N] [--related a,b]");
    return res(false, "usage", null);
  }
  const target = findTarget(cwd, { file: args.file, question: args.task });
  if (!target) {
    say(`/doc: no file or symbol found for ${JSON.stringify((args.task || args.file || "").slice(0, 60))}; name a file or a function (or use --file PATH)`);
    return res(false, "no-target", null);
  }
  const file = target.file;
  const lang = langOf(file);
  if (!lang) {
    say(`/doc: ${file} is not a language /doc can check: only Python (.py) and JavaScript/TypeScript (.js .mjs .cjs .ts .mts .cts) are supported, because the code must be proven unchanged. JSX/TSX and other file types are refused. Nothing was changed.`);
    return res(false, "unsupported", file);
  }
  let raw: string;
  try {
    if (statSync(join(cwd, file)).size > 400_000) throw new Error("too big");
    raw = readFileSync(join(cwd, file), "utf8");
  } catch {
    say(`/doc: cannot read ${file} (missing, binary or over 400k)`);
    return res(false, "unreadable", file);
  }
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const original = normalizeEol(raw);
  const only = args.all ? undefined : target.symbol;
  const { batches, wanted } = batchSymbols(original, lang, only);
  say(`target: ${file}${target.symbol && !args.all ? ` (${target.symbol})` : ""}`);
  if (!wanted.length) {
    say(only ? `${only} already has a doc, or was not found as a function, class or method in ${file}; nothing to do` : `every symbol in ${file} already has a doc; nothing to do`);
    return res(true, "nothing-to-do", file);
  }
  say(`${wanted.length} symbol(s) without a doc, ${batches.length} batch(es)`);

  let cur = original;
  let calls = 0;
  const documented: string[] = [];
  const refusedAll: string[] = [];
  const style = lang === "py" ? "Python: add docstrings" : "JavaScript/TypeScript: add /** */ doc comments";
  for (const [bi, keys] of batches.entries()) {
    pg.step("document symbols", bi + 1, batches.length);
    const syms = listSymbols(lang, cur).filter((s) => keys.includes(s.key));
    if (!syms.length) continue;
    const cl = cur.split("\n");
    const body = syms.map((s) => `--- ${s.kind} ${s.name} (line ${s.line}) ---\n${snippet(cl, s)}`).join("\n\n");
    const head = `File: ${file}\n${style} to exactly these symbols and nothing else:\n${syms.map((s) => `- ${s.kind} ${s.name}`).join("\n")}\n\nCode:\n${body}\n\nReply with edit blocks only.`;
    const messages: Message[] = [
      { role: "system", content: DOC_RULES },
      { role: "user", content: head },
    ];
    const before = new Set(listSymbols(lang, cur).filter((s) => s.hasDoc).map((s) => s.key));
    let last: string[] = [];
    for (let attempt = 0; attempt < 2; attempt++) {
      calls++;
      const r = await deps.chat("doc", messages, { workflow: "doc", config: cfg, env: deps.env });
      const g = applyDocBlocks(r.text, file, original, cur, lang);
      for (const x of g.refused) say(`refused: ${x}`);
      cur = g.text; // blocks that passed the guard are kept even when others were refused
      last = g.refused;
      if (!g.refused.length) break;
      if (attempt === 0) {
        messages.push(
          { role: "assistant", content: r.text },
          { role: "user", content: `Not accepted: ${g.refused.join("; ")}. Blocks that were accepted are already applied. Reply with corrected edit blocks for the rest only; comments and docstrings only, code untouched.` },
        );
        say("retrying the batch once");
      }
    }
    refusedAll.push(...last);
    for (const s of listSymbols(lang, cur)) if (s.hasDoc && !before.has(s.key) && keys.includes(s.key)) documented.push(s.name);
  }

  if (cur === original) {
    say("/doc: no documentation could be added safely; the file is unchanged");
    say(`calls: ${calls}`);
    return res(false, "nothing-applied", file, calls, [], refusedAll);
  }
  pg.step("check");
  // final guard, independent of the block-by-block one
  if (!sameCode(lang, original, cur)) {
    say("/doc: the final text differs in code, so nothing was written (this should not happen)");
    return res(false, "code-changed", file, calls, [], refusedAll);
  }
  const compile = deps.compile ?? makeCompile(cfg.test.python);
  const c = await compile(lang, file, cur);
  if (!c.ok) {
    say(`/doc: the documented file does not compile, so it was not written:\n${c.message}`);
    say(`calls: ${calls}`);
    return res(false, "compile-failed", file, calls, [], refusedAll);
  }
  say(c.skipped ? `compile check skipped (${c.message})` : `compile check: ok (${lang === "py" ? "py_compile" : "node --check"})`);
  pg.step("write");
  const abs = join(cwd, file);
  pg.touch(file);
  writeFileSync(abs, eol === "\r\n" ? cur.replace(/\n/g, "\r\n") : cur);
  await lintPass(
    { cwd, files: [file], env: deps.env },
    { report: say, lint: deps.lint, verify: async () => (await compile(lang, file, normalizeEol(readFileSync(abs, "utf8")))).ok },
  );
  say(`documented: ${documented.join(", ") || "(none counted)"}`);
  say(`code check: stripped code identical to the original (${lang === "py" ? "Python" : "JS/TS"} comment and docstring scanner)`);
  say(`calls: ${calls}`);
  return res(true, "pass", file, calls, documented, refusedAll, true);
}

export type DocRunResult = (DocResult & { mode: "comments" }) | (ReadmeResult & { mode: "readme" });

export async function runDoc(args: DocArgs, deps: DocDeps): Promise<DocRunResult> {
  if (args.mode === "readme") return { mode: "readme", ...(await runReadme(args.readme, deps)) };
  return { mode: "comments", ...(await runDocComments(args, deps)) };
}

/** Section titles of the project's README (Markdown headings or HTML h2/h3/<section>; empty when there is none): lets routed text name a section to update. */
export function readmeHeadings(cwd: string): string[] {
  const f = findReadme(cwd);
  if (!f) return [];
  try {
    return readmeSections(readFileSync(join(cwd, f.rel), "utf8").replace(/\r\n/g, "\n"), f.kind).map((x) => x.title);
  } catch {
    return [];
  }
}
