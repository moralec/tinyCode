// Automatic compaction of a long Pi session (operator 2026-10-29: several requests in one session filled 73 % of a
// 33k context and replies were cut off).
//
// Pi API used: the `context` event (our benchmark section 3, table row `context`: "Returns a new messages
// list"; section 4 item 4 and the cache rules: older messages are changed only in batches). The returned list is what
// the model sees; Pi's stored session is untouched. We do NOT use the `turn_end` drafts "compaction" / "context_edit"
// (same section): they are persisted append-only session entries, and this edit must stay reversible and tied to the
// context window of the model at hand.
//
// Rule: when the context passes `limits.compactAt` (default 0.6) of the window, every finished request before the
// current one (its user message and all its turns and tool traffic) is replaced by one short note
//   request: ...; result: ...; files changed: ...
// The current request's messages are kept as they are. All finished requests go at once (a batch) and the folded
// prefix never changes afterwards (until the next batch), so the server's prompt cache breaks rarely. The notes are
// carried at the front of the current request's user message, so roles still alternate user / assistant.
import { contextTokens, type Msg } from "./limits.ts";

const TEXT_CAP = 140;
const clip = (s: string, n = TEXT_CAP): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};

export function msgText(m: Msg): string {
  if (typeof m.content === "string") return m.content;
  if (!Array.isArray(m.content)) return "";
  return (m.content as { type: string; text?: string }[]).map((p) => (p.type === "text" ? (p.text ?? "") : "")).join("");
}

export { contextTokens } from "./limits.ts";

const FILE_TOOLS = new Set(["edit", "write", "edit_file"]);

/** One finished request as a note: `request: ...; result: ...; files changed: ...` */
export function summarizeRequest(turns: Msg[]): string {
  const user = turns[0]!;
  const files: string[] = [];
  let result = "";
  for (const m of turns.slice(1)) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const p of m.content as { type: string; name?: string; arguments?: Record<string, unknown> }[]) {
        const a = p.arguments;
        const f = p.type === "toolCall" && FILE_TOOLS.has(p.name ?? "") && a ? String(a.path ?? a.file_path ?? a.file ?? "") : "";
        if (f && !files.includes(f)) files.push(f);
      }
      const t = msgText(m).trim();
      if (t) result = t;
    } else if (m.role === "toolResult") {
      for (const l of msgText(m).split("\n")) {
        const mm = l.match(/^\s*(?:files(?: changed)?|added|changed):\s*(.+)$/i);
        if (mm) for (const f of mm[1]!.split(/[,\s]+/).filter((x) => /[./]/.test(x))) if (!files.includes(f)) files.push(f);
      }
    }
  }
  if (!result) {
    const last = [...turns].reverse().find((m) => m.role === "toolResult");
    result = last ? msgText(last) : "no reply";
  }
  return `request: ${clip(msgText(user))}; result: ${clip(result)}; files changed: ${files.length ? files.slice(0, 8).join(", ") + (files.length > 8 ? ", …" : "") : "none"}`;
}

export interface CompactInfo {
  /** finished requests folded in this batch */
  folded: number;
  tokensBefore: number;
  tokensAfter: number;
}

export class Compactor {
  /** Notes of the requests folded so far, oldest first. */
  notes: string[] = [];
  /** Messages before this index are folded; the one at this index is the request that was current at the batch. */
  private through = 0;
  private anchor = "";
  batches = 0;
  /** set when the last `apply` ran a batch (for the log line) */
  last: CompactInfo | null = null;

  /** share of the window (0 = off) */
  private compactAt: number;
  constructor(compactAt: number) {
    this.compactAt = compactAt;
  }

  reset(): void {
    this.notes = [];
    this.through = 0;
    this.anchor = "";
    this.batches = 0;
    this.last = null;
  }

  private key(m: Msg): string {
    return `${m.role}|${String(m.timestamp ?? "")}|${msgText(m).slice(0, 80)}`;
  }

  /** The list with the folded prefix replaced by the notes, or `undefined` when nothing is folded. `messages` is not modified. */
  apply(messages: Msg[], windowTokens: number, systemChars = 0): Msg[] | undefined {
    this.last = null;
    if (this.through > 0 && (messages.length <= this.through || this.key(messages[this.through]!) !== this.anchor)) this.reset(); // another session or a rewound one
    let out = this.fold(messages);
    if (this.compactAt > 0 && windowTokens > 0) {
      const before = contextTokens(out ?? messages, systemChars);
      if (before > this.compactAt * windowTokens) {
        const cur = currentStart(messages);
        if (cur > this.through) {
          // batch: every finished request between the folded prefix and the current request, at once
          const finished = requests(messages.slice(this.through, cur));
          for (const r of finished) this.notes.push(summarizeRequest(r));
          this.through = cur;
          this.anchor = this.key(messages[cur]!);
          this.batches++;
          out = this.fold(messages);
          this.last = { folded: finished.length, tokensBefore: before, tokensAfter: contextTokens(out!, systemChars, true) };
        }
      }
    }
    return out;
  }

  private fold(messages: Msg[]): Msg[] | undefined {
    if (!this.through || !this.notes.length) return undefined;
    const cur = messages[this.through]!;
    const head = `[earlier in this session, finished requests (older messages were folded away)]\n${this.notes.map((n) => `- ${n}`).join("\n")}\n\n[current request]\n`;
    const content = typeof cur.content === "string" ? head + cur.content : [{ type: "text", text: head }, ...(Array.isArray(cur.content) ? (cur.content as unknown[]) : [])];
    return [{ ...cur, content }, ...messages.slice(this.through + 1)];
  }
}

/** Index of the current request's user message (the last user message), or -1. */
export function currentStart(messages: Msg[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "user") return i;
  return -1;
}

/** Split into requests: each starts at a user message and runs to the next one. Messages before the first user message are dropped. */
export function requests(messages: Msg[]): Msg[][] {
  const out: Msg[][] = [];
  for (const m of messages) {
    if (m.role === "user") out.push([m]);
    else if (out.length) out[out.length - 1]!.push(m);
  }
  return out;
}
