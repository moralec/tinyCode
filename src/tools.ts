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
  if (o.ok && !o.remaining) return "STATUS: done \u2014 the request is complete; report the result to the user in plain words and stop";
  if (o.ok) return `STATUS: partial \u2014 ${o.remaining}`;
  const why = (o.reason ?? o.text.trim().split("\n")[0] ?? "").slice(0, 160) || "the tool could not finish";
  return `STATUS: failed \u2014 ${why}; you may continue with raw tools`;
}

/** The tool result shape: one text part (never raw work) ending with the STATUS line, details for the UI. */
export function toolResult(o: ToolOutcome): { content: { type: "text"; text: string }[]; details: { ok: boolean } } {
  return { content: [{ type: "text", text: `${compact(o.text)}\n${statusLine(o)}` }], details: { ok: o.ok } };
}

/** The required first field of every tool: the model's own one-sentence narration, shown in the chat when the tool starts. */
export const INTENT_DESCRIPTION = "one sentence: what you're about to do and why";
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
  { name: "fix", label: "Fix", description: "Fix a bug or failing test: edits code, runs tests, retries.", parameters: Type.Object({ intent: INTENT(), task: S() }) },
  { name: "edit_file", label: "Edit file", description: "Change one file as asked (rename, refactor, small change).", parameters: Type.Object({ intent: INTENT(), path: S(), instruction: S() }) },
  { name: "add", label: "Add", description: "Add new code (function, option, endpoint) with a test.", parameters: Type.Object({ intent: INTENT(), task: S(), file: O() }) },
  { name: "explain", label: "Explain", description: "Explain a function or file, cited. No edits.", parameters: Type.Object({ intent: INTENT(), question: S(), file: O() }) },
  { name: "test", label: "Write tests", description: "Write tests for a function or file, then run them.", parameters: Type.Object({ intent: INTENT(), what: S(), file: O() }) },
  { name: "doc", label: "Doc", description: "Docstrings or comments for a file; or update the README from the code.", parameters: Type.Object({ intent: INTENT(), request: S(), file: O() }) },
  { name: "review", label: "Review", description: "Review the uncommitted changes for problems.", parameters: Type.Object({ intent: INTENT(), path: O() }) },
  { name: "commit", label: "Commit", description: "Commit the changes with a written message.", parameters: Type.Object({ intent: INTENT(), hint: O() }) },
  { name: "plan", label: "Plan", description: "Turn a request for a new app or feature into a task list.", parameters: Type.Object({ intent: INTENT(), request: S() }) },
  { name: "build", label: "Build", description: "Build the planned tasks one by one.", parameters: Type.Object({ intent: INTENT(), task: Type.Optional(Type.Integer()) }) },
  { name: "research", label: "Research", description: "Find libraries or prior art on GitHub and the web; cited answer.", parameters: Type.Object({ intent: INTENT(), question: S() }) },
];

/** The 11 workflow tools. `run` does the work; a throw becomes a "failed" result (the model decides what next). */
export function workflowTools(run: ToolRunner, show?: (text: string, ctx: ExtensionContext) => void) {
  return SPECS.map((s) =>
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

export function registerWorkflowTools(pi: ExtensionAPI, run: ToolRunner): void {
  const show = (text: string, ctx: ExtensionContext): void => {
    // the model's own words, posted as an assistant-style message (no UI: plain stdout, like the end summary)
    if (ctx.hasUI) pi.sendMessage({ customType: CUSTOM_SAY, content: text, display: true });
    else process.stdout.write(text + "\n");
  };
  pi.registerMessageRenderer(CUSTOM_SAY, (m) => new Text(typeof m.content === "string" ? m.content : "", 1, 0));
  for (const t of workflowTools(run, show)) pi.registerTool(t);
}

// ---------------------------------------------------------------- the tools-first system prompt

/** Fixed text (same every run, so the cache holds). Tested at <= 250 tokens together with the working-method text. */
export const TOOLS_FIRST_PROMPT =
  "You have tinyCode tools: fix, edit_file, add, explain, test, doc, review, commit, plan, build, research. For any " +
  "request about code, first say in one sentence what you will do, then call the matching tool as your first " +
  "call (not todo, not read). A tool's phases are its plan: no todo for it. Use raw tools " +
  "only when no tool fits or one could not finish. After each tool, tell the user " +
  "what it reported in plain words and decide the next step. Ask the user before " +
  "changes that touch many files (README, builds, commits). When a tool returns STATUS: done, report and stop; don't redo the work with raw tools. You can always read this project with your tools; never ask the user for code or paths you can find yourself. A line starting 'tinyCode hint' names the likely tool.";

// ---------------------------------------------------------------- the hint (the code router, no model call)

/**
 * The router's whole judgement as one tail line, always (the model still decides and narrates). Decided by code
 * (confident): "Use `fix` for this (file: X)." Decided by the small-model call, or a change with no file named:
 * "This looks like `fix` (X)." Nothing fits (a question, chat, unsure): "This is a question; answer it directly, no tool needed."
 */
/** True when the model should plan with todo: no tinyCode tool fits and the request is not a question. */
export function todoFirst(r: Route & { source?: "code" | "model" }): boolean {
  if (hintFor(r).tool) return false;
  return !(r.workflow === "ask" || (r.workflow === "none" && r.confident));
}

export function hintFor(r: Route & { source?: "code" | "model" }): { tool: string | null; line: string } {
  const wf = actionable(r);
  const tool = wf ? TOOL_FOR[wf] : r.workflow === "edit" ? "edit_file" : null;
  if (!tool) return { tool: null, line: "tinyCode hint: This is a question; answer it directly, no tool needed." };
  if (r.source === "model" || !wf) return { tool, line: `tinyCode hint: This looks like \`${tool}\`${r.file ? ` (${r.file})` : ""}.` };
  return { tool, line: `tinyCode hint: Use \`${tool}\` for this${r.file ? ` (file: ${r.file})` : ""}.` };
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
      return `try \`${this.hint}\` first; it is cheaper and checked`;
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
