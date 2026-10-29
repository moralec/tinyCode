// /research <question> (S13): "is there a library for X?", "how do others do Y on GitHub?" answered in a separate
// context. A research branch picks one tool per call (GitHub search, fetch a URL as text, local find), under hard
// caps on steps and tokens, then ONE summarising call returns {answer, sources}. Only that short cited answer goes
// back to the conversation (or into /plan's prompt); search output never does. Pure TypeScript `fetch`, no Unix
// tools, no Pi import: the local `find` is injected (extensions/tinycode/index.ts wires src/branch.ts findAnswer).
// GITHUB_TOKEN is read from the environment, sent only to api.github.com, and never logged or echoed.
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

export const RESEARCH_SYSTEM = `You research a developer's question with tools, one call at a time, then stop.
Reply with JSON only: {"tool":"<name>","arg":"<argument>"}.
Tools:
- github_repos: arg = search words; lists public GitHub repositories (name, stars, language, description, url).
- github_code: arg = search words; lists code files on GitHub (needs a token, may be refused).
- fetch: arg = an http(s) URL you saw in a result; returns the page as plain text (a README, a docs page).
- find: arg = a question about the local project's code; returns a short answer with path:line.
- done: arg = "" ; you have enough to answer.
Prefer github_repos first, then fetch the README of the two or three best repos. Never repeat a call. Only cite URLs you saw in a result.`;

const SUMMARY_USER = (words: number, question: string) =>
  `Now answer the question: ${question}\nAt most ${words} words, plain text. Compare the options if asked. List in "sources" the URLs you relied on, copied exactly from the results above (GitHub repository links first).`;

export interface ResearchArgs {
  question: string;
}
export function parseResearchArgs(raw: string): ResearchArgs {
  return { question: raw.trim() };
}

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
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

/** Only public http(s) pages: no other scheme, no localhost or private-network addresses. */
export function urlAllowed(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h === "::1") return false;
  const m = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) return false;
  }
  return !/^(fc|fd|fe80)/.test(h) || !h.includes(":");
}

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

/** Fetch a URL as readable text. The token is never sent here (only to api.github.com). */
export async function fetchText(url: string, f: FetchLike, chars: number): Promise<string> {
  if (!urlAllowed(url)) throw new Error("only public http(s) URLs can be fetched");
  const res = await f(url, { headers: { "User-Agent": "tinycode", Accept: "text/html,text/plain,text/markdown,*/*;q=0.5" }, signal: AbortSignal.timeout(15_000) });
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
      messages.push({ role: "user", content: `Reply with JSON {"tool":"<one of ${RESEARCH_TOOLS.join(", ")}>","arg":"..."}. Steps left: ${rc.maxSteps - steps}.` });
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
          obs = await fetchText(arg, f, rc.resultChars);
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
