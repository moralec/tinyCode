// /plan <request>: turn "I want to build X" (or a change to an existing project) into .tinycode/plan.json, a short spec
// and an ordered task list, plus .tinycode/PLAN.md for humans. Code gathers the context (empty folder: none; existing
// project: outline + README head, about 2k tokens), one call on the "plan" step (lane from config) returns the JSON,
// code validates it. Pure logic with injected dependencies (chat, confirm), like fix.ts and review.ts.
import { parseTaskFile } from "./cachefiles.ts";
import { NOOP_PROGRESS, type Progress } from "../progress.ts";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { outline } from "../context/outline.ts";
import type { Message } from "../llm.ts";
import type { ChatFn } from "./fix.ts";

export const MIN_TASKS = 3;
export const MAX_TASKS = 12;
/** context budget: about 2k tokens at 4 characters each */
export const OUTLINE_CHARS = 6000;
export const README_CHARS = 1500;

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    spec: { type: "string" },
    stack: { type: "string" },
    tasks: {
      type: "array",
      minItems: MIN_TASKS,
      maxItems: MAX_TASKS,
      items: {
        type: "object",
        properties: {
          id: { type: "integer" },
          title: { type: "string" },
          files: { type: "array", items: { type: "string" } },
          test: { type: "string" },
        },
        required: ["id", "title", "files", "test"],
      },
    },
  },
  required: ["spec", "stack", "tasks"],
};

export const PLAN_SYSTEM = `Plan a small software change: short spec plus ordered task list.
Reply JSON: {"spec":"<3-6 sentences: what it does, how it behaves>","stack":"<language, libraries, test tool>","tasks":[{"id":1,"title":"<one short sentence>","files":["<relative path>"],"test":"<test that defines done: file and what it checks>"}]}
${MIN_TASKS} to ${MAX_TASKS} tasks, ids 1,2,3,... in build order. Task = one behaviour, one or two files.
files: paths relative to project root, never absolute. Each task names the test that proves it done, written before the code.
Early tasks set up what later ones need. Existing code: follow its files and conventions.`;

export interface PlanTask {
  id: number;
  title: string;
  files: string[];
  test: string;
  done: boolean;
}
export interface Plan {
  spec: string;
  stack: string;
  tasks: PlanTask[];
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** A path inside the project: relative, no drive letter, no `..` segment. */
export function isRelativePath(p: string): boolean {
  if (!p || p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p)) return false;
  return !p.split(/[\\/]/).includes("..");
}

/** Validate a parsed model reply; returns the normalised plan (all `done:false`) or the list of problems. */
export function validatePlan(raw: unknown): { plan: Plan; errors: [] } | { plan: null; errors: string[] } {
  const errors: string[] = [];
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const spec = str(o.spec);
  const stack = str(o.stack);
  if (!spec) errors.push("spec is missing or empty");
  if (!stack) errors.push("stack is missing or empty");
  const arr = Array.isArray(o.tasks) ? o.tasks : null;
  if (!arr) errors.push("tasks must be an array");
  else if (arr.length < MIN_TASKS || arr.length > MAX_TASKS) errors.push(`tasks has ${arr.length} entries; it must have ${MIN_TASKS} to ${MAX_TASKS}`);
  const tasks: PlanTask[] = [];
  const ids = new Set<number>();
  (arr ?? []).forEach((t, i) => {
    const x = (typeof t === "object" && t !== null ? t : {}) as Record<string, unknown>;
    const at = `task ${i + 1}`;
    const id = typeof x.id === "number" && Number.isInteger(x.id) ? x.id : Number.NaN;
    if (Number.isNaN(id)) errors.push(`${at}: id must be an integer`);
    else if (ids.has(id)) errors.push(`${at}: id ${id} is used twice`);
    else ids.add(id);
    const title = str(x.title);
    if (!title) errors.push(`${at}: title is empty`);
    const files = Array.isArray(x.files) ? x.files.map(str) : [];
    if (!files.length) errors.push(`${at}: files is empty`);
    for (const f of files) if (!isRelativePath(parseTaskFile(f).path)) errors.push(`${at}: file "${f}" must be a relative path inside the project`);
    const test = str(x.test);
    if (!test) errors.push(`${at}: test is empty (each task needs the test that defines done)`);
    tasks.push({ id: Number.isNaN(id) ? i + 1 : id, title, files, test, done: false });
  });
  return errors.length ? { plan: null, errors } : { plan: { spec, stack, tasks }, errors: [] };
}

/** Parse a reply (tolerant of fences) and validate it. */
export function parsePlan(text: string): ReturnType<typeof validatePlan> {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { plan: null, errors: ["the reply is not JSON"] };
  try {
    return validatePlan(JSON.parse(m[0]));
  } catch {
    return { plan: null, errors: ["the reply is not valid JSON"] };
  }
}

/** The numbered list shown to the user. */
export function formatPlan(p: Plan): string[] {
  const lines = [`Plan: ${p.spec}`, `Stack: ${p.stack}`];
  p.tasks.forEach((t, i) => lines.push(`${i + 1}. ${t.title}  [${t.files.join(", ")}]  test: ${t.test}`));
  return lines;
}

/** .tinycode/PLAN.md for humans. */
export function planMarkdown(p: Plan): string {
  const out = ["# Plan", "", p.spec, "", `**Stack:** ${p.stack}`, "", "## Tasks", ""];
  for (const t of p.tasks) {
    out.push(`${t.id}. [${t.done ? "x" : " "}] ${t.title}`, `   - files: ${t.files.join(", ")}`, `   - test: ${t.test}`);
  }
  return out.join("\n") + "\n";
}

const IGNORED = new Set([".git", ".tinycode", ".DS_Store", "__pycache__", ".venv", "venv", "node_modules"]);

/** Existing project: outline + README head. Empty folder (or only dot/ignored entries): "" (no context). */
export function gatherContext(cwd: string): string {
  let names: string[];
  try {
    names = readdirSync(cwd).filter((n) => !IGNORED.has(n));
  } catch {
    return "";
  }
  if (!names.length) return "";
  const parts: string[] = [];
  const o = outline(cwd, OUTLINE_CHARS).trim();
  if (o) parts.push(`Repository outline:\n${o}`);
  const readme = names.find((n) => n.toLowerCase() === "readme.md" || n.toLowerCase() === "readme");
  if (readme) {
    try {
      const head = readFileSync(join(cwd, readme), "utf8").slice(0, README_CHARS).trim();
      if (head) parts.push(`${readme} (start):\n${head}`);
    } catch {
      // unreadable README: skip it
    }
  }
  return parts.join("\n\n");
}

export interface PlanArgs {
  request: string;
}
export function parsePlanArgs(raw: string): PlanArgs {
  return { request: raw.trim() };
}

// /research from /plan (S13): one optional call when the request asks for prior art or names a library the project
// does not already use. Words that read like a library but are not one are listed, not guessed at.
const PRIOR_ART = /\b(prior art|how do (others|people|other projects)|how (have )?others|is there (a|an|any) (library|package|module|tool)|existing (libraries|packages|projects|tools|implementations?)|alternatives? to|compare (the )?(libraries|packages|options)|best (library|package)|which (library|package))\b/i;
const LIB_NAME = /\b(?:using|with|via|use|on top of|based on|powered by)\s+(?:the\s+)?([A-Za-z][\w.-]{2,})(?:\s+(?:library|package|module|sdk|framework|lib))\b|\b([A-Za-z][\w.-]{2,})\s+(?:library|package|module|sdk|framework|lib)\b/gi;
const NOT_A_LIB = new Set(["the", "a", "an", "this", "that", "some", "any", "python", "standard", "stdlib", "new", "small", "good", "popular", "my", "our", "your", "node", "javascript", "typescript", "built", "builtin", "another", "same", "right", "best", "which", "what", "any"]);

/** The unfamiliar library the request names, if any: named, not a generic word, and not mentioned in the project's manifests. */
export function unfamiliarLibrary(request: string, cwd: string): string | null {
  let known = "";
  for (const f of ["requirements.txt", "pyproject.toml", "package.json", "setup.py", "Pipfile", "go.mod", "Cargo.toml"]) {
    try {
      known += readFileSync(join(cwd, f), "utf8").toLowerCase() + "\n";
    } catch {
      // no such manifest
    }
  }
  for (const m of request.matchAll(LIB_NAME)) {
    const name = (m[1] ?? m[2] ?? "").toLowerCase();
    if (name && !NOT_A_LIB.has(name) && !known.includes(name)) return name;
  }
  return null;
}

export function wantsResearch(request: string, cwd: string): boolean {
  return PRIOR_ART.test(request) || unfamiliarLibrary(request, cwd) !== null;
}

/** The phases /plan reports (`research` only when the request needs it; the research steps show as `research 4/8`). */
export const PLAN_PHASES = ["research", "plan", "save"];

export interface PlanDeps {
  progress?: Progress;
  cwd: string;
  config: Config;
  chat: ChatFn;
  report: (line: string) => void;
  /** the "run it?" question; absent without a UI */
  confirm?: (question: string) => Promise<boolean>;
  env?: Record<string, string | undefined>;
  /** /research (S13): returns the short cited answer, or null. Called at most once, only when the request needs it. */
  research?: (question: string) => Promise<string | null>;
}

export interface PlanResult {
  plan: Plan | null;
  calls: number;
  /** plan.json path, or null when no valid plan came back */
  file: string | null;
  confirmed: boolean;
  errors: string[];
  /** true when a /research answer went into the plan prompt */
  researched?: boolean;
}

export async function runPlan(args: PlanArgs, deps: PlanDeps): Promise<PlanResult> {
  if (!args.request) {
    deps.report("usage: /plan <what you want to build or change>");
    return { plan: null, calls: 0, file: null, confirmed: false, errors: ["no request"] };
  }
  const pg = deps.progress ?? NOOP_PROGRESS;
  pg.step("research");
  const context = gatherContext(deps.cwd);
  // One research call at most; a failure or an empty answer plans without it. Only the answer enters the prompt.
  let notes: string | null = null;
  if (deps.research && wantsResearch(args.request, deps.cwd)) {
    try {
      notes = (await deps.research(args.request))?.trim() || null;
    } catch (e) {
      deps.report(`/plan: research skipped: ${(e as Error).message}`);
    }
  }
  const messages: Message[] = [
    { role: "system", content: PLAN_SYSTEM },
    {
      role: "user",
      content: `${context ? context + "\n\n" : "The folder is empty: a new project.\n\n"}${notes ? `Research notes (from GitHub, may be imperfect):\n${notes}\n\n` : ""}Request: ${args.request}\n\nPlan it.`,
    },
  ];
  let calls = 0;
  let result: ReturnType<typeof validatePlan> = { plan: null, errors: ["no reply"] };
  // One retry: the errors are appended (retries only append), never a rewrite of the prompt.
  for (let attempt = 0; attempt < 2; attempt++) {
    calls++;
    if (attempt === 0) pg.step("plan");
    else pg.step("plan", attempt + 1, 2);
    const r = await deps.chat("plan", messages, { workflow: "plan", config: deps.config, env: deps.env, schema: PLAN_SCHEMA, schemaName: "plan" });
    result = parsePlan(r.text);
    if (result.plan) break;
    messages.push({ role: "assistant", content: r.text }, { role: "user", content: `Plan invalid:\n- ${result.errors.join("\n- ")}\nCorrected JSON only.` });
  }
  if (!result.plan) {
    deps.report(`/plan: no valid plan after ${calls} calls: ${result.errors.join("; ")}`);
    return { plan: null, calls, file: null, confirmed: false, errors: result.errors };
  }
  const plan = result.plan;
  pg.step("save");
  const dir = join(deps.cwd, ".tinycode");
  const file = join(dir, "plan.json");
  mkdirSync(dir, { recursive: true });
  if (existsSync(file)) renameSync(file, join(dir, "plan.prev.json"));
  writeFileSync(file, JSON.stringify(plan, null, 2) + "\n");
  writeFileSync(join(dir, "PLAN.md"), planMarkdown(plan));
  pg.touch(".tinycode/plan.json");
  for (const l of formatPlan(plan)) deps.report(l);
  deps.report(`saved .tinycode/plan.json and .tinycode/PLAN.md (${plan.tasks.length} tasks, ${calls} call${calls === 1 ? "" : "s"})`);
  const confirmed = deps.confirm ? await deps.confirm("run it?") : false;
  return { plan, calls, file, confirmed, errors: [], researched: notes !== null };
}
