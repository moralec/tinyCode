// Strict-template compatibility: some chat templates (Mistral/Devstral with llama-server --jinja) refuse a request
// unless roles alternate user/assistant (after an optional system message), tool calls and results excepted. tinyCode
// adds user-role messages of its own (todo tail, checkpoint note, nudges, custom messages) next to others, and
// right after tool results; plain Pi never does. This is the LAST transformation before a list is sent:
//   - consecutive user-role messages become one (text parts joined with a blank line, other parts kept in order);
//   - a user-role message straight after a tool result is folded into that tool result (the template wants an
//     assistant turn there; the text is the same, only its place changes). Never across an assistant message.
// Deterministic and idempotent: the same input gives the same output, so the cached prefix stays stable.
// Pi's internal roles that become `user` when sent (custom, bashExecution, branchSummary, compactionSummary) are
// converted first by `convert` (Pi's convertToLlm), when one is given.

export interface AltMsg {
  role: string;
  content?: unknown;
  [k: string]: unknown;
}

type Part = { type?: string; text?: string; [k: string]: unknown };

const PI_INTERNAL = new Set(["custom", "bashExecution", "branchSummary", "compactionSummary"]);

function parts(content: unknown): Part[] {
  if (typeof content === "string") return content.length ? [{ type: "text", text: content }] : [];
  if (Array.isArray(content)) return content as Part[];
  return [];
}

/** `a` then `b`, adjacent text parts joined with a blank line, everything else kept in order */
function joinParts(a: Part[], b: Part[]): Part[] {
  const out = a.map((p) => ({ ...p }));
  const rest = b.filter((p) => !(p.type === "text" && !p.text));
  for (const p of rest) {
    const last = out[out.length - 1];
    if (p.type === "text" && last && last.type === "text") last.text = `${last.text ?? ""}\n\n${p.text ?? ""}`;
    else out.push({ ...p });
  }
  return out;
}

/** string in, string out (workflow lists); parts in, parts out (Pi lists) */
function joinContent(a: unknown, b: unknown): unknown {
  if (typeof a === "string" && typeof b === "string") return a && b ? `${a}\n\n${b}` : a || b;
  return joinParts(parts(a), parts(b));
}

export interface AlternateResult<T> {
  messages: T[];
  /** user messages merged into a user message */
  merged: number;
  /** user messages folded into the tool result before them */
  folded: number;
}

export function alternate<T extends AltMsg>(messages: T[], convert?: (ms: T[]) => T[]): AlternateResult<T> {
  const internal = convert && messages.some((m) => PI_INTERNAL.has(m.role));
  const src = internal ? convert!(messages) : messages;
  const out: T[] = [];
  let merged = 0;
  let folded = 0;
  for (const m of src) {
    const prev = out[out.length - 1];
    if (m.role === "user" && prev && prev.role === "user") {
      out[out.length - 1] = { ...prev, content: joinContent(prev.content, m.content) };
      merged++;
    } else if (m.role === "user" && prev && (prev.role === "toolResult" || prev.role === "tool")) {
      const text = parts(m.content);
      const plain = typeof prev.content === "string" && text.every((p) => p.type === "text"); // wire shape: stays a string
      out[out.length - 1] = { ...prev, content: plain ? joinContent(prev.content, text.map((p) => p.text ?? "").join("\n\n")) : joinParts(parts(prev.content), text) } as T;
      folded++;
    } else out.push(m);
  }
  // nothing changed: hand back the original list (and its identity), converted or not
  if (merged + folded === 0) return { messages, merged, folded };
  return { messages: out, merged, folded };
}

/**
 * The rule the Mistral templates enforce, as a checker: returns the problems (empty = fine).
 * After an optional first system message: a user message comes first or right after an assistant message; an
 * assistant message right after a user message or tool result; a tool result right after an assistant message or
 * another tool result (so a user message straight after a tool result is a violation).
 */
export function checkAlternation(messages: AltMsg[]): string[] {
  const bad: string[] = [];
  const allowed: Record<string, Array<string | undefined>> = {
    user: [undefined, "assistant"],
    assistant: ["user", "tool"],
    tool: ["assistant", "tool"],
  };
  let prev: string | undefined;
  messages.forEach((m, i) => {
    if (i === 0 && m.role === "system") return;
    const r = m.role === "toolResult" ? "tool" : m.role;
    if (!allowed[r]) bad.push(`#${i}: unexpected role ${m.role}`);
    else if (!allowed[r]!.includes(prev)) bad.push(`#${i}: ${r} after ${prev ?? "start"}`);
    prev = r;
  });
  return bad;
}
