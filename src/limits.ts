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
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.ts";
import { logCall, logPath } from "./log.ts";

type Limit = Config["limits"];
type Env = Record<string, string | undefined>;

// ---------------------------------------------------------------- repeat guard

export const REPEAT_NUDGE =
  "[this is the same call as the last two; try a different approach or update your todo]";
export const BUDGET_REASON = "The call budget for this task is used up. Give your final answer now, without more tool calls.";

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
export type Verdict = { action: "allow" } | { action: "block"; reason: string };

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
  return `${text.slice(0, headLen)}\n[... ${cut} chars cut; full output saved to ${path} ...]\n${text.slice(text.length - tailLen)}`;
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

function argSummary(args: unknown): string {
  const a = args as Record<string, unknown> | undefined;
  let s = a && typeof a === "object" ? String(a.command ?? a.path ?? a.question ?? canonicalJson(a)) : "";
  // a read window is named by its start line, or "README.html" alone would stand for every window of it
  if (a && typeof a === "object" && a.path !== undefined && a.offset !== undefined) s += ` from line ${String(a.offset)}`;
  return s.replace(/\s+/g, " ").slice(0, 60);
}

export class Masker {
  /** Monotonic: once masked, always masked, so the prefix of the context only changes at batch boundaries. */
  private masked = new Map<string, string>();
  /** How many batches have fired (for tests and the log). */
  batches = 0;
  private maskAboveTokens: number;
  private keepRecent: number;
  constructor(maskAboveTokens = 6000, keepRecent = 2) {
    this.maskAboveTokens = maskAboveTokens;
    this.keepRecent = keepRecent;
  }

  reset(): void {
    this.masked.clear();
    this.batches = 0;
  }

  /**
   * Returns a new message list, or `undefined` when nothing is (or has ever been) masked. When the unmasked tool
   * results older than the newest `keepRecent` add up to more than `maskAboveTokens`, ALL of them are replaced at
   * once with `[masked: <tool> <args up to 60 chars>, <n> lines]`.
   */
  apply(messages: Msg[]): Msg[] | undefined {
    const results = messages.filter((m) => m.role === "toolResult" && m.toolCallId);
    const older = results.slice(0, Math.max(0, results.length - this.keepRecent));
    const fresh = older.filter((m) => !this.masked.has(m.toolCallId as string));
    const tokens = fresh.reduce((s, m) => s + approxTokens(resultText(m).length), 0);
    if (fresh.length && tokens > this.maskAboveTokens) {
      const calls = callInputs(messages);
      for (const m of fresh) {
        const c = calls.get(m.toolCallId as string);
        const lines = resultText(m).replace(/\n$/, "").split("\n").length;
        this.masked.set(
          m.toolCallId as string,
          `[masked: ${m.toolName ?? c?.name ?? "tool"} ${argSummary(c?.args)}, ${lines} lines; see your notes]`,
        );
      }
      this.batches++;
    }
    if (!this.masked.size) return undefined;
    return messages.map((m) => {
      const ph = m.role === "toolResult" && m.toolCallId ? this.masked.get(m.toolCallId) : undefined;
      return ph === undefined ? m : { ...m, content: [{ type: "text", text: ph }] };
    });
  }
}

// ---------------------------------------------------------------- working memory (S4b)

export const MAX_TODO_ITEMS = 12;
export const MAX_TODO_CHARS = 200;

/** Fixed text appended to Pi's system prompt (fixed so the cache holds). At most 150 tokens (tested). */
export const MEMORY_PROMPT =
  "When no tinyCode tool fits and the request is not a question, start with todo: your steps, and update it after each step. Use notes for facts " +
  "you will need again (file, line, value). Use find before read. Read only the lines you need. Never re-read what " +
  "your notes cover. Make small edits (about 40 lines at most); split bigger changes. Run run_tests after edits. " +
  "Stop when the todo is done.";

export interface TodoStep {
  text: string;
  done: boolean;
}

export const TODO_NOOP = "no change: your todo is already saved; continue with the next step or finish";
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

  reset(): void {
    this.steps = [];
    this.notes = [];
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
    if (!n) return { ok: false, text: `Not saved: at most ${MAX_TODO_ITEMS} steps and ${MAX_TODO_ITEMS} notes. Merge items and send it again.` };
    if (!this.empty && this.isNoop(input)) return { ok: true, noop: true, text: TODO_NOOP };
    this.steps = n.steps;
    this.notes = n.notes;
    const done = this.steps.filter((s) => s.done).length;
    return { ok: true, text: `Saved: ${done}/${this.steps.length} steps done, ${this.notes.length} notes.` };
  }

  /** The tail text; "" when there is nothing to show. */
  format(): string {
    if (this.empty) return "";
    const lines = ["[your todo]"];
    this.steps.forEach((s, i) => lines.push(`${i + 1}. [${s.done ? "x" : " "}] ${s.text}`));
    if (this.notes.length) {
      lines.push("[your notes]");
      for (const n of this.notes) lines.push(`- ${n}`);
    }
    return lines.join("\n");
  }
}

/** Tail lines that are not the todo: an empty-todo nudge and the output-limit notice. */
export const NO_TODO_NUDGE = "[todo is empty] Call todo now with your steps, then continue.";
export const READ_NUDGE = "[note what you learned in your todo]";
export const OUTPUT_LIMIT_NOTICE =
  "[your last reply hit the output limit and was cut off; its tool call did not run] Redo it in smaller pieces: " +
  "each edit about 40 lines at most.";

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
export class ReadMemory {
  private seen = new Map<string, { turn: number; hash: string; refused: boolean }>();

  reset(): void {
    this.seen.clear();
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
    if (prev && prev.hash === hash && !prev.refused) {
      prev.refused = true;
      return `You read this at turn ${prev.turn}; check your notes. If you still need it, note in your todo what you need from it and ask again: it will be served.`;
    }
    this.seen.set(key, { turn, hash, refused: false });
    return null;
  }
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
    ? `This ${toolName} is about ${n} tokens, over the ${maxTokens} limit. Split it into smaller edits (about 40 lines each) and send them one at a time.`
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
  mask(messages: Msg[]): Msg[] | undefined;
  /** result cap, unless stepped back */
  cap(text: string): string | null;
}

export function createLimits(limits: Limit, session: string, env: Env = process.env): LimitState {
  const state: LimitState = {
    guard: new RepeatGuard(limits.repeatBlockAt),
    masker: new Masker(limits.maskAboveTokens, limits.keepRecentResults),
    turns: new TurnCap(limits.turnCap),
    todo: new Todo(),
    reads: new ReadMemory(),
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
    mask: (messages) => (state.stepped ? undefined : state.masker.apply(messages)),
    cap: (text) => (state.stepped ? null : capText(text, limits, state.save)),
  };
  return state;
}

/** What the `tool_call` handler needs from the outside world: path resolution and a window's content hash. */
export interface CallEnv {
  resolvePath(p: string): string;
  /** hash of lines offset..offset+limit-1 of the file; "missing" when it cannot be read */
  windowHash(absPath: string, offset: number, limit: number): string;
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
  capView(toolName, input, limits.viewLines);
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
      lim.intervene("re-read");
      return { action: "block", reason: why };
    }
  }
  return { action: "allow" };
}
