import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

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
export type StepName = "route" | "pick" | "edit" | "review" | "branch" | "hunk" | "plan" | "research" | "explain" | "doc" | "ask" | "commit" | "loop" | "digest";

export interface Config {
  lanes: Record<string, Lane | null>;
  steps: Record<StepName, Step>;
  ladder: {
    rung2: boolean;
    rung3: boolean;
    /** a second quick try after a failed rung 1 (and rung 2 when on), before rung 3: from the best tree when a rung beat the
     *  original (still-failing names, first error, current files), else a fresh sample of the rung-1 edit (lane seed + 1) */
    secondTry: boolean;
    /** quick tries (rung 1, second try): tokens kept free for the reply inside the lane's contextWindow; a prompt that would
     *  leave less is shrunk (outline, then passing tests, then test output, then the task text), else the quick tries are skipped */
    replyReserve: number;
    /** quick tries: prompt characters per token for the fit estimate (2.6: gemma-4-12b read the bowling rung-1 prompt at 2.62) */
    charsPerToken: number;
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
    /** E13: a direct run's `task` argument that repeats the user's request word for word is shown to the model as "(the request above)" (src/orchestrate.ts TASK_REF); off until measured */
    taskRef: boolean;
    /** E4: Pi's tool list and edit rules in the system prompt become one terse rule line (src/prompt.ts TERSE_RULES); off until measured */
    terseSystem: boolean;
    /** milestone checkpoints (src/checkpoint.ts): at a milestone (new best test count, or an edit then tests at the best count), when the prompt is over this share of the usable prompt (window - 4096 - outputReserve: 10240 at 16k, 26624 at 32k), what was sent between the request and the milestone's turn is replaced by one note; 0 = off (also the backstop) */
    checkpointAt: number;
    /** a checkpoint must take out at least this share of the window (else no cache break for it) */
    checkpointMinSave: number;
    /** at least this many model calls between two milestone checkpoints (the backstop at the usable line ignores it) */
    checkpointGap: number;
    /** a checkpoint keeps the current text of the files this request edited (most recently edited first) as one read turn,
     *  up to this share of the usable prompt; those reads count as served (re-read: "still above"); 0 = off (the note says read before edit) */
    checkpointKeepFiles: number;
    /** a milestone checkpoint within 2x the gap of the last one doubles the gap for the next (at most 4x checkpointGap); one later than that resets it to checkpointGap (the usable-line backstop ignores the gap) */
    checkpointBackoff: boolean;
    /** a "steady" milestone whose working tree (non-test files) is the one of the last checkpoint is skipped (the cut would rebuild the list the model just looped from) */
    checkpointSkipSame: boolean;
    /** Pi's loop keeps its best tree (src/besttree.ts): snapshot on each new best, "worse than best" line, restore_best,
     *  the stuck rule's restore and the end-of-request restore. false: counts are still tracked, nothing is kept or
     *  restored, so undoWorse and stuckTestRuns have nothing to act on (feature C12, docs/features/FEATURES.md) */
    loopBestTree: boolean;
    /** a `write` that replaces an existing file once a test has passed gets "Whole-file rewrite. Prefer edit." (feature C21) */
    rewriteNudge: boolean;
    /** with rewriteNudge: the line says what the rewrite threw away against the file's best-tree copy (cut to under half,
     *  top-level names dropped, Python that no longer parses) and that restore_best puts it back (feature E1,
     *  docs/designs/rewrite_guard.md). Off until measured. Needs loopBestTree */
    rewriteGuard: boolean;
    /** `restore_best` is declared from the request's start, not only once a best tree exists (it says "No best tree yet."
     *  until then), so the tool list does not change mid-run and the cached prefix holds (feature E12). Needs loopBestTree */
    restoreToolAlways: boolean;
    /** a run_tests result worse than the best (fewer pass or more fail) puts the best tree back at once, test files untouched, with one line; the same break 3 times: auto-restore off until a new best */
    undoWorse: boolean;
    /** undoWorse acts from the Nth time the same break (counts and failing names) is seen since the best: 1 = at once; 2 = a first break gets the "Worse than best" line and may be fixed forward */
    undoWorseFrom: number;
    /** Pi's edit failed with "Could not find": retried with whole lines compared after their indentation (one shift for all
     *  lines, exactly one place per edit, all edits[] or none, the replacement re-indented); "Found N occurrences": the
     *  result lists each occurrence's lines with the nearest line above and below (src/forgive.ts). Never a test file. */
    forgiveEdits: boolean;
    /** a file a workflow just wrote or kept for a hand-over is served whole on its first read (no view or result cap) when it has at most this many lines */
    freshFileLines: number;
    /** test runs in a row without beating the best: best restored, model told to stop and report (0 = off) */
    stuckTestRuns: number;
    /** "Tests still fail (x/y). Continue." follow-ups when the model ends its turn with failing tests, per request (0 = off) */
    autoContinue: number;
    /** the system prompt tells the model to write a file and run it when a debug script would pass this many lines */
    scriptLines: number;
    /** a project context file (AGENTS.md / CLAUDE.md in Pi's system prompt) over max(this, contextFileShare x the model's window) tokens is replaced by a digest of that size, an outline until the digest is made (src/context/digest.ts); 0 = off */
    contextFileTokens: number;
    /** share of the model's context window a context file may take before it is digested (the floor is contextFileTokens): 0.05 = 1.6k at 32k, 6.5k at 131k */
    contextFileShare: number;
    // ---- loop guards 2 (docs/designs/loop-guards-2/design.md): every key off by default, measured before it is turned on
    /** E28: after a step-back the masks made before it stay (README rule 14 as amended); no new mask after it, apart from the usable-line backstop */
    stepBackKeepsMasks: boolean;
    /** E27 rule 3: when /build starts, the plan's calls and results already in the context are masked (the plan is in .tinycode/plan.json) */
    retirePlan: boolean;
    /** E27 rule 2: a fresh file (freshFileLines) is served whole on its first read only up to this many lines; 0 = follow freshFileLines. Checkpoints' kept files keep reading freshFileLines */
    freshServeLines: number;
    /** E24: run_tests' limit is clamp(this x the request's longest clean run, 30 s, 300 s); 300 s before a clean run and right after a timeout; 0 = off (300 s always). Suggested 10 */
    testTimeScale: number;
    /** E24: a bash/powershell call that runs tests and sets no timeout of its own gets this many seconds (the scaled limit when testTimeScale is on and it is smaller); kept after a step-back; 0 = off. Suggested 120 */
    bashTestSeconds: number;
    /** E23: a bash/powershell call whose command has more lines than this is refused once (write the script to a file); the same call sent again is served; 0 = off. Armed value 40 (2 x scriptLines) */
    bashMaxLines: number;
    /** E23: a write whose content has more lines than this is refused once (write part, add the rest with edit); the same call sent again is served; 0 = off. Armed value 150 */
    writeMaxLines: number;
    /** E22: a snapshot of the original tree once per request (lazily, before the first change); the same failure 3 runs in a row offers `restore_best to=start` (declared from the request's start); a fresh-attempt state while the model rebuilds. Needs loopBestTree (ignored without it, like rewriteGuard) */
    startOver: boolean;
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
    /** recorded GitHub/web responses (absolute path to a JSON file; design research-replay): /research answers every
     * fetch from it, makes no GitHub or web call and no DNS query, and stops with the reason when it cannot be used.
     * null (default) = the network, as always. For benches and tests. */
    replay: string | null;
    /** E19 (design research-grounding): project, vendored or pinned code questions go to `find` first, library and
     * prior-art questions to GitHub first; a source that fails once (network failure, HTTP 401/403/429) is dropped for
     * the run. false (default) = today's prompt and no drop. */
    localFirst: boolean;
    /** E20 (design research-grounding): `find` results inside /research carry their cited lines read from tracked
     * files; the summary returns 1-4 facts with quotes checked by code; the trunk sees the facts first and a check
     * request on the STATUS done line. false (default) = today's summary and result. */
    grounded: boolean;
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
   * C20, strict-template fix (src/alternate.ts): models whose chat template refuses a user message after a tool result or
   * another user message (Mistral/Devstral with --jinja). Matched case-insensitively as a substring of the model id; only
   * those get the merge. Others are left alone: on hybrid models (Qwen3.5/3.6) folding the per-turn tail into the last
   * tool result breaks the prompt cache every turn (~1.7k recomputed tokens per call, bench/pairs/cachebreak.py).
   * [] = off for every model; ["*"] = every model (the behaviour of 1f452ef).
   */
  strictRoles: string[];
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
  /** test.command: the project's test command, run in cwd through the shell; `{test}` in it becomes the named test file (quoted), or nothing when the whole suite runs */
  test: { python: string; command: string | null };
  /** languages tinyCode treats as its own beyond Python (design languages-and-oracles): "ts" = TypeScript/JavaScript
   * (file list, undo, outline, the project's own npm test). "py" is always on. Default ["py","ts"]: "ts" on since the gate passed (FEATURES D8, 2026-11-10); ["py"] turns it off. */
  languages: string[];
  /** design plan-build-fit: /plan and /build stages, each off until measured (FEATURES rule) */
  stages: {
    /** E21: a second plan call over the files the draft's tasks name (plus their imports and importers); tasks may carry a check */
    planReview: boolean;
    /** E21b: /build runs a task's own check (from the saved plan) as part of its test, shows it in the task header,
     * and, under wholeCheck, re-runs earlier tasks' checks (stale-check?). Separate from planReview (Addendum 2) */
    buildChecks: boolean;
    /** E21: characters of file text the review call is shown (at least 1000) */
    planReadChars: number;
    /** E25: the whole suite after each /build task (plus earlier tasks' checks under buildChecks); one repair */
    wholeCheck: boolean;
  };
}

/** the values config `languages` accepts */
export const LANGUAGES = ["py", "ts"] as const;

const DOOR = "http://127.0.0.1:8080/v1";
/** the context size assumed for a lane that sets no contextWindow (Pi's provider registration and the ladder's quick tries) */
export const DEFAULT_CONTEXT_WINDOW = 32768;

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
    // context-file digests (operator 2026-11-02): one background call per file version, the small lane by default
    digest: { lane: "small", fallback: null },
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
    // a second quick try (issue #10): connect 16k, rung 1 passed in 38 s when its first idea landed, 10 min in Pi when not
    secondTry: true,
    // 8k window (P4000 bowling): rung 1 sent 7.1k tokens and its reply hit the window at 1110 tokens, nothing applied
    replyReserve: 2048,
    charsPerToken: 2.6,
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
    taskRef: false,
    terseSystem: false,
    checkpointAt: 0.55,
    checkpointMinSave: 0.1,
    checkpointGap: 4,
    // steadiness (operator 2026-10-30, dot-dsl / bowling 16k r3 at the 10-minute cap: 16 and 14 checkpoints, each one
    // dropping the edited file, the model re-reading it, the same cycle again)
    checkpointKeepFiles: 0.25,
    checkpointBackoff: true,
    checkpointSkipSame: true,
    loopBestTree: true,
    rewriteNudge: true,
    rewriteGuard: false,
    restoreToolAlways: false,
    undoWorse: true,
    // 2: only a repeated break (operator 2026-10-30). The 16k v2 passes went through worse trees and fixed forward
    // (bowling r2 28/31 -> 3/31 -> 25/31 -> 31/31, paasio r3 22 -> 12 -> 23 -> 25, sgf r1 16 -> 6 -> 18); 1 = at once
    undoWorseFrom: 2,
    // Nemotron-Nano-9B-v2 16k (runs-radar 2026-10-30, tinyCode arm): 37 of 72 "Could not find" edits had the right lines
    // under one indentation shift (dot-dsl 35 of 36), retried unchanged until the 10-minute cap
    forgiveEdits: true,
    freshFileLines: 300,
    stuckTestRuns: 3,
    autoContinue: 1,
    scriptLines: 20,
    // operator 2026-11-02: a 78 KB CLAUDE.md filled ~20k of a 32k window; ~1.5k tokens keeps the rules, not the history
    contextFileTokens: 1500,
    // operator 2026-11-02: the budget grows with the window (131k gpt-oss): digest still, but keep more of the file
    contextFileShare: 0.05,
    // loop guards 2: off until measured (FEATURES E22-E24, E27, E28)
    stepBackKeepsMasks: false,
    retirePlan: false,
    freshServeLines: 0,
    testTimeScale: 0,
    bashTestSeconds: 0,
    bashMaxLines: 0,
    writeMaxLines: 0,
    startOver: false,
    maxTokens: { pick: 300, edit: 4096, review: 600, branch: 180, hunk: 600, route: 200, plan: 2500, research: 200, explain: 400, doc: 1500, ask: 600, commit: 300 },
  },
  mode: "auto",
  progress: { stuckCalls: 25, heartbeatSeconds: 60 },
  research: { maxSteps: 8, maxTokens: 20000, resultChars: 3500, answerWords: 200, replay: null, localFirst: false, grounded: false },
  // code router only (lite v1): an unsure request goes to plain Pi, no small-lane call
  route: { enabled: true, model: false },
  // v1 (operator 2026-10-30): tinyCode takes over only what it measured better at; everything else is plain Pi
  intercept: ["fix", "test"],
  strictRoles: ["*"],
  orchestration: { mode: "auto", learn: true, minDecisions: 20, minAgreement: 0.9, window: 50 },
  test: { python: "python3", command: null },
  languages: ["py", "ts"],
  stages: { planReview: true, buildChecks: false, planReadChars: 8000, wholeCheck: false },
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
  // E17 was denied and removed on 2026-11-12: a config that still sets it is told so, not silently ignored
  if ("acceptance" in cfg)
    throw new ConfigError('acceptance: removed on 2026-11-12 (E17, the acceptance check written from the request, was denied); delete the "acceptance" block from the config');
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
  if (!Array.isArray(cfg.strictRoles) || cfg.strictRoles.some((n) => typeof n !== "string" || !n))
    throw new ConfigError(`strictRoles: must be a list of model-id substrings (or ["*"]), got ${JSON.stringify(cfg.strictRoles)}`);
  if (cfg.research.replay !== null && (typeof cfg.research.replay !== "string" || !isAbsolute(cfg.research.replay)))
    throw new ConfigError(`research.replay: must be null or an absolute path to a recording file, got ${JSON.stringify(cfg.research.replay)}`);
  for (const k of ["localFirst", "grounded"] as const)
    if (typeof cfg.research[k] !== "boolean") throw new ConfigError(`research.${k}: must be true or false`);
  if (!Array.isArray(cfg.languages) || cfg.languages.some((n) => !(LANGUAGES as readonly unknown[]).includes(n)) || !cfg.languages.includes("py"))
    throw new ConfigError(`languages: must be a list of ${LANGUAGES.map((l) => JSON.stringify(l)).join(", ")} that includes "py", got ${JSON.stringify(cfg.languages)}`);
  if (!["auto", "ladder", "pi"].includes(cfg.ladder.mode))
    throw new ConfigError(`ladder.mode: must be "auto", "ladder" or "pi" (Adaptive Ladder), got ${JSON.stringify(cfg.ladder.mode)}`);
  if (!(typeof cfg.limits.compactAt === "number" && cfg.limits.compactAt >= 0 && cfg.limits.compactAt <= 1)) throw new ConfigError("limits.compactAt: must be a share of the context window from 0 (off) to 1");
  if (!(typeof cfg.limits.pressureAt === "number" && cfg.limits.pressureAt >= 0 && cfg.limits.pressureAt <= 1)) throw new ConfigError("limits.pressureAt: must be a share of the context window from 0 (off) to 1");
  for (const k of ["piCompactReserve", "piKeepRecent"] as const)
    if (!(typeof cfg.limits[k] === "number" && cfg.limits[k] > 0 && cfg.limits[k] < 1)) throw new ConfigError(`limits.${k}: must be a share of the context window in (0, 1)`);
  if (cfg.limits.piCompactReserve + cfg.limits.piKeepRecent > PI_COMPACT_MAX_SUM + 1e-9)
    throw new ConfigError(`limits.piCompactReserve + limits.piKeepRecent: must be at most ${PI_COMPACT_MAX_SUM} (after a compaction the kept part plus the summary must sit well below the trigger at 1 - reserve)`);
  if (typeof cfg.ladder.skipSolePick !== "boolean") throw new ConfigError("ladder.skipSolePick: must be true or false");
  if (typeof cfg.ladder.secondTry !== "boolean") throw new ConfigError("ladder.secondTry: must be true or false");
  if (!(Number.isInteger(cfg.ladder.replyReserve) && cfg.ladder.replyReserve > 0)) throw new ConfigError("ladder.replyReserve: must be a positive integer (tokens)");
  if (!(typeof cfg.ladder.charsPerToken === "number" && cfg.ladder.charsPerToken >= 1 && cfg.ladder.charsPerToken <= 8)) throw new ConfigError("ladder.charsPerToken: must be a number from 1 to 8");
  if (!(Number.isInteger(cfg.ladder.reviewDiffChars) && cfg.ladder.reviewDiffChars > 0)) throw new ConfigError("ladder.reviewDiffChars: must be a positive integer");
  for (const k of ["reviewFileLines", "reviewFailBlocks", "keptFailNames"] as const)
    if (!(Number.isInteger(cfg.ladder[k]) && cfg.ladder[k] > 0)) throw new ConfigError(`ladder.${k}: must be a positive integer`);
  if (!(Number.isInteger(cfg.ladder.reviewOutlineChars) && cfg.ladder.reviewOutlineChars >= 0)) throw new ConfigError("ladder.reviewOutlineChars: must be an integer >= 0 (0 = no outline)");
  if (!(Number.isInteger(cfg.limits.maskArgChars) && cfg.limits.maskArgChars > 0)) throw new ConfigError("limits.maskArgChars: must be a positive integer");
  if (!(Number.isInteger(cfg.limits.outputReserve) && cfg.limits.outputReserve >= 0)) throw new ConfigError("limits.outputReserve: must be an integer >= 0 (tokens)");
  if (typeof cfg.limits.terseSystem !== "boolean") throw new ConfigError("limits.terseSystem: must be true or false");
  if (typeof cfg.limits.taskRef !== "boolean") throw new ConfigError("limits.taskRef: must be true or false");
  if (!(typeof cfg.limits.checkpointAt === "number" && cfg.limits.checkpointAt >= 0 && cfg.limits.checkpointAt <= 1)) throw new ConfigError("limits.checkpointAt: must be a share of the context window from 0 (off) to 1");
  if (!(typeof cfg.limits.checkpointMinSave === "number" && cfg.limits.checkpointMinSave >= 0 && cfg.limits.checkpointMinSave < 1)) throw new ConfigError("limits.checkpointMinSave: must be a share of the context window in [0, 1)");
  if (!(Number.isInteger(cfg.limits.checkpointGap) && cfg.limits.checkpointGap >= 1)) throw new ConfigError("limits.checkpointGap: must be an integer >= 1 (model calls)");
  if (!(typeof cfg.limits.checkpointKeepFiles === "number" && cfg.limits.checkpointKeepFiles >= 0 && cfg.limits.checkpointKeepFiles < 1)) throw new ConfigError("limits.checkpointKeepFiles: must be a share of the usable prompt in [0, 1) (0 = off)");
  for (const k of ["checkpointBackoff", "checkpointSkipSame", "loopBestTree", "rewriteNudge", "rewriteGuard", "restoreToolAlways", "undoWorse", "forgiveEdits"] as const)
    if (typeof cfg.limits[k] !== "boolean") throw new ConfigError(`limits.${k}: must be true or false`);
  if (!(Number.isInteger(cfg.limits.undoWorseFrom) && cfg.limits.undoWorseFrom >= 1)) throw new ConfigError("limits.undoWorseFrom: must be an integer >= 1 (1 = at once)");
  for (const k of ["maskAboveTokens", "scriptLines", "freshFileLines"] as const)
    if (!(Number.isInteger(cfg.limits[k]) && cfg.limits[k] > 0)) throw new ConfigError(`limits.${k}: must be a positive integer`);
  if (!(typeof cfg.limits.contextFileShare === "number" && cfg.limits.contextFileShare >= 0 && cfg.limits.contextFileShare < 1)) throw new ConfigError("limits.contextFileShare: must be a share of the context window in [0, 1)");
  for (const k of ["stuckTestRuns", "autoContinue", "contextFileTokens"] as const)
    if (!(Number.isInteger(cfg.limits[k]) && cfg.limits[k] >= 0)) throw new ConfigError(`limits.${k}: must be an integer >= 0 (0 = off)`);
  // loop guards 2 (docs/designs/loop-guards-2/design.md)
  for (const k of ["stepBackKeepsMasks", "retirePlan", "startOver"] as const)
    if (typeof cfg.limits[k] !== "boolean") throw new ConfigError(`limits.${k}: must be true or false`);
  for (const k of ["freshServeLines", "bashTestSeconds", "bashMaxLines", "writeMaxLines"] as const)
    if (!(Number.isInteger(cfg.limits[k]) && cfg.limits[k] >= 0)) throw new ConfigError(`limits.${k}: must be an integer >= 0 (0 = off)`);
  if (!(typeof cfg.limits.testTimeScale === "number" && Number.isFinite(cfg.limits.testTimeScale) && cfg.limits.testTimeScale >= 0))
    throw new ConfigError("limits.testTimeScale: must be a finite number >= 0 (0 = off)");
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
  // design plan-build-fit (E21a, E21b, E25)
  for (const k of ["planReview", "buildChecks", "wholeCheck"] as const)
    if (typeof cfg.stages[k] !== "boolean") throw new ConfigError(`stages.${k}: must be true or false, got ${JSON.stringify(cfg.stages[k])}`);
  if (!(Number.isInteger(cfg.stages.planReadChars) && cfg.stages.planReadChars >= 1000))
    throw new ConfigError(`stages.planReadChars: must be an integer of at least 1000, got ${JSON.stringify(cfg.stages.planReadChars)}`);
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
