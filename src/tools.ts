// S19: the workflows as the orchestrator's tools (rule 15), the tools-first system prompt, the router as a hint, and
// the tools-first nudge. The model decides and narrates; each tool is one workflow run (code gathers, narrow calls,
// code checks) that returns a compact result string, never raw work.
//
// Pi API used (vendor pi 1.4.0, dist/core/extensions/types.d.ts, PX sections 2 and 3):
//   pi.registerTool(defineTool({name, label, description, parameters (TypeBox), executionMode, execute(id, params, signal, onUpdate, ctx)}))
//   pi.on("before_agent_start", (e, ctx) => ({ systemPrompt, message }))   once per user prompt; `message` is the tail hint
//   pi.on("tool_call", ...)  /  pi.on("agent_end", ...)                    the nudge and the tools_first log
// This file and branch.ts are the only ones that import Pi at runtime (jiti), like branch.ts.
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { RESTORE_TOOL } from "./besttree.ts";
import { actionable, type Route } from "./router.ts";

/** Workflow (router vocabulary) -> the Pi tool that runs it. `edit` is `edit_file`: Pi's own `edit` stays the raw fallback. */
export const TOOL_FOR: Record<string, string | null> = {
  fix: "fix",
  edit: "edit_file",
  add: "add",
  explain: "explain",
  test: "test",
  doc: "doc",
  review: "review",
  commit: "commit",
  plan: "plan",
  build: "build",
  research: "research",
  ask: null,
};

export const WORKFLOW_TOOLS = ["fix", "edit_file", "add", "explain", "test", "doc", "review", "commit", "plan", "build", "research"] as const;
export type WorkflowTool = (typeof WORKFLOW_TOOLS)[number];
export const isWorkflowTool = (name: string): boolean => (WORKFLOW_TOOLS as readonly string[]).includes(name);

/** Pi's own file/shell tools: a first action with one of these while the hint names a tinyCode tool gets the nudge. */
export const RAW_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "ls"]);

/** What a tool run gives back: the compact text, and whether the workflow did what was asked. */
export interface ToolOutcome {
  text: string;
  ok: boolean;
  /** ok but unfinished: what remains (STATUS: partial) */
  remaining?: string;
  /** not ok: why (STATUS: failed); defaults to the first line of the text */
  reason?: string;
}
export type ToolRunner = (name: WorkflowTool, params: Record<string, unknown>, ctx: ExtensionContext) => Promise<ToolOutcome>;

export const RESULT_CAP = 2400;

/** Cap a result so a tool's answer never costs more than ~600 tokens; the cut is announced. */
export function compact(text: string, cap = RESULT_CAP): string {
  const t = text.trim();
  return t.length <= cap ? t : `${t.slice(0, cap - 20).trimEnd()}\n[cut at ${cap} chars]`;
}

/** Tool-mode wording: the next step names tools, not slash commands. */
export const forTool = (text: string): string => text.replace(/\brun \/(\w+)/g, "call $1").replace(/\bwith \/fix\b/g, "with fix");

/** The explicit completion line every tool result ends with. done: report and stop; partial: what remains; failed: raw tools allowed. */
export function statusLine(o: ToolOutcome): string {
  if (o.ok && !o.remaining) return "STATUS: done. Report to user, stop.";
  if (o.ok) return `STATUS: partial \u2014 ${o.remaining}`;
  const why = (o.reason ?? o.text.trim().split("\n")[0] ?? "").slice(0, 160) || "tool could not finish";
  return `STATUS: failed \u2014 ${why}; raw tools ok`;
}

/** The tool result shape: one text part (never raw work) ending with the STATUS line, details for the UI. */
export function toolResult(o: ToolOutcome): { content: { type: "text"; text: string }[]; details: { ok: boolean } } {
  return { content: [{ type: "text", text: `${compact(o.text)}\n${statusLine(o)}` }], details: { ok: o.ok } };
}

/** The required first field of every tool: the model's own one-sentence narration, shown in the chat when the tool starts. */
export const INTENT_DESCRIPTION = "what you do, one line";
export const CUSTOM_SAY = "tinycode-say";
const INTENT = () => Type.String({ description: INTENT_DESCRIPTION });
/** The intent text of a tool call's params, or "". */
export const intentOf = (params: unknown): string => {
  const v = (params as { intent?: unknown } | null)?.intent;
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, 300) : "";
};

const S = (description?: string) => (description ? Type.String({ description }) : Type.String());
const O = (description?: string) => Type.Optional(S(description));

interface Spec {
  name: WorkflowTool;
  label: string;
  description: string;
  parameters: ReturnType<typeof Type.Object>;
}

// Terse beats complete (budget: all tool descriptions + schemas <= ~900 tokens, measured with the gemma tokenizer).
export const SPECS: Spec[] = [
  { name: "fix", label: "Fix", description: "Fix bug or failing test: edits, runs tests, retries.", parameters: Type.Object({ intent: INTENT(), task: S(), test: O("test file, if named") }) },
  { name: "edit_file", label: "Edit file", description: "Change one file (rename, refactor, small change).", parameters: Type.Object({ intent: INTENT(), path: S(), instruction: S() }) },
  { name: "add", label: "Add", description: "Add code (function, option, endpoint) plus test.", parameters: Type.Object({ intent: INTENT(), task: S(), file: O() }) },
  { name: "explain", label: "Explain", description: "Explain function or file, cited. No edits.", parameters: Type.Object({ intent: INTENT(), question: S(), file: O() }) },
  { name: "test", label: "Write tests", description: "Write tests for function or file, run them.", parameters: Type.Object({ intent: INTENT(), what: S(), file: O() }) },
  { name: "doc", label: "Doc", description: "Docstrings/comments for file, or README update.", parameters: Type.Object({ intent: INTENT(), request: S(), file: O() }) },
  { name: "review", label: "Review", description: "Review uncommitted changes.", parameters: Type.Object({ intent: INTENT(), path: O() }) },
  { name: "commit", label: "Commit", description: "Commit changes with written message.", parameters: Type.Object({ intent: INTENT(), hint: O() }) },
  { name: "plan", label: "Plan", description: "New app/feature request to task list.", parameters: Type.Object({ intent: INTENT(), request: S() }) },
  { name: "build", label: "Build", description: "Build planned tasks in order.", parameters: Type.Object({ intent: INTENT(), task: Type.Optional(Type.Integer()) }) },
  { name: "research", label: "Research", description: "Search GitHub/web for libraries, prior art; cited answer.", parameters: Type.Object({ intent: INTENT(), question: S() }) },
];

/**
 * The workflow tools, all 11 or only those in `only` (config `intercept`: a tool tinyCode does not intercept is not
 * declared to the model). `run` does the work; a throw becomes a "failed" result (the model decides what next).
 */
export function workflowTools(run: ToolRunner, show?: (text: string, ctx: ExtensionContext) => void, only?: readonly string[]) {
  return SPECS.filter((s) => !only || only.includes(s.name)).map((s) =>
    defineTool({
      name: s.name,
      label: s.label,
      description: s.description,
      parameters: s.parameters,
      // one workflow at a time: they share the GPU, the progress display and the files
      executionMode: "sequential",
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const said = intentOf(params);
        if (said && show) {
          try {
            show(said, ctx as ExtensionContext);
          } catch {
            // narration is a courtesy; the tool still runs
          }
        }
        let out: ToolOutcome;
        try {
          out = await run(s.name, params as Record<string, unknown>, ctx as ExtensionContext);
        } catch (e) {
          out = { text: `${s.name} failed: ${(e as Error).message}`, ok: false };
        }
        return toolResult(out);
      },
    }),
  );
}

export function registerWorkflowTools(pi: ExtensionAPI, run: ToolRunner, only?: readonly string[]): void {
  const show = (text: string, ctx: ExtensionContext): void => {
    // the model's own words, posted as an assistant-style message (no UI: plain stdout, like the end summary)
    if (ctx.hasUI) pi.sendMessage({ customType: CUSTOM_SAY, content: text, display: true });
    else process.stdout.write(text + "\n");
  };
  pi.registerMessageRenderer(CUSTOM_SAY, (m) => new Text(typeof m.content === "string" ? m.content : "", 1, 0));
  for (const t of workflowTools(run, show, only)) pi.registerTool(t);
}

// ---------------------------------------------------------------- the tools-first system prompt

/** Fixed text (same every run, so the cache holds). Tested at <= 250 tokens together with the working-method text. */
export const TOOLS_FIRST_PROMPT =
  "Workflow tools: fix, edit_file, add, explain, test, doc, review, commit, plan, build, research. Code request: one line, " +
  "then the matching tool as first call (no todo, no read). Tool phases = its plan. Raw tools only if no tool fits or " +
  "STATUS not done. After a tool: tell the result, pick next step. Many-file change (README, build, commit): ask user " +
  "first. STATUS done: report, stop; no redo. Find paths and code yourself; never ask user. 'tinyCode hint' line = likely tool.";

/**
 * The tools-first text for the declared workflow tools (config `intercept`). All 11: TOOLS_FIRST_PROMPT, unchanged.
 * None: "" (no line). Some: the same rules, naming only those tools; the many-file line only when doc, build or commit is one.
 */
export function toolsFirstPrompt(tools: readonly string[]): string {
  const mine = WORKFLOW_TOOLS.filter((t) => tools.includes(t));
  if (mine.length === WORKFLOW_TOOLS.length) return TOOLS_FIRST_PROMPT;
  if (!mine.length) return "";
  const many = mine.filter((t) => t === "doc" || t === "build" || t === "commit");
  return (
    `Workflow tools: ${mine.join(", ")}. Request fits one: one line, then that tool as first call (no todo, no read). ` +
    "Tool phases = its plan. Raw tools only if no tool fits or STATUS not done. After a tool: tell the result, pick next step. " +
    (many.length ? `Many-file change (${many.map((t) => (t === "doc" ? "README" : t)).join(", ")}): ask user first. ` : "") +
    "STATUS done: report, stop; no redo. Find paths and code yourself; never ask user. 'tinyCode hint' line = likely tool."
  );
}

/** The terse-reply line (fixed text per config): short prose saves output tokens, which cost the most time. */
export const tersePrompt = (scriptLines: number): string =>
  `Reply short. Max one line before a tool call. No recap. Debug script over ${scriptLines} lines: write a file, run it. Paths: relative to cwd.`;

// ---------------------------------------------------------------- the hint (the code router, no model call)

/**
 * The router's whole judgement as one tail line, always (the model still decides and narrates). Decided by code
 * (confident): "use `fix` (file: X)." Decided by the small-model call, or a change with no file named:
 * "maybe `fix` (X)." Nothing fits (a question, chat, unsure): "question; answer, no tool."
 */
/** True when the model should plan with todo: no tinyCode tool fits and the request is not a question. */
export function todoFirst(r: Route & { source?: "code" | "model" }): boolean {
  if (hintFor(r).tool) return false;
  return !(r.workflow === "ask" || (r.workflow === "none" && r.confident));
}

/**
 * The `intercept` name a routing answer falls under: its workflow tool (`edit` with no one file is still `edit_file`),
 * or `ask` for a general question and for anything no workflow fits (the "question; answer, no tool." hint).
 */
export function interceptKey(r: Route): string {
  const wf = actionable(r);
  if (wf === "ask") return "ask";
  if (wf) return TOOL_FOR[wf] ?? "ask";
  return r.workflow === "edit" ? "edit_file" : "ask";
}
/** True when tinyCode takes this routing answer over (hint, direct run): its workflow is in `intercept`. */
export const intercepts = (intercept: readonly string[], r: Route): boolean => intercept.includes(interceptKey(r));

/**
 * What the router adds to a request: the tail hint and whether the empty-todo nudge may fire. A workflow tinyCode does
 * not intercept is "no workflow": no hint line, no nudge (the request reaches Pi as plain Pi sees it).
 */
export function triage(r: Route & { source?: "code" | "model" }, intercept: readonly string[]): { hint: { tool: string | null; line: string } | null; nudgeTodo: boolean } {
  if (!intercepts(intercept, r)) return { hint: null, nudgeTodo: false };
  return { hint: hintFor(r), nudgeTodo: todoFirst(r) };
}

export function hintFor(r: Route & { source?: "code" | "model" }): { tool: string | null; line: string } {
  const wf = actionable(r);
  // a change with no one file (rename everywhere, a new format wired into several files): edit_file is one file only
  if (r.workflow === "edit" && !r.file) return { tool: null, line: "tinyCode hint: change spans files; use read/edit, no tinyCode tool." };
  const tool = wf ? TOOL_FOR[wf] : null;
  if (!tool) return { tool: null, line: "tinyCode hint: question; answer, no tool." };
  if (r.source === "model" || !wf) return { tool, line: `tinyCode hint: maybe \`${tool}\`${r.file ? ` (${r.file})` : ""}.` };
  return { tool, line: `tinyCode hint: use \`${tool}\`${r.file ? ` (file: ${r.file})` : ""}.` };
}

// ---------------------------------------------------------------- the tool diet

/** The tools of Pi's own loop. Once a request is in raw-tool work these are the only ones declared to the model (plus `restore_best` when a best tree exists). */
export const LOOP_TOOLS = ["read", "edit", "write", "bash", "find", "run_tests", "todo"] as const;
/** The raw tools whose first use in a request means the model is doing the work itself. */
const RAW_WORK_TOOLS = new Set(["edit", "write", "bash"]);

/**
 * True when this event puts the request into raw-tool work: a workflow tool returned without STATUS done (partial or
 * failed: the model carries on by hand), or the model's own edit, write or bash call.
 */
export function entersRawWork(e: { call: string } | { tool: string; text: string }): boolean {
  if ("call" in e) return RAW_WORK_TOOLS.has(e.call);
  return isWorkflowTool(e.tool) && !e.text.includes("STATUS: done");
}

/** Per-request tool diet state: on from the first raw-work event of a request until the next user message. */
export class ToolDiet {
  on = false;

  /** True the first time a request enters raw work (the tool set must change), false when it already has. */
  enter(): boolean {
    if (this.on) return false;
    this.on = true;
    return true;
  }

  /** True when a diet was on (the tool set must change back). */
  leave(): boolean {
    const was = this.on;
    this.on = false;
    return was;
  }
}

/**
 * The tools to declare to the model: the baseline (what Pi had active, without `restore_best`), cut to the loop tools
 * in a diet, plus `restore_best` once a best tree exists. The order of the baseline is kept, so a repeated call with the
 * same arguments gives the same list.
 */
export function toolSet(baseline: string[], o: { diet: boolean; best: boolean }): string[] {
  const loop = LOOP_TOOLS as readonly string[];
  const base = baseline.filter((n) => n !== RESTORE_TOOL && (!o.diet || loop.includes(n)));
  return o.best ? [...base, RESTORE_TOOL] : base;
}

// ---------------------------------------------------------------- the tools-first nudge (rule 14: a nudge, never a block)

export interface ToolsFirstRecord {
  ts: string;
  request: string;
  hint: string | null;
  first: string | null;
  /** yes: the first action was not a raw read/bash/edit/write; no: it was; none: the run made no tool call */
  tools_first: "yes" | "no" | "none";
  nudged: boolean;
  /** what the hint cost: who decided (code or the small-lane call), its tokens and milliseconds */
  hint_source: string | null;
  hint_tokens: number;
  hint_ms: number;
}

/** Per-request state: the hint the model was given, its first tool call, and the one nudge. */
export class ToolsFirst {
  private request = "";
  private hint: string | null = null;
  private first: string | null = null;
  private nudged = false;
  private active = false;
  private fresh = false;
  private cost: { source?: string; tokens?: number; ms?: number } = {};
  private reported = false;

  /** A new user request (`hint` = the tool the code router named, or null). */
  start(request: string, hint: string | null, cost: { source?: string; tokens?: number; ms?: number } = {}): void {
    this.cost = cost;
    this.request = request;
    this.hint = hint;
    this.first = null;
    this.nudged = false;
    this.active = true;
    this.fresh = false;
    this.reported = false;
  }

  /** Every tool call. Returns the one tail line to add when the first action is a raw tool while the hint names a tool. */
  onCall(name: string): string | null {
    if (!this.active || this.first !== null) return null;
    this.first = name;
    this.fresh = true;
    if (this.hint && RAW_TOOLS.has(name)) {
      this.nudged = true;
      return `use \`${this.hint}\` first: cheaper, checked`;
    }
    return null;
  }

  /** The record, once, right after the call that set `first` (so a run cut short after its first call is still logged). */
  takeFirst(): ToolsFirstRecord | null {
    if (!this.fresh) return null;
    this.fresh = false;
    this.reported = true;
    return this.snapshot();
  }

  private snapshot(): ToolsFirstRecord {
    return {
      ts: new Date().toISOString(),
      request: this.request.replace(/\s+/g, " ").slice(0, 160),
      hint: this.hint,
      first: this.first,
      tools_first: this.first === null ? "none" : RAW_TOOLS.has(this.first) ? "no" : "yes",
      nudged: this.nudged,
      hint_source: this.cost.source ?? null,
      hint_tokens: this.cost.tokens ?? 0,
      hint_ms: this.cost.ms ?? 0,
    };
  }

  /** The request's record at the end of the run (null when no request was started). */
  finish(): ToolsFirstRecord | null {
    if (!this.active) return null;
    this.active = false;
    return this.reported ? null : this.snapshot();
  }
}
