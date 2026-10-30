// Adaptive orchestration: "code decides, the model speaks". Pure TypeScript, no Pi import (index.ts wires it).
//
// Choosing a workflow is classification, and the code router does it better than the 12B model (22/25 against 15/25 on
// our benchmark). The model is good at talking, reporting and deciding what comes next. So, when the
// router is confident, tinyCode runs the workflow itself and the model speaks around it:
//   before: one fixed sentence per workflow, from code (no model call);
//   run:    the workflow, with its normal progress (status line, checklist, heartbeat);
//   after:  the result (ending with its STATUS line) goes to the model as a tool's output, and the model reports in plain
//           words and decides the next step (retry, raw tools, ask the user, stop).
// Modes (config `orchestration`): code = router has a workflow -> direct; model = the model chooses with tools and the
// hint (S19); auto = confident -> direct, unsure / question / chat -> the model, unless the model has earned the choice
// (agreement rule below, `orchestration.learn`).
//
// Agreement rule: when the model chooses, its first tool call is compared with the router's code-decided answer and one
// line is appended to orchestration.jsonl. A model whose last `window` (50) such decisions match the router at least
// `minAgreement` (90 %) of the time, with at least `minDecisions` (20) of them, is handed every case in `auto`: it keeps
// choosing, and the log keeps growing, so a model that slips falls back to direct runs by itself.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.ts";
import { logPath } from "./log.ts";
import { CUSTOM_BEAT } from "./progress.ts";
import { actionable, type Route } from "./router.ts";
import { CUSTOM_SAY, interceptKey, intercepts, isWorkflowTool, TOOL_FOR, toolResult, type ToolOutcome, type WorkflowTool } from "./tools.ts";

type Env = Record<string, string | undefined>;
export type Orch = Config["orchestration"];
export type RoutedLike = Route & { source?: "code" | "model" };

export const CUSTOM_RESULT = "tinycode-result";
export const CUSTOM_SAY_DIRECT = CUSTOM_SAY;


// ---------------------------------------------------------------- what the router's answer means as a tool call

export interface DirectCall {
  tool: WorkflowTool;
  params: Record<string, string>;
}

/** The workflow tool and parameters for a routing answer; null for a question, chat or an `edit` with no file. */
export function directCall(r: Route): DirectCall | null {
  const wf = actionable(r);
  if (!wf) return null;
  const tool = TOOL_FOR[wf];
  if (!tool || !isWorkflowTool(tool)) return null;
  const goal = r.goal.trim();
  const file: Record<string, string> = r.file ? { file: r.file } : {};
  switch (tool as WorkflowTool) {
    case "fix": return { tool: "fix", params: { task: goal, ...(r.test ? { test: r.test } : {}) } };
    case "edit_file": return r.file ? { tool: "edit_file", params: { path: r.file, instruction: goal } } : null;
    case "add": return { tool: "add", params: { task: goal, ...file } };
    case "explain": return { tool: "explain", params: { question: goal, ...file } };
    case "test": return { tool: "test", params: { what: goal, ...file } };
    case "doc": return { tool: "doc", params: { request: goal, ...file } };
    case "review": return { tool: "review", params: r.file ? { path: r.file } : {} };
    case "plan": return { tool: "plan", params: { request: goal } };
    case "research": return { tool: "research", params: { question: goal } };
    default: return null;
  }
}

// ---------------------------------------------------------------- agreement log

export interface DecisionRecord {
  ts: string;
  model: string;
  request: string;
  /** the router's tool (null = question / chat / nothing fits) */
  router: string | null;
  /** the model's first workflow tool (null = it answered or used raw tools) */
  chose: string | null;
  match: boolean;
}
export function decisionsPath(env: Env = process.env): string {
  return join(dirname(logPath(env)), "orchestration.jsonl");
}
export function logDecision(rec: DecisionRecord, env: Env = process.env): void {
  try {
    const p = decisionsPath(env);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify({ kind: "decision", ...rec }) + "\n");
  } catch {
    // a log must never break a run
  }
}
export function logDirect(rec: Record<string, unknown>, env: Env = process.env): void {
  try {
    const p = decisionsPath(env);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify({ kind: "direct", ts: new Date().toISOString(), ...rec }) + "\n");
  } catch {
    // ignore
  }
}
export function readLog(env: Env = process.env): Record<string, unknown>[] {
  let text: string;
  try {
    text = readFileSync(decisionsPath(env), "utf8");
  } catch {
    return [];
  }
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // torn line
    }
  }
  return out;
}
export const readDecisions = (env: Env = process.env): DecisionRecord[] => readLog(env).filter((r) => r.kind === "decision") as unknown as DecisionRecord[];

/** The record of one request: the router's tool against the model's first call (a raw tool or no call = no workflow chosen). */
export function agreement(model: string, request: string, routerTool: string | null, firstCall: string | null): DecisionRecord {
  const chose = firstCall && isWorkflowTool(firstCall) ? firstCall : null;
  return { ts: new Date().toISOString(), model, request: request.replace(/\s+/g, " ").slice(0, 160), router: routerTool, chose, match: chose === routerTool };
}

export interface Rate {
  n: number;
  matched: number;
  /** 0..1, or 0 with n = 0 */
  rate: number;
  /** meets minDecisions and minAgreement */
  trusted: boolean;
}
/** The model's agreement over its last `window` logged decisions. */
export function rateFor(o: Orch, model: string, decisions: DecisionRecord[]): Rate {
  const mine = decisions.filter((d) => d.model === model).slice(-o.window);
  const matched = mine.filter((d) => d.match).length;
  const rate = mine.length ? matched / mine.length : 0;
  return { n: mine.length, matched, rate, trusted: mine.length >= o.minDecisions && rate >= o.minAgreement };
}

// ---------------------------------------------------------------- who runs it

export interface Choice {
  /** tinyCode runs the workflow itself */
  direct: DirectCall | null;
  why: string;
}
/**
 * code: any workflow the router has -> direct. model: never. auto: only a confident code-decided answer; a small-lane
 * (unsure) answer, a question or chat goes to the model, and so does everything when the model has earned the choice.
 * `intercept` (config): a workflow not in it is never run directly (absent = every workflow, today's behaviour).
 */
export function choose(o: Orch, r: RoutedLike, rate: Rate | null, intercept?: readonly string[]): Choice {
  if (o.mode === "model") return { direct: null, why: "orchestration model" };
  if (intercept && !intercepts(intercept, r)) return { direct: null, why: `not intercepted (${interceptKey(r)}): plain Pi` };
  const call = directCall(r);
  if (!call) return { direct: null, why: "no workflow fits (question, chat or unclear)" };
  if (o.mode === "code") return { direct: call, why: "orchestration code" };
  if (r.source === "model") return { direct: null, why: "router unsure (small-lane decision)" };
  if (o.learn && rate?.trusted) return { direct: null, why: `model agrees with the router ${Math.round(rate.rate * 100)} % over ${rate.n} decisions` };
  return { direct: call, why: "router confident" };
}

// ---------------------------------------------------------------- the sentence before

const SENTENCE: Record<string, string> = {
  fix: "Fixing the bug",
  edit_file: "Making the change",
  add: "Adding the code",
  explain: "Reading the code",
  test: "Writing tests",
  doc: "Writing docs",
  review: "Reviewing changes",
  plan: "Making the task list",
  research: "Searching prior art",
};
/** The fixed sentence shown before a direct run (from code, no model call): "Fixing the bug in orders/report.py." */
export function sentenceFor(call: DirectCall): string {
  const file = call.params.file ?? call.params.path;
  return `${SENTENCE[call.tool] ?? call.tool}${file ? ` in ${file}` : ""}.`;
}

// ---------------------------------------------------------------- one direct run

export type Status = "done" | "partial" | "failed";
export const statusOf = (o: ToolOutcome): Status => (o.ok ? (o.remaining ? "partial" : "done") : "failed");

export interface DirectResult {
  call: DirectCall;
  said: string;
  outcome: ToolOutcome;
  status: Status;
  /** the compact result ending with its STATUS line: exactly what a tool call would have returned */
  text: string;
  id: string;
}
export interface DirectDeps {
  /** shows the sentence as the assistant's message */
  show: (sentence: string) => void;
  run: (call: DirectCall) => Promise<ToolOutcome>;
  /** called before a run of a workflow that changes files; the function it returns says what the request names that the run left alone ("" = nothing) */
  scope?: () => () => string;
}
/** The fixed sentence, then the run. A throw in the run becomes a failed result (the model decides what next). */
export async function runDirect(deps: DirectDeps, call: DirectCall): Promise<DirectResult> {
  const said = sentenceFor(call);
  try {
    deps.show(said);
  } catch {
    // narration is a courtesy
  }
  let left: (() => string) | undefined;
  try {
    left = scoped(call) ? deps.scope?.() : undefined;
  } catch {
    left = undefined;
  }
  let outcome: ToolOutcome;
  try {
    outcome = await deps.run(call);
  } catch (e) {
    outcome = { text: `${call.tool} failed: ${(e as Error).message}`, ok: false };
  }
  // "done" only when the run covered what the request names: else partial, and Pi's loop finishes it
  if (left && outcome.ok && !outcome.remaining) {
    let rest = "";
    try {
      rest = left();
    } catch {
      rest = "";
    }
    if (rest) outcome = { ...outcome, remaining: `${rest}; check, finish with read/edit` };
  }
  return { call, said, outcome, status: statusOf(outcome), text: toolResult(outcome).content[0]!.text, id: `tc_direct_${Date.now().toString(36)}` };
}

// ---------------------------------------------------------------- what the request names that the run left alone

/** Workflows that change the files a request names. A README run's named code files are its sources, not targets. */
const SCOPED = new Set<string>(["edit_file", "add", "doc"]);
const scoped = (call: DirectCall): boolean => SCOPED.has(call.tool) && !/\.(?:md|rst|txt)$/i.test(call.params.file ?? call.params.path ?? "");
// "app/server.py must keep working unchanged", "leave X alone": named, but not to change
const KEEP = /\b(?:unchanged|alone|as is|untouched|(?:do not|don'?t|never) (?:change|touch|edit))\b/i;
const PATH_WORD = /(?<![\w/.-])[\w/-]+(?:\.[\w-]+)+/g;
const TICKED_NAME = /`([A-Za-z_]\w*)(?:\([^`]*\))?`/g;
const SCAN_CAP = 2000;
const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const defines = (src: string, name: string) => new RegExp(`^\\s*(?:async\\s+)?(?:def|class)\\s+${escRe(name)}\\b|^${escRe(name)}\\s*[:=](?!=)`, "m").test(src);
const uses = (src: string, name: string) => new RegExp(`(?<![\\w.])${escRe(name)}\\b`).test(src);

/** Repo files the request names (path, file name, dotted module `exporter.cli`), minus one it says to leave alone. */
export function namedFiles(request: string, files: string[]): string[] {
  const out: string[] = [];
  for (const sentence of request.split(/[.!?;:](?:\s+|$)|\n+/)) {
    if (KEEP.test(sentence)) continue;
    for (const m of sentence.matchAll(PATH_WORD)) {
      const w = m[0];
      const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
      const byName = files.filter((f) => base(f) === w);
      const mod = w.replace(/\./g, "/");
      const hit = files.find((f) => f === w) ?? (byName.length === 1 ? byName[0] : undefined) ?? files.find((f) => f === `${mod}.py` || f === `${mod}/__init__.py`);
      if (hit && !out.includes(hit)) out.push(hit);
    }
  }
  return out;
}

export interface ScopeBefore {
  /** named file -> its text before the run (null: missing) */
  files: Map<string, string | null>;
  /** `ticked` Python names the request gives that the repo defined before the run */
  names: string[];
}
/** The request's scope before a run: the named files' text and which of its `names` the repo defines. */
export function scopeBefore(request: string, files: string[], read: (p: string) => string | null): ScopeBefore {
  const named = new Map<string, string | null>();
  for (const f of namedFiles(request, files)) named.set(f, read(f));
  const ticked = [...new Set([...request.matchAll(TICKED_NAME)].map((m) => m[1]!))];
  const py = files.filter((f) => f.endsWith(".py")).slice(0, SCAN_CAP);
  const srcs = ticked.length ? py.map((f) => read(f) ?? "") : [];
  return { files: named, names: ticked.filter((n) => srcs.some((s) => defines(s, n))) };
}
/** What the run left alone: named files it did not change, and names it removed that untouched files still use. "" = nothing. */
export function scopeAfter(b: ScopeBefore, files: string[], read: (p: string) => string | null): string {
  const parts: string[] = [];
  const same = [...b.files].filter(([f, before]) => read(f) === before).map(([f]) => f);
  if (same.length) parts.push(`named, untouched: ${same.join(", ")}`);
  if (b.names.length) {
    const py = files.filter((f) => f.endsWith(".py")).slice(0, SCAN_CAP).map((f) => [f, read(f) ?? ""] as const);
    for (const n of b.names) {
      if (py.some(([, s]) => defines(s, n))) continue;
      const still = py.filter(([, s]) => uses(s, n)).map(([f]) => f);
      if (still.length) parts.push(`${n} gone, still used: ${still.slice(0, 5).join(", ")}${still.length > 5 ? ` +${still.length - 5}` : ""}`);
    }
  }
  return parts.join("; ");
}

/** Details carried on the custom message that starts the model's after-turn (the context hook turns it into a tool turn). */
export interface ResultDetails {
  id: string;
  tool: string;
  params: Record<string, string>;
  say: string;
  status: Status;
}
/** The custom message for `before_agent_start`: labelled as the tool's output, in case the context rewrite does not apply. */
export function resultMessage(d: DirectResult): { customType: string; content: string; display: boolean; details: ResultDetails } {
  return {
    customType: CUSTOM_RESULT,
    content: `[result of the ${d.call.tool} tool, run by tinyCode]\n${d.text}`,
    display: false,
    details: { id: d.id, tool: d.call.tool, params: d.call.params, say: d.said, status: d.status },
  };
}

// ---------------------------------------------------------------- the model sees a tool's output, not the user's words

interface Msg {
  role: string;
  [k: string]: unknown;
}
/**
 * `context` hook: the custom result message becomes an assistant turn (the sentence plus the tool call) followed by that
 * call's tool result, so the model reads the output as its own tool's, not as the user's words. The direct run's own
 * "say" message is dropped (its sentence is inside the assistant turn). Returns undefined when there is nothing to do.
 */
export function asToolTurn(messages: Msg[], model: { id: string; provider: string; api: string }): Msg[] | undefined {
  const isResult = (m: Msg) => m.role === "custom" && m.customType === CUSTOM_RESULT;
  const isDirectSay = (m: Msg) => m.role === "custom" && m.customType === CUSTOM_SAY_DIRECT && (m.details as { direct?: boolean } | undefined)?.direct === true;
  if (!messages.some((m) => isResult(m) || isDirectSay(m))) return undefined;
  const out: Msg[] = [];
  for (const m of messages) {
    if (isDirectSay(m)) continue;
    if (!isResult(m)) {
      out.push(m);
      continue;
    }
    const d = m.details as ResultDetails | undefined;
    if (!d) {
      out.push(m);
      continue;
    }
    const ts = typeof m.timestamp === "number" ? m.timestamp : Date.now();
    const body = typeof m.content === "string" ? m.content : "";
    const text = body.replace(/^\[result of[^\]]*\]\n/, "");
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
    out.push({
      role: "assistant",
      content: [{ type: "toolCall", id: d.id, name: d.tool, arguments: { intent: d.say, ...d.params } }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: zero,
      stopReason: "toolUse",
      timestamp: ts,
    });
    out.push({ role: "toolResult", toolCallId: d.id, toolName: d.tool, content: [{ type: "text", text }], isError: d.status === "failed", timestamp: ts });
  }
  return out;
}

/** Custom messages that are for the human only: heartbeats and stuck lines, and the sentence a tool call already carries as its `intent`. */
const DISPLAY_ONLY = new Set([CUSTOM_BEAT, CUSTOM_SAY]);
/** `context` hook: the messages without the display-only ones (run after `asToolTurn`, which folds a direct run's sentence into its tool turn). Same list when there is none. */
export function dropDisplayOnly<T extends Msg>(messages: T[]): T[] {
  return messages.some((m) => m.role === "custom" && DISPLAY_ONLY.has(String(m.customType))) ? messages.filter((m) => !(m.role === "custom" && DISPLAY_ONLY.has(String(m.customType)))) : messages;
}

// ---------------------------------------------------------------- no second run of a finished workflow

/** A tool call's target: its file or path parameter ("" when it names none). */
export const targetOf = (params: unknown): string => {
  const p = (params ?? {}) as Record<string, unknown>;
  const v = p.file ?? p.path;
  return typeof v === "string" ? v.trim().replace(/^\.\//, "") : "";
};
/** A request's direct runs: the same workflow on the same target is not run again unless its STATUS was failed or partial. */
export class DoneGuard {
  private done = new Set<string>();
  reset(): void {
    this.done.clear();
  }
  record(tool: string, status: Status, target = ""): void {
    if (status === "done") this.done.add(`${tool}\0${target}`);
  }
  /** The refusal text (read by the model, never an abort), or null when the call may run (another tool or another target). */
  check(tool: string, target = ""): string | null {
    return this.done.has(`${tool}\0${target}`) ? `${tool}${target ? ` ${target}` : ""} STATUS: done already. Report, no rerun.` : null;
  }
}

// ---------------------------------------------------------------- /tinycode stats

export function formatOrchestration(cfg: Config, log: Record<string, unknown>[]): string {
  const o = cfg.orchestration;
  const head = `Orchestration (mode ${o.mode}${o.mode === "auto" ? `, learn ${o.learn ? "on" : "off"}` : ""})`;
  const decisions = log.filter((r) => r.kind === "decision") as unknown as DecisionRecord[];
  const direct = log.filter((r) => r.kind === "direct");
  const rows: string[] = [`direct runs: ${direct.length}${direct.length ? ` (${["done", "partial", "failed"].map((s) => `${direct.filter((r) => r.status === s).length} ${s}`).join(", ")})` : ""}`];
  const models = [...new Set(decisions.map((d) => d.model))].sort();
  if (!models.length) rows.push("no model decisions logged yet");
  for (const m of models) {
    const r = rateFor(o, m, decisions);
    const state = r.trusted ? (o.mode === "auto" && o.learn ? "trusted: gets every case" : "trusted") : `learning (needs ${o.minDecisions} decisions at ${Math.round(o.minAgreement * 100)} %)`;
    rows.push(`${m}: agrees with the router ${Math.round(r.rate * 100)} % (${r.matched}/${r.n}) → ${state}`);
  }
  return [head, ...rows].join("\n");
}
