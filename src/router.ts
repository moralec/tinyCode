// Routing plain input to a workflow (rule 7). Port of our benchmark, same logic and the same frozen verb lists.
// Code first: file and symbol names from the repo, verbs, question shape. Only when that is unsure: one call to the
// small lane (step "route", json_schema {workflow, file, goal, confident}). Unmatched or unsure -> "none".
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatFn } from "./workflows/fix.ts";

export const WORKFLOWS = ["fix", "edit", "add", "review", "readme", "none"] as const;
export type Workflow = (typeof WORKFLOWS)[number] | "plan" | "explain" | "test" | "doc" | "ask" | "research";

// Generic verbs only; written before the test requests (router.py), not tuned to them.
const VERBS: Record<string, RegExp> = {
  fix: /\b(fix|bug|broken|crash(es|ing)?|fails?|failing|wrong|error|doesn'?t work|isn'?t working|regression)\b/,
  edit: /\b(add|rename|move|refactor|implement|support|make|remove|delete|replace|extract|change)\b/,
  review: /\b(review|look over|check over|audit)\b/,
  readme: /\b(readme|overview|document|documentation|docs)\b/,
};
// "build/create/make a ... app/tool/script": a new thing with no matching file goes to /plan (S11).
const PLAN = /\b(build|create|make|write|develop|set up)\s+(me\s+)?(a|an|the|my|some)\b[^.?!]*\b(app|application|tool|script|cli|program|website|site|api|bot|library|service|game|project)\b/;
// "add/write/implement a new <function|endpoint|option|...>": new code (S14), not a change to existing code.
const NEW_THING = "functions?|methods?|endpoints?|routes?|options?|flags?|commands?|subcommands?|classes|class|helpers?|handlers?|arguments?|parameters?|decorators?";
const ADD = new RegExp(`\\b(add|write|create|implement|introduce)\\s+(a|an|another|new)\\s+(?:[\\w-]+\\s+){0,3}(${NEW_THING})\\b`);
// "what does X do / explain X / how does X work" about a named file or symbol of this repo (S15). Needs a file
// found in the repo; a general question with no repo name stays "none" (S18's /ask).
const EXPLAIN = /\b(explain|walk me through|what (does|is|do)\b[^?!]*\b(do|does|doing|for)\b|how (does|do|is)\b[^?!]*\b(work|works|working|implemented)\b)/;
// "write/add/generate tests for X" (S16): tests only, never code. Distinct from /add (code plus one test): the noun is
// "tests" (or "unit tests"), not a new function. A bug-fix word ("fix the failing test") stays with /fix.
const TESTS = /\b(write|add|create|generate|make|need|give me)\s+(?:(?:some|more|new|a few|a|the|extra|unit|pytest|jest|vitest|regression|missing)\s+){0,3}tests?\b(?!\s+(?:runner|script|harness|command|framework|suite\b))/;
// "add docstrings / comments / doc comments to X" (S17): comments only, never code. "update/write the readme/overview" stays
// the frozen workflow "readme" (router parity); `actionable` turns it into /doc readme when the words ask for a write.
const DOC = /\b(add|write|generate|update|improve|fill in|put|insert|create)\s+(?:[\w-]+\s+){0,3}(docstrings?|doc ?comments?|jsdoc|comments?)\b(?!\s+(?:parser|function|endpoint|field|section|box|form|component|model|system|feature|api|table|count|thread))/;
const DOC_README = /\b(update|write|generate|refresh|create|regenerate|rewrite|rebuild|redo|improve)\b[^.?!]{0,30}\b(readme|overview)\b|\b(readme|overview)\b[^.?!]{0,20}\b(needs|out of date|outdated|stale|should be updated)\b/i;
// "find a library for X", "is there a package that ...", "prior art for Y", "how do others do Z": /research (S13 left it
// command-only; S18 routes it). Needs no file of this repo; a question about this repo's own code is never research.
const LIB_NOUN = "librar(?:y|ies)|packages?|crates?|frameworks?|npm|pypi|gems?|repos|repositories|open[- ]source";
const RESEARCH = new RegExp(
  `\\b(?:find|any|is there|are there|recommend|suggest|look(?:ing)? (?:for|up)|search (?:for|github)|search github for|compare|best|popular)\\b[^.?!]{0,40}\\b(?:${LIB_NOUN})\\b` +
    `|\\b(?:prior art|state of the art|on github|search github|how do (?:other|others|people)|how (?:have|did|do) others|research)\\b`,
);
// A general question: a knowledge-shaped opener, no file of this repo, nothing that points at "this code" (S18's /ask).
// Deliberately narrow: "why do waiters get sorted ..." and "how long would a csv export take" (frozen rows) stay "none".
const GENERAL = /^\s*(?:what(?:'s| is| are| was)\b|what'?s the difference|difference between|how (?:do|can|should|would) (?:i|you|we)\b|how to\b|when (?:should|would|do) (?:i|you|we)\b|should i\b|which is (?:better|faster|best)\b|is it (?:better|ok|okay|safe|bad|good)\b|can you explain (?:what|the difference)\b|explain (?:what|the difference)\b|why (?:is|are) (?:it|there|a|an|the)\b)/i;
const REPO_REF = /\b(?:this|these|those|that|my|our|we|us|here|it|its|the (?:code|codebase|repo|repository|project|app|application|file|files|function|class|module|script|test|tests|bug|error|build|server|database|exporter|importer|folder|directory))\b/i;
const QUESTION = /^\s*(what|why|how|where|when|who|which|is|are|does|do|should)\b/i;
const POLITE = /\b(please|can you|could you)\b/;

export const SCHEMA = {
  type: "object",
  properties: {
    workflow: { type: "string", enum: [...WORKFLOWS] },
    file: { type: "string" },
    goal: { type: "string" },
    confident: { type: "boolean" },
  },
  required: ["workflow", "file", "goal", "confident"],
};
export const SYSTEM =
  "You route a developer's message to a workflow. fix = repair a bug or failing behaviour; edit = change, rename or move " +
  "existing code; add = write a new function, option, endpoint or class; review = read code and report problems; readme = write or update docs; none = a " +
  'question, chat, or anything unclear. file = the one repository path the message is about, or "". ' +
  "confident = false unless the message clearly asks for that workflow. Reply with JSON only.";

const SKIP = new Set(["__pycache__", "node_modules", "venv"]);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface RepoIndex {
  files: string[];
  names: Map<string, string>;
}

function walk(root: string): string[] {
  const out: string[] = [];
  const rec = (rel: string) => {
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => cmp(a.name, b.name));
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!e.name.startsWith(".") && !SKIP.has(e.name)) rec(p);
      } else out.push(p);
    }
  };
  rec("");
  return out;
}

const splitExt = (f: string): [string, string] => {
  const i = f.lastIndexOf(".");
  return i <= 0 ? [f, ""] : [f.slice(0, i), f.slice(i)];
};

/** Top-level def/class names and UPPER_CASE assignments of a Python file (line-based stand-in for `ast`). */
function pyNames(src: string): string[] {
  const out: string[] = [];
  for (const line of src.split(/\r?\n/)) {
    const d = line.match(/^(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (d) {
      if (d[1]!.length >= 5) out.push(d[1]!);
      continue;
    }
    const a = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/);
    if (a && a[1]!.length >= 5 && a[1] === a[1]!.toUpperCase() && /[A-Z]/.test(a[1]!)) out.push(a[1]!);
  }
  return out;
}

const singular = (w: string): string => (w.length > 3 && w.endsWith("ies") ? `${w.slice(0, -3)}y` : w.length > 3 && /[^s]s$/.test(w) ? w.slice(0, -1) : w);

/** snake, kebab and camel case into lowercase words: "FileHandler", "file-handler", "file_handlers" -> [file, handler(s)]. */
export function stemWords(stem: string): string[] {
  return stem
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

/** Loose phrases a message may use for a file: its words joined by a space, last word singular or plural. */
function loosePhrases(stem: string): string[] {
  const w = stemWords(stem);
  if (w.length < 2) return [];
  const head = w.slice(0, -1).join(" ");
  const last = singular(w[w.length - 1]!);
  return [`${head} ${last}`, `${head} ${last}s`];
}

/** {lowercase name: path} for file stems, file names and top-level def/class/CONSTANT names. */
export function buildIndex(repo: string, files = walk(repo)): RepoIndex {
  const names = new Map<string, string>();
  const put = (k: string, p: string) => {
    if (!names.has(k)) names.set(k, p);
  };
  const loose: [string, string][] = [];
  for (const p of files) {
    const f = p.slice(p.lastIndexOf("/") + 1);
    const [stem, ext] = splitExt(f);
    if (f.startsWith(".") || stem === "__init__" || stem === "conftest" || stem.startsWith("test_")) continue;
    put(f.toLowerCase(), p);
    if (stem.length >= 4) put(stem.toLowerCase(), p);
    for (const k of loosePhrases(stem)) loose.push([k, p]);
    if (ext === ".py" && !`/${p}`.includes("/tests/")) {
      let src: string;
      try {
        src = readFileSync(join(repo, p), "utf8");
      } catch {
        continue;
      }
      for (const n of pyNames(src)) put(n.toLowerCase(), p);
    }
  }
  // loose phrases last: an exact name always wins the key
  for (const [k, p] of loose) put(k, p);
  return { files: [...files].sort(cmp), names };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The repo path whose name appears first in the text ("" when none). */
export function findFile(text: string, names: Map<string, string>): string {
  let best: [number, string] | undefined;
  for (const [w, p] of names) {
    const m = new RegExp(`(?<![\\w/])${esc(w)}(?![\\w])`).exec(text);
    if (m && (!best || m.index < best[0] || (m.index === best[0] && p < best[1]))) best = [m.index, p];
  }
  return best ? best[1] : "";
}

export interface Route {
  workflow: Workflow;
  file: string;
  goal: string;
  confident: boolean;
}

export function heuristic(text: string, names: Map<string, string>): Route {
  const low = text.toLowerCase();
  let found = Object.keys(VERBS).filter((w) => VERBS[w]!.test(low));
  if (found.includes("readme")) found = ["readme"];
  else if (found.includes("review")) found = ["review"];
  const file = findFile(low, names);
  const question = QUESTION.test(low) && !POLITE.test(low);
  if (!question && DOC.test(low) && !found.includes("fix") && !found.includes("review") && !found.includes("readme")) return { workflow: "doc", file, goal: text, confident: true };
  if (!question && TESTS.test(low) && !found.includes("fix") && !found.includes("review") && !found.includes("readme")) return { workflow: "test", file, goal: text, confident: true };
  if (!file && RESEARCH.test(low) && !found.includes("fix") && !found.includes("review") && !found.includes("readme") && !DOC_README.test(low)) return { workflow: "research", file: "", goal: text, confident: true };
  if (!file && !question && PLAN.test(low)) return { workflow: "plan", file: "", goal: text, confident: true };
  if (file && EXPLAIN.test(low) && !found.includes("review") && !found.includes("readme")) return { workflow: "explain", file, goal: text, confident: true };
  if (!file && question && GENERAL.test(low) && !REPO_REF.test(low)) return { workflow: "ask", file: "", goal: text, confident: true };
  const addOnly = !found.length || (found.length === 1 && found[0] === "edit");
  if (!question && addOnly && ADD.test(low)) return { workflow: "add", file, goal: text, confident: true };
  if (question || !found.length) return { workflow: "none", file, goal: text, confident: question };
  return { workflow: found[0] as Workflow, file, goal: text, confident: found.length === 1 };
}

export interface Routed extends Route {
  source: "code" | "model";
  prompt_tokens: number;
  completion_tokens: number;
  ms: number;
  /** set when the model call failed and the answer fell back to "none" */
  error?: string;
}

export async function route(text: string, idx: RepoIndex, chat: ChatFn): Promise<Routed> {
  const t0 = Date.now();
  const h = heuristic(text, idx.names);
  let r: Routed = { ...h, source: "code", prompt_tokens: 0, completion_tokens: 0, ms: 0 };
  if (!h.confident) {
    try {
      const res = await chat(
        "route",
        [
          { role: "system", content: SYSTEM },
          { role: "user", content: `Repository files:\n${idx.files.slice(0, 200).join("\n")}\n\nMessage: ${text}` },
        ],
        { schema: SCHEMA, schemaName: "route", workflow: "route" },
      );
      const m = JSON.parse(res.text) as Partial<Route>;
      r = {
        workflow: (m.workflow ?? "none") as Workflow,
        file: typeof m.file === "string" ? m.file : "",
        goal: typeof m.goal === "string" ? m.goal : text,
        confident: m.confident === true,
        source: "model",
        prompt_tokens: res.usage.prompt_tokens,
        completion_tokens: res.usage.completion_tokens,
        ms: 0,
      };
      if (!r.confident || !(WORKFLOWS as readonly string[]).includes(r.workflow)) r.workflow = "none";
      if (r.file && !idx.files.includes(r.file)) r.file = findFile(r.file.toLowerCase(), idx.names);
    } catch (e) {
      r = { ...h, workflow: "none", confident: false, source: "model", prompt_tokens: 0, completion_tokens: 0, ms: 0, error: (e as Error).message };
    }
  }
  r.ms = Date.now() - t0;
  return r;
}

/** Per-session index cache: the walk is cheap, the parse reruns only when the file count changes. */
export function makeIndexCache(): (repo: string) => RepoIndex {
  const cache = new Map<string, { count: number; idx: RepoIndex }>();
  return (repo) => {
    const files = walk(repo);
    const hit = cache.get(repo);
    if (hit && hit.count === files.length) return hit.idx;
    const idx = buildIndex(repo, files);
    cache.set(repo, { count: files.length, idx });
    return idx;
  };
}

/** The one confirmation line: "<workflow> <file>: <goal up to 60 chars> — run it?" */
export function confirmLine(r: Route): string {
  const goal = r.goal.replace(/\s+/g, " ").trim();
  const g = goal.length > 60 ? goal.slice(0, 59) + "…" : goal;
  return `${r.workflow}${r.file ? " " + r.file : ""}: ${g} — run it?`;
}

/** What the handler does with a routing answer: a workflow to confirm, or null (pass the input to Pi untouched). */
export function actionable(r: Route): "fix" | "edit" | "add" | "review" | "plan" | "explain" | "test" | "doc" | "ask" | "research" | null {
  if (r.workflow === "doc") return "doc";
  if (r.workflow === "ask") return "ask";
  if (r.workflow === "research") return "research";
  // readme: only when the words ask to write or update it (a mention such as "the readme promises 25MB" is not a request)
  if (r.workflow === "readme") return DOC_README.test(r.goal) ? "doc" : null;
  if (r.workflow === "test") return "test";
  if (r.workflow === "plan") return "plan";
  if (r.workflow === "explain") return "explain";
  if (r.workflow === "fix") return "fix";
  // /add picks its own target file when the router has none
  if (r.workflow === "add") return "add";
  // /edit needs a file; unsure of the file = Pi's normal loop. readme goes to /doc readme above (S17).
  if (r.workflow === "edit") return r.file ? "edit" : null;
  if (r.workflow === "review") return "review";
  return null;
}
