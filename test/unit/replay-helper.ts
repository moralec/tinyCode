// Replay of a recorded tinyCode arm through the context pipeline (no Pi, no model): the request each call would send,
// without and with milestone checkpoints. Shared by checkpoint.test.ts; the numbers are of the recorded trajectory.
// The model's behaviour is not replayed: every call sends what the recorded model did next, so a rule that would change
// what the model does (kept files, an auto-undo) shows only in the sizes and the checkpoints of the same trajectory.
import { readFileSync } from "node:fs";
import { BestTree } from "../../src/besttree.ts";
import { buildNote, Checkpointer, milestoneOf, pairingOk, requestStart, requestText, touchedFiles, type CheckpointInfo } from "../../src/checkpoint.ts";

import { Masker, Todo, usableTokens, type Msg } from "../../src/limits.ts";
import { DEFAULTS } from "../../src/config.ts";
import { isTestPath } from "../../src/workflows/fix.ts";
import { failingNames, parseCounts } from "../../src/testrun.ts";

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
  /** the replay's non-test tree at this call (Files.hash) */
  tree: string;
}

/** The limits as they were before the steadiness rules (v2 checkpoints: no kept files, no back-off, no auto-undo). */
export const V2_LIMITS = { ...DEFAULTS.limits, checkpointKeepFiles: 0, checkpointBackoff: false, checkpointSkipSame: false, undoWorse: false };

/** loop calls (1-based) before which the last replay skipped a steady milestone as the same tree */
export const skipped: number[] = [];

/**
 * The files of the trajectory as the replay knows them at each point: a write's content, an edit applied to the text
 * known so far, a read window spliced in (its "[lines a-b of n ...]" marker sets the length). Keyed by path under cwd.
 */
class Files {
  private text = new Map<string, string[]>();
  private cwd: string;
  constructor(cwd: string) {
    this.cwd = cwd;
  }
  key(p: string): string {
    return p.startsWith(this.cwd + "/") ? p.slice(this.cwd.length + 1) : p;
  }
  get(p: string): string | null {
    const t = this.text.get(this.key(p));
    return t ? t.join("\n") : null;
  }
  read(p: string, offset: number, out: string): void {
    const m = out.match(/\n\[lines (\d+)-(\d+) of (\d+)[^\]]*\]$/);
    const body = (m ? out.slice(0, m.index) : out).replace(/\n$/, "");
    const lines = this.text.get(this.key(p)) ?? [];
    const add = body.split("\n");
    lines.splice(offset - 1, add.length, ...add);
    if (m) lines.length = Math.max(lines.length, Number(m[3]));
    else if (offset === 1) lines.length = add.length;
    this.text.set(this.key(p), lines);
  }
  /** the non-test files known so far, as one string (the replay's tree hash) */
  hash(): string {
    return [...this.text].filter(([k]) => !isTestPath(k)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}\0${v.join("\n")}`).join("\0");
  }
  write(p: string, content: string): void {
    this.text.set(this.key(p), content.replace(/\n$/, "").split("\n"));
  }
  edit(p: string, edits: { oldText?: unknown; newText?: unknown }[]): void {
    let t = this.get(p);
    if (t === null) return;
    for (const e of edits) if (typeof e.oldText === "string" && t.includes(e.oldText)) t = t.replace(e.oldText, String(e.newText ?? ""));
    this.write(p, t);
  }
}

/** Each loop call of the fixture: the messages before its reply, through Checkpointer (when `checkpoints`) and Masker. */
export function replay(fx: Fixture, checkpoints: boolean, limits = DEFAULTS.limits): ReplayCall[] {
  const L = limits;
  const masker = new Masker(L.maskAboveTokens, L.keepRecentResults, L.pressureAt, L.maskArgChars);
  const ckpt = new Checkpointer(checkpoints ? L.checkpointAt : 0, L.checkpointMinSave, L.checkpointGap, { keepFiles: L.checkpointKeepFiles, backoff: L.checkpointBackoff, skipSame: L.checkpointSkipSame });
  const files = new Files(fx.cwd);
  skipped.length = 0;
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
      const args = (call?.arguments ?? {}) as { path?: string; offset?: number; content?: string; edits?: { oldText?: unknown; newText?: unknown }[]; oldText?: unknown; newText?: unknown };
      if (!m.isError && typeof args.path === "string") {
        if (m.toolName === "read" && !/^Unchanged since/.test(text)) files.read(args.path, Number(args.offset ?? 1) || 1, text);
        if (m.toolName === "write" && typeof args.content === "string") files.write(args.path, args.content);
        if (m.toolName === "edit") files.edit(args.path, Array.isArray(args.edits) ? args.edits : [args]);
      }
      if (m.toolName === "todo" && call?.arguments) todo.set(call.arguments as never);
      if (m.toolName === "run_tests") {
        best.observe(parseCounts(text), () => {});
        const kind = milestoneOf(best.verdict, edited, parseCounts(text));
        ckpt.tests(kind, String(m.toolCallId), kind ? files.hash() : undefined);
        if (ckpt.lastSkipped) skipped.push(out.length + 1);
        lastText = text;
        edited = false;
      }
    }
    const checked = ckpt.apply(ctx, {
      windowTokens: fx.window,
      systemChars: fx.systemChars,
      usableTokens: usable,
      view: (ms) => masker.view(ms),
      fileText: (p) => files.get(p),
      pathKey: (p) => files.key(p),
      maxFileLines: L.freshFileLines,
      note: (showTests, kept) => {
        const req = requestStart(ctx);
        return buildNote({ request: requestText(ctx[req]), best: best.best, bestRun: best.bestRunNo, last: best.lastCounts, lastText, showTests, kept: kept.map((p) => files.key(p)), files: touchedFiles(ctx.slice(req), fx.cwd), steps: todo.steps, notes: todo.notes });
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
      tree: files.hash(),
    });
  }
  return out;
}

/**
 * Where auto-undo (limits.undoWorse) would fire on the recorded test runs (1-based run numbers) and where its repeat
 * guard turns it off. The recorded model went on from the worse tree; with the undo it would have gone on from the best
 * one, so only the first firing is an exact replay.
 */
export function undoReplay(fx: Fixture, from = DEFAULTS.limits.undoWorseFrom): { runs: number; undos: number[]; guard: number | null; lines: string[] } {
  const best = new BestTree(0, 0, true, from);
  const undos: number[] = [];
  const lines: string[] = [];
  let guard: number | null = null;
  let runs = 0;
  for (const m of fx.messages) {
    if (m.role !== "toolResult" || m.toolName !== "run_tests") continue;
    runs++;
    const text = ((m.content as { text?: string }[]) ?? []).map((p) => p.text ?? "").join("");
    const counts = parseCounts(text);
    const before = best.undos;
    const line = best.observe(counts, () => {}, undefined, { undo: () => ({}), sig: counts ? `${counts.passed}/${counts.failed}|${failingNames(text, 1000).names.join("|")}` : undefined });
    if (best.undos > before) {
      undos.push(runs);
      if (line?.startsWith("Same break") && guard === null) guard = runs;
    }
    if (line && !lines.includes(line)) lines.push(line);
  }
  return { runs, undos, guard, lines };
}
