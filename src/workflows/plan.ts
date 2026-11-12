// /plan <request>: turn "I want to build X" (or a change to an existing project) into .tinycode/plan.json, a short spec
// and an ordered task list, plus .tinycode/PLAN.md for humans. Code gathers the context (empty folder: none; existing
// project: outline + README head, about 2k tokens), one call on the "plan" step (lane from config) returns the JSON,
// code validates it. Pure logic with injected dependencies (chat, confirm), like fix.ts and review.ts.
import { parseTaskFile } from "./cachefiles.ts";
import { NOOP_PROGRESS, type Progress } from "../progress.ts";
import { lstatSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { localImports, reverseImports } from "../context/imports.ts";
import { outline, repoFiles } from "../context/outline.ts";
import { checkInside, writeInside } from "../safewrite.ts";
import type { Message } from "../llm.ts";
import type { ChatFn } from "./fix.ts";
import { ReplayError } from "./research.ts";

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

// E21 (stages.planReview, design plan-build-fit): with the switch on, the draft and the review use these. The two
// constants above are untouched, so with it off the request is byte-for-byte today's.
export const PLAN_SCHEMA_CHECKS = {
  ...PLAN_SCHEMA,
  properties: {
    ...PLAN_SCHEMA.properties,
    tasks: {
      ...PLAN_SCHEMA.properties.tasks,
      items: {
        ...PLAN_SCHEMA.properties.tasks.items,
        properties: { ...PLAN_SCHEMA.properties.tasks.items.properties, check: { type: "string" }, expect: { type: "string" } },
      },
    },
  },
};
export const PLAN_CHECK_LINE = "Optional per task: check = one python command that shows it done; expect = text its output contains.";
export const PLAN_SYSTEM_CHECKS = `${PLAN_SYSTEM}\n${PLAN_CHECK_LINE}`;

export interface PlanTask {
  id: number;
  title: string;
  files: string[];
  test: string;
  /** E21: one python command that shows the task done (run through E17's runner in a scratch folder) */
  check?: string;
  /** E21: text the check's stdout contains (case-sensitive, after \r\n -> \n); absent = exit code 0 alone */
  expect?: string;
  done: boolean;
}
export interface Plan {
  spec: string;
  stack: string;
  tasks: PlanTask[];
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export const CHECK_MAX = 200;
/**
 * Characters a check may not hold outside double quotes: a model that expects a pipe or a redirect is told it gets
 * none (the check runs with no shell, as an argv). Inside double quotes any character is a literal argument
 * (plan-build-fit Addendum 1).
 */
const CHECK_BAD = /[|&;<>()$`^%'\\]/;

/** Why the characters of a check cannot be used, or null: CHECK_BAD outside double quotes, or `\"` (not an escape in checkArgv). */
function checkCharProblem(check: string): string | null {
  let inQ = false;
  for (let i = 0; i < check.length; i++) {
    const ch = check[i]!;
    if (ch === "\\" && check[i + 1] === '"') return 'check may not hold \\" (double quotes only group words; there is no escape)';
    if (ch === '"') inQ = !inQ;
    else if (!inQ && CHECK_BAD.test(ch)) return "check may not hold | & ; < > ( ) $ ` ^ % ' or \\ outside double quotes (it runs as one command, no shell)";
  }
  return null;
}
const PY_ONLY = "checks are Python-only in v1";
const NOT_PYTHON = new Set(["node", "npx", "npm", "pnpm", "yarn", "deno", "bun", "tsx", "ts-node", "jest", "vitest"]);

/** A check's words, double quotes grouping; null when a quote is left open. */
export function checkArgv(check: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  let any = false;
  for (const ch of check) {
    if (ch === '"') {
      inQ = !inQ;
      any = true;
    } else if (!inQ && /\s/.test(ch)) {
      if (any) out.push(cur);
      cur = "";
      any = false;
    } else {
      cur += ch;
      any = true;
    }
  }
  if (inQ) return null;
  if (any) out.push(cur);
  return out;
}

/**
 * Why a task's check cannot be used, or null. `known` holds the repo's files plus the files the plan's tasks name:
 * a `-m X` target must be one of them (`X/__main__.py` or `X.py`, dots as `/`).
 */
export function checkProblem(task: { check?: unknown; expect?: unknown }, known: ReadonlySet<string>): string | null {
  if (typeof task.check !== "string") return "check is not a string";
  const check = task.check.trim();
  if (!check) return "check is empty";
  if (/[\r\n]/.test(check)) return "check must be one line";
  if (check.length > CHECK_MAX) return `check is over ${CHECK_MAX} characters`;
  const argv = checkArgv(check);
  if (!argv) return "check has an open quote";
  const chars = checkCharProblem(check);
  if (chars) return chars;
  if (!argv.length) return "check is empty";
  const first = argv[0]!;
  if (first !== "python" && first !== "python3") return NOT_PYTHON.has(first) ? PY_ONLY : `the first word must be python or python3, got "${first.slice(0, 40)}"`;
  const m = argv.indexOf("-m");
  if (m > 0) {
    const mod = argv[m + 1];
    if (!mod || !/^[\w.]+$/.test(mod)) return "-m needs a module name";
    const p = mod.replace(/\./g, "/");
    if (!known.has(`${p}/__main__.py`) && !known.has(`${p}.py`)) return `-m ${mod}: no such module in the repo or the plan`;
  }
  if (task.expect !== undefined) {
    if (typeof task.expect !== "string") return "expect is not a string";
    if (task.expect.length > CHECK_MAX) return `expect is over ${CHECK_MAX} characters`;
  }
  return null;
}

export interface ValidateOpts {
  /** "ignore" (default, today's): check/expect are not read; "optional": a bad check is dropped (one note), never an error; "required": every task needs a valid check (the review only) */
  checks?: "ignore" | "optional" | "required";
  /** the repo's files, for a check's `-m` target */
  files?: readonly string[];
}

/** A path inside the project: relative, no drive letter, no `..` segment. */
export function isRelativePath(p: string): boolean {
  if (!p || p.startsWith("/") || p.startsWith("\\") || /^[A-Za-z]:/.test(p)) return false;
  return !p.split(/[\\/]/).includes("..");
}

/**
 * Validate a parsed model reply; returns the normalised plan (all `done:false`) or the list of problems. With
 * `checks` "optional" or "required" (E21), task checks are read too; `dropped` lists the optional ones dropped.
 */
export function validatePlan(
  raw: unknown,
  opts: ValidateOpts = {},
): { plan: Plan; errors: []; dropped?: string[]; checkErrors?: string[] } | { plan: null; errors: string[]; checkErrors?: string[] } {
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
  const mode = opts.checks ?? "ignore";
  if (mode === "ignore") return errors.length ? { plan: null, errors } : { plan: { spec, stack, tasks }, errors: [] };
  // E21: checks, read once every task's files are known (a `-m` target may be a file a later task creates)
  const known = new Set([...(opts.files ?? []), ...tasks.flatMap((t) => t.files.map((f) => parseTaskFile(f).path))]);
  const dropped: string[] = [];
  // "required" (the review): a check fault is listed in checkErrors and its check dropped; only structural errors refuse
  const checkErrors: string[] = [];
  const out = tasks.map((t, i) => {
    const x = ((arr ?? [])[i] ?? {}) as Record<string, unknown>;
    const has = typeof x.check === "string" ? x.check.trim() !== "" : x.check !== undefined && x.check !== null;
    if (!has) {
      if (mode === "required") {
        checkErrors.push(`task ${i + 1}: check is missing`);
        dropped.push(`task ${t.id}: no check: check is missing`);
      }
      return t;
    }
    const why = checkProblem(x, known);
    if (why) {
      // a TS/JS check is dropped even in the review: checks are Python-only in v1, and the read set still serves the plan
      if (mode === "required" && why !== PY_ONLY) checkErrors.push(`task ${i + 1}: ${why}`);
      dropped.push(`task ${t.id}: check dropped: ${why}`);
      return t;
    }
    const { done, ...rest } = t;
    const expect = typeof x.expect === "string" && x.expect !== "" ? x.expect : undefined;
    return { ...rest, check: (x.check as string).trim(), ...(expect !== undefined ? { expect } : {}), done };
  });
  const ce = checkErrors.length ? { checkErrors } : {};
  return errors.length ? { plan: null, errors, ...ce } : { plan: { spec, stack, tasks: out }, errors: [], dropped, ...ce };
}

/** Parse a reply (tolerant of fences) and validate it. */
export function parsePlan(text: string, opts: ValidateOpts = {}): ReturnType<typeof validatePlan> {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return { plan: null, errors: ["the reply is not JSON"] };
  try {
    return validatePlan(JSON.parse(m[0]), opts);
  } catch {
    return { plan: null, errors: ["the reply is not valid JSON"] };
  }
}

/** E21: a task's check as shown with the plan and in /build's task header. */
export const checkLine = (t: PlanTask): string => `${t.check}${t.expect !== undefined ? ` (expects "${t.expect}")` : ""}`;

/** The numbered list shown to the user. */
export function formatPlan(p: Plan): string[] {
  const lines = [`Plan: ${p.spec}`, `Stack: ${p.stack}`];
  p.tasks.forEach((t, i) => {
    lines.push(`${i + 1}. ${t.title}  [${t.files.join(", ")}]  test: ${t.test}`);
    if (t.check) lines.push(`   check: ${checkLine(t)}`);
  });
  return lines;
}

/** .tinycode/PLAN.md for humans. */
export function planMarkdown(p: Plan): string {
  const out = ["# Plan", "", p.spec, "", `**Stack:** ${p.stack}`, "", "## Tasks", ""];
  for (const t of p.tasks) {
    out.push(`${t.id}. [${t.done ? "x" : " "}] ${t.title}`, `   - files: ${t.files.join(", ")}`, `   - test: ${t.test}`);
    if (t.check) out.push(`   - check: ${checkLine(t)}`);
  }
  return out.join("\n") + "\n";
}

/** E21: a file of the read set is shown up to this many lines, then cut with a marker. */
export const READ_FILE_LINES = 150;

export interface ReadSet {
  /** files shown, in order: named by the draft and existing, their imports, their importers */
  files: string[];
  /** files that did not fit the budget: listed by name only */
  listed: string[];
  /** what the review call is shown; "" when there is nothing to show */
  text: string;
}

/**
 * E21: the files the draft's tasks name that exist, then their in-repo imports, then their importers (one level each,
 * no duplicates), shown within `budget` characters. Code only, no model call.
 */
export function planReadSet(cwd: string, draft: Plan, langs: readonly string[], budget: number): ReadSet {
  const all = repoFiles(cwd, langs);
  const set = new Set(all);
  const isFile = (p: string) => {
    try {
      return statSync(join(cwd, p)).isFile();
    } catch {
      return false;
    }
  };
  const order: string[] = [];
  const add = (p: string) => {
    if (!order.includes(p)) order.push(p);
  };
  const named: string[] = [];
  for (const t of draft.tasks)
    for (const f of t.files) {
      const p = parseTaskFile(f).path;
      if (isRelativePath(p) && (set.has(p) || isFile(p)) && !named.includes(p)) named.push(p);
    }
  if (!named.length) return { files: [], listed: [], text: "" };
  const read = (p: string) => {
    try {
      return readFileSync(join(cwd, p), "utf8");
    } catch {
      return "";
    }
  };
  named.forEach(add);
  for (const p of named) localImports(p, read(p), set, langs).forEach(add);
  const rev = reverseImports(cwd, named, all, langs);
  for (const p of named) (rev.get(p) ?? []).forEach(add);
  const files: string[] = [];
  const listed: string[] = [];
  const blocks: string[] = [];
  let used = 0;
  for (const p of order) {
    const lines = read(p).replace(/\n$/, "").split("\n");
    const body = lines.length > READ_FILE_LINES ? `${lines.slice(0, READ_FILE_LINES).join("\n")}\n... (cut: ${lines.length - READ_FILE_LINES} more lines)` : lines.join("\n");
    const block = `${p}\n\`\`\`\n${body}\n\`\`\``;
    if (listed.length || used + block.length > budget) {
      listed.push(p);
      continue;
    }
    files.push(p);
    blocks.push(block);
    used += block.length + 2;
  }
  const text = blocks.join("\n\n") + (listed.length ? `${blocks.length ? "\n\n" : ""}Not shown (over the budget): ${listed.join(", ")}` : "");
  return { files, listed, text };
}

/** E21: the review call's user message. */
export function reviewPrompt(rs: ReadSet): string {
  return (
    `Files your tasks touch, and files linked to them:\n\n${rs.text}\n\n` +
    "Correct the plan. A task must list every file it changes: a registry, a settings file, an import. " +
    "Give each task `check` (one python command that shows it done) and `expect` (text its output contains). " +
    "A check runs in an empty folder with the project importable: import the code; do not read project files by relative path; no pytest. " +
    "Corrected JSON only."
  );
}

/** E21: why a valid review may not replace the draft (it must keep every draft file and at least the task count), or null. */
export function reviewScopeProblem(draft: Plan, review: Plan): string | null {
  const paths = (p: Plan) => new Set(p.tasks.flatMap((t) => t.files.map((f) => parseTaskFile(f).path)));
  const kept = paths(review);
  const lost = [...paths(draft)].filter((f) => !kept.has(f));
  if (lost.length) return `a file was dropped (${lost.join(", ")})`;
  if (review.tasks.length < draft.tasks.length) return `fewer tasks (${review.tasks.length} < ${draft.tasks.length})`;
  return null;
}

const IGNORED = new Set([".git", ".tinycode", ".DS_Store", "__pycache__", ".venv", "venv", "node_modules"]);

/** Existing project: outline + README head. Empty folder (or only dot/ignored entries): "" (no context). */
export function gatherContext(cwd: string, langs: readonly string[] = ["py"]): string {
  let names: string[];
  try {
    names = readdirSync(cwd).filter((n) => !IGNORED.has(n));
  } catch {
    return "";
  }
  if (!names.length) return "";
  const parts: string[] = [];
  const o = outline(cwd, OUTLINE_CHARS, langs).trim();
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
  /** E21 (planReview on): "used", or why the review call was not made or not used */
  review?: string;
}

export async function runPlan(args: PlanArgs, deps: PlanDeps): Promise<PlanResult> {
  if (!args.request) {
    deps.report("usage: /plan <what you want to build or change>");
    return { plan: null, calls: 0, file: null, confirmed: false, errors: ["no request"] };
  }
  const pg = deps.progress ?? NOOP_PROGRESS;
  pg.step("research");
  const context = gatherContext(deps.cwd, deps.config.languages);
  // One research call at most; a failure or an empty answer plans without it. Only the answer enters the prompt.
  let notes: string | null = null;
  if (deps.research && wantsResearch(args.request, deps.cwd)) {
    try {
      notes = (await deps.research(args.request))?.trim() || null;
    } catch (e) {
      if (e instanceof ReplayError) throw e;   // research.replay unusable: fail closed, never plan as if research ran
      deps.report(`/plan: research skipped: ${(e as Error).message}`);
    }
  }
  // E21: with planReview on, the draft may carry checks (optional: a bad one is dropped) and a review call may follow
  const review = deps.config.stages.planReview;
  const langs = deps.config.languages;
  const schema = review ? PLAN_SCHEMA_CHECKS : PLAN_SCHEMA;
  const draftOpts: ValidateOpts = review ? { checks: "optional", files: repoFiles(deps.cwd, langs) } : {};
  const messages: Message[] = [
    { role: "system", content: review && langs.includes("py") ? PLAN_SYSTEM_CHECKS : PLAN_SYSTEM },
    {
      role: "user",
      content: `${context ? context + "\n\n" : "The folder is empty: a new project.\n\n"}${notes ? `Research notes (from GitHub, may be imperfect):\n${notes}\n\n` : ""}Request: ${args.request}\n\nPlan it.`,
    },
  ];
  let calls = 0;
  let result: ReturnType<typeof validatePlan> = { plan: null, errors: ["no reply"] };
  let lastReply = "";
  // One retry: the errors are appended (retries only append), never a rewrite of the prompt.
  for (let attempt = 0; attempt < 2; attempt++) {
    calls++;
    if (attempt === 0) pg.step("plan");
    else pg.step("plan", attempt + 1, 2);
    const r = await deps.chat("plan", messages, { workflow: "plan", config: deps.config, env: deps.env, schema, schemaName: "plan" });
    result = parsePlan(r.text, draftOpts);
    lastReply = r.text;
    if (result.plan) break;
    messages.push({ role: "assistant", content: r.text }, { role: "user", content: `Plan invalid:\n- ${result.errors.join("\n- ")}\nCorrected JSON only.` });
  }
  if (!result.plan) {
    deps.report(`/plan: no valid plan after ${calls} calls: ${result.errors.join("; ")}`);
    return { plan: null, calls, file: null, confirmed: false, errors: result.errors };
  }
  let plan = result.plan;
  for (const d of result.dropped ?? []) deps.report(d);
  let reviewNote: string | undefined;
  if (review) {
    // E21: a second call over the files the draft names (existing project only), kept only if it keeps the draft's scope
    const rs = context ? planReadSet(deps.cwd, plan, langs, deps.config.stages.planReadChars) : { files: [], listed: [], text: "" };
    if (!rs.text) reviewNote = context ? "no review call: the draft names no existing file" : "no review call: empty folder";
    else {
      messages.push({ role: "assistant", content: lastReply }, { role: "user", content: reviewPrompt(rs) });
      const reqOpts: ValidateOpts = { ...draftOpts, checks: "required" };
      let rv: ReturnType<typeof validatePlan> = { plan: null, errors: ["no reply"] };
      for (let attempt = 0; attempt < 2; attempt++) {
        calls++;
        pg.step("plan review", attempt + 1, 2);
        const r = await deps.chat("plan", messages, { workflow: "plan", config: deps.config, env: deps.env, schema: PLAN_SCHEMA_CHECKS, schemaName: "plan" });
        rv = parsePlan(r.text, reqOpts);
        if (rv.plan) break;
        messages.push({ role: "assistant", content: r.text }, { role: "user", content: `Plan invalid:\n- ${rv.errors.join("\n- ")}\nCorrected JSON only.` });
      }
      const scope = rv.plan ? reviewScopeProblem(plan, rv.plan) : `invalid twice: ${rv.errors.slice(0, 3).join("; ")}`;
      if (rv.plan && !scope) {
        plan = rv.plan;
        reviewNote = "used";
        const k = rv.dropped?.length ?? 0;
        for (const d of rv.dropped ?? []) deps.report(d);
        deps.report(`plan review used (${rs.files.length} file(s) read${rs.listed.length ? `, ${rs.listed.length} listed only` : ""}${k ? `; ${k} check(s) dropped` : ""})`);
      } else {
        reviewNote = `not used: ${scope}`;
        deps.report(`plan review not used: ${scope}`);
      }
    }
  }
  pg.step("save");
  // .tinycode/ and its files may be committed by the repository: refuse a symlink anywhere on the way (src/safewrite.ts)
  const prev = checkInside(deps.cwd, join(".tinycode", "plan.json"));
  let had = false;
  try {
    had = lstatSync(prev).isFile();
  } catch {
    // no earlier plan
  }
  if (had) renameSync(prev, checkInside(deps.cwd, join(".tinycode", "plan.prev.json")));
  const file = writeInside(deps.cwd, join(".tinycode", "plan.json"), JSON.stringify(plan, null, 2) + "\n");
  writeInside(deps.cwd, join(".tinycode", "PLAN.md"), planMarkdown(plan));
  pg.touch(".tinycode/plan.json");
  for (const l of formatPlan(plan)) deps.report(l);
  deps.report(`saved .tinycode/plan.json and .tinycode/PLAN.md (${plan.tasks.length} tasks, ${calls} call${calls === 1 ? "" : "s"})`);
  const confirmed = deps.confirm ? await deps.confirm("run it?") : false;
  return { plan, calls, file, confirmed, errors: [], researched: notes !== null, ...(reviewNote !== undefined ? { review: reviewNote } : {}) };
}
