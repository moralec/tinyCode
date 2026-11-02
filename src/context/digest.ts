// Oversized project context files shrunk to a digest (operator 2026-11-02: a 78 KB CLAUDE.md took ~20k of
// gpt-oss-20b's 32k window before the first step, and the first file read overflowed it). Pi puts every
// AGENTS.md / CLAUDE.md into each system prompt as a <project_instructions> block; a block over
// limits.contextFileTokens is replaced here. The digest is made once per file version by a small-lane call
// (map over sections, one reduce if still long), kept on disk by content hash. Until it exists the block is cut
// to a code-made outline, so a request never waits for it. Pure TypeScript; the model call is injected.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Message } from "../llm.ts";

/** bump when the digest prompt or shape changes: old digests are then made again */
export const DIGEST_VERSION = 1;
const BLOCK = /<project_instructions path="([^"]*)">\n([\s\S]*?)\n<\/project_instructions>/g;
const RULE_WORDS = /\b(never|always|must|do not|don't|only|required?|forbidden)\b/i;
const LINE_MAX = 200;
/** characters per word of a digest with its space (prose ~6; code-heavy rules run longer, so the budget is checked in characters) */
const CHARS_PER_WORD = 6.5;

/** (path, content, word budget) -> digest text; throws or returns "" when it cannot make one */
export type Summarize = (path: string, content: string, maxWords: number) => Promise<string>;

export interface ShrinkOptions {
  /** a block over this many tokens is shrunk; 0 = off */
  maxTokens: number;
  charsPerToken: number;
  /** where digests are kept (digestDir()) */
  dir: string;
  /** makes the digest in the background; absent = outline only */
  summarize?: Summarize;
  /** digests being made now (shared across requests, so one file is summarised once) */
  pending?: Set<string>;
  /** called when a background digest is written or fails */
  onDigest?: (path: string, ok: boolean, detail: string) => void;
}
export interface Shrunk {
  path: string;
  fromTokens: number;
  toTokens: number;
  kind: "digest" | "outline";
}

export function digestDir(env: Record<string, string | undefined> = process.env): string {
  return env.TINYCODE_CONTEXT_CACHE || join(homedir(), ".local", "state", "tinycode", "context");
}

/** one digest per file version and size budget (a 32k window's digest is not the one a 131k window gets) */
export function digestKey(content: string, maxChars: number): string {
  return createHash("sha256").update(`v${DIGEST_VERSION}\n${maxChars}\n${content}`).digest("hex").slice(0, 24);
}

/** the token limit for a context file: max(floor, share x window); floor 0 = off (operator 2026-11-02) */
export function contextFileLimit(floor: number, share: number, window: number): number {
  return floor > 0 ? Math.max(floor, Math.round(share * window)) : 0;
}

/**
 * A code-made outline of a markdown file in at most `maxChars`: headings, list items and lines with rule words
 * (never/always/must/...), each cut to 200 characters; fenced code and plain prose are left out.
 */
export function outline(content: string, maxChars: number): string {
  const out: string[] = [];
  let used = 0;
  let fenced = false;
  for (const raw of content.split("\n")) {
    const line = raw.trimEnd();
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced || !line.trim()) continue;
    const keep = /^#{1,6}\s/.test(line) || /^\s*([-*+]|\d+[.)])\s/.test(line) || RULE_WORDS.test(line);
    if (!keep) continue;
    const cut = line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line;
    if (used + cut.length + 1 > maxChars) {
      out.push("[…cut]");
      break;
    }
    out.push(cut);
    used += cut.length + 1;
  }
  return out.join("\n");
}

function readDigest(dir: string, key: string): string | null {
  const f = join(dir, `${key}.md`);
  try {
    return existsSync(f) ? readFileSync(f, "utf8") : null;
  } catch {
    return null;
  }
}

function writeDigest(dir: string, key: string, text: string): void {
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${key}.md`);
  writeFileSync(`${f}.tmp`, text);
  renameSync(`${f}.tmp`, f);
}

/**
 * `prompt` with every <project_instructions> block over the limit replaced by its digest (kept on disk) or, until
 * that exists, its outline -- the digest is then started in the background. Blocks under the limit stay as they are.
 */
export function shrinkContextFiles(prompt: string, o: ShrinkOptions): { prompt: string; shrunk: Shrunk[] } {
  const shrunk: Shrunk[] = [];
  if (!(o.maxTokens > 0)) return { prompt, shrunk };
  const maxChars = Math.floor(o.maxTokens * o.charsPerToken);
  const next = prompt.replace(BLOCK, (whole, path: string, content: string) => {
    if (content.length <= maxChars) return whole;
    const key = digestKey(content, maxChars);
    const kept = readDigest(o.dir, key);
    let body: string;
    let kind: Shrunk["kind"];
    if (kept !== null) {
      body = kept.trim();
      kind = "digest";
    } else {
      body = outline(content, maxChars);
      kind = "outline";
      if (o.summarize && !o.pending?.has(key)) startDigest(path, content, key, maxChars, o);
    }
    const from = Math.round(content.length / o.charsPerToken);
    const to = Math.round(body.length / o.charsPerToken);
    shrunk.push({ path, fromTokens: from, toTokens: to, kind });
    const head = `[tinyCode ${kind} of ${path}: ~${from} -> ~${to} tokens. Full rules: grep or read ${path} when a task needs them.]`;
    return `<project_instructions path="${path}">\n${head}\n${body}\n</project_instructions>`;
  });
  return { prompt: next, shrunk };
}

function startDigest(path: string, content: string, key: string, maxChars: number, o: ShrinkOptions): void {
  o.pending?.add(key);
  const words = Math.max(80, Math.floor(maxChars / CHARS_PER_WORD));
  o.summarize!(path, content, words)
    .then((text) => {
      const t = (text ?? "").trim();
      if (!t || t.length >= content.length) throw new Error("empty or no shorter");
      writeDigest(o.dir, key, t.length > maxChars ? `${t.slice(0, maxChars - 7)}\n[…cut]` : t);
      o.onDigest?.(path, true, `${Math.round(t.length / o.charsPerToken)} tokens`);
    })
    .catch((e: unknown) => o.onDigest?.(path, false, e instanceof Error ? e.message : String(e)))
    .finally(() => o.pending?.delete(key));
}

const DIGEST_SYSTEM = (words: number) =>
  "You shrink project instructions for a small coding model. Keep: hard rules (never, always, must), commands, paths, " +
  "file and tool names, numbers, naming and style rules. Drop: history, reasons, dates, examples, repeats, praise. " +
  `Write terse bullets in pidgin English, short section tags allowed, no intro. Max ${words} words.`;

/** Markdown split at headings into pieces of at most `maxChars` (a piece without headings is cut by lines). */
export function sections(content: string, maxChars: number): string[] {
  const parts: string[] = [];
  let cur = "";
  for (const line of content.split("\n")) {
    const heading = /^#{1,3}\s/.test(line);
    if (cur && (cur.length + line.length + 1 > maxChars || (heading && cur.length > maxChars / 2))) {
      parts.push(cur);
      cur = "";
    }
    cur += (cur ? "\n" : "") + (line.length > maxChars ? line.slice(0, maxChars) : line);
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/**
 * The background Summarize over one chat function: each section of at most `chunkChars` gets its share of the word
 * budget (one call each, one after another -- local servers lose throughput on parallel calls), and the joined
 * result gets one reduce call when it is over the budget in characters (live 2026-11-02: 583 words of a code-heavy
 * CLAUDE.md digest were 4.8k characters against a 3.9k cap).
 */
export function makeSummarize(
  chat: (messages: Message[], maxTokens: number) => Promise<string>,
  chunkChars: number,
): Summarize {
  return async (path, content, words) => {
    const parts = sections(content, chunkChars);
    const outs: string[] = [];
    for (const p of parts) {
      const share = Math.max(40, Math.round((words * p.length) / content.length));
      const msgs: Message[] = [
        { role: "system", content: DIGEST_SYSTEM(share) },
        { role: "user", content: `File ${path}${parts.length > 1 ? ` (part ${outs.length + 1} of ${parts.length})` : ""}:\n\n${p}` },
      ];
      outs.push((await chat(msgs, Math.ceil(share * 2) + 64)).trim());
    }
    let joined = outs.filter(Boolean).join("\n");
    if (joined.length > words * CHARS_PER_WORD) {
      const msgs: Message[] = [
        { role: "system", content: DIGEST_SYSTEM(words) },
        { role: "user", content: `Digest notes of ${path}; merge and shrink, keep every hard rule:\n\n${joined}` },
      ];
      joined = (await chat(msgs, Math.ceil(words * 2) + 64)).trim();
    }
    return joined;
  };
}
