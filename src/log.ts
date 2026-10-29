// One JSON line per model call, appended to ~/.local/state/tinycode/calls.jsonl (override TINYCODE_LOG).
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface CallRecord {
  ts: string;
  session: string;
  workflow: string | null;
  step: string;
  lane: string;
  model: string;
  prompt_tokens: number;
  cached_tokens: number;
  completion_tokens: number;
  ms: number;
  /** HTTP status, or an error code/name when no response came back */
  status: number | string;
}

type Env = Record<string, string | undefined>;

export function logPath(env: Env = process.env): string {
  return env.TINYCODE_LOG || join(homedir(), ".local", "state", "tinycode", "calls.jsonl");
}

const listeners = new Set<(rec: CallRecord) => void>();

/** Subscribe to every logged call (the progress counters read the same records `/tinycode stats` reads). Returns the unsubscribe. */
export function onCall(fn: (rec: CallRecord) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Append one record. Never throws: a log that cannot be written must not break a workflow. */
export function logCall(rec: CallRecord, env: Env = process.env): void {
  for (const fn of listeners) {
    try {
      fn(rec);
    } catch {
      // a listener must not break a workflow
    }
  }
  try {
    const p = logPath(env);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(rec) + "\n");
  } catch {
    // ignore
  }
}

/** S19: one line per user request, `tools_first: yes|no|none`, beside the call log (tools-first.jsonl). Never throws. */
export function logToolsFirst(rec: Record<string, unknown>, env: Env = process.env): void {
  try {
    const p = join(dirname(logPath(env)), "tools-first.jsonl");
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(rec) + "\n");
  } catch {
    // ignore
  }
}

export function readCalls(env: Env = process.env): CallRecord[] {
  let text: string;
  try {
    text = readFileSync(logPath(env), "utf8");
  } catch {
    return [];
  }
  const out: CallRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as CallRecord);
    } catch {
      // skip a torn line
    }
  }
  return out;
}

/** Text for `/tinycode stats`: per step, calls and cache-hit % (cached / prompt tokens). */
export function formatStats(calls: CallRecord[]): string {
  if (!calls.length) return "no calls logged yet";
  const by = new Map<string, { n: number; prompt: number; cached: number; completion: number; ms: number }>();
  for (const c of calls) {
    const s = by.get(c.step) ?? { n: 0, prompt: 0, cached: 0, completion: 0, ms: 0 };
    s.n++;
    s.prompt += c.prompt_tokens || 0;
    s.cached += c.cached_tokens || 0;
    s.completion += c.completion_tokens || 0;
    s.ms += c.ms || 0;
    by.set(c.step, s);
  }
  const rows = ["step        calls  prompt_tok  cache-hit  avg_ms"];
  for (const [step, s] of [...by].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const hit = s.prompt ? `${Math.round((100 * s.cached) / s.prompt)}%` : "-";
    rows.push(`${step.padEnd(11)} ${String(s.n).padStart(5)}  ${String(s.prompt).padStart(10)}  ${hit.padStart(9)}  ${String(Math.round(s.ms / s.n)).padStart(6)}`);
  }
  return rows.join("\n");
}
