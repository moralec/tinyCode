import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Lane {
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
  /** context size in tokens that Pi should assume for this lane's model (default 32768) */
  contextWindow?: number;
  /** per-reply output cap Pi uses for this lane's model (default 4096; was a fixed 4096 in the provider registration) */
  maxTokens?: number;
  /** sampling temperature sent with every request of this lane, 0-2 (default 0) */
  temperature?: number;
  /** sampling seed sent with every request of this lane (integer); absent = not sent */
  seed?: number;
}
export interface Step {
  lane: string;
  fallback: string | null;
}
export type OrchestrationMode = "auto" | "code" | "model";
export type LadderMode = "auto" | "ladder" | "pi";
/**
 * The workflows tinyCode may take over (`intercept`): the 11 workflow tools plus `ask`, which also covers the router's
 * "question; answer, no tool." hint for a request no workflow fits. `edit` is accepted for `edit_file`.
 */
export const INTERCEPTABLE = ["fix", "edit_file", "add", "explain", "test", "doc", "review", "commit", "plan", "build", "research", "ask"] as const;
export type StepName = "route" | "pick" | "edit" | "review" | "branch" | "hunk" | "plan" | "research" | "explain" | "doc" | "ask" | "commit" | "loop";

export interface Config {
  lanes: Record<string, Lane | null>;
  steps: Record<StepName, Step>;
  ladder: {
    rung2: boolean;
    rung3: boolean;
    /** rung 3 starts from the best ladder tree when it beats the original (true), or always from the original tree with a
     *  one-line note (false: Pi reasons from clean code, not from a half-wrong edit; the background best tree still guards) */
    keepBest: boolean;
    /** rung 1: a tree with exactly one non-test source file skips the pick call (that file is the pick) */
    skipSolePick: boolean;
    loopTurnCap: number;
    singleFileOnly: string[];
    /** rung 2: the reviewer is shown at most this many characters of the diff (cut at a line, with a marker line saying so) */
    reviewDiffChars: number;
    /** rung 2: each changed file is shown to the reviewer whole, at most this many lines (cut with a marker line saying so) */
    reviewFileLines: number;
    /** rung 2: the reviewer is shown the assertion block of at most this many failing tests */
    reviewFailBlocks: number;
    /** rung 2: the repository outline given to the reviewer is cut at this many characters; 0 = no outline */
    reviewOutlineChars: number;
    /** the hand-over of a kept ladder tree names at most this many still-failing tests */
    keptFailNames: number;
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
    /** normal masking: when the unmasked tool results older than keepRecentResults add up to more than this many tokens, all of them are masked in one batch, together with long arguments and replies in assistant messages older than keepRecentResults */
    maskAboveTokens: number;
    keepRecentResults: number;
    repeatBlockAt: number;
    /** interventions (refusals, nudges) in one run before tinyCode steps back and Pi works unguarded */
    stepBackAt: number;
    /** call budget for plain chat; 0 = none (tinyCode never aborts; rung 3 has its own ladder.loopTurnCap) */
    turnCap: number;
    /** an edit/write whose new text is bigger than this many tokens is refused (S4b): split it */
    editMaxTokens: number;
    /** compact the session (fold finished requests into one-line notes) when the context passes this share of the window; 0 = off */
    compactAt: number;
    /** Pi's own auto-compaction (extension, src/picompact.ts): it starts only when the context passes (1 - this) of the window (share, in (0, 1)); until then tinyCode's masking handles the context */
    piCompactReserve: number;
    /** Pi's own compaction keeps about this share of the window unsummarised (share, in (0, 1)); keep + reserve must stay <= 0.6 so one compaction ends well below the trigger */
    piKeepRecent: number;
    /** pressure masking: when the prompt passes this share of the window, old tool results, long tool-call arguments and long replies are masked (batched); 0 = off */
    pressureAt: number;
    /** a string argument or reply text in an older assistant message longer than this many characters is shortened (normal and pressure batches) */
    maskArgChars: number;
    /** tokens a reply needs after Pi's own 4096-token clamp (src/limits.ts usableTokens): pressureAt, piCompactReserve and the checkpoint backstop never sit above window - 4096 - this */
    outputReserve: number;
    /** milestone checkpoints (src/checkpoint.ts): at a milestone (new best test count, or an edit then tests at the best count), when the prompt is over this share of the usable prompt (window - 4096 - outputReserve: 10240 at 16k, 26624 at 32k), what was sent between the request and the milestone's turn is replaced by one note; 0 = off (also the backstop) */
    checkpointAt: number;
    /** a checkpoint must take out at least this share of the window (else no cache break for it) */
    checkpointMinSave: number;
    /** at least this many model calls between two milestone checkpoints (the backstop at the usable line ignores it) */
    checkpointGap: number;
    /** a file a workflow just wrote or kept for a hand-over is served whole on its first read (no view or result cap) when it has at most this many lines */
    freshFileLines: number;
    /** test runs in a row without beating the best: best restored, model told to stop and report (0 = off) */
    stuckTestRuns: number;
    /** "Tests still fail (x/y). Continue." follow-ups when the model ends its turn with failing tests, per request (0 = off) */
    autoContinue: number;
    /** the system prompt tells the model to write a file and run it when a debug script would pass this many lines */
    scriptLines: number;
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
  /** model: when the code router is unsure, ask the small lane (one call); false = unsure stays "none", no call */
  route: { enabled: boolean; model: boolean };
  /**
   * The workflows tinyCode takes over by itself (operator 2026-10-30, tally-1: its edge is `fix` and `test` only). A
   * workflow in the list gets the router hint, the direct run and its tool declared to the model. A request the router
   * gives to a workflow not in the list reaches Pi as plain Pi sees it: no hint line, no direct run, no todo nudge, its
   * tool not declared, and the system prompt names only the listed tools. Typed slash commands (/doc, /explain ...)
   * always work. The background layer (masking, working set, read memory, compaction, best tree) is on for every request.
   * Names: see INTERCEPTABLE (`ask` = the question hint). Default: ["fix","test"] (v1); [...INTERCEPTABLE] = every workflow.
   */
  intercept: string[];
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
    trunk: { baseUrl: DOOR, model: "tinycode-model", contextWindow: 32768, maxTokens: 4096 },
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
    // one shot (operator 2026-10-30, 16k window runs): rung 1 only, then Pi's loop; rung 2 cost 13 s and solved nothing there
    rung2: false,
    rung3: true,
    keepBest: true,
    skipSolePick: true,
    loopTurnCap: 20,
    singleFileOnly: [],
    reviewDiffChars: 3000,
    reviewFileLines: 250,
    reviewFailBlocks: 6,
    reviewOutlineChars: 1500,
    keptFailNames: 8,
    mode: "auto",
    adaptive: { minRuns: 10, minRungShare: 1 / 3, retryEvery: 20 },
  },
  // checkpointAt 0.55 (replay of the 59 recorded tinyCode runs, test/unit/replay-helper.ts): 16k paasio and sgf-parsing
  // get 3 and 2 checkpoints, the 16k passes (connect, bowling, dot-dsl) none; 32k: 6 checkpoints in 5 of 55 runs (0.45: 14 in 12,
  // and dot-dsl 16k gets one).
  limits: {
    toolResultTokens: 1500,
    viewLines: 100,
    maskAboveTokens: 1500,
    keepRecentResults: 2,
    repeatBlockAt: 2,
    stepBackAt: 3,
    turnCap: 0,
    editMaxTokens: 3000,
    compactAt: 0.6,
    piCompactReserve: 0.2,
    piKeepRecent: 0.25,
    pressureAt: 0.7,
    maskArgChars: 400,
    outputReserve: 2048,
    checkpointAt: 0.55,
    checkpointMinSave: 0.1,
    checkpointGap: 4,
    freshFileLines: 300,
    stuckTestRuns: 3,
    autoContinue: 1,
    scriptLines: 20,
    maxTokens: { pick: 300, edit: 4096, review: 600, branch: 180, hunk: 600, route: 200, plan: 2500, research: 200, explain: 400, doc: 1500, ask: 600, commit: 300 },
  },
  mode: "auto",
  progress: { stuckCalls: 25, heartbeatSeconds: 60 },
  research: { maxSteps: 8, maxTokens: 20000, resultChars: 3500, answerWords: 200 },
  // code router only (lite v1): an unsure request goes to plain Pi, no small-lane call
  route: { enabled: true, model: false },
  // v1 (operator 2026-10-30): tinyCode takes over only what it measured better at; everything else is plain Pi
  intercept: ["fix", "test"],
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

/** limits.piCompactReserve + limits.piKeepRecent may not exceed this: the trigger sits at 1 - reserve, so keep + summary then stays at least 0.4 + room below it */
export const PI_COMPACT_MAX_SUM = 0.6;

export class ConfigError extends Error {}

export function validate(cfg: Config): Config {
  if (cfg.mode !== "auto" && cfg.mode !== "dev") throw new ConfigError(`mode: must be "auto" or "dev", got ${JSON.stringify(cfg.mode)}`);
  if (!["auto", "code", "model"].includes(cfg.orchestration.mode))
    throw new ConfigError(`orchestration: mode must be "auto", "code" or "model", got ${JSON.stringify(cfg.orchestration.mode)}`);
  if (typeof cfg.orchestration.learn !== "boolean") throw new ConfigError("orchestration.learn: must be true or false");
  if (!(cfg.orchestration.minAgreement > 0 && cfg.orchestration.minAgreement <= 1)) throw new ConfigError("orchestration.minAgreement: must be in (0, 1]");
  for (const k of ["minDecisions", "window"] as const)
    if (!(Number.isInteger(cfg.orchestration[k]) && cfg.orchestration[k] > 0)) throw new ConfigError(`orchestration.${k}: must be a positive integer`);
  if (!Array.isArray(cfg.intercept) || cfg.intercept.some((n) => typeof n !== "string"))
    throw new ConfigError(`intercept: must be a list of workflow names (${INTERCEPTABLE.join(", ")}), got ${JSON.stringify(cfg.intercept)}`);
  const unknown = cfg.intercept.filter((n) => n !== "edit" && !(INTERCEPTABLE as readonly string[]).includes(n));
  if (unknown.length) throw new ConfigError(`intercept: unknown workflow ${unknown.map((n) => JSON.stringify(n)).join(", ")} (known: ${INTERCEPTABLE.join(", ")})`);
  cfg.intercept = [...new Set(cfg.intercept.map((n) => (n === "edit" ? "edit_file" : n)))];
  if (!["auto", "ladder", "pi"].includes(cfg.ladder.mode))
    throw new ConfigError(`ladder.mode: must be "auto", "ladder" or "pi" (Adaptive Ladder), got ${JSON.stringify(cfg.ladder.mode)}`);
  if (!(typeof cfg.limits.compactAt === "number" && cfg.limits.compactAt >= 0 && cfg.limits.compactAt <= 1)) throw new ConfigError("limits.compactAt: must be a share of the context window from 0 (off) to 1");
  if (!(typeof cfg.limits.pressureAt === "number" && cfg.limits.pressureAt >= 0 && cfg.limits.pressureAt <= 1)) throw new ConfigError("limits.pressureAt: must be a share of the context window from 0 (off) to 1");
  for (const k of ["piCompactReserve", "piKeepRecent"] as const)
    if (!(typeof cfg.limits[k] === "number" && cfg.limits[k] > 0 && cfg.limits[k] < 1)) throw new ConfigError(`limits.${k}: must be a share of the context window in (0, 1)`);
  if (cfg.limits.piCompactReserve + cfg.limits.piKeepRecent > PI_COMPACT_MAX_SUM + 1e-9)
    throw new ConfigError(`limits.piCompactReserve + limits.piKeepRecent: must be at most ${PI_COMPACT_MAX_SUM} (after a compaction the kept part plus the summary must sit well below the trigger at 1 - reserve)`);
  if (typeof cfg.ladder.skipSolePick !== "boolean") throw new ConfigError("ladder.skipSolePick: must be true or false");
  if (!(Number.isInteger(cfg.ladder.reviewDiffChars) && cfg.ladder.reviewDiffChars > 0)) throw new ConfigError("ladder.reviewDiffChars: must be a positive integer");
  for (const k of ["reviewFileLines", "reviewFailBlocks", "keptFailNames"] as const)
    if (!(Number.isInteger(cfg.ladder[k]) && cfg.ladder[k] > 0)) throw new ConfigError(`ladder.${k}: must be a positive integer`);
  if (!(Number.isInteger(cfg.ladder.reviewOutlineChars) && cfg.ladder.reviewOutlineChars >= 0)) throw new ConfigError("ladder.reviewOutlineChars: must be an integer >= 0 (0 = no outline)");
  if (!(Number.isInteger(cfg.limits.maskArgChars) && cfg.limits.maskArgChars > 0)) throw new ConfigError("limits.maskArgChars: must be a positive integer");
  if (!(Number.isInteger(cfg.limits.outputReserve) && cfg.limits.outputReserve >= 0)) throw new ConfigError("limits.outputReserve: must be an integer >= 0 (tokens)");
  if (!(typeof cfg.limits.checkpointAt === "number" && cfg.limits.checkpointAt >= 0 && cfg.limits.checkpointAt <= 1)) throw new ConfigError("limits.checkpointAt: must be a share of the context window from 0 (off) to 1");
  if (!(typeof cfg.limits.checkpointMinSave === "number" && cfg.limits.checkpointMinSave >= 0 && cfg.limits.checkpointMinSave < 1)) throw new ConfigError("limits.checkpointMinSave: must be a share of the context window in [0, 1)");
  if (!(Number.isInteger(cfg.limits.checkpointGap) && cfg.limits.checkpointGap >= 1)) throw new ConfigError("limits.checkpointGap: must be an integer >= 1 (model calls)");
  for (const k of ["maskAboveTokens", "scriptLines", "freshFileLines"] as const)
    if (!(Number.isInteger(cfg.limits[k]) && cfg.limits[k] > 0)) throw new ConfigError(`limits.${k}: must be a positive integer`);
  for (const k of ["stuckTestRuns", "autoContinue"] as const)
    if (!(Number.isInteger(cfg.limits[k]) && cfg.limits[k] >= 0)) throw new ConfigError(`limits.${k}: must be an integer >= 0 (0 = off)`);
  for (const [name, lane] of Object.entries(cfg.lanes)) {
    if (lane === null) continue;
    if (!isObj(lane) || typeof lane.baseUrl !== "string" || typeof lane.model !== "string" || !lane.baseUrl || !lane.model)
      throw new ConfigError(`lanes.${name}: needs baseUrl and model (strings), or null`);
    if (lane.contextWindow !== undefined && !(Number.isInteger(lane.contextWindow) && lane.contextWindow > 0))
      throw new ConfigError(`lanes.${name}.contextWindow: must be a positive integer`);
    if (lane.maxTokens !== undefined && !(Number.isInteger(lane.maxTokens) && lane.maxTokens > 0))
      throw new ConfigError(`lanes.${name}.maxTokens: must be a positive integer`);
    if (lane.temperature !== undefined && !(typeof lane.temperature === "number" && lane.temperature >= 0 && lane.temperature <= 2))
      throw new ConfigError(`lanes.${name}.temperature: must be a number from 0 to 2`);
    if (lane.seed !== undefined && !Number.isInteger(lane.seed))
      throw new ConfigError(`lanes.${name}.seed: must be an integer`);
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
