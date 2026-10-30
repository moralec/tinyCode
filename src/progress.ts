// One progress system for every workflow and for plain chat.
//
// A workflow declares its phases up front and calls `progress.step("summarising files", i, n)` as it works and
// `progress.done(...)` at the end. The helper turns that into
//   - a live status line   `tinyCode · doc readme · summarising files 12/46 · 31 calls · 24k tok · 1m40s`
//   - a checklist widget   `✓ scan` / `▸ summarising files 12/46` / `○ folders` (the model's own todo in plain chat)
//   - one end summary      outcome, what changed, calls, tokens (cached %), time, next step
// Calls and tokens come from the call log (src/log.ts `onCall`), the same records `/tinycode stats` reads, so the two
// always agree. Nothing here ever stops a run by itself: "looks stuck" only warns, and a stop happens only when the
// operator answers "stop" to the one question asked (the next model call of that workflow then fails with a plain error).
import { onCall, type CallRecord } from "./log.ts";
import { beatSentence, endSentence, stuckSentence, waitingSentence } from "./progress-text.ts";

export interface ProgressSink {
  /** footer status text; undefined clears it */
  status(text: string | undefined): void;
  /** checklist lines above the editor; undefined clears them */
  widget(lines: string[] | undefined): void;
  /** the end summary: a chat-visible message in the TUI, stdout in -p mode */
  message(text: string, kind?: "beat"): void;
  /** a progress line for a terminal without a UI (stderr) */
  err(line: string): void;
  /** true in the TUI: the status line and widget carry progress; false: progress lines go to `err` */
  interactive: boolean;
  /** terminal width, for the graceful narrow form */
  width?(): number;
  /** ask once when stuck; true = continue. Absent: warn and continue. */
  confirmStuck?(calls: number): Promise<boolean>;
  /** the operator said stop */
  onStop?(): void;
}

/** customType of the heartbeat and stuck lines: for the human only, never in the model's context (src/orchestrate.ts `dropDisplayOnly`) */
export const CUSTOM_BEAT = "tinycode-beat";

export interface Summary {
  outcome?: "done" | "blocked" | "failed";
  /** what happened, e.g. "docs/overview.html written" */
  text?: string;
  /** the reason, for blocked/failed */
  reason?: string;
  files?: string[];
  /** the next step, e.g. "run /build to continue" */
  next?: string;
}

export interface ProgressOptions {
  workflow: string;
  /** phases declared up front, in order; the checklist uses them */
  phases?: string[];
  sink: ProgressSink;
  now?: () => number;
  /** calls without a phase step or a changed file before "looks stuck" (0 = never) */
  stuckCalls?: number;
  /** refresh the elapsed time every second (the TUI); tests turn it off */
  timer?: boolean;
  /** show the cached share of prompt tokens (plain chat) */
  showCache?: boolean;
  /** one short chat-visible heartbeat line about this often (seconds; 0 or absent = off); needs `timer` and calls `tick()` */
  heartbeatSeconds?: number;
  /** do not subscribe to the call log (tests that feed `count` by hand) */
  noLog?: boolean;
}

interface Frame {
  name: string;
  phase: string | null;
  i?: number;
  n?: number;
}

interface Core {
  o: ProgressOptions;
  now: () => number;
  start: number;
  calls: number;
  prompt: number;
  completion: number;
  cached: number;
  since: number;
  stuck: boolean;
  asked: boolean;
  stopped: boolean;
  declared: string[];
  cur: number;
  steps: number;
  phaseKey: string;
  frames: Frame[];
  todo: { text: string; done: boolean }[];
  extras: string[];
  finished: boolean;
  files: Set<string>;
  timer: ReturnType<typeof setInterval> | null;
  beatAt: number;
  beatCalls: number;
  beatSteps: number;
  idleBeats: number;
  activeAt: number;
  unsub: (() => void) | null;
}

export const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
};

export const fmtTok = (n: number): string => (n < 1000 ? String(n) : n < 10_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`);

const DIM = "\x1b[2m";
const UNDIM = "\x1b[22m";
const MAX_LINES = 6;

export class Progress {
  private core: Core;
  private frame: Frame;
  private depth: number;

  constructor(opts: ProgressOptions);
  constructor(opts: ProgressOptions, core: Core, frame: Frame, depth: number);
  constructor(opts: ProgressOptions, core?: Core, frame?: Frame, depth = 0) {
    if (core && frame) {
      this.core = core;
      this.frame = frame;
      this.depth = depth;
      return;
    }
    const now = opts.now ?? Date.now;
    this.frame = { name: opts.workflow, phase: null };
    this.depth = 0;
    this.core = {
      o: opts,
      now,
      start: now(),
      calls: 0,
      prompt: 0,
      completion: 0,
      cached: 0,
      since: 0,
      stuck: false,
      asked: false,
      stopped: false,
      declared: [...(opts.phases ?? [])],
      cur: -1,
      steps: 0,
      phaseKey: "",
      frames: [this.frame],
      todo: [],
      extras: [],
      finished: false,
      files: new Set(),
      timer: null,
      beatAt: now(),
      beatCalls: 0,
      beatSteps: 0,
      idleBeats: 0,
      activeAt: now(),
      unsub: opts.noLog ? null : onCall((r) => this.count(r)),
    };
    if (opts.timer) {
      this.core.timer = setInterval(() => this.tick(), 1000);
      this.core.timer.unref?.();
    }
    this.refresh();
  }

  // ------------------------------------------------------------ counters

  /** One model call (also fed by the call log). */
  count(r: Pick<CallRecord, "prompt_tokens" | "cached_tokens" | "completion_tokens"> & { step?: string }): void {
    const c = this.core;
    if (c.finished || r.step === "step_back") return;
    c.calls++;
    c.prompt += r.prompt_tokens || 0;
    c.cached += r.cached_tokens || 0;
    c.completion += r.completion_tokens || 0;
    c.since++;
    c.activeAt = c.now();
    const limit = c.o.stuckCalls ?? 0;
    if (limit > 0 && c.since >= limit && !c.stuck) {
      c.stuck = true;
      this.refresh();
      if (!c.asked) {
        c.asked = true;
        const s = c.o.sink;
        if (s.confirmStuck) {
          s.confirmStuck(c.since)
            .then((cont) => {
              if (!cont) {
                c.stopped = true;
                s.onStop?.();
              }
              this.refresh();
            })
            .catch(() => {});
        } else {
          // auto mode: no question, one plain sentence in the chat (a terminal without a UI gets it on stderr)
          if (s.interactive) s.message(stuckSentence(c.since), "beat");
          else s.err(`tinyCode · ${c.o.workflow} · ${stuckSentence(c.since)}`);
        }
      }
    } else if (c.o.sink.interactive || c.calls % 5 === 0) {
      // the TUI line follows every call; a terminal without a UI gets a line every few calls
      this.refresh();
    }
  }

  get calls(): number {
    return this.core.calls;
  }
  get tokens(): number {
    return this.core.prompt + this.core.completion;
  }
  get stuck(): boolean {
    return this.core.stuck;
  }
  get stopped(): boolean {
    return this.core.stopped;
  }
  get finished(): boolean {
    return this.core.finished;
  }

  /** Real progress without a phase step: a file changed, a todo item finished. Resets the stuck counter. */
  touch(file?: string): void {
    const c = this.core;
    if (file) c.files.add(file);
    c.since = 0;
    if (c.stuck) {
      c.stuck = false;
      this.refresh();
    }
  }

  /**
   * A sub-step happened (one chunk, merge, section or task of a phase): progress that does not change the phase label.
   * Resets the stuck counter, so a phase that works steadily is never "stuck" however many calls it makes.
   */
  sub(): void {
    const c = this.core;
    c.since = 0;
    c.steps++;
    c.activeAt = c.now();
    if (c.stuck) {
      c.stuck = false;
      this.refresh();
    }
  }

  /** The files changed so far (from `touch(file)`). */
  get changed(): string[] {
    return [...this.core.files];
  }

  // ------------------------------------------------------------ phases

  /** Declare (or replace) the phases once they are known, e.g. /build's tasks after the plan is read. */
  declare(phases: string[]): void {
    const c = this.core;
    c.declared = [...phases];
    c.cur = -1;
    this.refresh();
  }

  /** Enter (or advance within) a phase: `step("summarising files", 12, 46)`. */
  step(label: string, i?: number, n?: number): void {
    const c = this.core;
    if (c.finished) return;
    this.frame.phase = label;
    this.frame.i = i;
    this.frame.n = n;
    if (this.depth === 0) {
      let k = c.declared.indexOf(label);
      if (k < 0) {
        c.declared.push(label);
        k = c.declared.length - 1;
      }
      c.cur = k;
    }
    c.steps++;
    c.activeAt = c.now();
    const key = `${this.depth}:${label}:${i ?? ""}`;
    if (key !== c.phaseKey) {
      c.phaseKey = key;
      this.touch();
    }
    this.refresh(true);
  }

  /** Alias of `step`, for reading: a new phase. */
  phase(label: string, i?: number, n?: number): void {
    this.step(label, i, n);
  }

  /** Nested work (a ladder hand-over, /research inside /plan, a build task's fix): shows as `outer → inner · phase`. */
  nest(name: string): Progress {
    const c = this.core;
    c.frames.splice(this.depth + 1);
    const frame: Frame = { name, phase: null };
    c.frames.push(frame);
    this.refresh();
    return new Progress(c.o, c, frame, this.depth + 1);
  }

  /** Leave a nested frame. */
  end(): void {
    if (this.depth > 0) this.core.frames.splice(this.depth);
    this.refresh();
  }

  /** A short extra label on the status line, e.g. "stepped back"; "" removes it. */
  note(key: string, text: string): void {
    const c = this.core;
    c.extras = c.extras.filter((e) => !e.startsWith(`${key}\u0000`));
    if (text) c.extras.push(`${key}\u0000${text}`);
    this.refresh();
  }

  /** The model's own todo (plain chat): the checklist and the status line follow it. */
  setTodo(steps: { text: string; done: boolean }[]): void {
    const c = this.core;
    const before = c.todo.filter((s) => s.done).length;
    c.todo = steps.map((s) => ({ text: s.text, done: s.done }));
    if (c.todo.filter((s) => s.done).length > before) this.touch();
    this.refresh();
  }

  // ------------------------------------------------------------ the chat function

  /** Wrap a chat function: a stop the operator asked for ends the next call with a plain error, nothing else changes. */
  chat<F extends (...a: never[]) => Promise<unknown>>(fn: F): F {
    const wrapped = ((...a: never[]) => {
      if (this.core.stopped) return Promise.reject(new Error("stopped at your request"));
      return fn(...a);
    }) as F;
    return wrapped;
  }

  // ------------------------------------------------------------ rendering

  private todoCount(): { done: number; total: number } | null {
    const t = this.core.todo;
    return t.length ? { done: t.filter((s) => s.done).length, total: t.length } : null;
  }

  private crumbs(): string {
    const c = this.core;
    const parts: string[] = [];
    c.frames.forEach((f, k) => {
      const ph = f.phase ? `${f.phase}${f.n ? ` ${f.i ?? 0}/${f.n}` : ""}` : "";
      parts.push(f.name + (ph ? ` · ${ph}` : ""));
      const next = c.frames[k + 1];
      if (next) parts.push(" → ");
      else if (!ph && !this.todoCount()) parts.push(" · running…");
    });
    return parts.join("");
  }

  /** The status line. `width` (default: the sink's) drops tokens first, then calls. */
  render(width?: number): string {
    const c = this.core;
    const w = width ?? c.o.sink.width?.() ?? 0;
    const head = ["tinyCode", this.crumbs()];
    const t = this.todoCount();
    if (t) head.push(`todo ${t.done}/${t.total}`);
    for (const e of c.extras) head.push(e.split("\u0000")[1]!);
    if (c.stuck) head.push(`looks stuck after ${c.since} calls`);
    const tok = c.prompt + c.completion;
    const cache = c.o.showCache && c.prompt ? ` (${Math.round((100 * c.cached) / c.prompt)}% cached)` : "";
    const build = (withTok: boolean, withCalls: boolean): string =>
      [...head, ...(withCalls ? [`${c.calls} calls`] : []), ...(withTok ? [`${fmtTok(tok)} tok${cache}`] : []), fmtTime(c.now() - c.start)].join(" · ");
    for (const [a, b] of [[true, true], [false, true], [false, false]] as const) {
      const s = build(a, b);
      if (!w || s.length <= w) return s;
    }
    const s = build(false, false);
    return s.length > w ? `${s.slice(0, Math.max(1, w - 1))}…` : s;
  }

  /** Checklist lines: ✓ done (dimmed), ▸ current, ○ pending; at most 6 lines, "+N more" after. Empty when there is nothing to list. */
  checklist(): string[] {
    const c = this.core;
    const root = c.frames[0]!;
    const items: { mark: "✓" | "▸" | "○"; text: string }[] = [];
    if (c.declared.length) {
      c.declared.forEach((label, k) => {
        const cur = k === c.cur;
        const text = cur && root.n ? `${label} ${root.i ?? 0}/${root.n}` : label;
        items.push({ mark: k < c.cur ? "✓" : cur ? "▸" : "○", text });
      });
    } else if (c.todo.length) {
      const first = c.todo.findIndex((s) => !s.done);
      c.todo.forEach((s, k) => items.push({ mark: s.done ? "✓" : k === first ? "▸" : "○", text: s.text }));
    }
    if (!items.length) return [];
    const ix = items.findIndex((x) => x.mark === "▸");
    const dim = c.o.sink.interactive;
    const line = (x: { mark: string; text: string }) => (x.mark === "✓" && dim ? `${DIM}✓ ${x.text}${UNDIM}` : `${x.mark} ${x.text}`);
    if (items.length <= MAX_LINES) return items.map(line);
    const show = MAX_LINES - 1;
    const start = Math.min(Math.max(0, (ix < 0 ? 0 : ix) - 1), items.length - show);
    return [...items.slice(start, start + show).map(line), `+${items.length - show} more`];
  }

  /** Redraw the status line (the TUI timer calls this every second so the elapsed time moves). */
  tick(): void {
    if (this.core.o.sink.interactive) this.refresh();
    this.heartbeat();
  }

  /** The heartbeat: a plain sentence (what, how far, what next) with a short stats tail. */
  heartbeatLine(): string {
    const c = this.core;
    return beatSentence({
      frames: c.frames.map((f) => ({ name: f.name, phase: f.phase ? { label: f.phase, i: f.i, n: f.n } : null })),
      declared: c.declared,
      cur: c.cur,
      todo: c.todo,
      calls: c.calls,
      elapsedMs: c.now() - c.start,
      tokens: fmtTok(c.prompt + c.completion),
    });
  }

  /** Called every tick: about every `heartbeatSeconds` post one line; skip when nothing happened, say "still waiting" after 3 skips. Never stops anything. */
  private heartbeat(): void {
    const c = this.core;
    const every = (c.o.heartbeatSeconds ?? 0) * 1000;
    if (c.finished || every <= 0) return;
    const now = c.now();
    if (now - c.beatAt < every) return;
    const idle = c.calls === c.beatCalls && c.steps === c.beatSteps;
    c.beatAt = now;
    c.beatCalls = c.calls;
    c.beatSteps = c.steps;
    let line: string | null = null;
    if (!idle) c.idleBeats = 0;
    else if (++c.idleBeats >= 3) line = waitingSentence(now - c.activeAt);
    if (!idle) line = this.heartbeatLine();
    if (!line) return;
    const s = c.o.sink;
    if (s.interactive) s.message(line, "beat");
    else s.err(line);
  }

  private refresh(phaseChange = false): void {
    const c = this.core;
    if (c.finished) return;
    const s = c.o.sink;
    const text = this.render();
    if (s.interactive) {
      s.status(text);
      const cl = this.checklist();
      s.widget(cl.length ? cl : undefined);
    } else if (phaseChange || c.stuck || (c.calls > 0 && c.calls % 5 === 0)) {
      s.err(text);
    }
  }

  // ------------------------------------------------------------ the end

  /** The end summary: outcome, what changed, calls, tokens (cached %), time, next step. `brief` (the text a model reads) leaves out calls, tokens and time. */
  summary(s: Summary | string = {}, brief = false): string {
    const c = this.core;
    const o = typeof s === "string" ? { text: s } : s;
    const outcome = o.outcome ?? "done";
    const files = o.files ?? this.changed;
    const shown = files.length > 3 ? `${files.slice(0, 3).join(", ")} (+${files.length - 3} more)` : files.join(", ");
    const tok = c.prompt + c.completion;
    const cache = c.cached ? ` (${Math.round((100 * c.cached) / c.prompt)}% cached)` : "";
    const body = [
      o.reason ?? o.text ?? "",
      shown && !(o.text ?? "").includes(files[0] ?? "\u0000") ? `changed ${shown}` : "",
      ...(brief ? [] : [`${c.calls} call${c.calls === 1 ? "" : "s"}`, `${fmtTok(tok)} tokens${cache}`, fmtTime(c.now() - c.start)]),
    ].filter(Boolean);
    return `${c.o.workflow} ${outcome}: ${body.join(", ")}` + (o.next ? `\nNext: ${o.next}` : "");
  }

  /** Stop the display, clear the status and the checklist, post the summary. Safe to call twice. */
  done(s: Summary | string = {}): string {
    const c = this.core;
    if (c.finished) return this.summary(s);
    const o = typeof s === "string" ? { text: s } : s;
    const text = `${endSentence(o.outcome ?? "done", o.text ?? "", o.reason)}\n${this.summary(s)}`;
    c.finished = true;
    if (c.timer) clearInterval(c.timer);
    c.unsub?.();
    c.o.sink.status(undefined);
    c.o.sink.widget(undefined);
    c.o.sink.message(text);
    return text;
  }

  fail(reason: string, extra: Omit<Summary, "outcome" | "reason"> = {}): string {
    return this.done({ ...extra, outcome: "failed", reason });
  }

  /** Stop the display without a summary (plain chat: Pi's own answer is the result). */
  clear(): void {
    const c = this.core;
    if (c.finished) return;
    c.finished = true;
    if (c.timer) clearInterval(c.timer);
    c.unsub?.();
    c.o.sink.status(undefined);
    c.o.sink.widget(undefined);
  }
}

export function createProgress(opts: ProgressOptions): Progress {
  return new Progress(opts);
}

/** A progress that shows nothing (for callers that do not track): every method is safe. */
export function quietProgress(workflow = "tinyCode"): Progress {
  return createProgress({ workflow, noLog: true, sink: { status() {}, widget() {}, message() {}, err() {}, interactive: false } });
}

/** Shared by workflows run without a caller that tracks them (unit tests, other workflows' helpers). */
export const NOOP_PROGRESS: Progress = quietProgress();
