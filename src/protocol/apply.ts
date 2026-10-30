// Applying a reply to files. applyBlocks is behaviourally tc0.apply_blocks (parity tested against goldens);
// applyReply adds the whole-file fallback. Deliberate differences from tc0, all listed in test/unit/apply.test.ts:
//  - paths outside cwd (absolute, drive letters, symlink-free escapes) are refused as "bad path" (tc0 only refused "..")
//  - a file's CRLF line endings are matched as LF and written back as CRLF (tc0 rewrote the file as LF)
//  - a block whose SEARCH equals its REPLACE is not applied ("no change"); tc0 counted it as applied
//  - every failure carries a reason, and writes to one path go through a queue
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, win32 } from "node:path";
import { normalizeEol, parseBlocks, parseWholeFiles } from "./blocks.ts";

export const NO_CHANGE = "no change: SEARCH and REPLACE are identical";
export type FailReason = "not found" | "protected" | "bad path" | "too long" | typeof NO_CHANGE;

export interface BlockResult {
  path: string;
  kind: "search" | "create" | "file";
  ok: boolean;
  reason?: FailReason;
}

export interface ApplyResult {
  /** paths written, in order (tc0 `applied`) */
  applied: string[];
  /** paths not written (tc0 `failed`) */
  failed: string[];
  /** one entry per block, with the reason a block failed */
  results: BlockResult[];
}

export interface ApplyOptions {
  cwd: string;
  /**
   * Paths never edited, compared after normalisation. `null` or omitted = every `tests/` path (tc0's default);
   * an array (possibly empty) = exactly those paths (what tc1/ladder pass: the task's test file).
   */
  protected?: readonly string[] | null;
  /** whole-file fallback: largest existing file (in lines) a fenced reply may replace. Default 150. */
  maxWholeFileLines?: number;
}

/** python os.path.normpath on a "/"-separated path */
function normpath(p: string): string {
  const n = posix.normalize(p === "" ? "." : p);
  return n.length > 1 && n.endsWith("/") ? n.slice(0, -1) : n;
}

function isProtected(path: string, prot: Set<string> | null): boolean {
  return prot === null ? path.startsWith("tests/") || path.includes("/tests/") : prot.has(normpath(path));
}

/** Absolute path inside cwd, or null. The path is already "/"-separated (cleanPath). */
function safeResolve(cwd: string, path: string): string | null {
  if (!path || path.includes("..") || isAbsolute(path) || win32.isAbsolute(path) || /^[a-zA-Z]:/.test(path)) {
    return null;
  }
  const abs = resolve(cwd, path);
  const rel = relative(resolve(cwd), abs);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? null : abs;
}

// Per-path write queue: read-modify-write of one file never interleaves (PX §2 withFileMutationQueue).
const queues = new Map<string, Promise<unknown>>();
export function withFileMutationQueue<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return run;
}

interface Loaded {
  text: string; // LF only
  eol: "\n" | "\r\n";
  exists: boolean;
}

async function load(abs: string): Promise<Loaded | "bad"> {
  let s;
  try {
    s = await stat(abs);
  } catch {
    return { text: "", eol: "\n", exists: false };
  }
  if (!s.isFile()) return "bad";
  const raw = await readFile(abs, "utf8");
  const crlf = (raw.match(/\r\n/g) ?? []).length;
  const lf = (raw.match(/\n/g) ?? []).length - crlf;
  return { text: normalizeEol(raw), eol: crlf > lf ? "\r\n" : "\n", exists: true };
}

async function save(abs: string, text: string, eol: "\n" | "\r\n"): Promise<void> {
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, eol === "\n" ? text : text.replace(/\n/g, "\r\n"), "utf8");
}

const firstReplace = (old: string, at: number, search: string, replace: string) =>
  old.slice(0, at) + replace + old.slice(at + search.length);

/**
 * tc0 edit on LF text: empty SEARCH creates/appends, else the first exact match, else the first
 * whitespace-insensitive line match with the replacement re-indented. null = SEARCH not found.
 */
export function applyEdit(old: string, search: string, replace: string): string | null {
  if (!search.trim()) return old + (old && !old.endsWith("\n") ? "\n" : "") + replace + "\n";
  const exact = old.indexOf(search);
  if (exact >= 0) return firstReplace(old, exact, search, replace);
  const ol = old.split("\n");
  const sl = search.split("\n").map((s) => s.trim());
  let at = -1;
  for (let i = 0; i <= ol.length - sl.length; i++) {
    if (sl.every((s, j) => ol[i + j]!.trim() === s)) {
      at = i;
      break;
    }
  }
  if (at < 0) return null;
  const lead = (s: string) => s.length - s.trimStart().length;
  const ind = lead(ol[at]!);
  const rl = replace.split("\n");
  const rind = rl[0]!.trim() ? lead(rl[0]!) : 0;
  const re = rl.map((x) => (x.trim() ? " ".repeat(Math.max(0, ind - rind)) + x : x));
  return [...ol.slice(0, at), ...re, ...ol.slice(at + sl.length)].join("\n");
}

/** SEARCH and REPLACE say the same thing (line by line, ignoring trailing spaces): applying it would change nothing. */
export function isNoopEdit(search: string, replace: string): boolean {
  if (!search.trim()) return false; // an empty SEARCH creates or appends
  const lines = (t: string) => t.split("\n").map((l) => l.trimEnd()).join("\n").trimEnd();
  return lines(search) === lines(replace);
}

function setup(opts: ApplyOptions) {
  const prot = opts.protected == null ? null : new Set(opts.protected.map((p) => normpath(p.replace(/\\/g, "/"))));
  const out: ApplyResult = { applied: [], failed: [], results: [] };
  const record = (r: BlockResult) => {
    out.results.push(r);
    (r.ok ? out.applied : out.failed).push(r.path);
  };
  return { prot, out, record };
}

/** tc0.apply_blocks: SEARCH/REPLACE blocks only. Refused paths and misses never throw; they come back as reasons. */
export async function applyBlocks(reply: string, opts: ApplyOptions): Promise<ApplyResult> {
  const { prot, out, record } = setup(opts);
  await runBlocks(reply, opts, prot, record);
  return out;
}

async function runBlocks(
  reply: string,
  opts: ApplyOptions,
  prot: Set<string> | null,
  record: (r: BlockResult) => void,
): Promise<number> {
  const blocks = parseBlocks(reply);
  for (const b of blocks) {
    const kind = b.search.trim() ? "search" : "create";
    if (isProtected(b.path, prot)) {
      record({ path: b.path, kind, ok: false, reason: "protected" });
      continue;
    }
    const abs = safeResolve(opts.cwd, b.path);
    if (abs === null) {
      record({ path: b.path, kind, ok: false, reason: "bad path" });
      continue;
    }
    if (isNoopEdit(b.search, b.replace)) {
      record({ path: b.path, kind, ok: false, reason: NO_CHANGE });
      continue;
    }
    const r = await withFileMutationQueue(abs, async (): Promise<BlockResult> => {
      const f = await load(abs);
      if (f === "bad") return { path: b.path, kind, ok: false, reason: "bad path" };
      const next = applyEdit(f.text, b.search, b.replace);
      if (next === null) return { path: b.path, kind, ok: false, reason: "not found" };
      await save(abs, next, f.eol);
      return { path: b.path, kind, ok: true };
    });
    record(r);
  }
  return blocks.length;
}

/**
 * What the ladder calls: SEARCH/REPLACE blocks, and only when the reply holds none, the whole-file fallback
 * (rule 2): `path` then the complete file in a fence replaces an existing file of at most maxWholeFileLines.
 */
export async function applyReply(reply: string, opts: ApplyOptions): Promise<ApplyResult> {
  const { prot, out, record } = setup(opts);
  if ((await runBlocks(reply, opts, prot, record)) > 0) return out;
  const max = opts.maxWholeFileLines ?? 150;
  for (const f of parseWholeFiles(reply)) {
    if (isProtected(f.path, prot)) {
      record({ path: f.path, kind: "file", ok: false, reason: "protected" });
      continue;
    }
    const abs = safeResolve(opts.cwd, f.path);
    if (abs === null) {
      record({ path: f.path, kind: "file", ok: false, reason: "bad path" });
      continue;
    }
    record(
      await withFileMutationQueue(abs, async (): Promise<BlockResult> => {
        const cur = await load(abs);
        if (cur === "bad") return { path: f.path, kind: "file", ok: false, reason: "bad path" };
        if (!cur.exists) return { path: f.path, kind: "file", ok: false, reason: "not found" };
        const lines = cur.text.split("\n").length - (cur.text.endsWith("\n") ? 1 : 0);
        if (lines > max) return { path: f.path, kind: "file", ok: false, reason: "too long" };
        await save(abs, f.content.endsWith("\n") ? f.content : f.content + "\n", cur.eol);
        return { path: f.path, kind: "file", ok: true };
      }),
    );
  }
  return out;
}
