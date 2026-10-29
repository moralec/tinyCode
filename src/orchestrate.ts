// Adaptive orchestration: "code decides, the model speaks". Pure TypeScript, no Pi import (index.ts wires it).
//
// Choosing a workflow is classification, and the code router does it better than the 12B model (22/25 against 15/25 on
// our benchmark). The model is good at talking, reporting and deciding what comes next. So, when the
// router is confident, tinyCode runs the workflow itself and the model speaks around it:
//   before: one short call on the trunk lane (step "say"): the request, the workflow and the file -> one sentence;
//           a template sentence when that call fails;
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
import type { Message } from "./llm.ts";
import { logPath } from "./log.ts";
import { actionable, type Route } from "./router.ts";
import type { ChatFn } from "./workflows/fix.ts";
import { CUSTOM_SAY, isWorkflowTool, TOOL_FOR, toolResult, type ToolOutcome, type WorkflowTool } from "./tools.ts";

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
    case "fix": return { tool: "fix", params: { task: goal } };
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
 */
export function choose(o: Orch, r: RoutedLike, rate: Rate | null): Choice {
  if (o.mode === "model") return { direct: null, why: "orchestration model" };
  const call = directCall(r);
  if (!call) return { direct: null, why: "no workflow fits (question, chat or unclear)" };
  if (o.mode === "code") return { direct: call, why: "orchestration code" };
  if (r.source === "model") return { direct: null, why: "router unsure (small-lane decision)" };
  if (o.learn && rate?.trusted) return { direct: null, why: `model agrees with the router ${Math.round(rate.rate * 100)} % over ${rate.n} decisions` };
  return { direct: call, why: "router confident" };
}

// ---------------------------------------------------------------- the sentence before

export const SAY_SYSTEM = "You are a coding assistant. Tell the user in one short sentence, in plain words, what you are about to do. No preamble, no code, no questions.";
const VERB: Record<string, string> = {
  fix: "fix the bug",
  edit_file: "make the change",
  add: "add the new code",
  explain: "read and explain the code",
  test: "write the tests",
  doc: "write the documentation",
  review: "review the changes",
  plan: "turn the request into a task list",
  research: "look for libraries and prior art",
};
/** The sentence when the model call fails: "I'll fix the bug in orders/report.py." */
export function templateSentence(call: DirectCall): string {
  const file = call.params.file ?? call.params.path;
  return `I'll ${VERB[call.tool] ?? call.tool}${file ? ` in ${file}` : ""}.`;
}
export interface Said {
  text: string;
  source: "model" | "template";
  tokens: number;
  ms: number;
}
/** Constant system prefix first (cache-friendly), the request last; max_tokens comes from limits.maxTokens.say (60). */
export async function beforeSentence(chat: ChatFn, request: string, call: DirectCall): Promise<Said> {
  const file = call.params.file ?? call.params.path;
  const messages: Message[] = [
    { role: "system", content: SAY_SYSTEM },
    { role: "user", content: `Workflow: ${call.tool}${file ? `\nFile: ${file}` : ""}\nRequest: ${request.replace(/\s+/g, " ").slice(0, 400)}` },
  ];
  const t0 = Date.now();
  try {
    const res = await chat("say", messages, { workflow: "say" });
    const line = (res.text.split("\n").map((l) => l.trim()).find(Boolean) ?? "").replace(/^["'`]+|["'`]+$/g, "").trim();
    if (line.length >= 8) return { text: line.slice(0, 240), source: "model", tokens: res.usage.prompt_tokens + res.usage.completion_tokens, ms: res.ms };
  } catch {
    // fall through to the template
  }
  return { text: templateSentence(call), source: "template", tokens: 0, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------- one direct run

export type Status = "done" | "partial" | "failed";
export const statusOf = (o: ToolOutcome): Status => (o.ok ? (o.remaining ? "partial" : "done") : "failed");

export interface DirectResult {
  call: DirectCall;
  said: Said;
  outcome: ToolOutcome;
  status: Status;
  /** the compact result ending with its STATUS line: exactly what a tool call would have returned */
  text: string;
  id: string;
}
export interface DirectDeps {
  chat: ChatFn;
  /** shows the sentence as the assistant's message */
  show: (sentence: string) => void;
  run: (call: DirectCall) => Promise<ToolOutcome>;
}
/** before-sentence, then the run. A throw in the run becomes a failed result (the model decides what next). */
export async function runDirect(deps: DirectDeps, request: string, call: DirectCall): Promise<DirectResult> {
  const said = await beforeSentence(deps.chat, request, call);
  try {
    deps.show(said.text);
  } catch {
    // narration is a courtesy
  }
  let outcome: ToolOutcome;
  try {
    outcome = await deps.run(call);
  } catch (e) {
    outcome = { text: `${call.tool} failed: ${(e as Error).message}`, ok: false };
  }
  return { call, said, outcome, status: statusOf(outcome), text: toolResult(outcome).content[0]!.text, id: `tc_direct_${Date.now().toString(36)}` };
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
    content: `[result of the ${d.call.tool} tool, run by tinyCode for the request above]\n${d.text}`,
    display: false,
    details: { id: d.id, tool: d.call.tool, params: d.call.params, say: d.said.text, status: d.status },
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
      content: [
        { type: "text", text: d.say },
        { type: "toolCall", id: d.id, name: d.tool, arguments: { intent: d.say, ...d.params } },
      ],
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

// ---------------------------------------------------------------- no second run of a finished workflow

/** A request's direct runs: the same workflow is not run again unless its STATUS was failed or partial. */
export class DoneGuard {
  private done = new Set<string>();
  reset(): void {
    this.done.clear();
  }
  record(tool: string, status: Status): void {
    if (status === "done") this.done.add(tool);
  }
  /** The refusal text (read by the model, never an abort), or null when the call may run. */
  check(tool: string): string | null {
    return this.done.has(tool) ? `${tool} already finished (STATUS: done) for this request. Report its result to the user instead of running it again.` : null;
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
