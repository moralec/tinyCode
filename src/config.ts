import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Lane {
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
  /** context size in tokens that Pi should assume for this lane's model (default 32768) */
  contextWindow?: number;
}
export interface Step {
  lane: string;
  fallback: string | null;
}
export type OrchestrationMode = "auto" | "code" | "model";
export type LadderMode = "auto" | "ladder" | "pi";
export type StepName = "route" | "pick" | "edit" | "review" | "branch" | "hunk" | "plan" | "research" | "explain" | "doc" | "ask" | "commit" | "loop" | "say";

export interface Config {
  lanes: Record<string, Lane | null>;
  steps: Record<StepName, Step>;
  ladder: {
    rung2: boolean;
    rung3: boolean;
    loopTurnCap: number;
    singleFileOnly: string[];
    /** Adaptive Ladder: "auto" learns per model, "ladder" always rungs 1-2 then Pi, "pi" always straight to Pi's loop */
    mode: LadderMode;
    adaptive: {
      /** /fix runs on the ladder with a model before the first decision */
      minRuns: number;
      /** below this share of rung 1-2 solves (over the last minRuns ladder runs) the model starts at Pi's loop */
      minRungShare: number;
      /** every Nth /fix run with a model re-tries the ladder */
      retryEvery: number;
    };
  };
  limits: {
    toolResultTokens: number;
    viewLines: number;
    maskAboveTokens: number;
    keepRecentResults: number;
    repeatBlockAt: number;
    /** interventions (refusals, nudges) in one run before tinyCode steps back and Pi works unguarded */
    stepBackAt: number;
    /** call budget for plain chat; 0 = none (tinyCode never aborts; rung 3 has its own ladder.loopTurnCap) */
    turnCap: number;
    /** an edit/write whose new text is bigger than this many tokens is refused (S4b): split it */
    editMaxTokens: number;
    maxTokens: Record<string, number>;
  };
  /** "auto" (default): tinyCode asks no diagnostic questions; "dev": shows stuck confirm, router hint, events, per-call tokens (/dev on|off) */
  mode: "auto" | "dev";
  /** progress display: calls without a phase step or a changed file before the status line says "looks stuck" (tinyCode never stops a run by itself) */
  progress: { stuckCalls: number; /** seconds between heartbeat lines in the chat (0 = off) */ heartbeatSeconds: number };
  /** /research (S13): hard caps for the research branch */
  research: {
    /** tool steps before the summary call */
    maxSteps: number;
    /** prompt + completion tokens over all calls of one research run; the summary call is allowed to finish */
    maxTokens: number;
    /** characters of one tool result shown to the model */
    resultChars: number;
    /** words in the returned answer */
    answerWords: number;
  };
  route: { enabled: boolean };
  /**
   * Who chooses the workflow ("code decides, the model speaks"). Setting `orchestration` to a plain string ("auto", "code"
   * or "model") is shorthand for `{ mode: <string> }`.
   *   code:  whenever the router has a workflow, tinyCode runs it directly; the model says one sentence before and reports after.
   *   model: the model chooses with the workflows as tools and the router hint (the S19 behaviour).
   *   auto:  router confident (code decided, with a workflow) -> direct run; unsure, question or chat -> the model chooses.
   */
  orchestration: {
    mode: OrchestrationMode;
    /** auto: a model whose own choices agree with the router often enough is handed unsure and confident cases alike */
    learn: boolean;
    /** decisions of that model needed before the switch (the most recent `window` count) */
    minDecisions: number;
    /** share of those decisions that matched the router (0.9 = 90 %) */
    minAgreement: number;
    window: number;
  };
  test: { python: string; command: string | null };
}

const DOOR = "http://127.0.0.1:8080/v1";

export const DEFAULTS: Config = {
  lanes: {
    trunk: { baseUrl: DOOR, model: "tinycode-model", contextWindow: 32768 },
    small: { baseUrl: DOOR, model: "tinycode-model", contextWindow: 32768 },
    cloud: null,
  },
  steps: {
    route: { lane: "small", fallback: null },
    pick: { lane: "trunk", fallback: null },
    edit: { lane: "trunk", fallback: null },
    review: { lane: "trunk", fallback: null },
    branch: { lane: "small", fallback: null },
    hunk: { lane: "small", fallback: null },
    // the one step where judgement about structure matters: trunk by default, "cloud" allowed when configured
    plan: { lane: "trunk", fallback: null },
    // research branch (tool choice + summary): the small lane by default, like the other branches
    research: { lane: "small", fallback: null },
    // /explain: one call that reads code and answers with citations; trunk by default
    explain: { lane: "trunk", fallback: null },
    // /doc: docstring batches and the readme/overview calls (S17); trunk by default
    doc: { lane: "trunk", fallback: null },
    // /ask (general question, no tools) and /commit (message from the staged diff): the small lane by default (S18)
    ask: { lane: "small", fallback: null },
    commit: { lane: "small", fallback: null },
    loop: { lane: "trunk", fallback: null },
    // the one sentence before a directly run workflow (orchestration): trunk, so the sentence is in the model's own voice
    say: { lane: "trunk", fallback: null },
  },
  // Defaults set from the round-2 ladder runs (our round-2 benchmark, contender "ladder"):
  //  - gemma-4-12b: 10/10 at 3.1 calls and ~5.6k prompt tokens per task (8 rung 1, 1 rung 2, 1 Pi); tc1 alone 9/10,
  //    bare Pi 7/10 at 144k. The Adaptive Ladder keeps it on the ladder.
  //  - qwen3.5-4b: ladder 9/10 but 6 of 10 solved by Pi; tc1 alone 5/10, bare Pi 10/10 at about the same tokens.
  //    The one ladder miss (r2-05) was Pi starting from a half-edited tree. The Adaptive Ladder moves it to Pi's
  //    loop after 10 runs (rungs 1-2 solved 3/10 < 1/3); rung 3 always restores the tree first.
  //  - Adaptive Ladder (operator 2026-10-29): mode "auto" starts every model on the ladder, learns from fix-runs.jsonl,
  //    and re-tries the ladder every 20th run. No model names here.
  //  - singleFileOnly is empty by default (no model names in defaults); a user may list a trunk model there to skip
  //    rung 1 when several files are picked. The 4B's multi-file miss (r2-03) is handled by the Adaptive Ladder.
  //  - rung2 stays on: 2 of 20 ladder tasks were solved by rung 2 (gemma r2-07, 4B r2-08).
  //  - loopTurnCap 20: rung 3 needed at most 20 Pi calls (4B r2-09: 23 total - 3 direct) and 11 on gemma (r2-06).
  //  - steps.review stays on the trunk lane: ladder-r4b (review on the 4B) has no rows yet.
  ladder: {
    rung2: true,
    rung3: true,
    loopTurnCap: 20,
    singleFileOnly: [],
    mode: "auto",
    adaptive: { minRuns: 10, minRungShare: 1 / 3, retryEvery: 20 },
  },
  limits: {
    toolResultTokens: 1500,
    viewLines: 100,
    maskAboveTokens: 6000,
    keepRecentResults: 2,
    repeatBlockAt: 2,
    stepBackAt: 3,
    turnCap: 0,
    editMaxTokens: 3000,
    maxTokens: { pick: 300, edit: 3000, review: 220, branch: 180, hunk: 250, route: 200, plan: 2500, research: 200, explain: 400, doc: 1500, ask: 600, commit: 300, say: 60 },
  },
  mode: "auto",
  progress: { stuckCalls: 25, heartbeatSeconds: 60 },
  research: { maxSteps: 8, maxTokens: 20000, resultChars: 3500, answerWords: 200 },
  route: { enabled: true },
  orchestration: { mode: "auto", learn: true, minDecisions: 20, minAgreement: 0.9, window: 50 },
  test: { python: "python3", command: null },
};

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** Deep merge: objects merge key by key; arrays, scalars and null replace. */
export function deepMerge(base: unknown, over: unknown): unknown {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out: Json = { ...base };
  for (const k of Object.keys(over)) out[k] = k in base ? deepMerge(base[k], over[k]) : over[k];
  return out;
}

export class ConfigError extends Error {}

export function validate(cfg: Config): Config {
  if (cfg.mode !== "auto" && cfg.mode !== "dev") throw new ConfigError(`mode: must be "auto" or "dev", got ${JSON.stringify(cfg.mode)}`);
  if (!["auto", "code", "model"].includes(cfg.orchestration.mode))
    throw new ConfigError(`orchestration: mode must be "auto", "code" or "model", got ${JSON.stringify(cfg.orchestration.mode)}`);
  if (typeof cfg.orchestration.learn !== "boolean") throw new ConfigError("orchestration.learn: must be true or false");
  if (!(cfg.orchestration.minAgreement > 0 && cfg.orchestration.minAgreement <= 1)) throw new ConfigError("orchestration.minAgreement: must be in (0, 1]");
  for (const k of ["minDecisions", "window"] as const)
    if (!(Number.isInteger(cfg.orchestration[k]) && cfg.orchestration[k] > 0)) throw new ConfigError(`orchestration.${k}: must be a positive integer`);
  if (!["auto", "ladder", "pi"].includes(cfg.ladder.mode))
    throw new ConfigError(`ladder.mode: must be "auto", "ladder" or "pi" (Adaptive Ladder), got ${JSON.stringify(cfg.ladder.mode)}`);
  for (const [name, lane] of Object.entries(cfg.lanes)) {
    if (lane === null) continue;
    if (!isObj(lane) || typeof lane.baseUrl !== "string" || typeof lane.model !== "string" || !lane.baseUrl || !lane.model)
      throw new ConfigError(`lanes.${name}: needs baseUrl and model (strings), or null`);
    if (lane.contextWindow !== undefined && !(Number.isInteger(lane.contextWindow) && lane.contextWindow > 0))
      throw new ConfigError(`lanes.${name}.contextWindow: must be a positive integer`);
  }
  for (const [name, step] of Object.entries(cfg.steps)) {
    for (const key of ["lane", "fallback"] as const) {
      const ref = step[key];
      if (key === "fallback" && ref === null) continue;
      if (typeof ref !== "string" || !(ref in cfg.lanes))
        throw new ConfigError(`steps.${name}.${key}: unknown lane ${JSON.stringify(ref)}`);
      if (cfg.lanes[ref] === null) throw new ConfigError(`steps.${name}.${key}: lane "${ref}" is null (not configured)`);
    }
  }
  return cfg;
}

export function configPath(env: Record<string, string | undefined> = process.env): string {
  return env.TINYCODE_CONFIG || join(homedir(), ".config", "tinycode", "config.json");
}

/** Defaults deep-merged with the user file (absent file = defaults), then validated. */
export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const path = configPath(env);
  let user: unknown = {};
  try {
    user = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new ConfigError(`${path}: ${(e as Error).message}`);
  }
  return mergeConfig(user);
}

export function mergeConfig(user: unknown): Config {
  // shorthand: "orchestration": "code" means { "mode": "code" }
  if (isObj(user) && typeof user.orchestration === "string") user = { ...user, orchestration: { mode: user.orchestration } };
  return validate(deepMerge(structuredClone(DEFAULTS), user) as Config);
}
