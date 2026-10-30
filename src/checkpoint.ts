// Milestone checkpoints: save, clean, continue (operator 2026-10-30, "go for it").
//
// Evidence: at a 16k window (Qwen3.6, intercept fix+test) tinyCode lost paasio (19/25) and sgf-parsing (22/23) to the
// context while working. paasio's last request (72 messages): tool results 45 % (repeated run_tests outputs, file reads),
// the model's own old tool-call arguments 28 %, prose 10 %, tool definitions 9 %. Masking had already shortened what it
// could; Pi's compaction never ran (src/picompact.ts header).
//
// Rule. A milestone is detected by code, no model call:
//   - "best":   run_tests reaches a new best count (BestTree snapshots that tree);
//   - "steady": a successful edit/write, then run_tests at the best count (no regression).
// A green run is no milestone (the work is done; the model only reports). A todo step marked done is not one either: it
// is the model's word, not a test, and "read the files: done" would cut the very reads the next edit needs.
// At the next model call, when the prompt is over `checkpointAt` of the usable prompt (below), `checkpointGap` calls after the
// last checkpoint, and the cut takes out at least `checkpointMinSave` of the window, what is SENT becomes
//   head (system, earlier folded requests, the request, its hint and a direct workflow run) + one note + the milestone's
//   turn (its tool call and result) and everything after it.
// Pi's session keeps the full history; only the context hook's copy changes. The note is code-built pidgin (buildNote).
// A milestone is good until the next test run: a later run that is not a milestone drops it.
// Backstop: over the usable line (src/limits.ts usableTokens: window - Pi's 4096 clamp - limits.outputReserve) the cut is
// made at the last turn, milestone or not, gap ignored (paasio 16k died at ~12.1k of 16.4k, Pi's clamp left 203 then 1
// output tokens).
// Cache: a checkpoint changes the history after the head once; the head (system + request) stays the same prefix.
import { better } from "./workflows/fix.ts";
import { msgText } from "./compact.ts";
import { approxTokens, contextTokens, LOOP_TOOL_NAMES, sizeTokens, type Msg, type TodoStep } from "./limits.ts";
import { failingNames, firstErrorLine, type TestCounts } from "./testrun.ts";
import type { TestVerdict } from "./besttree.ts";

export type MilestoneKind = "best" | "steady";
export type CheckpointKind = MilestoneKind | "pressure";

/** The milestone a run_tests result makes (pure): see the header. `edited` = a successful edit/write since the last test run. */
export function milestoneOf(verdict: TestVerdict, edited: boolean, counts: TestCounts | null | undefined): MilestoneKind | null {
  if (!counts || counts.failed <= 0) return null;
  if (verdict === "best") return "best";
  if (verdict === "same" && edited) return "steady";
  return null;
}

// ---------------------------------------------------------------- message structure

type Part = { type: string; id?: string; name?: string; text?: string; arguments?: Record<string, unknown> };
const parts = (m: Msg | undefined): Part[] => (m && Array.isArray(m.content) ? (m.content as Part[]) : []);
const calls = (m: Msg | undefined): Part[] => (m?.role === "assistant" ? parts(m).filter((p) => p.type === "toolCall") : []);

/**
 * End (exclusive) of the head after the request at `req`: the custom and system messages right after it (router hint, a
 * system patch), then one assistant turn whose calls are all workflow tools (a direct run shown as the model's tool,
 * src/orchestrate.ts asToolTurn) with all of its results. That turn is the request's state before Pi's loop.
 */
export function headEnd(messages: Msg[], req: number): number {
  let j = req + 1;
  while (j < messages.length && (messages[j]!.role === "custom" || messages[j]!.role === "system")) j++;
  const c = calls(messages[j]);
  if (c.length && c.every((p) => !LOOP_TOOL_NAMES.has(String(p.name ?? "")))) {
    const open = new Set(c.map((p) => p.id));
    let k = j + 1;
    while (k < messages.length && messages[k]!.role === "toolResult" && open.delete(messages[k]!.toolCallId)) k++;
    if (!open.size) j = k;
  }
  return j;
}

/** Index of the assistant message holding the tool call `callId`, or -1. */
export function turnOf(messages: Msg[], callId: string): number {
  return messages.findIndex((m) => calls(m).some((p) => p.id === callId));
}

/** The first tool-call id of the last assistant message that has tool calls (the last turn), or null. */
export function lastTurnId(messages: Msg[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = calls(messages[i]);
    if (c.length && c[0]!.id) return c[0]!.id;
  }
  return null;
}

/** Every tool result follows its tool call, and every tool call has its result (the OpenAI-compatible API refuses orphans). */
export function pairingOk(messages: Msg[]): boolean {
  const open = new Set<string>();
  const seen = new Set<string>();
  for (const m of messages) {
    for (const p of calls(m)) {
      if (!p.id) return false;
      open.add(p.id);
      seen.add(p.id);
    }
    if (m.role === "toolResult") {
      if (!m.toolCallId || !seen.has(m.toolCallId)) return false;
      open.delete(m.toolCallId);
    }
  }
  return open.size === 0;
}

const promptChars = (ms: Msg[]): number =>
  ms.reduce((n, m) => {
    if (typeof m.content === "string") return n + m.content.length;
    for (const p of parts(m)) n += p.type === "text" ? (p.text ?? "").length : p.type === "toolCall" ? String(p.name ?? "").length + JSON.stringify(p.arguments ?? {}).length : 0;
    return n;
  }, 0);

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

/**
 * The cleaned list: head + the note + system messages of the cut part (tiny, may carry tool changes) + messages from the
 * turn at `cut` on. The note joins the request message when the head ends with it (no two user messages in a row), else
 * it is a user message after the head's tool result. Assistant messages in `stale` lose their usage in the copy: it is the
 * size of the prompt before the cut, and Pi's output clamp and tinyCode's estimates would read it as the size now.
 */
export function cleaned(messages: Msg[], head: number, cut: number, note: string, stale: Set<string> = new Set()): Msg[] {
  const out = messages.slice(0, head);
  const last = out[out.length - 1];
  if (last && typeof last.summary === "string" && last.content === undefined) {
    out[out.length - 1] = { ...last, summary: `${last.summary}\n\n${note}` }; // Pi sends a summary as a user message
  } else if (last?.role === "user") {
    const content = typeof last.content === "string" ? [{ type: "text", text: last.content }] : Array.isArray(last.content) ? [...(last.content as unknown[])] : [];
    out[out.length - 1] = { ...last, content: [...content, { type: "text", text: `\n\n${note}` }] };
  } else {
    out.push({ role: "user", content: [{ type: "text", text: note }], timestamp: Number(messages[cut]?.timestamp ?? Date.now()) - 1 });
  }
  out.push(...messages.slice(head, cut).filter((m) => m.role === "system"));
  for (const m of messages.slice(cut)) out.push(m.role === "assistant" && stale.has(asstId(m)) ? { ...m, usage: ZERO_USAGE } : m);
  return out;
}

const asstId = (m: Msg): string => `${String(m.timestamp ?? "")}|${calls(m).map((p) => p.id ?? "").join(",")}`;

// ---------------------------------------------------------------- the note

export interface NoteInput {
  /** the request text (the folded-requests prefix of src/compact.ts is dropped) */
  request: string;
  best: TestCounts | null;
  /** test run that reached the best (0 = the hand-over's tree) */
  bestRun: number;
  last: TestCounts | null;
  /** the last run_tests text */
  lastText: string;
  /** false when the kept turn already shows the last test output (then no fail names / first error here) */
  showTests: boolean;
  files: { path: string; edited: boolean }[];
  steps: TodoStep[];
  notes: string[];
}

export const NOTE_MAX_CHARS = 1200;
const NOTE_FILES = 6;
const NOTE_FAILS = 6;
const clip = (s: string, n: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const fmt = (c: TestCounts): string => `${c.passed}/${c.passed + c.failed}`;

/**
 * Index of the current request: the last user message, or a Pi compaction / branch summary after it (Pi's own
 * compaction can summarise the request away: the summary then heads what is sent). -1 when there is neither.
 */
export function requestStart(messages: Msg[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (["user", "compactionSummary", "branchSummary"].includes(messages[i]!.role)) return i;
  return -1;
}

/** The request's own words, without the folded-requests prefix; for the note its last non-empty line (the ask). */
export function requestText(m: Msg | undefined): string {
  const t = m ? (typeof m.summary === "string" && m.content === undefined ? m.summary : msgText(m)) : "";
  const at = t.lastIndexOf("[current request]\n");
  return at >= 0 ? t.slice(at + "[current request]\n".length) : t;
}

/** The checkpoint note: terse, code-built, at most NOTE_MAX_CHARS. */
export function buildNote(i: NoteInput): string {
  const lines = ["[checkpoint] Older steps removed. Files on disk are current: read before edit."];
  const ask = i.request.split("\n").map((l) => l.trim()).filter(Boolean).pop();
  if (ask) lines.push(`Task: ${clip(ask, 160)}`);
  if (i.best) {
    const now = i.last && better(i.best, i.last) ? ` Now ${fmt(i.last)}: worse, call restore_best.` : "";
    lines.push(`Saved: ${fmt(i.best)} pass (best${i.bestRun ? `, test run ${i.bestRun}` : ", hand-over"}).${now}`);
  } else if (i.last) lines.push(`Tests: ${fmt(i.last)} pass.`);
  if (i.files.length) {
    const f = i.files.slice(0, NOTE_FILES).map((x) => `${x.path}${x.edited ? " (edited)" : ""}`);
    lines.push(`Files: ${f.join(", ")}${i.files.length > NOTE_FILES ? `, +${i.files.length - NOTE_FILES}` : ""}.`);
  }
  if (i.showTests && i.lastText) {
    const f = failingNames(i.lastText, NOTE_FAILS);
    if (f.total) lines.push(`Still fail: ${f.names.map((n) => n.split("::").pop()).join(", ")}${f.total > f.names.length ? `, +${f.total - f.names.length}` : ""}.`);
    const e = firstErrorLine(i.lastText);
    if (e) lines.push(`First error: ${clip(e, 160)}`);
  }
  const done = i.steps.filter((s) => s.done).map((s) => clip(s.text, 60));
  const next = i.steps.filter((s) => !s.done).map((s) => clip(s.text, 60));
  if (done.length) lines.push(`Done: ${done.join("; ")}.`);
  if (next.length) lines.push(`Next: ${next.join("; ")}.`);
  if (i.notes.length) lines.push(`Notes: ${i.notes.map((n) => clip(n, 100)).join("; ")}`);
  const text = lines.join("\n");
  return text.length > NOTE_MAX_CHARS ? `${text.slice(0, NOTE_MAX_CHARS - 1)}…` : text;
}

/** Files the request's tool calls touched (read, edit, write), first touch first, paths relative to `cwd`. */
export function touchedFiles(messages: Msg[], cwd = ""): { path: string; edited: boolean }[] {
  const out = new Map<string, boolean>();
  const pre = cwd ? cwd.replace(/\/+$/, "") + "/" : "";
  for (const m of messages) {
    for (const p of calls(m)) {
      if (!["read", "edit", "write"].includes(String(p.name))) continue;
      const raw = p.arguments?.path ?? p.arguments?.file_path;
      if (typeof raw !== "string" || !raw) continue;
      const path = pre && raw.startsWith(pre) ? raw.slice(pre.length) : raw;
      out.set(path, (out.get(path) ?? false) || p.name !== "read");
    }
  }
  return [...out].map(([path, edited]) => ({ path, edited }));
}

// ---------------------------------------------------------------- the checkpointer

export interface CheckpointInfo {
  kind: CheckpointKind;
  tokensBefore: number;
  tokensAfter: number;
  /** messages taken out of what is sent */
  removed: number;
  noteChars: number;
}

export interface CheckpointCtx {
  windowTokens: number;
  systemChars: number;
  /** the backstop line in tokens (usableTokens); 0 = none */
  usableTokens: number;
  /** false: no new milestone checkpoint (tinyCode stepped back); the backstop and an active checkpoint still apply */
  milestones?: boolean;
  /** the list as masking will send it (Masker.view), so the saving counted is the one the model sees; default: as is */
  view?: (messages: Msg[]) => Msg[];
  /** the note for a checkpoint made now; `showTests` = false when the kept turn already has the last test output */
  note: (showTests: boolean) => string;
}

interface Active {
  callId: string;
  note: string;
  anchor: string;
  stale: Set<string>;
}

export class Checkpointer {
  private pending: { kind: MilestoneKind; callId: string } | null = null;
  private active: Active | null = null;
  private since = Number.POSITIVE_INFINITY;
  /** checkpoints made (this request) */
  count = 0;
  /** set when the last `apply` made a checkpoint */
  last: CheckpointInfo | null = null;
  private at: number;
  private minSave: number;
  private gap: number;
  constructor(at: number, minSave: number, gap: number) {
    this.at = at;
    this.minSave = minSave;
    this.gap = gap;
  }

  reset(): void {
    this.pending = null;
    this.active = null;
    this.since = Number.POSITIVE_INFINITY;
    this.count = 0;
    this.last = null;
  }

  /** A run_tests result: its milestone, or null (then a pending milestone is dropped: the state moved on). */
  tests(kind: MilestoneKind | null, callId: string): void {
    this.pending = kind ? { kind, callId } : null;
  }

  get hasPending(): boolean {
    return this.pending !== null;
  }

  private render(messages: Msg[], req: number, a: Active): Msg[] | undefined {
    const head = headEnd(messages, req);
    const cut = turnOf(messages, a.callId);
    if (cut < head) return undefined;
    return cleaned(messages, head, cut, a.note, a.stale);
  }

  /** What to send (a new list), or `undefined` when no checkpoint is in force. `messages` is not modified. */
  apply(messages: Msg[], o: CheckpointCtx): Msg[] | undefined {
    this.last = null;
    this.since++;
    if (!(this.at > 0) || !(o.windowTokens > 0)) return undefined;
    // no request at all (never seen): no milestone cut, but the backstop still works with the leading messages as head
    const req = requestStart(messages);
    // the request's own text: src/compact.ts may prefix it with folded requests mid-request, which is the same request
    const anchor = req < 0 ? "" : `${String(messages[req]!.timestamp ?? "")}|${requestText(messages[req]).slice(0, 80)}`;
    if (this.active && this.active.anchor !== anchor) this.reset(); // a new request (or a rewound session)
    let out = this.active ? this.render(messages, req, this.active) : undefined;
    if (this.active && !out) this.active = null; // its turn is gone (Pi compacted it away)
    const cur = out ?? messages;
    // never trust the last reply's usage alone: it is too small when the list grew back (limits.ts sizeTokens); the
    // characters are counted as masking will send them
    const view = o.view ?? ((ms: Msg[]) => ms);
    const before = Math.max(contextTokens(cur, o.systemChars), sizeTokens(view(cur), o.systemChars));
    let target: { kind: CheckpointKind; callId: string } | null = null;
    // the gate is a share of the usable prompt (what the model can use after Pi's clamp and the reply), so the same share
    // means the same pressure at any window: 16k usable 10240, 32k 26624
    const gate = this.at * (o.usableTokens > 0 ? o.usableTokens : o.windowTokens);
    if (this.pending && req >= 0 && o.milestones !== false && this.since >= this.gap && before > gate) target = this.pending;
    else if (o.usableTokens > 0 && before > o.usableTokens) {
      const id = lastTurnId(messages);
      if (id) target = { kind: "pressure", callId: id };
    }
    if (!target) return out;
    const head = headEnd(messages, req);
    const cut = turnOf(messages, target.callId);
    if (cut < head || (this.active && cut <= turnOf(messages, this.active.callId))) {
      if (target === this.pending) this.pending = null;
      return out;
    }
    const kept = messages.slice(cut);
    const showTests = !kept.some((m) => m.role === "toolResult" && m.toolName === "run_tests");
    const stale = new Set(kept.filter((m) => m.role === "assistant").map(asstId));
    const next: Active = { callId: target.callId, note: o.note(showTests), anchor, stale };
    const cand = cleaned(messages, head, cut, next.note, stale);
    const saved = approxTokens(promptChars(view(cur)) - promptChars(view(cand)));
    if (!pairingOk(cand) || saved <= 0 || saved < this.minSave * o.windowTokens) return out; // a pending milestone may still pass later
    this.active = next;
    this.pending = null;
    this.since = 0;
    this.count++;
    this.last = { kind: target.kind, tokensBefore: before, tokensAfter: Math.max(0, before - saved), removed: cut - head, noteChars: next.note.length };
    return cand;
  }
}
