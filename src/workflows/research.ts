// /research <question> (S13): "is there a library for X?", "how do others do Y on GitHub?" answered in a separate
// context. A research branch picks one tool per call (GitHub search, fetch a URL as text, local find), under hard
// caps on steps and tokens, then ONE summarising call returns {answer, sources}. Only that short cited answer goes
// back to the conversation (or into /plan's prompt); search output never does. Pure TypeScript `fetch`, no Unix
// tools, no Pi import: the local `find` is injected (extensions/tinycode/index.ts wires src/branch.ts findAnswer).
// GITHUB_TOKEN is read from the environment, sent only to api.github.com, and never logged or echoed.
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { NOOP_PROGRESS, type Progress } from "../progress.ts";
import type { Config } from "../config.ts";
import type { Message } from "../llm.ts";
import type { ChatFn } from "./fix.ts";

export const RESEARCH_TOOLS = ["github_repos", "github_code", "fetch", "find", "done"] as const;
export type ResearchTool = (typeof RESEARCH_TOOLS)[number];

export const STEP_SCHEMA = {
  type: "object",
  properties: { tool: { type: "string", enum: [...RESEARCH_TOOLS] }, arg: { type: "string" } },
  required: ["tool", "arg"],
};
export const ANSWER_SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" }, sources: { type: "array", items: { type: "string" }, maxItems: 6 } },
  required: ["answer", "sources"],
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

const SUMMARY_USER = (words: number, question: string) =>
  `Answer now: ${question}\nMax ${words} words, plain text. Compare options if asked. "sources": URLs relied on, copied exactly from results above (GitHub repo links first).`;

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
    throw new Error(`GitHub HTTP ${res.status}${hint}`);
  }
  return JSON.parse(await res.text());
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
    if (!urlAllowed(cur)) throw new Error("only public http(s) URLs can be fetched");
    const host = new URL(cur).hostname.replace(/^\[|\]$/g, "");
    if (lookup && !isIP(host)) {
      const addrs = await lookup(host);
      if (!addrs.length || addrs.some(privateAddress)) throw new Error("only public http(s) URLs can be fetched (the name resolves to a private address)");
    }
    res = await f(cur, { headers: { "User-Agent": "tinycode", Accept: "text/html,text/plain,text/markdown,*/*;q=0.5" }, signal: AbortSignal.timeout(15_000), redirect: "manual" });
    if (res.status < 300 || res.status >= 400) break;
    const loc = res.headers?.get("location");
    if (!loc) throw new Error(`HTTP ${res.status} without a location`);
    if (hop >= MAX_REDIRECTS) throw new Error(`more than ${MAX_REDIRECTS} redirects`);
    cur = new URL(loc, cur).toString();
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers?.get("content-type") ?? "";
  const body = (await res.text()).slice(0, chars * 8);
  const text = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(body) ? htmlToText(body) : body.trim();
  return cap(text || "(empty page)", chars);
}

const URL_RE = /https?:\/\/[^\s)<>"'\]]+/g;
const cleanUrl = (u: string) => u.replace(/[.,;:]+$/, "");

/** Run the research branch. Never throws on a tool failure (the failure is the observation); chat errors propagate. */
export async function runResearch(args: ResearchArgs, deps: ResearchDeps): Promise<ResearchResult> {
  const env = deps.env ?? process.env;
  const rc = deps.config.research;
  const f = deps.fetch ?? (globalThis.fetch as unknown as FetchLike);
  const lookup = deps.lookup !== undefined ? deps.lookup : deps.fetch ? null : dnsAddresses;
  const report = deps.report ?? (() => {});
  const pg = deps.progress ?? NOOP_PROGRESS;
  const trace: string[] = [];
  const empty: ResearchResult = { answer: "", sources: [], steps: 0, tokens: 0, stopped: "none", trace };
  if (!args.question) {
    report("usage: /research <question: a library you need, or how others do something>");
    return empty;
  }
  const seen = new Set<string>();
  const called = new Set<string>();
  let tokens = 0;
  const addUsage = (u: { prompt_tokens: number; completion_tokens: number }) => {
    tokens += u.prompt_tokens + u.completion_tokens;
  };
  const messages: Message[] = [
    { role: "system", content: RESEARCH_SYSTEM },
    { role: "user", content: `Question: ${args.question}\nSteps allowed: ${rc.maxSteps}.` },
  ];
  let steps = 0;
  let stopped = "steps";
  let badReplies = 0;
  while (steps < rc.maxSteps) {
    if (tokens >= rc.maxTokens) {
      stopped = "tokens";
      break;
    }
    pg.step("research", steps + 1, rc.maxSteps);
    const r = await deps.chat("research", messages, { workflow: "research", config: deps.config, env, schema: STEP_SCHEMA, schemaName: "step" });
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
      messages.push({ role: "user", content: `JSON {"tool":"<one of ${RESEARCH_TOOLS.join(", ")}>","arg":"..."}. Steps left: ${rc.maxSteps - steps}.` });
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
    if (!arg) obs = "give an argument";
    else if (called.has(key)) obs = "you already made that call; try a different one, or done";
    else {
      called.add(key);
      try {
        if (tool === "github_repos") obs = await githubRepos(arg, f, env);
        else if (tool === "github_code") obs = await githubCode(arg, f, env);
        else if (tool === "fetch") {
          obs = await fetchText(arg, f, rc.resultChars, lookup);
          seen.add(cleanUrl(arg));
        } else obs = deps.find ? await deps.find(arg) : "find is not available here";
      } catch (e) {
        obs = `${tool} failed: ${redact((e as Error).message, env)}`;
      }
    }
    obs = cap(redact(obs, env), rc.resultChars);
    for (const u of obs.match(URL_RE) ?? []) seen.add(cleanUrl(u));
    report(`research ${steps}/${rc.maxSteps}: ${tool}`);
    messages.push({ role: "user", content: `Result:\n${obs}\nSteps left: ${rc.maxSteps - steps}.` });
  }
  // One summarising call, appended to the same context (cache-friendly); the question is repeated at the tail.
  messages.push({ role: "user", content: SUMMARY_USER(rc.answerWords, args.question) });
  pg.step("research", rc.maxSteps, rc.maxSteps);
  const r = await deps.chat("research", messages, {
    workflow: "research",
    config: deps.config,
    env,
    schema: ANSWER_SCHEMA,
    schemaName: "answer",
    maxTokens: Math.max(300, Math.ceil(rc.answerWords * 2.5)),
  });
  addUsage(r.usage);
  let answer = "";
  let sources: string[] = [];
  try {
    const j = JSON.parse(r.text.match(/\{[\s\S]*\}/)?.[0] ?? "") as { answer?: unknown; sources?: unknown };
    answer = typeof j.answer === "string" ? j.answer.trim() : "";
    if (Array.isArray(j.sources)) sources = j.sources.filter((s): s is string => typeof s === "string").map(cleanUrl);
  } catch {
    answer = r.text.trim();
  }
  // Only URLs that appeared in a tool result may be cited; a made-up link is dropped.
  sources = [...new Set(sources.filter((s) => seen.has(s)))];
  const words = answer.split(/\s+/).filter(Boolean);
  if (words.length > rc.answerWords) answer = words.slice(0, rc.answerWords).join(" ") + " ...";
  answer = redact(answer, env);
  return { answer, sources, steps, tokens, stopped, trace };
}

/** The short cited block shown to the user and handed to /plan. */
export function formatResearch(r: ResearchResult): string {
  if (!r.answer) return "(research found nothing)";
  return r.sources.length ? `${r.answer}\n\nSources:\n${r.sources.map((s) => `- ${s}`).join("\n")}` : r.answer;
}
