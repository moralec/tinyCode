// /research <question> (S13): "is there a library for X?", "how do others do Y on GitHub?" answered in a separate
// context. A research branch picks one tool per call (GitHub search, fetch a URL as text, local find), under hard
// caps on steps and tokens, then ONE summarising call returns {answer, sources}. Only that short cited answer goes
// back to the conversation (or into /plan's prompt); search output never does. Pure TypeScript `fetch`, no Unix
// tools, no Pi import: the local `find` is injected (extensions/tinycode/index.ts wires src/branch.ts findAnswer).
// GITHUB_TOKEN is read from the environment, sent only to api.github.com, and never logged or echoed.
import { readFileSync } from "node:fs";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { readText, trackedFiles } from "../context/evidence.ts";
import { NOOP_PROGRESS, type Progress } from "../progress.ts";
import type { Config } from "../config.ts";
import type { Message } from "../llm.ts";
import type { ChatFn } from "./fix.ts";

export const RESEARCH_TOOLS = ["github_repos", "github_code", "fetch", "find", "done"] as const;
export type ResearchTool = (typeof RESEARCH_TOOLS)[number];

/** The step schema; `dropped` tools (E19: a GitHub tool whose source failed) are left out of the enum. */
export function stepSchema(dropped: ReadonlySet<string> = new Set()) {
  return {
    type: "object",
    properties: { tool: { type: "string", enum: RESEARCH_TOOLS.filter((t) => !dropped.has(t)) }, arg: { type: "string" } },
    required: ["tool", "arg"],
  };
}
export const STEP_SCHEMA = stepSchema();
export const ANSWER_SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" }, sources: { type: "array", items: { type: "string" }, maxItems: 6 } },
  required: ["answer", "sources"],
};
/** E20 (research.grounded): at most this many facts, each with a quote code checks against its cited place. */
export const FACTS_MAX = 4;
export const ANSWER_SCHEMA_GROUNDED = {
  type: "object",
  properties: {
    answer: { type: "string" },
    sources: { type: "array", items: { type: "string" }, maxItems: 6 },
    facts: {
      type: "array",
      minItems: 1,
      maxItems: FACTS_MAX,
      items: {
        type: "object",
        properties: { claim: { type: "string" }, cite: { type: "string" }, quote: { type: "string" } },
        required: ["claim", "cite", "quote"],
      },
    },
  },
  required: ["answer", "sources", "facts"],
};

export const RESEARCH_SYSTEM = `Research a developer's question with tools, one call at a time, then stop.
Reply JSON only: {"tool":"<name>","arg":"<argument>"}.
Tools:
- github_repos: arg = search words; public GitHub repos (name, stars, language, description, url).
- github_code: arg = search words; GitHub code files (needs token, may be refused).
- fetch: arg = http(s) URL seen in a result; page as plain text (README, docs).
- find: arg = question about local project code; short answer with path:line.
- done: arg = ""; enough to answer.
github_repos first, then fetch README of the 2-3 best repos. Never repeat a call. Cite only URLs seen in a result.`;

/** E19 (research.localFirst): the last line routes by the kind of question; the model decides, nothing runs first. */
export const RESEARCH_SYSTEM_LOCAL = RESEARCH_SYSTEM.slice(0, RESEARCH_SYSTEM.lastIndexOf("\n") + 1) +
  "Question about this project, or code it vendors or pins: find first. Library or prior-art question: github_repos, then fetch the README of the 2-3 best. Never repeat a call. Cite only URLs or path:line seen in a result.";

const SUMMARY_USER = (words: number, question: string) =>
  `Answer now: ${question}\nMax ${words} words, plain text. Compare options if asked. "sources": URLs relied on, copied exactly from results above (GitHub repo links first).`;
const FACTS_USER = `\n"facts": 1-${FACTS_MAX} key facts, each {claim, cite: path:line or URL from a result, quote: words copied exactly from that line or page}.`;
/** E20: the prose answer of a grounded summary (the facts carry the content; keeps the tool text under RESULT_CAP). */
export const GROUNDED_ANSWER_WORDS = 100;
/** E20: the check request on the trunk's `STATUS: done` line, for a grounded result with at least one kept fact. */
export const GROUNDED_CHECK = "Before reporting, compare the key fact with its quoted line; if it does not answer the question, read or find there.";
/** E20: what remains when a grounded result kept no fact (`STATUS: partial`). */
export const NO_QUOTED_FACT = "no quoted fact; check by hand";

export interface ResearchArgs {
  question: string;
}
export function parseResearchArgs(raw: string): ResearchArgs {
  return { question: raw.trim() };
}

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal; redirect?: "manual" }) => Promise<{
  ok: boolean;
  status: number;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}>;

/** The phases /research reports (inside /plan it is the plan's `research` phase, driven by the same progress). */
export const RESEARCH_PHASES = ["research"];

export interface ResearchDeps {
  progress?: Progress;
  config: Config;
  chat: ChatFn;
  /** injectable for tests; default is the global fetch */
  fetch?: FetchLike;
  /** host name -> addresses, checked before each fetch hop; default: DNS with the global fetch, none with an injected one */
  lookup?: LookupFn | null;
  /** the local `find` branch (src/branch.ts findAnswer); absent = the tool answers "not available" */
  find?: (question: string) => Promise<string>;
  report?: (line: string) => void;
  env?: Record<string, string | undefined>;
  /** the project root, for E20's quoting of `find` citations and the fact check; absent = nothing is quoted */
  cwd?: string;
}

/** A fact the summary gave whose quote code found at its cited place (E20); `window` is the text shown around it. */
export interface Fact {
  claim: string;
  cite: string;
  quote: string;
  window: string;
}

export interface ResearchResult {
  answer: string;
  sources: string[];
  steps: number;
  tokens: number;
  /** why the tool loop ended: done | steps | tokens | invalid */
  stopped: string;
  /** one `tool(arg)` line per step, for the log */
  trace: string[];
  /** E20: the facts kept by the quote check (empty with research.grounded off) */
  facts: Fact[];
  /** E20: facts the quote check dropped (0 with research.grounded off) */
  dropped: number;
}

/** Replace the token (if any) wherever it appears; used on every string that leaves this module. */
export function redact(text: string, env: Record<string, string | undefined>): string {
  const t = env.GITHUB_TOKEN;
  return t && t.length >= 4 ? text.split(t).join("***") : text;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

/** HTML to readable text: scripts, styles and tags dropped, block tags become line breaks, entities decoded. */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|head|nav|footer)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(p|div|br|li|ul|ol|h[1-6]|tr|table|section|article|pre|blockquote)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e] ?? (/^#\d+$/.test(e) ? String.fromCharCode(Number(e.slice(1))) : m))
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The 8 groups of an IPv6 address (an IPv4 tail folded in), or null. */
function v6Groups(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0]!;
  const tail = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (tail) {
    const [a, b, c, d] = tail.slice(1).map(Number) as [number, number, number, number];
    s = s.slice(0, -tail[0].length) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : null;
  const parts = rest === null ? head : [...head, ...Array(Math.max(0, 8 - head.length - rest.length)).fill("0"), ...rest];
  return parts.length === 8 ? parts.map((x) => parseInt(x || "0", 16)) : null;
}

/**
 * True for an address off the public internet: loopback, private, link-local, CGNAT, benchmarking, unspecified,
 * multicast and reserved, and the IPv4-mapped, NAT64 and 6to4 forms of those. Anything unparsable counts as private.
 */
export function privateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split(".").map(Number) as [number, number];
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
  }
  if (v !== 6) return true;
  const g = v6Groups(ip);
  if (!g) return true;
  const v4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return privateAddress(v4(g[6]!, g[7]!)); // ::ffff:a.b.c.d
  if (g.slice(0, 6).every((x) => x === 0)) return true; // ::, ::1, IPv4-compatible
  if (g[0] === 0x64 && g[1] === 0xff9b) return privateAddress(v4(g[6]!, g[7]!)); // NAT64
  if (g[0] === 0x2002) return privateAddress(v4(g[1]!, g[2]!)); // 6to4
  const top = g[0]!;
  return (top & 0xfe00) === 0xfc00 || (top & 0xffc0) === 0xfe80 || (top & 0xffc0) === 0xfec0 || (top & 0xff00) === 0xff00;
}

/** Only public http(s) pages: no other scheme, no localhost or private-network names or addresses (any written form). */
export function urlAllowed(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home.arpa")) return false;
  return isIP(h) ? !privateAddress(h) : true;
}

export type LookupFn = (host: string) => Promise<string[]>;
/** Every address a name resolves to (A and AAAA). */
export const dnsAddresses: LookupFn = async (host) => (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

// Typed tool failures (E19's drop table classifies by class, not by message; the messages are today's). Anything else a
// tool throws is a network failure: refused connection, DNS error, the 15-second timeout, replay's `not recorded`.
/** A non-2xx reply, or a 3xx without a location. */
export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
/** tinyCode refused the URL (not public http(s), a private address after DNS, too many redirects). */
export class RefusedError extends Error {}
/** GitHub's body is not JSON. */
export class BadReplyError extends Error {}

function cap(text: string, chars: number): string {
  return text.length > chars ? text.slice(0, chars) + `\n[cut at ${chars} characters]` : text;
}

const GITHUB = "https://api.github.com";

async function githubGet(path: string, f: FetchLike, env: Record<string, string | undefined>): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json", "User-Agent": "tinycode", "X-GitHub-Api-Version": "2022-11-28" };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  const res = await f(GITHUB + path, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? " (rate limit, or code search needs GITHUB_TOKEN)" : "";
    throw new HttpError(res.status, `GitHub HTTP ${res.status}${hint}`);
  }
  const body = await res.text();
  try {
    return JSON.parse(body);
  } catch (e) {
    throw new BadReplyError((e as Error).message);
  }
}

export async function githubRepos(query: string, f: FetchLike, env: Record<string, string | undefined>): Promise<string> {
  const j = (await githubGet(`/search/repositories?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=6`, f, env)) as {
    items?: { full_name?: string; html_url?: string; stargazers_count?: number; language?: string | null; description?: string | null }[];
  };
  const items = j.items ?? [];
  if (!items.length) return "no repositories found";
  return items
    .map((r) => `${r.full_name} (${r.stargazers_count ?? 0} stars, ${r.language ?? "?"}): ${(r.description ?? "").slice(0, 160)} ${r.html_url}`)
    .join("\n");
}

export async function githubCode(query: string, f: FetchLike, env: Record<string, string | undefined>): Promise<string> {
  const j = (await githubGet(`/search/code?q=${encodeURIComponent(query)}&per_page=6`, f, env)) as {
    items?: { path?: string; html_url?: string; repository?: { full_name?: string } }[];
  };
  const items = j.items ?? [];
  if (!items.length) return "no code found";
  return items.map((r) => `${r.repository?.full_name}: ${r.path} ${r.html_url}`).join("\n");
}

const MAX_REDIRECTS = 4;

/**
 * Fetch a URL as readable text. The token is never sent here (only to api.github.com). Redirects are followed by hand,
 * so every hop passes urlAllowed and, with `lookup`, a resolved-address check (security audit 2026-11-09). Residual:
 * the name is resolved again by fetch itself, so a DNS answer that changes between the two (rebinding) is not caught.
 */
export async function fetchText(url: string, f: FetchLike, chars: number, lookup: LookupFn | null = null): Promise<string> {
  let cur = url;
  let res: Awaited<ReturnType<FetchLike>>;
  for (let hop = 0; ; hop++) {
    if (!urlAllowed(cur)) throw new RefusedError("only public http(s) URLs can be fetched");
    const host = new URL(cur).hostname.replace(/^\[|\]$/g, "");
    if (lookup && !isIP(host)) {
      const addrs = await lookup(host);
      if (!addrs.length || addrs.some(privateAddress)) throw new RefusedError("only public http(s) URLs can be fetched (the name resolves to a private address)");
    }
    res = await f(cur, { headers: { "User-Agent": "tinycode", Accept: "text/html,text/plain,text/markdown,*/*;q=0.5" }, signal: AbortSignal.timeout(15_000), redirect: "manual" });
    if (res.status < 300 || res.status >= 400) break;
    const loc = res.headers?.get("location");
    if (!loc) throw new HttpError(res.status, `HTTP ${res.status} without a location`);
    if (hop >= MAX_REDIRECTS) throw new RefusedError(`more than ${MAX_REDIRECTS} redirects`);
    cur = new URL(loc, cur).toString();
  }
  if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status}`);
  const type = res.headers?.get("content-type") ?? "";
  const body = (await res.text()).slice(0, chars * 8);
  const text = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(body) ? htmlToText(body) : body.trim();
  return cap(text || "(empty page)", chars);
}

// ---------------------------------------------------------------- replay (design research-replay)

/** research.replay could not be used: /research stops with this before its first model call, never falling back to the network. */
export class ReplayError extends Error {}

interface ReplayEntry { status: number; body: string; contentType?: string; location?: string }

/** Read and check a recording: `{"version": 1, "responses": {"<exact URL>": {status, body, contentType?, location?}}}`. */
export function loadReplay(path: string): Map<string, ReplayEntry> {
  const fail = (why: string): never => {
    throw new ReplayError(`research.replay: cannot use ${path}: ${why}`);
  };
  let j: { version?: unknown; responses?: unknown };
  try {
    j = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    return fail((e as Error).message);
  }
  if (j?.version !== 1) fail(`version must be 1, got ${JSON.stringify(j?.version)}`);
  if (!j.responses || typeof j.responses !== "object" || Array.isArray(j.responses)) fail("responses must be an object");
  const out = new Map<string, ReplayEntry>();
  for (const [url, e] of Object.entries(j.responses as Record<string, Partial<ReplayEntry>>)) {
    const ok = e && typeof e.status === "number" && Number.isInteger(e.status) && e.status >= 100 && e.status <= 599 && typeof e.body === "string" &&
      (e.contentType === undefined || typeof e.contentType === "string") && (e.location === undefined || typeof e.location === "string");
    if (!ok) fail(`${url}: needs a status (100-599) and a string body; contentType and location are optional strings`);
    out.set(url, e as ReplayEntry);
  }
  return out;
}

/** A fetch that answers only from the recording: an unrecorded URL throws `not recorded: <url>` (the tool's observation). */
export function replayFetch(rec: Map<string, ReplayEntry>): FetchLike {
  return async (url) => {
    const e = rec.get(url);
    if (!e) throw new Error(`not recorded: ${url}`);
    const headers: Record<string, string | undefined> = { "content-type": e.contentType, location: e.location };
    return { ok: e.status >= 200 && e.status < 300, status: e.status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null }, text: async () => e.body };
  };
}

const URL_RE = /https?:\/\/[^\s)<>"'\]]+/g;
const cleanUrl = (u: string) => u.replace(/[.,;:]+$/, "");

// ---------------------------------------------------------------- E19: find with a file path reads it (research.localFirst)

/**
 * A `find` argument that names one tracked file: the exact path, or a path suffix that matches exactly one tracked file
 * (`ISSUES/0212.md` -> `vendor/tablekit/ISSUES/0212.md`). Only files git tracks, so nothing outside the project is
 * read. Null when there is no such file or more than one matches: the question goes to the branch as before.
 */
export function findPathFile(arg: string, files: readonly string[]): string | null {
  const a = arg.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  if (!a || /\s/.test(a) || !a.includes(".")) return null;
  if (files.includes(a)) return a;
  const hits = files.filter((f) => f.endsWith("/" + a));
  return hits.length === 1 ? hits[0]! : null;
}

/** The file's text with line numbers, as the observation of a path-shaped find (no branch call). */
function readForFind(cwd: string, path: string): string | null {
  const text = readText(join(cwd, path));
  if (text === null) return null;
  const lines = text.replace(/\n$/, "").split("\n");
  return `${path} (read: find was given a file path)\n` + lines.map((l, i) => `${i + 1}: ${l}`).join("\n");
}

// ---------------------------------------------------------------- E19: a failed source is dropped (research.localFirst)

const GITHUB_TOOLS = ["github_repos", "github_code"];
const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return "";
  }
};

/** Which sources a run has dropped, and the first failure of each (design research-grounding, section 4). */
export class DroppedSources {
  readonly tools = new Map<string, string>();
  readonly hosts = new Map<string, string>();

  /** The "dropped" answer for a call to a dropped tool or host, else null (the call is made). */
  refusal(tool: string, arg: string): string | null {
    const t = this.tools.get(tool);
    if (t) return `${tool} dropped this run (${t}); use another tool or done`;
    const h = tool === "fetch" ? this.hosts.get(hostOf(arg)) : undefined;
    return h ? `fetch dropped this run for ${hostOf(arg)} (${h}); use another tool or done` : null;
  }

  /** Classify one tool failure by the table; returns the note added to the observation when a source is dropped. */
  fail(tool: string, arg: string, e: unknown, message: string): string | null {
    const network = !(e instanceof HttpError || e instanceof RefusedError || e instanceof BadReplyError);
    const auth = e instanceof HttpError && [401, 403, 429].includes(e.status);
    const first = `${tool} failed: ${message}`.slice(0, 120);
    if (GITHUB_TOOLS.includes(tool)) {
      if (network) {
        for (const g of GITHUB_TOOLS) if (!this.tools.has(g)) this.tools.set(g, first);
        return "GitHub dropped for this run";
      }
      if (auth) {
        this.tools.set(tool, first);
        return `${tool} dropped for this run`;
      }
      return null;
    }
    const host = tool === "fetch" ? hostOf(arg) : "";
    if (host && (network || auth)) {
      this.hosts.set(host, first);
      return `${host} dropped for this run`;
    }
    return null;
  }

  /** The tools still offered: the schema's enum and the bad-reply nudge. */
  live(): string[] {
    return RESEARCH_TOOLS.filter((t) => !this.tools.has(t));
  }
}

// ---------------------------------------------------------------- E20: cited lines quoted, facts checked (research.grounded)

/** Characters of one quoted line inside the research branch, and the most a fact's window shows in the trunk. */
export const QUOTE_CHARS = 240;
/** The facts block in the trunk is at most this many tokens (approxTokens, 4 characters each). */
export const FACTS_TOKENS = 330;
// a fact line's share of the block: header and dropped line (~95 characters) plus 4 lines of at most FACT_LINE_CHARS
const FACT_LINE_CHARS = 300;
const CLAIM_CHARS = 80;
const CITE_CHARS = 60;
const QUOTE_MIN = 8;
const QUOTE_MAX = 300;

/** What quoting and the fact check need across one run: tracked files (once), file lines (cached), lines shown. */
export interface QuoteContext {
  cwd: string;
  langs: readonly string[];
  tracked?: Set<string>;
  files: Map<string, string[] | null>;
  /** every `path:line` quoted to the research model; a path:line fact must cite within 2 lines of one */
  shown: Set<string>;
}
export const quoteContext = (cwd: string, langs: readonly string[]): QuoteContext => ({ cwd, langs, files: new Map(), shown: new Set() });

/** A cited path as a tracked file's `/` path, or null: absolute, outside cwd, untracked. A `\` path counts as `/`. */
function trackedPath(ctx: QuoteContext, raw: string): string | null {
  const p = raw.replace(/\\/g, "/");
  if (isAbsolute(p) || win32.isAbsolute(p)) return null;
  const rel = relative(ctx.cwd, resolve(ctx.cwd, p)).split(sep).join("/");
  if (!rel || rel === ".." || rel.startsWith("../")) return null;
  ctx.tracked ??= new Set(trackedFiles(ctx.cwd, ctx.langs));
  return ctx.tracked.has(rel) ? rel : null;
}

/** The lines of a tracked text file (binary or over 400 KB: null, as `find` reads them). */
function fileLines(ctx: QuoteContext, rel: string): string[] | null {
  if (!ctx.files.has(rel)) {
    const text = readText(join(ctx.cwd, rel));
    ctx.files.set(rel, text === null ? null : text.split(/\r?\n/));
  }
  return ctx.files.get(rel) ?? null;
}

// a `find` citation line as src/branch.ts formatAnswer writes it: `- path:line` or `- path:first-last`
const CITE_LINE = /^- (?:\.\/)?([^\s:]+):(\d+)(?:-(\d+))?\b/;

/** E20: each `- path:line` of a `find` result becomes `- path:line: <text>` (a range: up to 3 lines), read by code from a
 * tracked file; a line quoted earlier in the run is `- path:line (quoted above)`; anything else is left as it is. */
export function quoteCitations(obs: string, ctx: QuoteContext): string {
  return obs
    .split("\n")
    .map((line) => {
      const m = line.match(CITE_LINE);
      const rel = m ? trackedPath(ctx, m[1]!) : null;
      const lines = rel ? fileLines(ctx, rel) : null;
      const a = m ? Number(m[2]) : 0;
      if (!rel || !lines || a < 1 || a > lines.length) return line;
      const b = Math.min(m![3] ? Math.max(Number(m![3]), a) : a, a + 2, lines.length);
      const out: string[] = [];
      for (let n = a; n <= b; n++) {
        const key = `${rel}:${n}`;
        if (ctx.shown.has(key)) out.push(`- ${key} (quoted above)`);
        else {
          ctx.shown.add(key);
          out.push(`- ${key}: ${lines[n - 1]!.trim().slice(0, QUOTE_CHARS)}`);
        }
      }
      return out.join("\n");
    })
    .join("\n");
}

/** Whitespace collapsed, surrounding quote marks and backticks removed, case folded. */
export const normQuote = (s: string): string =>
  s.replace(/\s+/g, " ").trim().replace(/^[`'"‘’“”]+|[`'"‘’“”]+$/g, "").trim().toLowerCase();

/** Up to `width` characters of `text` (whitespace collapsed) centred on the normalised quote, `...` where cut; null
 * when the quote is not in the text. */
export function quoteWindow(text: string, quote: string, width: number): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  const i = flat.toLowerCase().indexOf(quote);
  if (i < 0 || !quote) return null;
  if (flat.length <= width) return flat;
  const inner = Math.max(width - 6, 1);
  let start = quote.length >= inner ? i : Math.max(0, Math.round(i + quote.length / 2 - inner / 2));
  start = Math.min(start, Math.max(0, flat.length - inner));
  const end = Math.min(flat.length, start + inner);
  return `${start > 0 ? "..." : ""}${flat.slice(start, end)}${end < flat.length ? "..." : ""}`;
}

/** A tool result inside the run, for URL facts: the URLs it contains (a fetch: also the fetched URL) and its text. */
export interface Page {
  urls: Set<string>;
  text: string;
}

/** E20: keep a fact only when its quote is at its cited place: a tracked `path:line` within 2 lines of a line shown to
 * the research model, quote in lines line..line+2; or a URL seen in a result, quote in the text of a result with that
 * URL. Quotes are 8-300 characters after normalising. Returns the kept facts (with the trunk's window) and the count
 * dropped. */
export function checkFacts(raw: unknown, ctx: QuoteContext | null, seen: ReadonlySet<string>, pages: readonly Page[]): { facts: Fact[]; dropped: number } {
  const facts: Fact[] = [];
  let dropped = 0;
  for (const f of (Array.isArray(raw) ? raw : []).slice(0, FACTS_MAX)) {
    const o = (f ?? {}) as { claim?: unknown; cite?: unknown; quote?: unknown };
    const claim = typeof o.claim === "string" ? o.claim.replace(/\s+/g, " ").trim().slice(0, CLAIM_CHARS) : "";
    const cite = typeof o.cite === "string" ? o.cite.trim() : "";
    const q = typeof o.quote === "string" ? normQuote(o.quote) : "";
    const shownCite = cite.slice(0, CITE_CHARS);
    const width = Math.min(QUOTE_CHARS, FACT_LINE_CHARS - 7 - claim.length - shownCite.length);
    let window: string | null = null;
    if (claim && q.length >= QUOTE_MIN && q.length <= QUOTE_MAX) {
      const pl = /^https?:\/\//i.test(cite) ? null : cite.match(/^(?:\.\/)?([^\s:]+):(\d+)/);
      if (pl && ctx) {
        const rel = trackedPath(ctx, pl[1]!);
        const lines = rel ? fileLines(ctx, rel) : null;
        const n = Number(pl[2]);
        const near = rel !== null && [-2, -1, 0, 1, 2].some((d) => ctx.shown.has(`${rel}:${n + d}`));
        if (lines && near && n >= 1 && n <= lines.length) window = quoteWindow(lines.slice(n - 1, n + 2).join(" "), q, width);
      } else if (!pl) {
        const u = cleanUrl(cite);
        if (seen.has(u)) for (const p of pages) if (p.urls.has(u) && (window = quoteWindow(p.text, q, width))) break;
      }
    }
    if (window) facts.push({ claim, cite: shownCite, quote: q, window });
    else dropped++;
  }
  return { facts, dropped };
}

/** The `answer` string of a cut or unparsable grounded summary, when the regex finds it; never the raw JSON. */
function recoverAnswer(text: string): string {
  const m = text.match(/"answer"\s*:\s*"((?:[^"\\]|\\.)*)/);
  if (!m) return text.trim().startsWith("{") ? "" : text.trim();
  try {
    return (JSON.parse(`"${m[1]!.replace(/\\$/, "")}"`) as string).trim();
  } catch {
    return m[1]!.replace(/\\n/g, " ").replace(/\\(.)/g, "$1").trim();
  }
}

/** Run the research branch. Never throws on a tool failure (the failure is the observation); chat errors and a
 * ReplayError (research.replay unusable, thrown before the first model call) propagate. */
export async function runResearch(args: ResearchArgs, deps: ResearchDeps): Promise<ResearchResult> {
  const env = deps.env ?? process.env;
  const rc = deps.config.research;
  // an injected fetch (tests) wins; else research.replay answers from its recording, with no DNS query; else the network
  const replay = !deps.fetch && rc.replay ? replayFetch(loadReplay(rc.replay)) : null;
  const f = deps.fetch ?? replay ?? (globalThis.fetch as unknown as FetchLike);
  const lookup = replay ? null : deps.lookup !== undefined ? deps.lookup : deps.fetch ? null : dnsAddresses;
  const report = deps.report ?? (() => {});
  const pg = deps.progress ?? NOOP_PROGRESS;
  const trace: string[] = [];
  const empty: ResearchResult = { answer: "", sources: [], steps: 0, tokens: 0, stopped: "none", trace, facts: [], dropped: 0 };
  if (!args.question) {
    report("usage: /research <question: a library you need, or how others do something>");
    return empty;
  }
  const localFirst = rc.localFirst;
  const grounded = rc.grounded;
  const drop = new DroppedSources();
  const qctx = grounded && deps.cwd ? quoteContext(deps.cwd, deps.config.languages) : null;
  const pages: Page[] = [];
  const seen = new Set<string>();
  const called = new Set<string>();
  let tokens = 0;
  const addUsage = (u: { prompt_tokens: number; completion_tokens: number }) => {
    tokens += u.prompt_tokens + u.completion_tokens;
  };
  // grounded: quoted lines are re-read by every later call, so the loop may run to 1.5x the token cap (no new key)
  const tokenCap = grounded ? Math.floor(rc.maxTokens * 1.5) : rc.maxTokens;
  const messages: Message[] = [
    { role: "system", content: localFirst ? RESEARCH_SYSTEM_LOCAL : RESEARCH_SYSTEM },
    { role: "user", content: `Question: ${args.question}\nSteps allowed: ${rc.maxSteps}.` },
  ];
  let steps = 0;
  let stopped = "steps";
  let badReplies = 0;
  while (steps < rc.maxSteps) {
    if (tokens >= tokenCap) {
      stopped = "tokens";
      break;
    }
    pg.step("research", steps + 1, rc.maxSteps);
    const schema = localFirst ? stepSchema(new Set(drop.tools.keys())) : STEP_SCHEMA;
    const r = await deps.chat("research", messages, { workflow: "research", config: deps.config, env, schema, schemaName: "step" });
    addUsage(r.usage);
    let tool: string | undefined;
    let arg = "";
    try {
      const j = JSON.parse(r.text.match(/\{[\s\S]*\}/)?.[0] ?? "") as { tool?: unknown; arg?: unknown };
      tool = typeof j.tool === "string" ? j.tool : undefined;
      arg = typeof j.arg === "string" ? j.arg.trim() : "";
    } catch {
      tool = undefined;
    }
    messages.push({ role: "assistant", content: redact(r.text, env) });
    steps++;
    if (!tool || !(RESEARCH_TOOLS as readonly string[]).includes(tool)) {
      // A nudge, never a stop: the reply counts as a step; two in a row end the loop and go to the summary.
      if (++badReplies >= 2) {
        stopped = "invalid";
        break;
      }
      const offered = localFirst ? drop.live() : RESEARCH_TOOLS;
      messages.push({ role: "user", content: `JSON {"tool":"<one of ${offered.join(", ")}>","arg":"..."}. Steps left: ${rc.maxSteps - steps}.` });
      continue;
    }
    badReplies = 0;
    if (tool === "done") {
      stopped = "done";
      steps--;
      break;
    }
    const key = `${tool}\u0000${arg}`;
    let obs: string;
    trace.push(`${tool}(${redact(arg, env).slice(0, 120)})`);
    // E19: a call to a dropped tool or host is not made; it costs the step, like a repeat
    const refused = localFirst && arg ? drop.refusal(tool, arg) : null;
    if (!arg) obs = "give an argument";
    else if (refused) obs = refused;
    else if (called.has(key)) obs = "you already made that call; try a different one, or done";
    else {
      called.add(key);
      try {
        if (tool === "github_repos") obs = await githubRepos(arg, f, env);
        else if (tool === "github_code") obs = await githubCode(arg, f, env);
        else if (tool === "fetch") {
          obs = await fetchText(arg, f, rc.resultChars, lookup);
          seen.add(cleanUrl(arg));
        } else {
          // E19: a file path is read, not searched for: each search for a path cost a branch call that could not match it
          const path = localFirst && deps.cwd ? findPathFile(arg, trackedFiles(deps.cwd, deps.config.languages)) : null;
          const read = path && deps.cwd ? readForFind(deps.cwd, path) : null;
          if (read !== null) obs = read;
          else {
            obs = deps.find ? await deps.find(arg) : "find is not available here";
            if (qctx) obs = quoteCitations(obs, qctx);
          }
        }
      } catch (e) {
        const message = redact((e as Error).message, env);
        const note = localFirst ? drop.fail(tool, arg, e, message) : null;
        obs = `${tool} failed: ${message}${note ? ` (${note})` : ""}`;
      }
    }
    obs = cap(redact(obs, env), rc.resultChars);
    const urls = (obs.match(URL_RE) ?? []).map(cleanUrl);
    for (const u of urls) seen.add(u);
    if (grounded && tool !== "find") pages.push({ urls: new Set([...urls, ...(tool === "fetch" && seen.has(cleanUrl(arg)) ? [cleanUrl(arg)] : [])]), text: obs });
    // grounded: the per-step lines stay out of the tool text (progress still shows the step)
    if (!grounded) report(`research ${steps}/${rc.maxSteps}: ${tool}`);
    messages.push({ role: "user", content: `Result:\n${obs}\nSteps left: ${rc.maxSteps - steps}.` });
  }
  // One summarising call, appended to the same context (cache-friendly); the question is repeated at the tail.
  const words = grounded ? Math.min(rc.answerWords, GROUNDED_ANSWER_WORDS) : rc.answerWords;
  messages.push({ role: "user", content: SUMMARY_USER(words, args.question) + (grounded ? FACTS_USER : "") });
  pg.step("research", rc.maxSteps, rc.maxSteps);
  const r = await deps.chat("research", messages, {
    workflow: "research",
    config: deps.config,
    env,
    schema: grounded ? ANSWER_SCHEMA_GROUNDED : ANSWER_SCHEMA,
    schemaName: "answer",
    // grounded: room for FACTS_MAX facts with a 300-character quote (~100 tokens) plus claim and cite
    maxTokens: Math.max(300, Math.ceil(words * 2.5)) + (grounded ? FACTS_MAX * 130 : 0),
  });
  addUsage(r.usage);
  let answer = "";
  let sources: string[] = [];
  let facts: Fact[] = [];
  let dropped = 0;
  const parse = (): { answer?: unknown; sources?: unknown; facts?: unknown } | null => {
    try {
      return JSON.parse(r.text.match(/\{[\s\S]*\}/)?.[0] ?? "") as { answer?: unknown; sources?: unknown; facts?: unknown };
    } catch {
      return null;
    }
  };
  const j = parse();
  if (grounded && (!j || r.finish === "length")) {
    // a cut or broken summary: the answer when the regex finds it, no facts, never the raw JSON
    answer = recoverAnswer(r.text);
  } else if (!j) {
    answer = r.text.trim();
  } else {
    answer = typeof j.answer === "string" ? j.answer.trim() : "";
    if (Array.isArray(j.sources)) sources = j.sources.filter((s): s is string => typeof s === "string").map(cleanUrl);
    if (grounded) ({ facts, dropped } = checkFacts(j.facts, qctx, seen, pages));
  }
  // Only URLs that appeared in a tool result may be cited; a made-up link is dropped.
  sources = [...new Set(sources.filter((s) => seen.has(s)))];
  const answerWords = answer.split(/\s+/).filter(Boolean);
  if (answerWords.length > words) answer = answerWords.slice(0, words).join(" ") + " ...";
  answer = redact(answer, env);
  facts = facts.map((x) => ({ claim: redact(x.claim, env), cite: redact(x.cite, env), quote: redact(x.quote, env), window: redact(x.window, env) }));
  return { answer, sources, steps, tokens, stopped, trace, facts, dropped };
}

/** E20: the facts block the trunk sees first: each kept fact with the text around its quote, and the dropped count. */
export function factsBlock(r: Pick<ResearchResult, "facts" | "dropped">): string {
  const lines = ["Facts (quoted, read from the files):", ...r.facts.map((x) => `- ${x.claim} — ${x.cite}: ${x.window}`)];
  if (r.dropped) lines.push(r.dropped === 1 ? "1 fact dropped: its quote is not at the cited place." : `${r.dropped} facts dropped: their quotes are not at the cited place.`);
  return lines.join("\n");
}

/** The short cited block shown to the user and handed to /plan; with kept facts (E20) the facts block comes first. */
export function formatResearch(r: ResearchResult): string {
  if (!r.answer) return "(research found nothing)";
  const body = r.sources.length ? `${r.answer}\n\nSources:\n${r.sources.map((s) => `- ${s}`).join("\n")}` : r.answer;
  return r.facts?.length ? `${factsBlock(r)}\n\n${body}` : body;
}
