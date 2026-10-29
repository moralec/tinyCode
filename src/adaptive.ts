// Adaptive Ladder: tinyCode learns which approach solves tasks most efficiently for each model.
// Every /fix run appends {ts, model, started, solved_by} to fix-runs.jsonl in tinyCode's state dir (next to calls.jsonl).
// Rule (auto mode): every model starts on the ladder (rungs 1-2, then Pi). Once a model has `minRuns` ladder runs, if
// rungs 1-2 solved fewer than `minRungShare` of the last `minRuns`, it starts at Pi's loop. Every `retryEvery`th run
// with the model re-tries the ladder, so a model can win it back. No model names here.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Config } from "./config.ts";
import { logPath } from "./log.ts";

export interface RunRecord {
  ts?: string | number;
  model: string;
  /** where the run started; absent = "ladder" (round-2 bakeoff rows) */
  started?: "ladder" | "pi";
  solved_by: string;
}
export type Start = "ladder" | "pi";
export interface Decision {
  start: Start;
  why: string;
  /** rungs 1-2 solves / ladder runs in the window */
  solved: number;
  runs: number;
}

type Env = Record<string, string | undefined>;
type Adaptive = Config["ladder"]["adaptive"];

export function runsPath(env: Env = process.env): string {
  return join(dirname(logPath(env)), "fix-runs.jsonl");
}

export function logRun(rec: RunRecord, env: Env = process.env): void {
  try {
    const p = runsPath(env);
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(rec) + "\n");
  } catch {
    // never break a workflow over a log
  }
}

export function readRuns(env: Env = process.env): RunRecord[] {
  let text: string;
  try {
    text = readFileSync(runsPath(env), "utf8");
  } catch {
    return [];
  }
  const out: RunRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as RunRecord;
      if (typeof r.model === "string" && typeof r.solved_by === "string") out.push(r);
    } catch {
      // skip a torn line
    }
  }
  return out;
}

/** Where the next /fix run with `model` should start. `runs` = that model's past records, oldest first. */
export function decide(mode: Config["ladder"]["mode"], a: Adaptive, model: string, runs: RunRecord[]): Decision {
  const mine = runs.filter((r) => r.model === model);
  const ladderRuns = mine.filter((r) => (r.started ?? "ladder") === "ladder").slice(-a.minRuns);
  const solved = ladderRuns.filter((r) => r.solved_by === "rung1" || r.solved_by === "rung2").length;
  const base = { solved, runs: ladderRuns.length };
  if (mode === "ladder") return { start: "ladder", why: "mode ladder", ...base };
  if (mode === "pi") return { start: "pi", why: "mode pi", ...base };
  const next = mine.length + 1;
  if (ladderRuns.length < a.minRuns) return { start: "ladder", why: `learning (${ladderRuns.length}/${a.minRuns} ladder runs)`, ...base };
  if (solved / ladderRuns.length >= a.minRungShare) return { start: "ladder", why: "checklist solves enough", ...base };
  if (a.retryEvery > 0 && next % a.retryEvery === 0) return { start: "ladder", why: `retry (run ${next})`, ...base };
  return { start: "pi", why: "checklist solves too few", ...base };
}

/** `/tinycode stats` lines, one per model: "gemma-4-12b: checklist solves 90 % (9/10) → ladder". */
export function formatAdaptive(cfg: Config, runs: RunRecord[]): string {
  const models = [...new Set(runs.map((r) => r.model))].sort();
  const head = `Adaptive Ladder (mode ${cfg.ladder.mode})`;
  if (!models.length) return `${head}\nno /fix runs logged yet`;
  const rows = models.map((m) => {
    const d = decide(cfg.ladder.mode, cfg.ladder.adaptive, m, runs);
    const pct = d.runs ? Math.round((100 * d.solved) / d.runs) : 0;
    return `${m}: checklist solves ${pct} % (${d.solved}/${d.runs}) → ${d.start}${cfg.ladder.mode === "auto" ? "" : ` (${d.why})`}`;
  });
  return [head, ...rows].join("\n");
}
