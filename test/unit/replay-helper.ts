// Replay of a recorded tinyCode arm through the context pipeline (no Pi, no model): the request each call would send,
// without and with milestone checkpoints. Shared by checkpoint.test.ts; the numbers are of the recorded trajectory.
import { readFileSync } from "node:fs";
import { BestTree } from "../../src/besttree.ts";
import { buildNote, Checkpointer, milestoneOf, pairingOk, requestStart, requestText, touchedFiles, type CheckpointInfo } from "../../src/checkpoint.ts";

import { Masker, Todo, usableTokens, type Msg } from "../../src/limits.ts";
import { DEFAULTS } from "../../src/config.ts";
import { parseCounts } from "../../src/testrun.ts";

export interface Fixture {
  window: number;
  cwd: string;
  systemChars: number;
  toolsChars: number;
  recorded: { seq: number; n_messages: number; prompt_chars: number; prompt_tokens: number; max_tokens: number }[];
  messages: Msg[];
}

export const loadFixture = (name: string): Fixture => JSON.parse(readFileSync(new URL(`../fixtures/checkpoint/${name}`, import.meta.url), "utf8")) as Fixture;

const chars = (ms: Msg[]): number =>
  ms.reduce((n, m) => {
    if (typeof m.content === "string") return n + m.content.length;
    for (const p of (Array.isArray(m.content) ? m.content : []) as { type: string; text?: string; name?: string; arguments?: unknown }[])
      n += p.type === "text" ? (p.text ?? "").length : p.type === "toolCall" ? String(p.name ?? "").length + JSON.stringify(p.arguments ?? {}).length : 0;
    return n;
  }, 0);

export interface ReplayCall {
  /** 1-based loop call */
  call: number;
  messages: number;
  /** system + messages + tool definitions, characters */
  chars: number;
  checkpoint: CheckpointInfo | null;
  /** tool calls and results paired, the request message sent unchanged (or with the note appended), the last turn sent */
  valid: boolean;
  requestKept: boolean;
  lastTurnKept: boolean;
}

/** Each loop call of the fixture: the messages before its reply, through Checkpointer (when `checkpoints`) and Masker. */
export function replay(fx: Fixture, checkpoints: boolean, limits = DEFAULTS.limits): ReplayCall[] {
  const L = limits;
  const masker = new Masker(L.maskAboveTokens, L.keepRecentResults, L.pressureAt, L.maskArgChars);
  const ckpt = new Checkpointer(checkpoints ? L.checkpointAt : 0, L.checkpointMinSave, L.checkpointGap);
  const best = new BestTree(0, 0);
  const todo = new Todo();
  const usable = usableTokens(fx.window, L.outputReserve);
  // each reply's usage is what this replay sent for it (the recorded usage is of the recorded, uncheckpointed prompts)
  const msgs = fx.messages.map((m) => ({ ...m }));
  let seen = 0;
  let edited = false;
  let lastText = "";
  const calls: { type: string; id?: string; name?: string; arguments?: Record<string, unknown> }[] = [];
  const out: ReplayCall[] = [];
  const loopStart = msgs.findIndex((m) => m.role === "toolResult" && m.toolName === "fix") + 1;
  for (let a = loopStart; a < msgs.length; a++) {
    if (msgs[a]!.role !== "assistant") continue;
    const ctx = msgs.slice(0, a);
    for (; seen < a; seen++) {
      const m = msgs[seen]!;
      if (m.role === "assistant") for (const p of (m.content as typeof calls) ?? []) if (p.type === "toolCall") calls.push(p);
      if (m.role !== "toolResult" || seen < loopStart) continue;
      const text = ((m.content as { text?: string }[]) ?? []).map((p) => p.text ?? "").join("");
      const call = calls.find((c) => c.id === m.toolCallId);
      if ((m.toolName === "edit" || m.toolName === "write") && !m.isError) edited = true;
      if (m.toolName === "todo" && call?.arguments) todo.set(call.arguments as never);
      if (m.toolName === "run_tests") {
        best.observe(parseCounts(text), () => {});
        ckpt.tests(milestoneOf(best.verdict, edited, parseCounts(text)), String(m.toolCallId));
        lastText = text;
        edited = false;
      }
    }
    const checked = ckpt.apply(ctx, {
      windowTokens: fx.window,
      systemChars: fx.systemChars,
      usableTokens: usable,
      view: (ms) => masker.view(ms),
      note: (showTests) => {
        const req = requestStart(ctx);
        return buildNote({ request: requestText(ctx[req]), best: best.best, bestRun: best.bestRunNo, last: best.lastCounts, lastText, showTests, files: touchedFiles(ctx.slice(req), fx.cwd), steps: todo.steps, notes: todo.notes });
      },
    });
    const cp = ckpt.last;
    const sent = checked ?? ctx;
    const masked = masker.apply(sent, cp ? undefined : { windowTokens: fx.window, systemChars: fx.systemChars, ceilingTokens: usable }) ?? sent;
    const sentChars = fx.systemChars + fx.toolsChars + chars(masked);
    const u = (msgs[a]!.usage ?? {}) as { output?: number };
    msgs[a]!.usage = { input: Math.ceil(sentChars / 4), output: u.output ?? 0, cacheRead: 0, cacheWrite: 0 };
    const req = ctx[requestStart(ctx)]!;
    const sentReq = masked.find((m) => m.role === "user" && m.timestamp === req.timestamp);
    const lastAsst = [...ctx].reverse().find((m) => m.role === "assistant");
    out.push({
      call: out.length + 1,
      messages: masked.length,
      chars: sentChars,
      checkpoint: cp,
      valid: pairingOk(masked),
      requestKept: !!sentReq && JSON.stringify(sentReq.content).startsWith(JSON.stringify(req.content).slice(0, -1)),
      lastTurnKept: !!lastAsst && masked.some((m) => m.role === "assistant" && m.timestamp === lastAsst.timestamp),
    });
  }
  return out;
}
