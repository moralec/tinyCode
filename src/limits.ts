// Limits for Pi's own loop (rung 3 and plain chat): the guards that turn a small model's identical-call loops into
// early stops. Pure TypeScript with no Pi import, so every rule is unit-tested without Pi; extensions/tinycode/index.ts
// wires these to Pi's events.
//
// Borrowed from little-coder (Apache-2.0, its extension set): the repeated-call detection of
// `quality-monitor` (but stopping, not nudging), the turn cap of `turn-cap`, the always-on view cap of `read-guard`
// (stricter), and the "keep the newest N, replace older ones with placeholders" pattern of `browser-extract-retention`
// (here in batches). The code is ours.
//
// S4b adds working memory for the loop (todo + notes recited at the tail, read memory, oversized-edit refusal). The
// recitation idea is Manus's; the "keep the prefix stable, put per-turn state at the tail" rule is PX section 4;
// little-coder's `write-guard`/`read-guard` pair (Apache-2.0) is the model for the read and edit guards.
//
// Operator rule (2026-10-29): tinyCode never terminates or aborts a run. Guards nudge; after `stepBackAt`
// interventions in a run, or a repeat that continues after its nudge, tinyCode STEPS BACK: it stops masking, view and
// result caps, re-read refusals and oversized-edit refusals for the rest of that run, and Pi works as it would
// without tinyCode. The todo tail and the prompt section stay (they only add).
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.ts";
import { logCall, logPath } from "./log.ts";

type Limit = Config["limits"];
type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------- repeat guard

export const REPEAT_NUDGE = "[same call 3 times; change approach or update todo]";
export const BUDGET_REASON = "Call budget used up. Final answer now, no more tool calls.";

/** Stable JSON: object keys sorted, so `{a,b}` and `{b,a}` are the same call. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** A tool call is served (`allow`) or refused with a reason the model reads (`block`). tinyCode never terminates. */
export type Verdict = { action: "allow"; whole?: true } | { action: "block"; reason: string };

/** What the repeat guard saw: nothing, a third identical call (nudge once), or a repeat that goes on after the nudge. */
export type RepeatSignal = "ok" | "nudge" | "continues";

const WINDOW = 6;
const MUTATING = new Set(["edit", "write"]);

export class RepeatGuard {
  private history: { name: string; key: string }[] = [];
  private nudged = new Set<string>();
  private blockAt: number;
  constructor(blockAt = 2) {
    this.blockAt = blockAt;
  }

  reset(): void {
    this.history = [];
    this.nudged.clear();
  }

  /**
   * Report a finished call. A successful `edit`/`write` changed the file, so the same call again is no longer
   * "the same call whose result will not change": its key is forgotten. A failed edit (the recorded loops are all
   * "Could not find the exact text") stays in the history.
   */
  result(name: string, input: unknown, isError: boolean): void {
    if (isError || !MUTATING.has(name)) return;
    const key = canonicalJson(input);
    this.history = this.history.filter((h) => !(h.name === name && h.key === key));
    this.nudged.delete(name + key);
  }

  /**
   * Never blocks. The call that makes `blockAt + 1` identical calls in the last six (this one included; with the
   * default 2, the third) returns "nudge" once per key; a repeat after that nudge returns "continues" (the caller
   * steps back). An allowed `edit`/`write` changes the files, so earlier non-edit calls (a test run, a read) are
   * forgotten: running the tests again after a real edit is not a repeat.
   */
  check(name: string, input: unknown): RepeatSignal {
    const key = canonicalJson(input);
    const same = this.history.slice(-(WINDOW - 1)).filter((h) => h.name === name && h.key === key).length + 1;
    this.history.push({ name, key });
    if (this.history.length > WINDOW) this.history.shift();
    if (same < this.blockAt + 1) {
      if (MUTATING.has(name)) this.history = this.history.filter((h) => MUTATING.has(h.name));
      return "ok";
    }
    if (this.nudged.has(name + key)) return "continues";
    this.nudged.add(name + key);
    return "nudge";
  }
}

// ---------------------------------------------------------------- view cap

/** `read` without a limit gets `viewLines`. Mutates and returns true when it changed the input. */
export function capView(toolName: string, input: Record<string, unknown>, viewLines: number): boolean {
  if (toolName !== "read" || !input || typeof input !== "object") return false;
  if (input.limit !== undefined && input.limit !== null) return false;
  input.limit = viewLines;
  return true;
}

/**
 * Pi's read notice for a window that stops early ("[16 more lines in file. Use offset=101 to continue.]", or the
 * "[Showing lines a-b of T. Use offset=X to continue.]" form) as one explicit line: "[lines 1-100 of 116; file continues:
 * read offset=101]". Returns null when the text has no such notice. A cut file must never read as a finished one.
 */
export function readCutMarker(text: string, input: { offset?: unknown }): string | null {
  const start = Math.max(1, Number(input?.offset ?? 1) || 1);
  const more = text.match(/\n*\[(\d+) more lines in file\. Use offset=(\d+) to continue\.\]\s*$/);
  if (more) {
    const next = Number(more[2]);
    return `${text.slice(0, more.index).replace(/\s+$/, "")}\n[lines ${start}-${next - 1} of ${next - 1 + Number(more[1])}; file continues: read offset=${next}]`;
  }
  const shown = text.match(/\n*\[Showing lines (\d+)-(\d+) of (\d+)[^\]]*Use offset=(\d+) to continue\.\]\s*$/);
  if (shown) return `${text.slice(0, shown.index).replace(/\s+$/, "")}\n[lines ${shown[1]}-${shown[2]} of ${shown[3]}; file continues: read offset=${shown[4]}]`;
  return null;
}

// ---------------------------------------------------------------- result cap

const CHARS_PER_TOKEN = 4;
export const approxTokens = (chars: number): number => Math.ceil(chars / CHARS_PER_TOKEN);

export function obsDir(session: string, env: Env = process.env): string {
  return join(dirname(logPath(env)), "obs", session);
}

/**
 * Text over `toolResultTokens * 4` characters becomes head + pointer + tail (about the cap in all) and the full
 * text goes to `<state>/obs/<session>/<n>.txt`. Returns null when the text is within the cap.
 */
export function capText(
  text: string,
  limits: Pick<Limit, "toolResultTokens">,
  save: (full: string) => string,
): string | null {
  const cap = limits.toolResultTokens * CHARS_PER_TOKEN;
  if (text.length <= cap) return null;
  const headLen = Math.floor(cap * 0.7);
  const tailLen = cap - headLen;
  const path = save(text);
  const cut = text.length - headLen - tailLen;
  return `${text.slice(0, headLen)}\n[... ${cut} chars cut; full output in ${path} ...]\n${text.slice(text.length - tailLen)}`;
}

/** Writes numbered observation files; never throws (a full disk must not break the run). */
export function obsSaver(session: string, env: Env = process.env): (full: string) => string {
  let n = 0;
  return (full) => {
    const path = join(obsDir(session, env), `${++n}.txt`);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, full);
    } catch {
      // keep the pointer anyway
    }
    return path;
  };
}

// ---------------------------------------------------------------- batched masking

interface TextPart {
  type: string;
  text?: string;
}
/** The slice of Pi's AgentMessage shape that masking needs; other fields pass through untouched. */
export interface Msg {
  role: string;
  toolCallId?: string;
  toolName?: string;
  content?: unknown;
  [k: string]: unknown;
}

function resultText(m: Msg): string {
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return (m.content as TextPart[]).map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("");
}

function callInputs(messages: Msg[]): Map<string, { name: string; args: unknown }> {
  const out = new Map<string, { name: string; args: unknown }>();
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    for (const p of m.content as { type: string; id?: string; name?: string; arguments?: unknown }[]) {
      if (p.type === "toolCall" && p.id) out.set(p.id, { name: p.name ?? "tool", args: p.arguments });
    }
  }
  return out;
}

/** Pi's loop tools; any other tool is a tinyCode workflow (its result is the request's state: kept counts, failing tests). */
/** how many most recently read files keep their latest read unmasked (the working set) */
export const WORKING_SET_FILES = 3;
export const LOOP_TOOL_NAMES = new Set(["read", "edit", "write", "bash", "find", "ls", "grep", "run_tests", "todo", "restore_best"]);

/**
 * The working set, never masked (connect on 3db5d78: the read of the file being fixed and the hand-over were masked by
 * call 8, the model could no longer see either and floundered for 100 calls): the latest `read` of each window of the
 * WORKING_SET_FILES most recently read paths, and the latest result of each workflow tool. Everything else masks as before.
 */
export function workingSet(messages: Msg[], files = WORKING_SET_FILES): Set<string> {
  const calls = callInputs(messages);
  const latest = new Map<string, string>();
  const order: string[] = []; // read paths, most recent last
  for (const m of messages) {
    if (m.role !== "toolResult" || !m.toolCallId) continue;
    const c = calls.get(m.toolCallId);
    const name = String(m.toolName ?? c?.name ?? "");
    const a = c?.args as { path?: unknown; offset?: unknown; limit?: unknown } | undefined;
    // per read window, as ReadMemory keys its re-read refusals, so "that result is still above" stays true
    if (name === "read" && a?.path !== undefined) {
      const p = String(a.path);
      latest.set(`read:${p}|${String(a.offset ?? 1)}|${String(a.limit ?? "")}`, m.toolCallId);
      order.splice(order.indexOf(p) >>> 0, order.includes(p) ? 1 : 0);
      order.push(p);
    } else if (name && !LOOP_TOOL_NAMES.has(name)) latest.set(`tool:${name}`, m.toolCallId);
  }
  const recent = new Set(order.slice(-files));
  return new Set([...latest].filter(([k]) => !k.startsWith("read:") || recent.has(k.slice(5, k.lastIndexOf("|", k.lastIndexOf("|") - 1)))).map(([, id]) => id));
}

function argSummary(args: unknown): string {
  const a = args as Record<string, unknown> | undefined;
  let s = a && typeof a === "object" ? String(a.command ?? a.path ?? a.question ?? canonicalJson(a)) : "";
  // a read window is named by its start line, or "README.html" alone would stand for every window of it
  if (a && typeof a === "object" && a.path !== undefined && a.offset !== undefined) s += ` from line ${String(a.offset)}`;
  return s.replace(/\s+/g, " ").slice(0, 60);
}

/**
 * Pi's own clamp (pi-ai `clampMaxTokensToContext`, CONTEXT_SAFETY_TOKENS): every request's max_tokens is cut to
 * window - prompt estimate - 4096. At a 16k window a prompt of ~12.3k leaves the reply nothing (paasio 16k r1: max_tokens
 * 203, then 1, "stop: context") while a share of the window (pressureAt 0.7 = 11.5k, piCompactReserve 0.2 = 13.1k)
 * still says there is room. Every context line is therefore capped at the usable line below.
 */
export const PI_OUTPUT_SAFETY = 4096;

/** The largest prompt that still leaves `outputReserve` tokens for the reply after Pi's clamp; 0 when the window is too small to say. */
export function usableTokens(windowTokens: number, outputReserve: number): number {
  return Math.max(0, windowTokens - PI_OUTPUT_SAFETY - outputReserve);
}

/** `share` of the window, never above the usable line (a window too small for the line keeps the share). */
export function lineTokens(windowTokens: number, share: number, outputReserve: number): number {
  const usable = usableTokens(windowTokens, outputReserve);
  return usable > 0 ? Math.min(share * windowTokens, usable) : share * windowTokens;
}

/** Pressure masking (F1): the window and system prompt the estimate needs, and what a batch did (for the log line). */
export interface PressureCtx {
  windowTokens: number;
  systemChars: number;
  /** the batch fires over min(pressureAt x window, this) (absent: the share alone); see usableTokens */
  ceilingTokens?: number;
}
export interface PressureInfo {
  tokensBefore: number;
  tokensAfter: number;
  results: number;
  calls: number;
}

type AsstPart = { type: string; text?: string; id?: string; arguments?: Record<string, unknown>; [k: string]: unknown };

/** Prompt size: the last assistant reply's real usage (input + cache + output tokens: its prompt plus its own reply) when there is one, plus chars/4 of what came after it; else chars/4 of everything (and the system prompt). */
export function contextTokens(messages: Msg[], systemChars = 0, ignoreUsage = false): number {
  for (let i = messages.length - 1; i >= 0 && !ignoreUsage; i--) {
    const u = messages[i]!.role === "assistant" ? (messages[i]!.usage as { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined) : undefined;
    const used = u ? (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) + (u.output ?? 0) : 0;
    if (used > 0) return used + approxTokens(messages.slice(i + 1).reduce((s, m) => s + promptChars(m), 0));
  }
  return approxTokens(systemChars + messages.reduce((s, m) => s + promptChars(m), 0));
}

/**
 * Prompt size for a decision that must not let a request go out too big: the larger of the usage-based estimate and
 * chars/4 of everything. The last reply's usage is the size of what THAT call sent; when the list now is bigger than
 * that (Pi compacted and restored a raw history, paasio 16k live 2026-10-30: usage said ~10.3k, the request was ~18k
 * and got HTTP 400), only the characters tell.
 */
export function sizeTokens(messages: Msg[], systemChars = 0): number {
  return Math.max(contextTokens(messages, systemChars), contextTokens(messages, systemChars, true));
}

/** Stable identity of an assistant message across calls (Pi gives no ids): timestamp, tool-call ids, start of text. */
function asstKey(m: Msg): string {
  const parts = Array.isArray(m.content) ? (m.content as AsstPart[]) : [];
  const ids = parts.filter((p) => p.type === "toolCall").map((p) => p.id ?? "").join(",");
  const text = parts.map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("").slice(0, 40);
  return `${String(m.timestamp ?? "")}|${ids}|${text}`;
}

/** Characters a message adds to the prompt: text parts, tool-call name + arguments, or a plain string. */
function promptChars(m: Msg): number {
  // Pi's compaction / branch summary messages carry `summary`, no content (sent as a user message with a short frame)
  if (typeof m.summary === "string" && m.content === undefined) return m.summary.length + 100;
  if (typeof m.content === "string") return m.content.length;
  if (!Array.isArray(m.content)) return 0;
  let n = 0;
  for (const p of m.content as AsstPart[]) {
    if (p.type === "text") n += (p.text ?? "").length;
    else if (p.type === "toolCall") n += String(p.name ?? "").length + JSON.stringify(p.arguments ?? {}).length;
  }
  return n;
}

/** The assistant message with long string arguments and long text parts shortened (structure and ids kept). */
function shortenAssistant(m: Msg, maxChars: number): Msg {
  if (!Array.isArray(m.content)) return m;
  const head = Math.floor(maxChars / 2);
  const content = (m.content as AsstPart[]).map((p) => {
    if (p.type === "text" && (p.text ?? "").length > maxChars) return { ...p, text: `${(p.text ?? "").slice(0, head).trimEnd()} […cut]` };
    if (p.type === "toolCall" && p.arguments && typeof p.arguments === "object") {
      const args: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(p.arguments)) {
        args[k] = typeof v === "string" && v.length > maxChars ? `[masked: ${v.replace(/\n$/, "").split("\n").length} lines; see notes]` : v;
      }
      return { ...p, arguments: args };
    }
    return p;
  });
  return { ...m, content };
}

export class Masker {
  /** Monotonic: once masked, always masked, so the prefix of the context only changes at batch boundaries. */
  private masked = new Map<string, string>();
  /** Assistant messages (by asstKey) whose long arguments and text were shortened (normal or pressure batch); monotonic too. */
  private shortened = new Set<string>();
  /** How many batches have fired (for tests and the log). */
  batches = 0;
  /** Pressure batches fired. */
  pressureBatches = 0;
  /** Set when the last `apply` ran a pressure batch (for the log line); null otherwise. */
  lastPressure: PressureInfo | null = null;
  private maskAboveTokens: number;
  private keepRecent: number;
  private pressureAt: number;
  private maskArgChars: number;
  constructor(maskAboveTokens = 1500, keepRecent = 2, pressureAt = 0, maskArgChars = 400) {
    this.maskAboveTokens = maskAboveTokens;
    this.keepRecent = keepRecent;
    this.pressureAt = pressureAt;
    this.maskArgChars = maskArgChars;
  }

  reset(): void {
    this.masked.clear();
    this.shortened.clear();
    this.batches = 0;
    this.pressureBatches = 0;
    this.lastPressure = null;
  }

  private placeholder(m: Msg, calls: Map<string, { name: string; args: unknown }>): string {
    const c = calls.get(m.toolCallId as string);
    const lines = resultText(m).replace(/\n$/, "").split("\n").length;
    return `[masked: ${m.toolName ?? c?.name ?? "tool"} ${argSummary(c?.args)}, ${lines} lines; see notes]`;
  }

  /** The list as it would be sent with the masks so far (no new batch); `messages` itself when nothing is masked. */
  view(messages: Msg[]): Msg[] {
    return this.render(messages) ?? messages;
  }

  private render(messages: Msg[]): Msg[] | undefined {
    if (!this.masked.size && !this.shortened.size) return undefined;
    return messages.map((m) => {
      if (m.role === "toolResult" && m.toolCallId) {
        const ph = this.masked.get(m.toolCallId);
        return ph === undefined ? m : { ...m, content: [{ type: "text", text: ph }] };
      }
      return m.role === "assistant" && this.shortened.has(asstKey(m)) ? shortenAssistant(m, this.maskArgChars) : m;
    });
  }

  /** Assistant messages older than the newest `keepRecent` that a shortening would make smaller and that are not shortened yet, with the characters it saves. */
  private shortenable(messages: Msg[]): { key: string; saved: number }[] {
    const asst = messages.filter((m) => m.role === "assistant");
    const out: { key: string; saved: number }[] = [];
    for (const m of asst.slice(0, Math.max(0, asst.length - this.keepRecent))) {
      const key = asstKey(m);
      if (this.shortened.has(key)) continue;
      const saved = promptChars(m) - promptChars(shortenAssistant(m, this.maskArgChars));
      if (saved > 0) out.push({ key, saved });
    }
    return out;
  }

  /**
   * Returns a new message list, or `undefined` when nothing is (or has ever been) masked. Normal batch: when the
   * unmasked tool results older than the newest `keepRecent`, plus what shortening the long string arguments and text
   * parts (over `maskArgChars`) of assistant messages older than the newest `keepRecent` would save, add up to more
   * than `maskAboveTokens`, ALL of those results are replaced at once with `[masked: <tool> <args up to 60 chars>,
   * <n> lines]` and those assistant messages are shortened. Monotonic: the prefix of the context only changes at batch
   * boundaries.
   *
   * With `pressure` and `pressureAt` > 0: when what will be sent is over `pressureAt` of the window, one more batch
   * ignores `maskAboveTokens`: every older tool result is masked and every older assistant message is shortened.
   */
  apply(messages: Msg[], pressure?: PressureCtx): Msg[] | undefined {
    this.lastPressure = null;
    const prev = this.render(messages); // as the model saw it at the last call: the masks of earlier batches only
    const results = messages.filter((m) => m.role === "toolResult" && m.toolCallId);
    const keep = workingSet(messages);
    const older = results.slice(0, Math.max(0, results.length - this.keepRecent)).filter((m) => !keep.has(m.toolCallId as string));
    const fresh = older.filter((m) => !this.masked.has(m.toolCallId as string));
    const cands = this.shortenable(messages);
    const tokens = fresh.reduce((s, m) => s + approxTokens(resultText(m).length), 0) + approxTokens(cands.reduce((s, c) => s + c.saved, 0));
    if ((fresh.length || cands.length) && tokens > this.maskAboveTokens) {
      const calls = callInputs(messages);
      for (const m of fresh) this.masked.set(m.toolCallId as string, this.placeholder(m, calls));
      for (const c of cands) this.shortened.add(c.key);
      this.batches++;
    }
    let out = this.render(messages);
    if (pressure && this.pressureAt > 0 && pressure.windowTokens > 0) {
      // The real prompt size of the last call (its reported usage, which counts tool definitions and the tokenizer),
      // minus what this call's active batch just took out, plus chars/4 of the messages added since.
      const chars = (ms: Msg[]): number => ms.reduce((t, m) => t + promptChars(m), 0);
      const before = Math.max(0, sizeTokens(prev ?? messages, pressure.systemChars) - approxTokens(chars(prev ?? messages) - chars(out ?? messages)));
      const line = Math.min(this.pressureAt * pressure.windowTokens, pressure.ceilingTokens && pressure.ceilingTokens > 0 ? pressure.ceilingTokens : Infinity);
      if (before > line) {
        const calls = callInputs(messages);
        let nResults = 0;
        for (const m of older) {
          if (this.masked.has(m.toolCallId as string)) continue;
          this.masked.set(m.toolCallId as string, this.placeholder(m, calls));
          nResults++;
        }
        const left = this.shortenable(messages);
        for (const c of left) this.shortened.add(c.key);
        const nCalls = left.length;
        if (nResults || nCalls) {
          this.pressureBatches++;
          const mid = out;
          out = this.render(messages);
          const after = Math.max(0, before - approxTokens(chars(mid ?? messages) - chars(out ?? messages)));
          this.lastPressure = { tokensBefore: before, tokensAfter: after, results: nResults, calls: nCalls };
        }
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- working memory (S4b)

export const MAX_TODO_ITEMS = 12;
export const MAX_TODO_CHARS = 200;

/** Fixed text appended to Pi's system prompt (fixed so the cache holds). At most 150 tokens (tested). */
export const MEMORY_PROMPT =
  "No tool fits and not a question: todo first, update each step. Notes = facts needed again (file, line, value). " +
  "find before read. Read needed lines only. No re-read of noted facts. Edits max ~40 lines; split bigger. " +
  "run_tests after edits. Todo done: stop.";

export interface TodoStep {
  text: string;
  done: boolean;
}

export const TODO_NOOP = "no change; todo saved. Next step or finish";
/** From this many no-op saves in a row the answer names the open step (add-1-chunk r2: 90 identical saves after the step-back, which ends the repeat guard but not this tool). */
export const TODO_NOOP_LOUD = 3;
export type TodoResult = { ok: true; text: string; noop?: boolean } | { ok: false; text: string };

const clip = (t: unknown): string => {
  const s = String(t ?? "").replace(/\s+/g, " ").trim();
  return s.length > MAX_TODO_CHARS ? `${s.slice(0, MAX_TODO_CHARS - 1)}…` : s;
};

/**
 * The model's running todo: replace-whole semantics. Shown at the tail of every request (never in the prefix), so
 * the cache stays valid; notes survive masking because they live here, not in the masked tool results.
 */
export class Todo {
  steps: TodoStep[] = [];
  notes: string[] = [];
  /** no-op saves in a row */
  private noops = 0;

  reset(): void {
    this.steps = [];
    this.notes = [];
    this.noops = 0;
  }

  get empty(): boolean {
    return !this.steps.length && !this.notes.length;
  }

  /** What a save would store (clipped, cleaned); null when it has too many items. */
  normalize(input: { steps?: unknown; notes?: unknown }): { steps: TodoStep[]; notes: string[] } | null {
    const steps = Array.isArray(input?.steps) ? input.steps : [];
    const notes = Array.isArray(input?.notes) ? input.notes : [];
    if (steps.length > MAX_TODO_ITEMS || notes.length > MAX_TODO_ITEMS) return null;
    return {
      steps: steps
        .map((s) => ({ text: clip((s as { text?: unknown })?.text), done: Boolean((s as { done?: unknown })?.done) }))
        .filter((s) => s.text),
      notes: notes.map(clip).filter(Boolean),
    };
  }

  /** True when saving `input` would change nothing: same steps, same done flags, same notes. */
  isNoop(input: { steps?: unknown; notes?: unknown }): boolean {
    const n = this.normalize(input);
    return !!n && canonicalJson(n) === canonicalJson({ steps: this.steps, notes: this.notes });
  }

  /** Replace the whole todo. Too many items is refused (the model shortens); a long item is cut at 200 characters. */
  set(input: { steps?: unknown; notes?: unknown }): TodoResult {
    const n = this.normalize(input);
    if (!n) return { ok: false, text: `Not saved: max ${MAX_TODO_ITEMS} steps, ${MAX_TODO_ITEMS} notes. Merge, resend.` };
    if (!this.empty && this.isNoop(input)) {
      this.noops++;
      const open = this.steps.find((s) => !s.done)?.text;
      if (this.noops < TODO_NOOP_LOUD) return { ok: true, noop: true, text: TODO_NOOP };
      const step = open ? ` Open: "${open.length > 60 ? `${open.slice(0, 59)}…` : open}". Do it with read/edit/bash, or finish.` : " All done: finish.";
      return { ok: true, noop: true, text: `no change ${this.noops}x; todo saved.${step}` };
    }
    this.noops = 0;
    this.steps = n.steps;
    this.notes = n.notes;
    const done = this.steps.filter((s) => s.done).length;
    return { ok: true, text: `Saved: ${done}/${this.steps.length} done, ${this.notes.length} notes.` };
  }

  /** The tail text; "" when there is nothing to show. */
  format(): string {
    if (this.empty) return "";
    const lines = ["[todo]"];
    this.steps.forEach((s, i) => lines.push(`${i + 1}. [${s.done ? "x" : " "}] ${s.text}`));
    if (this.notes.length) {
      lines.push("[notes]");
      for (const n of this.notes) lines.push(`- ${n}`);
    }
    return lines.join("\n");
  }
}

/** Tail lines that are not the todo: an empty-todo nudge and the output-limit notice. */
export const NO_TODO_NUDGE = "[todo empty] call todo with steps";
export const READ_NUDGE = "[note findings in todo]";
export const OUTPUT_LIMIT_NOTICE = "Last reply cut at output limit. Shorter reply, smaller edits.";

/**
 * The message appended at the end of the context each turn. `toolResults` is how many tool results the context
 * holds (the empty-todo nudge starts once the model has begun working without a todo, unless `nudgeTodo` is false: the request went to a tinyCode tool or is a question, so the tool's phases are the plan). Returns null for no tail.
 */
export function tailText(
  todo: Todo,
  outputLimitHit: boolean,
  toolResults: number,
  afterRead = false,
  extra: string[] = [],
  nudgeTodo = true,
): string | null {
  const parts: string[] = [];
  if (outputLimitHit) parts.push(OUTPUT_LIMIT_NOTICE);
  const t = todo.format();
  if (t) parts.push(t);
  else if (toolResults > 0 && nudgeTodo) parts.push(NO_TODO_NUDGE);
  if (afterRead) parts.push(READ_NUDGE);
  parts.push(...extra);
  return parts.length ? parts.join("\n") : null;
}

/** `messages` plus the tail as a final user message, or `undefined` when there is no tail. Never persisted by Pi. */
export function withTail(messages: Msg[], todo: Todo, outputLimitHit: boolean, extra: string[] = [], nudgeTodo = true): Msg[] | undefined {
  const results = messages.filter((m) => m.role === "toolResult").length;
  const last = messages[messages.length - 1];
  const text = tailText(todo, outputLimitHit, results, last?.role === "toolResult" && last.toolName === "read", extra, nudgeTodo);
  if (text === null) return undefined;
  return [...messages, { role: "user", content: [{ type: "text", text }], timestamp: Date.now() }];
}

/**
 * Read memory: the (path, window) pairs read in this task, kept also after the result was masked. The first re-read
 * of a window returns a pointer to the notes instead of the text; asking for it again serves it. Never refused
 * twice in a row. A window whose content changed since (its hash differs: the model edited it) is served at once.
 * (The hash is of the window, not of the file: after one edited line the other windows are still nudged.)
 */
export const KEPT_REREAD = "Unchanged since the checkpoint; its text is above. Need it again: ask again, it is served.";

export class ReadMemory {
  private seen = new Map<string, { turn: number; hash: string; refused: boolean; kept?: boolean }>();
  /** the last refusal was of a kept file (a checkpoint showed it): a pointer, not an intervention */
  keptHit = false;

  reset(): void {
    this.seen.clear();
    this.keptHit = false;
  }

  /** The window `read` will return: explicit offset/limit, else line 1 and the view cap (`capView` ran first). */
  static key(path: string, input: { offset?: unknown; limit?: unknown }, viewLines: number): string {
    const offset = Number(input.offset ?? 1) || 1;
    const limit = Number(input.limit ?? viewLines) || viewLines;
    return `${path}|${offset}|${limit}`;
  }

  /** Returns a note instead of the text for the first re-read, or null when the read is served (and remembered). */
  check(key: string, turn: number, hash: string): string | null {
    const prev = this.seen.get(key);
    this.keptHit = false;
    if (prev && prev.hash === hash && !prev.refused) {
      prev.refused = true;
      this.keptHit = prev.kept === true;
      if (prev.kept) return KEPT_REREAD;
      return `Unchanged since your read at turn ${prev.turn}; that result is still above. Need it again: ask again, it is served.`;
    }
    this.seen.set(key, { turn, hash, refused: false });
    return null;
  }

  /**
   * A file the model sees whole without a read call (a checkpoint's kept files, src/checkpoint.ts): every view window of
   * `text` counts as read at `turn`, so a re-read is pointed at it like any other.
   */
  serve(path: string, text: string, turn: number, viewLines: number): void {
    const n = text.split("\n").length;
    for (let offset = 1; offset <= n; offset += viewLines) this.seen.set(ReadMemory.key(path, { offset }, viewLines), { turn, hash: windowHash(text, offset, viewLines), refused: false, kept: true });
  }
}

/** The hash ReadMemory compares: of lines offset..offset+limit-1 of `text` (1-based). */
export function windowHash(text: string, offset: number, limit: number): string {
  return createHash("sha1").update(text.split("\n").slice(offset - 1, offset - 1 + limit).join("\n")).digest("hex");
}

/** Approximate tokens of the new text an `edit` (all its edits) or `write` would put on disk; 0 for other tools. */
export function editNewTokens(toolName: string, input: unknown): number {
  const i = input as { edits?: { newText?: unknown }[]; newText?: unknown; content?: unknown } | undefined;
  if (!i || typeof i !== "object") return 0;
  if (toolName === "write") return approxTokens(String(i.content ?? "").length);
  if (toolName !== "edit") return 0;
  const parts = Array.isArray(i.edits) ? i.edits.map((e) => e?.newText) : [i.newText];
  return approxTokens(parts.reduce<number>((s, t) => s + String(t ?? "").length, 0));
}

/** The refusal for an oversized edit/write, or null when it is within `maxTokens`. */
export function oversizeReason(toolName: string, input: unknown, maxTokens: number): string | null {
  const n = editNewTokens(toolName, input);
  return n > maxTokens
    ? `${toolName} ~${n} tokens, over ${maxTokens}. Split: ~40 lines each, one at a time.`
    : null;
}

// ---------------------------------------------------------------- call budget

/**
 * A call budget, not a guard: `cap` 0 means none (the default for plain chat). Rung 3 sets `ladder.loopTurnCap`.
 * Going over never aborts: `over` turns true, the next tool calls get BUDGET_REASON, and the rung-3 hand-off is
 * released so the command ends normally (exit 0).
 */
export class TurnCap {
  private turns = 0;
  cap: number;
  constructor(cap = 0) {
    this.cap = cap;
  }
  reset(): void {
    this.turns = 0;
  }
  /** Call on each `turn_start`; true when this turn is over the budget. */
  turnStarted(): boolean {
    this.turns++;
    return this.over;
  }
  get over(): boolean {
    return this.cap > 0 && this.turns > this.cap;
  }
  get count(): number {
    return this.turns;
  }
}

// ---------------------------------------------------------------- the bundle index.ts wires

export interface LimitState {
  guard: RepeatGuard;
  masker: Masker;
  turns: TurnCap;
  todo: Todo;
  reads: ReadMemory;
  /** files (absolute paths) a workflow just wrote or kept for a hand-over: their next read is served whole (limits.freshFileLines) */
  fresh: Set<string>;
  /** the last assistant reply stopped on the output limit (S4b): the next tail says so */
  outputLimitHit: boolean;
  /** tinyCode has stepped back for the rest of this run: Pi works as without it */
  stepped: boolean;
  stepBackReason: string | null;
  interventions: number;
  /** extra lines for the next tail (e.g. the repeat nudge); `index.ts` empties it when it builds the tail */
  tailNotes: string[];
  save: (full: string) => string;
  /** a new run (`agent_start`): guards start fresh */
  newRun(turnCap?: number): void;
  /** count one intervention (a refusal or a nudge); steps back at `stepBackAt` */
  intervene(kind: string): void;
  stepBack(reason: string): void;
  /** masking, unless stepped back */
  mask(messages: Msg[], pressure?: PressureCtx): Msg[] | undefined;
  /** result cap, unless stepped back */
  cap(text: string): string | null;
}

export function createLimits(limits: Limit, session: string, env: Env = process.env): LimitState {
  const state: LimitState = {
    guard: new RepeatGuard(limits.repeatBlockAt),
    masker: new Masker(limits.maskAboveTokens, limits.keepRecentResults, limits.pressureAt, limits.maskArgChars),
    turns: new TurnCap(limits.turnCap),
    todo: new Todo(),
    reads: new ReadMemory(),
    fresh: new Set(),
    outputLimitHit: false,
    stepped: false,
    stepBackReason: null,
    interventions: 0,
    tailNotes: [],
    save: obsSaver(session, env),
    newRun(turnCap) {
      state.guard.reset();
      state.turns.reset();
      state.todo.reset();
      state.reads.reset();
      state.outputLimitHit = false;
      state.stepped = false;
      state.stepBackReason = null;
      state.interventions = 0;
      state.tailNotes = [];
      state.turns.cap = turnCap ?? limits.turnCap;
    },
    intervene(kind) {
      if (state.stepped) return;
      state.interventions++;
      if (state.interventions >= limits.stepBackAt) state.stepBack(`${state.interventions} interventions (last: ${kind})`);
    },
    stepBack(reason) {
      if (state.stepped) return;
      state.stepped = true;
      state.stepBackReason = reason;
      logCall(
        {
          ts: new Date().toISOString(),
          session,
          workflow: "pi",
          step: "step_back",
          lane: "",
          model: "",
          prompt_tokens: 0,
          cached_tokens: 0,
          completion_tokens: 0,
          ms: 0,
          status: reason,
        },
        env,
      );
    },
    mask(messages, pressure) {
      if (state.stepped) return undefined;
      const out = state.masker.apply(messages, pressure);
      const p = state.masker.lastPressure;
      if (p) {
        logCall(
          {
            ts: new Date().toISOString(),
            session,
            workflow: "pi",
            step: "pressure_mask",
            lane: "",
            model: "",
            prompt_tokens: p.tokensBefore,
            cached_tokens: 0,
            completion_tokens: 0,
            ms: 0,
            status: `${p.tokensBefore} -> ${p.tokensAfter} tokens (${p.results} results, ${p.calls} replies)`,
          },
          env,
        );
      }
      return out;
    },
    cap: (text) => (state.stepped ? null : capText(text, limits, state.save)),
  };
  return state;
}

/** What the `tool_call` handler needs from the outside world: path resolution and a window's content hash. */
export interface CallEnv {
  resolvePath(p: string): string;
  /** hash of lines offset..offset+limit-1 of the file; "missing" when it cannot be read */
  windowHash(absPath: string, offset: number, limit: number): string;
  /** number of lines of the file, or -1 when it cannot be read (absent: fresh files are not served whole) */
  lineCount?(absPath: string): number;
}

/**
 * Every pre-call rule in order: call budget, (unless stepped back) view cap (mutates `input`), oversized edit/write,
 * repeat guard, read memory. Each refusal or nudge is an intervention; `stepBackAt` of them, or a repeat that goes on
 * after its nudge, step back for the rest of the run. Never terminates. `index.ts` calls this from `tool_call`;
 * tests call it to replay recorded sequences with no Pi.
 */
export function toolCallVerdict(
  lim: LimitState,
  limits: Limit,
  toolName: string,
  input: Record<string, unknown>,
  env: CallEnv,
): Verdict {
  if (lim.turns.over) return { action: "block", reason: BUDGET_REASON };
  if (lim.stepped) return { action: "allow" };
  // A file the workflow just wrote or kept is served whole on its first read (a cut copy reads as unfinished code).
  let whole = false;
  if (toolName === "read" && lim.fresh.size && (input.limit === undefined || input.limit === null) && !input.offset) {
    const abs = env.resolvePath(String(input.path ?? ""));
    if (lim.fresh.delete(abs)) {
      const n = env.lineCount?.(abs) ?? -1;
      whole = n >= 0 && n <= limits.freshFileLines;
    }
  }
  if (!whole) capView(toolName, input, limits.viewLines);
  const big = oversizeReason(toolName, input, limits.editMaxTokens);
  if (big) {
    lim.intervene("oversized edit");
    return { action: "block", reason: big };
  }
  // A todo save is keyed by what it would store, so repeated saves (no-ops included) count as identical calls.
  const sig = lim.guard.check(toolName, toolName === "todo" ? (lim.todo.normalize(input) ?? input) : input);
  if (sig === "continues") {
    lim.stepBack("repeat continued after the nudge");
    return { action: "allow" };
  }
  if (sig === "nudge") {
    lim.tailNotes.push(REPEAT_NUDGE);
    lim.intervene("repeat");
    return { action: "allow" };
  }
  if (toolName === "read") {
    const path = env.resolvePath(String(input.path ?? ""));
    const offset = Number(input.offset ?? 1) || 1;
    const limit = Number(input.limit ?? limits.viewLines) || limits.viewLines;
    const why = lim.reads.check(ReadMemory.key(path, input, limits.viewLines), lim.turns.count, env.windowHash(path, offset, limit));
    if (why) {
      // a kept file's pointer is always true (its text is right after the checkpoint note): not counted toward stepBackAt
      if (!lim.reads.keptHit) lim.intervene("re-read");
      return { action: "block", reason: why };
    }
  }
  return whole ? { action: "allow", whole: true } : { action: "allow" };
}
