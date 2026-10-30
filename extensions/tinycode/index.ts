import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatAdaptive, readRuns } from "../../src/adaptive.ts";
import { DEFAULT_CONTEXT_WINDOW, loadConfig, configPath, type Config, type Lane } from "../../src/config.ts";
import { findAnswer, registerBranchTools, registerTodoTool } from "../../src/branch.ts";
import { chat, SESSION } from "../../src/llm.ts";
import { createLimits, readCutMarker, sizeTokens, toolCallVerdict, usableTokens, windowHash, withTail } from "../../src/limits.ts";
import { buildNote, Checkpointer, milestoneOf, requestStart, requestText, touchedFiles } from "../../src/checkpoint.ts";
import { parseCounts } from "../../src/testrun.ts";
import { existsSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { formatStats, logCall, logToolsFirst, readCalls } from "../../src/log.ts";
import { makeIndexCache, route, type Routed } from "../../src/router.ts";
import { agreement, asToolTurn, choose, DoneGuard, dropDisplayOnly, formatOrchestration, logDecision, logDirect, rateFor, readDecisions, readLog, resultMessage, runDirect, scopeAfter, scopeBefore, targetOf, type DirectCall } from "../../src/orchestrate.ts";
import { confirmFor, explicitlyAsked, isDev, modeState, parseDevArgs, setMode } from "../../src/mode.ts";
import { CUSTOM_SAY, entersRawWork, forTool, intercepts, isWorkflowTool, registerWorkflowTools, ToolDiet, toolSet, ToolsFirst, triage, type ToolOutcome, type ToolRunner, type WorkflowTool } from "../../src/tools.ts";
import { composePrompt } from "../../src/prompt.ts";
import { BestTree, LOOP_SLOT, rewriteNudge } from "../../src/besttree.ts";
import { endProgress, live, startProgress, uiSink } from "../../src/progress-ui.ts";
import { createProgress, type Progress, type Summary } from "../../src/progress.ts";
import { BUILD_PHASES, parseBuildArgs, runBuild } from "../../src/workflows/build.ts";
import { Compactor } from "../../src/compact.ts";
import { loadPrepareCompaction, runPiCompact } from "../../src/picompact.ts";
import { compact as piCompact } from "@earendil-works/pi-coding-agent";
import { wrongPathHint } from "../../src/pathhint.ts";
import { ADD_PHASES, parseAddArgs, runAdd } from "../../src/workflows/add.ts";
import { ASK_PHASES, parseAskArgs, runAsk } from "../../src/workflows/ask.ts";
import { COMMIT_PHASES, parseCommitArgs, runCommit } from "../../src/workflows/commit.ts";
import { EXPLAIN_PHASES, parseExplainArgs, runExplain } from "../../src/workflows/explain.ts";
import { parseTestArgs, runTestGen, TEST_PHASES } from "../../src/workflows/testgen.ts";
import { DOC_PHASES, docArgsFromText, parseDocArgs, readmeHeadingLevels, runDoc, type DocArgs } from "../../src/workflows/doc.ts";
import { findReadme, README_PHASES, README_UPDATE_PHASES } from "../../src/workflows/docreadme.ts";
import { EDIT_PHASES, parseEditArgs, runEdit } from "../../src/workflows/edit.ts";
import { PLAN_PHASES, parsePlanArgs, runPlan } from "../../src/workflows/plan.ts";
import { formatResearch, parseResearchArgs, RESEARCH_PHASES, runResearch } from "../../src/workflows/research.ts";
import { parseReviewArgs, REVIEW_PHASES, runReview } from "../../src/workflows/review.ts";
import { FIX_PHASES, handoverText, isTestPath, parseFixArgs, restoreSnapshot, runFix, takeSnapshot, treeHash, undoFix, type PiHandoff } from "../../src/workflows/fix.ts";

export default function (pi: ExtensionAPI) {
  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (e) {
    const msg = (e as Error).message;
    pi.registerCommand("tinycode", { description: "tinyCode: show config", handler: async (_a, ctx) => { ctx.ui.notify(`tinyCode config error: ${msg}`, "error"); } });
    return;
  }

  setMode(cfg.mode);

  // One provider "tinycode"; one model per distinct local lane model (all lanes share the door baseUrl in defaults).
  const seen = new Map<string, Lane>();
  for (const lane of Object.values(cfg.lanes)) if (lane && !lane.apiKeyEnv && !seen.has(lane.model)) seen.set(lane.model, lane);
  const first = [...seen.values()][0];
  if (first) {
    pi.registerProvider("tinycode", {
      name: "tinyCode (door)",
      baseUrl: first.baseUrl,
      apiKey: "noop",
      api: "openai-completions",
      models: [...seen.values()].map((l) => ({
        id: l.model,
        name: l.model,
        reasoning: false,
        input: ["text" as const],
        contextWindow: l.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        maxTokens: l.maxTokens ?? 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        samplingParams: { temperature: l.temperature ?? 0, ...(l.seed !== undefined ? { seed: l.seed } : {}), chat_template_kwargs: { enable_thinking: false } },
        compat: { supportsDeveloperRole: false, supportsStore: false, supportsReasoningEffort: false, maxTokensField: "max_tokens" as const },
        ...(l.baseUrl !== first.baseUrl ? { baseUrl: l.baseUrl } : {}),
      })),
    });
  }

  const tm = toolManager(pi, cfg.limits.stuckTestRuns, cfg.limits.autoContinue, cfg.limits.undoWorse, cfg.limits.undoWorseFrom);
  registerBranchTools(pi, cfg, {
    tree: tm.best,
    snapshot: (cwd) => void takeSnapshot(cwd, process.env, LOOP_SLOT),
    restore: (cwd) => restoreSnapshot(cwd, process.env, LOOP_SLOT),
    // undo a worse run at once (limits.undoWorse): never a test file
    undo: cfg.limits.undoWorse ? (cwd) => restoreSnapshot(cwd, process.env, LOOP_SLOT, isTestPath) : undefined,
    onFirstBest: () => tm.sync(),
  });
  const loop = wireLimits(pi, cfg, tm);
  registerFix(pi, cfg, loop);
  registerEdit(pi, cfg, loop);
  registerAdd(pi, cfg, loop);
  registerExplain(pi, cfg);
  registerAsk(pi, cfg);
  registerCommit(pi, cfg);
  registerTestGen(pi, cfg);
  registerDoc(pi, cfg);
  registerReview(pi, cfg);
  registerPlan(pi, cfg);
  registerResearch(pi, cfg);
  registerBuild(pi, cfg, loop);
  registerTools(pi, cfg, loop);
  registerDev(pi);

  pi.registerCommand("tinycode", {
    description: "tinyCode: show the effective config. /tinycode stats: calls per step, the Adaptive Ladder (which start each model has learned) and orchestration (how often each model agrees with the router)",
    handler: async (args, ctx) => {
      const text = String(args ?? "").trim() === "stats"
        ? `${formatStats(readCalls())}\n\n${formatAdaptive(cfg, readRuns())}\n\n${formatOrchestration(cfg, readLog())}`
        : `tinyCode mode: ${modeState.mode}${isDev() ? " (dev: stuck confirm, router hint, events and per-call tokens are shown)" : " (auto: no diagnostic questions)"}\ntinyCode config (${configPath()}):\n${JSON.stringify(cfg, null, 2)}`;
      // Print/json mode has no UI: ctx.ui.notify is a no-op there (verified, PX section 10 item a), so write to stdout.
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else process.stdout.write(text + "\n");
    },
  });
}

/** the "tests still fail, continue" message tinyCode adds when the model stops early (it is model context) */
const CUSTOM_CONTINUE = "tinycode-continue";

/** /dev on|off: dev mode for this session (shows the stuck confirm, the router hint, events, per-call tokens). */
function registerDev(pi: ExtensionAPI): void {
  pi.registerCommand("dev", {
    description: "tinyCode: /dev on|off toggles dev mode for this session (auto = no diagnostic questions; dev = stuck confirm, router hint, events, per-call tokens)",
    handler: async (args, ctx) => {
      const m = parseDevArgs(String(args ?? ""));
      const text = m === null ? "usage: /dev on|off" : (setMode(m), `tinyCode mode: ${m}`);
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else process.stdout.write(text + "\n");
    },
  });
}

/**
 * Which tools the model sees (src/tools.ts `toolSet`): Pi's active set at the start of the request, cut to the loop tools
 * once the request is in raw-tool work (the diet), plus `restore_best` once a best tree exists. Every call is safe: an
 * older Pi without the tool-set API simply keeps all tools.
 */
function toolManager(pi: ExtensionAPI, stuckTestRuns: number, autoContinue: number, undoWorse = false, undoWorseFrom = 1) {
  const best = new BestTree(stuckTestRuns, autoContinue, undoWorse, undoWorseFrom);
  const diet = new ToolDiet();
  let baseline: string[] | null = null;
  const sync = (): void => {
    try {
      if (!baseline) return;
      const want = toolSet(baseline, { diet: diet.on, best: best.has });
      const cur = pi.getActiveTools();
      if (want.length !== cur.length || want.some((n, i) => n !== cur[i])) pi.setActiveTools(want);
    } catch {
      // no tool-set API: all tools stay
    }
  };
  const read = (): string[] | null => {
    try {
      return pi.getActiveTools();
    } catch {
      return null;
    }
  };
  return {
    best,
    diet,
    sync,
    /** a new user request: Pi's active set is the new baseline, no diet, no best tree */
    newRequest(): void {
      if (!diet.on) baseline = read() ?? baseline;
      diet.leave();
      best.reset();
      sync();
    },
    /** the request is in raw-tool work */
    enterRaw(): void {
      if (!diet.enter()) return;
      baseline ??= read();
      sync();
    },
  };
}

/** Pi-loop limits (S4): repeat guard, view cap, result cap, batched masking, turn cap, per-turn call log. */
function wireLimits(pi: ExtensionAPI, cfg: Config, tm: ReturnType<typeof toolManager>): LoopControl {
  const lim = createLimits(cfg.limits, SESSION);
  const compactor = new Compactor(cfg.limits.compactAt);
  // milestone checkpoints (src/checkpoint.ts): a successful edit/write since the last test run, and that run's text
  const ckpt = new Checkpointer(cfg.limits.checkpointAt, cfg.limits.checkpointMinSave, cfg.limits.checkpointGap, { keepFiles: cfg.limits.checkpointKeepFiles, backoff: cfg.limits.checkpointBackoff, skipSame: cfg.limits.checkpointSkipSame });
  let editedSinceTests = false;
  let lastTestText = "";
  const loopLane = cfg.steps.loop.lane;
  registerTodoTool(pi, lim.todo);
  const ctl: LoopControl = {
    nextTurnCap: undefined,
    started: undefined,
    ended: undefined,
    turns: () => lim.turns.count,
    runTool: undefined,
    onHandoff: (h, changed, cwd) => {
      // a hand-over: the files the workflow wrote are read whole once, and its tree is the loop's first best
      for (const f of changed) lim.fresh.add(f);
      tm.best.seed(h.tree, () => void takeSnapshot(cwd, process.env, LOOP_SLOT));
      tm.sync();
    },
  };
  const wholeReads = new Set<string>();
  const rewrites = new Set<string>();

  // Plain chat gets the same progress as a workflow (status line, checklist from the model's todo, calls, tokens, cache %).
  // Inside a workflow's rung 3 the workflow's own progress is live: the loop feeds its todo and its calls into that one.
  let own: Progress | null = null;
  const shown = (): Progress | null => live.current ?? own;
  const sync = () => {
    const p = shown();
    if (!p) return;
    p.setTodo(lim.todo.steps);
    p.note("step", lim.stepped ? "stepped back" : "");
    if (lim.stepped !== wasStepped) {
      wasStepped = lim.stepped;
      if (lim.stepped && isDev() && lastCtx?.hasUI) lastCtx.ui.notify(`dev: tinyCode stepped back (${lim.stepBackReason ?? "interventions"})`, "info");
    }
  };
  let wasStepped = false;
  let lastCtx: ExtensionContext | null = null;

  pi.on("agent_start", (_e, ctx) => {
    lastCtx = ctx;
    wasStepped = false;
    lim.newRun(ctl.nextTurnCap);
    if (!live.current && ctx.hasUI) {
      // only the live progress draws: while a workflow tool runs, the chat progress stays quiet (it flickered with it)
      const base = uiSink(pi, ctx);
      const mine = () => live.current === own;
      const sink = { ...base, status: (t: string) => mine() && base.status(t), widget: (l?: string[]) => mine() && base.widget(l) };
      own = createProgress({ workflow: "chat", sink, stuckCalls: cfg.progress.stuckCalls, heartbeatSeconds: cfg.progress.heartbeatSeconds, timer: true, showCache: true });
      live.current = own;
    }
    ctl.started?.();
  });

  // S19: fixed text appended to Pi's system prompt (same text every run, so the cache holds): tinyCode's tools first (rule 15),
  // then the S4b working method for raw tools. The router is only a hint: one tail line per request, no model call, no interception.
  const indexFor = makeIndexCache();
  const first = new ToolsFirst();
  // the empty-todo nudge fires only when no tinyCode tool fits and the request is not a question
  let nudgeTodo = true;
  const insideWorkflow = () => ctl.nextTurnCap !== undefined || (live.current !== null && live.current !== own);
  // Adaptive orchestration (src/orchestrate.ts): "code decides, the model speaks".
  // `input` (auto and code modes only) routes the user's text and, when the router is confident, records the plan; the text
  // itself always passes through untouched. The run happens in before_agent_start, after Pi has recorded the user's message,
  // so the transcript reads: user, the model's sentence, the workflow's progress, then the model's report.
  // The route is computed once per request and reused by before_agent_start.
  const doneGuard = new DoneGuard();
  let routedOnce: { text: string; r: Routed } | null = null;
  let plan: { text: string; call: DirectCall; r: Routed } | null = null;
  // the router's tool for a code-decided request the model chooses for: its first call is compared with it
  let agree: { request: string; tool: string | null } | null = null;
  // config `intercept`: this request went to a workflow tinyCode does not take over (plain Pi), and whether the model
  // changed a file in it; such a request gets the "tests still fail, continue" follow-up only after its own edit
  let plain = false;
  let edited = false;
  const modelId = (ctx: ExtensionContext | undefined): string => ctx?.model?.id ?? "";
  const routeOnce = async (text: string, cwd: string): Promise<Routed> => {
    if (routedOnce?.text === text) return routedOnce.r;
    const r = await route(text, indexFor(cwd), chat, cfg.route.model);
    routedOnce = { text, r };
    return r;
  };
  const showSay = (ctx: ExtensionContext, sentence: string): void => {
    // the sentence is the assistant's message; with a UI a custom message (the context hook folds it into the tool turn), else stdout
    if (ctx.hasUI) pi.sendMessage({ customType: CUSTOM_SAY, content: sentence, display: true, details: { direct: true } });
    else process.stdout.write(sentence + "\n");
  };
  pi.on("input", async (e, ctx) => {
    plan = null;
    const text = String(e.text ?? "").trim();
    if (cfg.orchestration.mode === "model" || !cfg.route.enabled || !text || text.startsWith("/") || e.source === "extension" || insideWorkflow()) return { action: "continue" as const };
    try {
      const r = await routeOnce(text, ctx.cwd);
      const rate = cfg.orchestration.learn ? rateFor(cfg.orchestration, modelId(ctx), readDecisions()) : null;
      // config `intercept`: a workflow tinyCode does not take over is never run directly (plain Pi gets the request)
      const ch = choose(cfg.orchestration, r, rate, cfg.intercept);
      if (ch.direct) plan = { text, call: ch.direct, r };
    } catch {
      plan = null;
    }
    return { action: "continue" as const };
  });
  pi.on("before_agent_start", async (e, ctx) => {
    // the tools-first line names only the intercepted workflow tools (config `intercept`)
    const systemPrompt = composePrompt(e.systemPrompt, cfg.limits.scriptLines, cfg.intercept);
    const text = String((e as { prompt?: string }).prompt ?? "").trim();
    if (text && !insideWorkflow()) modeState.lastPrompt = text;
    // not for a workflow's own hand-off (rung 3), not for slash commands, not for an empty prompt
    if (!text || text.startsWith("/") || insideWorkflow()) return { systemPrompt };
    doneGuard.reset();
    agree = null;
    plain = false;
    edited = false;
    lim.fresh.clear();
    wholeReads.clear();
    rewrites.clear();
    tm.newRequest();
    ckpt.reset();
    editedSinceTests = false;
    lastTestText = "";
    if (plan && plan.text === text && ctl.runTool) {
      // router confident: tinyCode runs the workflow; the model said one sentence before and reports after (its turn starts next)
      const p = plan;
      plan = null;
      nudgeTodo = false;
      first.start(text, null, { source: p.r.source, tokens: p.r.prompt_tokens + p.r.completion_tokens, ms: p.r.ms });
      // the request's named files and `names`, checked after the run: a run that left some alone is partial, not done
      const read = (f: string): string | null => {
        try {
          return readFileSync(resolve(ctx.cwd, f), "utf8");
        } catch {
          return null;
        }
      };
      const scope = () => {
        const b = scopeBefore(text, indexFor(ctx.cwd).files, read);
        return () => scopeAfter(b, indexFor(ctx.cwd).files, read);
      };
      const res = await runDirect({ show: (s) => showSay(ctx, s), run: (c) => ctl.runTool!(c.tool, c.params, ctx), scope }, p.call);
      doneGuard.record(res.call.tool, res.status, targetOf(res.call.params));
      if (entersRawWork({ tool: res.call.tool, text: res.text })) tm.enterRaw();
      logDirect({ model: modelId(ctx), tool: res.call.tool, status: res.status, request: text.replace(/\s+/g, " ").slice(0, 160) });
      return { systemPrompt, message: resultMessage(res) };
    }
    plan = null;
    let hint: { tool: string | null; line: string } | null = null;
    nudgeTodo = true;
    let cost: { source?: string; tokens?: number; ms?: number } = {};
    if (cfg.route.enabled) {
      // the router's full path: code first, the small-lane call only when code is unsure (src/router.ts)
      try {
        const r = await routeOnce(text, ctx.cwd);
        // config `intercept`: a workflow tinyCode does not take over is "no workflow": no hint line, no todo nudge, no agreement record
        const t = triage(r, cfg.intercept);
        plain = !intercepts(cfg.intercept, r);
        hint = t.hint;
        nudgeTodo = t.nudgeTodo;
        cost = { source: r.source, tokens: r.prompt_tokens + r.completion_tokens, ms: r.ms };
        if (hint && r.source === "code" && r.confident) agree = { request: text, tool: hint.tool };
      } catch {
        hint = null;
      }
    }
    first.start(text, hint?.tool ?? null, cost);
    return hint ? { systemPrompt, message: { customType: "tinycode-hint", content: hint.line, display: isDev() } } : { systemPrompt };
  });

  pi.on("agent_end", (_e, ctx) => {
    const rec = first.finish();
    if (rec) logToolsFirst({ ...rec });
    // the model answered without a tool call: that is its choice too (no workflow)
    if (rec && agree) logDecision(agreement(modelId(ctx), agree.request, agree.tool, null));
    agree = null;
    if (own) {
      own.clear();
      if (live.current === own) live.current = null;
      own = null;
    }
    ctl.ended?.();
  });

  // The model stopped with failing tests: one continuation, as a user would type it (src/besttree.ts continueLine).
  // agent_before_settle is Pi's hook for "one last continuation"; a sendUserMessage at agent_end was dropped (connect on
  // c35db37: no follow-up). The continuation has no prompt, so before_agent_start does not treat it as a new request.
  pi.on("agent_before_settle", (e, ctx) => {
    if (e.outcome !== "completed" || insideWorkflow()) return undefined;
    // a plain request (not intercepted) that only looked at failing tests (explain, review) is not told to continue
    const more = plain && !edited ? null : tm.best.continueLine();
    if (more) return { entries: [{ type: "custom_message" as const, customType: CUSTOM_CONTINUE, content: more, display: true }], continue: true };
    // ending for good: never below the best tree (src/besttree.ts endRestore)
    const back = tm.best.endRestore(() => restoreSnapshot(ctx.cwd, process.env, LOOP_SLOT));
    return back ? { entries: [{ type: "custom_message" as const, customType: CUSTOM_CONTINUE, content: back, display: true }] } : undefined;
  });

  pi.on("turn_end", () => {
    sync();
  });

  // A call budget, never an abort: over it, tool calls are refused with "answer now" and a rung-3 hand-off is released
  // so the command returns and Pi exits normally.
  pi.on("turn_start", () => {
    if (lim.turns.turnStarted()) ctl.ended?.();
  });

  pi.on("tool_call", (e, ctx) => {
    // Rung 3 of a workflow is Pi's loop: it must not call a workflow tool again (that would nest a run inside a run).
    if (ctl.nextTurnCap !== undefined && isWorkflowTool(e.toolName)) return { block: true, reason: "In workflow loop. Use read, edit, write, bash, find, run_tests only." };
    // A workflow tinyCode ran for this request with STATUS: done is not run again on the same target (a refusal the model reads, never an abort).
    const again = isWorkflowTool(e.toolName) ? doneGuard.check(e.toolName, targetOf(e.input)) : null;
    if (again) return { block: true, reason: again };
    // The tools-first nudge (rule 14: one tail line, never a block).
    const nudge = first.onCall(e.toolName);
    if (nudge) lim.tailNotes.push(nudge);
    const firstRec = first.takeFirst();
    if (firstRec) logToolsFirst({ ...firstRec });
    if (firstRec && agree) {
      logDecision(agreement(modelId(ctx), agree.request, agree.tool, firstRec.first));
      agree = null;
    }
    if (isDev() && ctx.hasUI && firstRec) ctx.ui.notify(`dev: tools-first ${firstRec.tools_first} (first call ${firstRec.first}, hint ${firstRec.hint ?? "none"}${nudge ? ", nudged" : ""})`, "info");
    if (!insideWorkflow() && entersRawWork({ call: e.toolName })) tm.enterRaw();
    if (e.toolName === "write") {
      const target = resolve(ctx.cwd, String((e.input as Record<string, unknown>).path ?? (e.input as Record<string, unknown>).file_path ?? ""));
      if (rewriteNudge("write", existsSync(target), tm.best.has)) rewrites.add(e.toolCallId);
    }
    const v = toolCallVerdict(lim, cfg.limits, e.toolName, e.input as Record<string, unknown>, {
      resolvePath: (p) => resolve(ctx.cwd, p),
      windowHash: (p, offset, limit) => {
        try {
          return windowHash(readFileSync(p, "utf8"), offset, limit);
        } catch {
          return "missing"; // unreadable: let Pi report the error
        }
      },
      lineCount: (p) => {
        try {
          return readFileSync(p, "utf8").split("\n").length;
        } catch {
          return -1;
        }
      },
    });
    if (v.action === "allow" && v.whole) wholeReads.add(e.toolCallId);
    return v.action === "allow" ? undefined : { block: true, reason: v.reason };
  });

  pi.on("tool_result", (e, ctx) => {
    lim.guard.result(e.toolName, e.input, e.isError);
    if (e.toolName === "todo") sync();
    else if (!e.isError && (e.toolName === "edit" || e.toolName === "write")) {
      edited = true;
      editedSinceTests = true;
      shown()?.touch(String(e.input.path ?? e.input.file_path ?? ""));
    }
    const parts = e.content.filter((p) => p.type === "text") as { type: "text"; text: string }[];
    if (e.toolName === "run_tests") {
      // a milestone (src/checkpoint.ts): the best tree has already seen this run (src/branch.ts run_tests)
      lastTestText = parts.map((p) => p.text).join("");
      const kind = milestoneOf(tm.best.verdict, editedSinceTests, parseCounts(lastTestText));
      // the tree is hashed only for a steady milestone (the one the same-tree rule can skip)
      ckpt.tests(kind, e.toolCallId, kind === "steady" || kind === "best" ? treeHash(ctx.cwd) : undefined);
      if (ckpt.lastSkipped)
        logCall({ ts: new Date().toISOString(), session: SESSION, workflow: "pi", step: "checkpoint_skip", lane: "", model: "", prompt_tokens: 0, cached_tokens: 0, completion_tokens: 0, ms: 0, status: `steady: same tree as the last checkpoint (${ckpt.skipped} this request)` });
      editedSinceTests = false;
    }
    if (parts.length !== e.content.length || !parts.length) return undefined;
    let text = parts.map((p) => p.text).join("");
    // a workflow tool that did not finish (no STATUS: done): the model carries on with raw tools, so the tool diet starts
    if (!insideWorkflow() && entersRawWork({ tool: e.toolName, text })) tm.enterRaw();
    let changed = false;
    // a read that stops early says so in one explicit line (a cut file must not read as a finished one)
    const cut = e.toolName === "read" && !e.isError ? readCutMarker(text, e.input) : null;
    if (cut !== null) {
      text = cut;
      changed = true;
    }
    // a mistyped project path: say where the project is and which file was meant (src/pathhint.ts)
    const hint = wrongPathHint(ctx.cwd, e.toolName, e.input, e.isError, text);
    if (hint) {
      text += `\n${hint}`;
      changed = true;
    }
    // a whole-file rewrite once tests pass: a nudge, never a block
    if (rewrites.delete(e.toolCallId) && !e.isError) {
      text += `\n${rewriteNudge("write", true, true)}`;
      changed = true;
    }
    const capped = wholeReads.delete(e.toolCallId) ? null : lim.cap(text);
    return capped === null && !changed ? undefined : { content: [{ type: "text" as const, text: capped ?? text }] };
  });

  // Pi's own compaction, sized for the window (src/picompact.ts, F7): cancelled while tinyCode's masking can still
  // handle the context; over the line, redone with window-sized keep/reserve so it ends well below the trigger.
  pi.on("session_before_compact", async (e, ctx) => {
    const m = ctx.model;
    const started = Date.now();
    const out = await runPiCompact({
      windowTokens: m?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      reason: e.reason,
      tokensBefore: e.preparation.tokensBefore,
      reserveShare: cfg.limits.piCompactReserve,
      keepShare: cfg.limits.piKeepRecent,
      ceilingTokens: usableTokens(m?.contextWindow ?? DEFAULT_CONTEXT_WINDOW, cfg.limits.outputReserve),
      selfManaged: cfg.limits.checkpointAt > 0,
      branchEntries: e.branchEntries,
      deps: async () => {
        if (!m) throw new Error("no model selected");
        const prepare = await loadPrepareCompaction();
        const auth = await ctx.modelRegistry.getApiKeyAndHeaders(m);
        if (!auth.ok) throw new Error(`no auth for ${m.provider}/${m.id}: ${auth.error}`);
        const model = auth.baseUrl ? { ...m, baseUrl: auth.baseUrl } : m;
        return { prepare, compact: (prep) => piCompact(prep as never, model, auth.apiKey, auth.headers as never, e.customInstructions, e.signal, undefined, undefined, auth.env) as never };
      },
    });
    logCall({
      ts: new Date().toISOString(),
      session: SESSION,
      workflow: "pi",
      step: "pi_compact",
      lane: loopLane,
      model: m?.id ?? "",
      prompt_tokens: out.tokensBefore,
      cached_tokens: 0,
      completion_tokens: out.summaryTokens,
      ms: Date.now() - started,
      status: out.status,
    });
    if (out.why) process.stderr.write(`tinyCode: pi_compact ${out.status === "passed" ? "passed to Pi" : "cancelled"} (${out.why})\n`);
    if (out.status === "resized" && ctx.hasUI) ctx.ui.notify(`tinyCode: compacted Pi's context at window size: ${out.tokensBefore} tokens before, summary ${out.summaryTokens} tokens`, "info");
    return out.result as never;
  });

  pi.on("context", (e, ctx) => {
    // a direct run's result is shown to the model as its own tool's output (assistant sentence + tool call + tool result)
    const m = ctx.model;
    const turned0 = m ? (asToolTurn(e.messages as never, { id: m.id, provider: m.provider, api: m.api }) as typeof e.messages | undefined) : undefined;
    // heartbeats and stuck lines are for the human only
    const shown = dropDisplayOnly((turned0 ?? e.messages) as never) as typeof e.messages;
    const turned = shown !== (turned0 ?? e.messages) ? shown : turned0;
    // compaction (src/compact.ts): over limits.compactAt of the window, finished requests become one note each (batched)
    let system = 0;
    try {
      system = String(ctx.getSystemPrompt?.() ?? "").length;
    } catch {
      system = 0;
    }
    const folded = compactor.apply((turned ?? e.messages) as never, m?.contextWindow ?? DEFAULT_CONTEXT_WINDOW, system) as typeof e.messages | undefined;
    if (compactor.last && ctx.hasUI) ctx.ui.notify(`tinyCode: compacted ${compactor.last.folded} finished request(s): context ${compactor.last.tokensBefore} -> ${compactor.last.tokensAfter} tokens`, "info");
    const unchecked = folded ?? turned ?? e.messages;
    const window = m?.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
    const usable = usableTokens(window, cfg.limits.outputReserve);
    // milestone checkpoints (src/checkpoint.ts): at a milestone, what lies between the request and the milestone's turn
    // becomes one note; over the usable line the last turn is the cut (backstop). Stepped back: no new milestone ones.
    const checked = ckpt.apply(unchecked as never, {
      windowTokens: window,
      systemChars: system,
      usableTokens: usable,
      milestones: !lim.stepped,
      view: (ms) => (lim.stepped ? ms : (lim.masker.view(ms as never) as never)),
      // kept files: the current text on disk, read now (the extension marks these reads as served below)
      fileText: (p) => {
        try {
          return readFileSync(resolve(ctx.cwd, p), "utf8");
        } catch {
          return null;
        }
      },
      maxFileLines: cfg.limits.freshFileLines,
      pathKey: (p) => resolve(ctx.cwd, p),
      note: (showTests, kept) => {
        const msgs = unchecked as never as Parameters<typeof touchedFiles>[0];
        const req = requestStart(msgs);
        return buildNote({
          // a Pi summary at the head already states the goal: no Task line from it
          request: msgs[req]?.role === "user" ? requestText(msgs[req]) : "",
          best: tm.best.best,
          bestRun: tm.best.bestRunNo,
          last: tm.best.lastCounts,
          lastText: lastTestText,
          showTests,
          kept: kept.map((p) => relative(ctx.cwd, resolve(ctx.cwd, p)) || p),
          files: touchedFiles(msgs.slice(Math.max(0, req)), ctx.cwd),
          steps: lim.todo.steps,
          notes: lim.todo.notes,
        });
      },
    }) as typeof e.messages | undefined;
    const cp = ckpt.last;
    if (cp) {
      lim.reads.reset(); // the reads are gone from what the model sees: a re-read is served
      // ... except the kept files: their text is right after the note, so a re-read is pointed at it
      for (const f of cp.kept) lim.reads.serve(resolve(ctx.cwd, f.path), f.text, lim.turns.count, cfg.limits.viewLines);
      const keptNote = cp.kept.length ? `, kept ${cp.kept.map((f) => relative(ctx.cwd, resolve(ctx.cwd, f.path)) || f.path).join(" ")}` : "";
      logCall({ ts: new Date().toISOString(), session: SESSION, workflow: "pi", step: "checkpoint", lane: "", model: "", prompt_tokens: cp.tokensBefore, cached_tokens: 0, completion_tokens: 0, ms: 0, status: `${cp.kind}: ${cp.tokensBefore} -> ${cp.tokensAfter} tokens (${cp.removed} messages, note ${cp.noteChars} chars${keptNote}, gap ${cp.gap})` });
      if (ctx.hasUI) ctx.ui.notify(`tinyCode: checkpoint (${cp.kind}): context ${cp.tokensBefore} -> ${cp.tokensAfter} tokens`, "info");
    }
    const messages = checked ?? unchecked;
    // pressure masking (src/limits.ts): over limits.pressureAt of the window (never above the usable line), old results,
    // long call arguments and long replies are masked (batched). The size counts characters too (sizeTokens), and a kept
    // reply's stale usage is zeroed by the checkpoint, so this also catches what a cut could not take out.
    const pressure = { windowTokens: window, systemChars: system, ceilingTokens: usable };
    let masked = lim.mask(messages as never, pressure);
    // never send a request over the usable line unmasked, not even stepped back (then masking is otherwise off)
    if (lim.stepped && usable > 0 && sizeTokens(messages as never, system) > usable) masked = lim.masker.apply(messages as never, pressure);
    const left = sizeTokens((masked ?? messages) as never, system);
    if (usable > 0 && left > usable)
      logCall({ ts: new Date().toISOString(), session: SESSION, workflow: "pi", step: "over_line", lane: "", model: "", prompt_tokens: left, cached_tokens: 0, completion_tokens: 0, ms: 0, status: `${left} tokens after checkpoint and masking, usable ${usable}` });
    const pressed = lim.masker.lastPressure;
    if (pressed && ctx.hasUI) ctx.ui.notify(`tinyCode: context pressure, masked ${pressed.results} old result(s) and ${pressed.calls} old reply(ies): ${pressed.tokensBefore} -> ${pressed.tokensAfter} tokens`, "info");
    // S4b: the todo and notes go last, as a user message (tail only: the prefix and the cache stay as they were).
    const out = withTail(masked ?? (messages as never), lim.todo, lim.outputLimitHit, lim.tailNotes.splice(0), nudgeTodo) ?? masked ?? (checked || folded || turned ? (messages as never) : undefined);
    return out ? { messages: out as never } : undefined;
  });

  pi.on("message_end", (e, ctx) => {
    const m = e.message as { role: string; model?: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }; stopReason?: string };
    if (m.role !== "assistant" || !m.usage) return;
    lim.outputLimitHit = m.stopReason === "length";
    if (isDev() && ctx.hasUI) ctx.ui.notify(`dev: call ${m.usage.input + m.usage.cacheRead + m.usage.cacheWrite} prompt (${m.usage.cacheRead} cached) + ${m.usage.output} completion tokens`, "info");
    logCall({
      ts: new Date().toISOString(),
      session: SESSION,
      workflow: "pi",
      step: "loop",
      lane: loopLane,
      model: m.model ?? "",
      prompt_tokens: m.usage.input + m.usage.cacheRead + m.usage.cacheWrite,
      cached_tokens: m.usage.cacheRead,
      completion_tokens: m.usage.output,
      ms: 0,
      status: m.stopReason === "error" ? "error" : 200,
    });
  });

  pi.on("after_provider_response", (e) => {
    if (e.status < 400) return;
    logCall({
      ts: new Date().toISOString(),
      session: SESSION,
      workflow: "pi",
      step: "loop",
      lane: loopLane,
      model: "",
      prompt_tokens: 0,
      cached_tokens: 0,
      completion_tokens: 0,
      ms: 0,
      status: e.status,
    });
  });
  return ctl;
}

/** What /fix needs from the Pi loop: a turn cap for the next run, and signals that a run started / ended. */
interface LoopControl {
  nextTurnCap: number | undefined;
  started: (() => void) | undefined;
  ended: (() => void) | undefined;
  turns: () => number;
  /** the workflow tools' runner (set by registerTools): tinyCode's direct runs use the same one */
  runTool: ToolRunner | undefined;
  /** a hand-over to Pi's loop: the files the workflow changed (absolute) and its tree's counts (src/besttree.ts) */
  onHandoff: (h: PiHandoff, changed: string[], cwd: string) => void;
}

const START_WAIT_MS = 60_000;
const RUN_WAIT_MS = 45 * 60_000;

interface Run {
  pg: Progress;
  /** the door's chat, with the operator's stop honoured */
  chat: typeof chat;
  /** detail lines: ctx.ui.notify with a UI, else stdout (notify is silent in -p mode, PX 10a) */
  report: (line: string) => void;
}

/** A workflow run as the model's tool (S19): what the run reported, its end summary, and the rung-3 text it did not run. */
interface ToolCapture {
  lines: string[];
  text: string;
  ok: boolean;
  handoff: string | null;
  /** ok but unfinished: what remains (STATUS: partial) */
  remaining?: string;
}
const newCapture = (): ToolCapture => ({ lines: [], text: "", ok: true, handoff: null });

/**
 * One progress for one workflow run: phases declared up front, a live status line and checklist (TUI) or stderr lines
 * (-p), and one end summary: a chat message (TUI) or stdout (-p). A throw becomes the summary's failure reason.
 * With `tool` (the run is the model's tool call) the summary is not posted: it goes into `tool` for the tool result,
 * and the detail lines are collected there (shown as notifications with a UI, never on stdout, which is the model's).
 */
async function tracked<T>(
  pi: ExtensionAPI,
  cfg: Config,
  ctx: ExtensionContext,
  name: string,
  phases: string[],
  body: (r: Run) => Promise<T>,
  summarize: (r: T, pg: Progress) => Summary,
  tool?: ToolCapture,
): Promise<T | undefined> {
  const pg = startProgress(pi, ctx, cfg, name, phases, tool !== undefined);
  const report = (line: string) => {
    if (tool) tool.lines.push(line);
    if (ctx.hasUI) ctx.ui.notify(line, "info");
    else if (!tool) process.stdout.write(line + "\n");
  };
  try {
    const r = await body({ pg, chat: pg.chat(chat), report });
    const sum = summarize(r, pg);
    pg.done(sum);
    if (tool) {
      tool.text = pg.summary(sum, true);
      tool.ok = (sum.outcome ?? "done") === "done";
    }
    return r;
  } catch (e) {
    pg.fail((e as Error).message);
    if (tool) {
      tool.text = pg.summary({ outcome: "failed", reason: (e as Error).message }, true);
      tool.ok = false;
    }
    return undefined;
  } finally {
    endProgress(pg);
  }
}

/** In a tool run Pi's loop is already running, so rung 3 cannot start one: the hand-off text is kept for the model, which continues with raw tools. */
const inlineHandoff = (tool: ToolCapture) => async (h: PiHandoff): Promise<{ turns: number }> => {
  tool.handoff = h.text;
  return { turns: 0 };
};
const handoffFor = (pi: ExtensionAPI, cfg: Config, ctx: ExtensionContext, loop: LoopControl, r: Run, tool?: ToolCapture) => {
  if (!cfg.ladder.rung3) return undefined;
  const inner = tool ? inlineHandoff(tool) : makeHandoff(pi, cfg, ctx, loop, r.report);
  return async (h: PiHandoff): Promise<{ turns: number }> => {
    loop.onHandoff(h, r.pg.changed.map((f) => resolve(ctx.cwd, f)), ctx.cwd);
    return inner(h);
  };
};

const noFiles = (pg: Progress): string[] => pg.changed;

/** One line to the UI, else stdout. */
const sayTo = (ctx: ExtensionContext, line: string): void => (ctx.hasUI ? ctx.ui.notify(line, "info") : void process.stdout.write(line + "\n"));

/**
 * /fix [--test PATH] <task> and /fix --undo. Rungs 1-2 are direct calls (src/workflows/fix.ts); rung 3 sets the Pi
 * model to the loop lane, sends the seeded message and awaits agent_end (-p mode does not wait on its own, PX 10b).
 */
function registerFix(pi: ExtensionAPI, cfg: Config, loop: LoopControl): void {
  pi.registerCommand("fix", {
    description: "tinyCode: fix a bug or make a change (Adaptive Ladder: outline, pick, edit, review, then Pi's loop; learns per model where to start). /fix [--test PATH] <task>, /fix --undo",
    handler: async (rawArgs, ctx) => {
      const say = (line: string) => sayTo(ctx, line);
      const args = parseFixArgs(rawArgs ?? "");
      if (args.undo) {
        say(undoFix(ctx.cwd));
        return;
      }
      if (!args.task) {
        say("usage: /fix [--test PATH] <task text>   |   /fix --undo");
        return;
      }
      await runFixTracked(pi, cfg, ctx, loop, args);
    },
  });
}

/** /fix through the progress system: shared by the command and by routing. */
function runFixTracked(pi: ExtensionAPI, cfg: Config, ctx: ExtensionContext, loop: LoopControl, args: Parameters<typeof runFix>[0], tool?: ToolCapture) {
  return tracked(
    pi, cfg, ctx, "fix", FIX_PHASES,
    (r) => runFix(args, { cwd: ctx.cwd, config: cfg, chat: r.chat, progress: r.pg, pi: handoffFor(pi, cfg, ctx, loop, r, tool), report: r.report }),
    (f, pg) =>
      f.notReproduced
        ? { outcome: "blocked", reason: `couldn't reproduce: behaviour already works (test: ${f.notReproduced.test}); test undone, nothing changed`, files: noFiles(pg) }
        : f.solvedBy === "none"
        ? { outcome: "blocked", reason: f.kept ? "no rung solved it; best tree kept" : "no rung solved it", files: noFiles(pg), next: "/fix --undo to revert, or more detail and /fix again" }
        : { text: `solved by ${f.solvedBy}`, files: noFiles(pg), next: "/fix --undo to revert" },
    tool,
  );
}

/** The rung-3 hand-off into Pi's loop, shared by /fix and /edit's offer. */
function makeHandoff(
  pi: ExtensionAPI,
  cfg: Config,
  ctx: ExtensionContext,
  loop: LoopControl,
  report: (line: string) => void,
): (h: PiHandoff) => Promise<{ turns: number }> {
  return async (h) => {
    const lane = cfg.lanes[cfg.steps.loop.lane];
    if (lane && !lane.apiKeyEnv) {
      const model = ctx.modelRegistry.find("tinycode", lane.model);
      if (model) await pi.setModel(model);
      else report(`note: model tinycode/${lane.model} not registered; the loop uses the current model`);
    }
    let startedFlag = false;
    const run = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, RUN_WAIT_MS);
      const startTimer = setTimeout(() => {
        if (!startedFlag) {
          report("note: Pi's loop did not start");
          clearTimeout(timer);
          resolve();
        }
      }, START_WAIT_MS);
      loop.started = () => {
        startedFlag = true;
        clearTimeout(startTimer);
      };
      loop.ended = () => {
        clearTimeout(timer);
        clearTimeout(startTimer);
        resolve();
      };
    });
    loop.nextTurnCap = h.turnCap;
    try {
      pi.sendUserMessage(h.text, { deliverAs: "followUp" });
      await run;
    } finally {
      loop.nextTurnCap = undefined;
      loop.started = undefined;
      loop.ended = undefined;
    }
    return { turns: loop.turns() };
  };
}

/**
 * /edit [--test PATH] <path> <instruction>. One file through its routine (src/routines). No path: ask with ctx.ui.input,
 * or an error in -p mode (the router's file match arrives with S8). On failure with a UI, offer rung 3 (/fix).
 */
function registerEdit(pi: ExtensionAPI, cfg: Config, loop: LoopControl): void {
  pi.registerCommand("edit", {
    description: "tinyCode: edit one file with a routine for its type. /edit [--test PATH] <path> <instruction>",
    handler: async (rawArgs, ctx) => {
      const say = (line: string) => sayTo(ctx, line);
      let args = parseEditArgs(rawArgs ?? "", ctx.cwd);
      if (!args.path) {
        if (!ctx.hasUI) {
          say("usage: /edit [--test PATH] <path> <instruction>   (no file named; give the path first)");
          return;
        }
        const p = await ctx.ui.input("Which file?", "path");
        if (!p) return;
        args = { ...args, path: p.trim() };
      }
      if (!args.instruction) {
        if (!ctx.hasUI) {
          say(`/edit ${args.path}: say what to change`);
          return;
        }
        const t = await ctx.ui.input(`What should change in ${args.path}?`, "instruction");
        if (!t) return;
        args = { ...args, instruction: t.trim() };
      }
      const a = args;
      const r = await runEditTracked(pi, cfg, ctx, a);
      if (r?.offerFix && ctx.hasUI && cfg.ladder.rung3) {
        // auto mode hands over without asking; dev mode asks
        const ask = confirmFor(ctx);
        const yes = ask ? await ask(`Hand ${a.path} to /fix (the ladder, then Pi's loop)?`) : false;
        if (yes) await runFixTracked(pi, cfg, ctx, loop, { test: a.test, undo: false, reproduce: false, task: `In ${a.path}: ${a.instruction}` });
      }
    },
  });
}

function runEditTracked(pi: ExtensionAPI, cfg: Config, ctx: ExtensionContext, a: Parameters<typeof runEdit>[0], tool?: ToolCapture) {
  return tracked(
    pi, cfg, ctx, "edit", EDIT_PHASES,
    (x) => runEdit(a, { cwd: ctx.cwd, config: cfg, chat: x.chat, progress: x.pg, report: x.report }),
    (e, pg) =>
      e.ok
        ? { text: `edited ${a.path}`, files: noFiles(pg), next: "/fix --undo does not cover /edit; review with git diff" }
        : { outcome: "failed", reason: e.unavailable ?? `could not edit ${a.path}; it was restored`, next: e.offerFix ? (tool ? "fix with same task, or edit by hand" : "/fix with the same task (the ladder, then Pi's loop)") : undefined },
    tool,
  );
}

/** /add [--test PATH] [--file PATH] <what to add>: new code plus a test; a failing test goes to /fix's ladder. */
function registerAdd(pi: ExtensionAPI, cfg: Config, loop: LoopControl): void {
  pi.registerCommand("add", {
    description: "tinyCode: add new code (function, CLI option, endpoint) with a test; a failing test goes to the /fix ladder. /add [--test PATH] [--file PATH] <what to add>",
    handler: async (rawArgs, ctx) => {
      const args = parseAddArgs(rawArgs ?? "");
      if (!args.task) {
        sayTo(ctx, "usage: /add [--test PATH] [--file PATH] <what to add>");
        return;
      }
      await runAddTracked(pi, cfg, ctx, loop, args);
    },
  });
}

function runAddTracked(pi: ExtensionAPI, cfg: Config, ctx: ExtensionContext, loop: LoopControl, args: Parameters<typeof runAdd>[0], tool?: ToolCapture) {
  return tracked(
    pi, cfg, ctx, "add", ADD_PHASES,
    (r) => runAdd(args, { cwd: ctx.cwd, config: cfg, chat: r.chat, progress: r.pg, pi: handoffFor(pi, cfg, ctx, loop, r, tool), report: r.report }),
    (a, pg) =>
      a.ok
        ? { text: a.target ? `added to ${a.target}${a.test ? ` with ${a.test}` : ""}` : "added", files: a.files.length ? a.files : noFiles(pg), next: "/fix --undo to revert" }
        : a.undone
          ? { outcome: "failed", reason: `${a.undone.why}; /add undid its changes`, files: noFiles(pg) }
          : { outcome: "failed", reason: a.target ? `test for new code in ${a.target} fails` : "no file was changed", files: noFiles(pg), next: "/fix --undo to revert" },
    tool,
  );
}

/** /explain [--file PATH] <symbol, file or question>: one call, cited answer, no edits (src/workflows/explain.ts). */
function registerExplain(pi: ExtensionAPI, cfg: Config): void {
  pi.registerCommand("explain", {
    description: "tinyCode: explain a function or file in at most 200 words with file:line citations, no edits. /explain [--file PATH] <symbol, file or question>",
    handler: async (rawArgs, ctx) => {
      await runExplainTracked(pi, cfg, ctx, parseExplainArgs(rawArgs ?? ""));
    },
  });
}

function runExplainTracked(pi: ExtensionAPI, cfg: Config, ctx: ExtensionContext, args: Parameters<typeof runExplain>[0], tool?: ToolCapture) {
  return tracked(
    pi, cfg, ctx, "explain", EXPLAIN_PHASES,
    (r) => runExplain(args, { cwd: ctx.cwd, config: cfg, chat: r.chat, progress: r.pg, report: r.report }),
    (e) => (e.target ? { text: `explained ${e.target.file}${e.ok ? "" : " (no valid citation)"}`, outcome: e.ok ? "done" : "blocked" } : { outcome: "failed", reason: "no file or symbol found; name one" }),
    tool,
  );
}

/** /ask <question>: one call, no tools, small lane (src/workflows/ask.ts). */
function registerAsk(pi: ExtensionAPI, cfg: Config): void {
  pi.registerCommand("ask", {
    description: "tinyCode: answer a general programming question in one call, no tools, no repo context (small lane). /ask <question>",
    handler: async (rawArgs, ctx) => {
      await runAskTracked(pi, cfg, ctx, parseAskArgs(rawArgs ?? ""));
    },
  });
}

function runAskTracked(pi: ExtensionAPI, cfg: Config, ctx: ExtensionContext, args: Parameters<typeof runAsk>[0]) {
  return tracked(
    pi, cfg, ctx, "ask", ASK_PHASES,
    (r) => runAsk(args, { config: cfg, chat: r.chat, progress: r.pg, report: r.report }),
    (a) => (a.ok ? { text: "answered" } : { outcome: "failed", reason: a.calls ? "the model gave no answer" : "no question given" }),
  );
}

/** /commit [--yes] [hint]: conventional message for the staged diff, confirmed, then git commit (src/workflows/commit.ts). */
function registerCommit(pi: ExtensionAPI, cfg: Config): void {
  pi.registerCommand("commit", {
    description: "tinyCode: write a conventional commit message for the staged changes (stages all after asking when nothing is staged) and commit it. /commit [--yes] [hint]",
    handler: async (rawArgs, ctx) => {
      await runCommitTracked(pi, cfg, ctx, parseCommitArgs(rawArgs ?? ""));
    },
  });
}

function runCommitTracked(pi: ExtensionAPI, cfg: Config, ctx: ExtensionContext, args: Parameters<typeof runCommit>[0], tool?: ToolCapture) {
  return tracked(
    pi, cfg, ctx, "commit", COMMIT_PHASES,
    (r) => runCommit(args, { cwd: ctx.cwd, config: cfg, chat: r.chat, progress: r.pg, report: r.report, confirm: confirmFor(ctx, { kind: "commit", explicit: tool ? explicitlyAsked("commit", modeState.lastPrompt) : true, fromTool: tool !== undefined }) }),
    (c) => {
      const first = c.message.split("\n")[0] ?? "";
      if (c.outcome === "committed") return { text: `committed: ${first}`, next: "git revert HEAD to undo" };
      if (c.outcome === "nothing") return { text: "nothing to commit" };
      if (c.outcome === "declined") return tool && !explicitlyAsked("commit", modeState.lastPrompt)
        ? { outcome: "blocked", reason: "not committed: the user did not ask for a commit", next: "report the result; no commit" }
        : { outcome: "blocked", reason: "not committed (declined)", next: "stage what you want, /commit again" };
      return { outcome: "failed", reason: c.outcome === "refused" ? "message refused twice; nothing committed" : "git failed; nothing committed" };
    },
    tool,
  );
}

/** /doc [--file PATH] <task> adds docstrings/comments (code proven unchanged); /doc readme [...] writes docs/overview.html or checks README sections (src/workflows/doc.ts). */
function registerDoc(pi: ExtensionAPI, cfg: Config): void {
  pi.registerCommand("doc", {
    description: "tinyCode: add docstrings/comments to a file or symbol (only comments change, checked by code), or `/doc readme [--update SECTION|all] [--out DIR] [--max-files N] [--related a,b]` for docs/overview.html or a check of README sections",
    handler: async (rawArgs, ctx) => {
      await runDocTracked(pi, cfg, ctx, parseDocArgs(rawArgs ?? ""));
    },
  });
}

/** /doc through the progress system: shared by the command and by routing. */
async function runDocTracked(pi: ExtensionAPI, cfg: Config, ctx: ExtensionContext, args: DocArgs, tool?: ToolCapture) {
  const readme = args.mode === "readme";
  const name = readme ? "doc readme" : "doc";
  const phases = !readme ? DOC_PHASES : args.readme.update ? README_UPDATE_PHASES : README_PHASES;
  const v = await tracked(
    pi, cfg, ctx, name, phases,
    (r) => runDoc(args, { cwd: ctx.cwd, config: cfg, chat: r.chat, progress: r.pg, report: r.report, confirm: confirmFor(ctx, { kind: "readme-rewrite", explicit: tool ? explicitlyAsked("readme-rewrite", modeState.lastPrompt) : args.mode === "readme" && !args.readme.ask, fromTool: tool !== undefined }) }),
    (d, pg) => {
      if (d.mode === "comments") {
        const where = (d.files?.length ? d.files : [d.file ?? ""]).join(", ");
        return d.ok ? { text: d.changed ? `documented ${d.documented.length} symbol(s) in ${where}` : `nothing to change in ${where}`, files: d.changed ? (d.files ?? [d.file ?? ""]) : [], next: d.changed ? "review with git diff" : undefined } : { outcome: "failed", reason: d.reason ?? "no change" };
      }
      if (!d.ok) return { outcome: d.reason === "declined" ? "blocked" : "failed", reason: d.reason === "up-to-date" ? "no section needed a change" : (d.reason ?? "nothing written") };
      if (d.updated.length) return { text: `updated ${d.updated.length} section(s): ${d.updated.join(", ")}`, files: d.output ? [d.output] : noFiles(pg), next: "review with git diff" };
      if (d.reason === "up-to-date") return { text: "every section matches the code; nothing changed" };
      return { text: `${d.output ?? "output"} written`, files: [] };
    },
    tool,
  );
  // files of the request that were not documented: partial, the model does them by hand
  if (tool && v?.mode === "comments" && v.ok && v.left?.length) tool.remaining = `not documented: ${v.left.join(", ")}; do by hand`;
  return v;
}

/** /test [--file PATH] [--test PATH] [--expect-fail] <what to test>: writes tests only, runs them (src/workflows/testgen.ts). */
function registerTestGen(pi: ExtensionAPI, cfg: Config): void {
  pi.registerCommand("test", {
    description: "tinyCode: write tests for a function or file (tests only, never code) and run them; a failing test that exposes a bug is reported. /test [--file PATH] [--test PATH] [--expect-fail] <what to test>",
    handler: async (rawArgs, ctx) => {
      await runTestTracked(pi, cfg, ctx, parseTestArgs(rawArgs ?? ""));
    },
  });
}

function runTestTracked(pi: ExtensionAPI, cfg: Config, ctx: ExtensionContext, args: Parameters<typeof runTestGen>[0], tool?: ToolCapture) {
  return tracked(
    pi, cfg, ctx, "test", TEST_PHASES,
    (r) => runTestGen(args, { cwd: ctx.cwd, config: cfg, chat: r.chat, progress: r.pg, report: r.report }),
    (t) =>
      t.ok
        ? { text: `${t.outcome === "expected-fail" ? "tests fail on current code, as expected" : "tests pass"}${t.testFile ? ` (${t.testFile})` : ""}`, files: t.files, next: "review with git diff" }
        : { outcome: t.outcome === "possible-bug" ? "blocked" : "failed", reason: t.outcome === "possible-bug" ? "tests fail on current code: possible bug (kept)" : t.outcome, files: t.files },
    tool,
  );
}

/** /review [git-diff-args]: one small call per diff hunk (src/workflows/review.ts). Reports to the UI, else stdout. */
function registerReview(pi: ExtensionAPI, cfg: Config): void {
  pi.registerCommand("review", {
    description: "tinyCode: review the working-tree diff hunk by hunk with the small model. /review [git-diff-args]",
    handler: async (rawArgs, ctx) => {
      await runReviewTracked(pi, cfg, ctx, parseReviewArgs(rawArgs ?? ""));
    },
  });
}

async function runReviewTracked(pi: ExtensionAPI, cfg: Config, ctx: ExtensionContext, args: Parameters<typeof runReview>[0], tool?: ToolCapture) {
  const v = await tracked(
    pi, cfg, ctx, "review", REVIEW_PHASES,
    (r) => runReview(args, { cwd: ctx.cwd, config: cfg, chat: r.chat, progress: r.pg, report: r.report }),
    (v) => ({ text: v.hunks ? `${v.findings.length} finding(s) in ${v.hunks} hunk(s)${v.unread ? `, ${v.unread} unread` : ""}` : "no changes to review", next: v.findings.length ? "fix them with /fix, or see findings.json" : undefined }),
    tool,
  );
  // a hunk whose reply stayed cut was not reviewed: partial, the model reads that part of the diff itself
  if (tool && v?.unread) tool.remaining = `${v.unread} hunk(s) unread (reply cut); read them in git diff`;
  return v;
}

/** The research branch as a function of a question: a short cited answer; the local `find` is the branch tool of src/branch.ts. */
function researchFor(cfg: Config, cwd: string, report: (line: string) => void, run: Pick<Run, "chat" | "pg">) {
  return async (question: string): Promise<string | null> => {
    const r = await runResearch(
      { question },
      { config: cfg, chat: run.chat, progress: run.pg, report, find: (q) => findAnswer(cwd, q, { config: cfg, workflow: "research" }) },
    );
    return r.answer ? formatResearch(r) : null;
  };
}

/** /research <question>: GitHub and the web in a separate context, only the cited answer comes back (src/workflows/research.ts). */
function registerResearch(pi: ExtensionAPI, cfg: Config): void {
  pi.registerCommand("research", {
    description: "tinyCode: research a question on GitHub and the web in a separate context; returns a short cited answer. /research <question>",
    handler: async (rawArgs, ctx) => {
      await runResearchTracked(pi, cfg, ctx, parseResearchArgs(rawArgs ?? ""));
    },
  });
}

function runResearchTracked(pi: ExtensionAPI, cfg: Config, ctx: ExtensionContext, args: Parameters<typeof runResearch>[0], tool?: ToolCapture) {
  return tracked(
    pi, cfg, ctx, "research", RESEARCH_PHASES,
    async (r) => {
      const res = await runResearch(args, { config: cfg, chat: r.chat, progress: r.pg, report: r.report, find: (q) => findAnswer(ctx.cwd, q, { config: cfg, workflow: "research" }) });
      if (args.question) {
        r.report(formatResearch(res));
        r.report(`(${res.steps} steps, ${res.tokens} tokens, ${res.stopped})`);
      }
      return res;
    },
    (x) => (x.answer ? { text: `answered in ${x.steps} step(s) (${x.stopped}), ${x.sources.length} source(s)` } : { outcome: "failed", reason: args.question ? "research found nothing" : "no question given" }),
    tool,
  );
}

/** /plan <request>: spec + task list into .tinycode/plan.json (src/workflows/plan.ts). Confirms with a UI, else prints. */
function registerPlan(pi: ExtensionAPI, cfg: Config): void {
  pi.registerCommand("plan", {
    description: "tinyCode: turn a request into a spec and an ordered task list (.tinycode/plan.json). /plan <what to build or change>",
    handler: async (rawArgs, ctx) => {
      await runPlanTracked(pi, cfg, ctx, parsePlanArgs(rawArgs ?? ""));
    },
  });
}

function runPlanTracked(pi: ExtensionAPI, cfg: Config, ctx: ExtensionContext, args: Parameters<typeof runPlan>[0], tool?: ToolCapture) {
  return tracked(
    pi, cfg, ctx, "plan", PLAN_PHASES,
    (r) =>
      runPlan(args, { cwd: ctx.cwd, config: cfg, chat: r.chat, progress: r.pg, report: r.report, confirm: confirmFor(ctx, { dflt: false }), research: researchFor(cfg, ctx.cwd, r.report, r) }),
    (p) =>
      p.plan
        ? { text: `${p.plan.tasks.length} task(s) in .tinycode/plan.json`, files: [".tinycode/plan.json", ".tinycode/PLAN.md"], next: "run /build to continue" }
        : { outcome: "failed", reason: p.errors.join("; ") || "no valid plan" },
    tool,
  );
}

/**
 * /build [--task N] [--yes]: run .tinycode/plan.json one fresh-context task at a time (src/workflows/build.ts).
 * Rung 3 of each task's ladder uses the same Pi hand-off as /fix. Asks before git init with a UI; --yes without one.
 */
function registerBuild(pi: ExtensionAPI, cfg: Config, loop: LoopControl): void {
  pi.registerCommand("build", {
    description: "tinyCode: build the plan in .tinycode/plan.json task by task (test first, the ladder, whole suite, one git commit per task). /build [--task N] [--yes]",
    handler: async (rawArgs, ctx) => {
      await runBuildTracked(pi, cfg, ctx, loop, parseBuildArgs(rawArgs ?? ""));
    },
  });
}

function runBuildTracked(pi: ExtensionAPI, cfg: Config, ctx: ExtensionContext, loop: LoopControl, args: Parameters<typeof runBuild>[0], tool?: ToolCapture) {
  return tracked(
    pi, cfg, ctx, "build", BUILD_PHASES,
    (r) =>
      runBuild(args, {
        cwd: ctx.cwd,
        config: cfg,
        chat: r.chat,
        progress: r.pg,
        pi: handoffFor(pi, cfg, ctx, loop, r, tool),
        report: r.report,
        confirm: confirmFor(ctx, { kind: "git-init", explicit: args.yes || (tool !== undefined && explicitlyAsked("git-init", modeState.lastPrompt)), fromTool: tool !== undefined }),
      }),
    (b, pg) =>
      b.blocked !== null
        ? { outcome: "blocked", reason: `stopped at task ${b.blocked} (${b.done}/${b.total} done)`, files: noFiles(pg), next: "run /build again to resume there" }
        : b.total === 0
          ? { outcome: "failed", reason: "no plan to build", next: "run /plan first" }
          : { text: `${b.done}/${b.total} task(s) done`, next: b.done < b.total ? "run /build to continue" : "review with git log" },
    tool,
  );
}

/** Detail lines that are the answer itself (an explanation, a review, a research result, a plan): they go to the model with the summary. */
const ANSWER_TOOLS = new Set<WorkflowTool>(["explain", "research", "review", "plan", "doc", "commit"]);

/**
 * S19: every workflow as a tool of Pi's model (rule 15). The model says what it will do, calls the tool, and decides
 * the next step from the result. Inside, nothing changes: code gathers, narrow calls, code checks. The result is the
 * end summary (outcome, files changed, counts, next step), plus the answer lines for the tools that answer.
 * The slash commands stay as direct shortcuts. Rung 3 (Pi's loop) is the model itself: a failed fix returns the
 * reviewer's diagnosis and the tree as it was, and the model carries on with raw tools.
 */
function registerTools(pi: ExtensionAPI, cfg: Config, loop: LoopControl): void {
  const runner: ToolRunner = async (name, p, ctx): Promise<ToolOutcome> => {
    const tool = newCapture();
    const str = (k: string): string => (typeof p[k] === "string" ? (p[k] as string).trim() : "");
    const opt = (k: string): string | undefined => str(k) || undefined;
    const need = (k: string): string | null => (str(k) ? null : `${name}: missing "${k}"`);
    const missing = { fix: need("task"), edit_file: need("path") ?? need("instruction"), add: need("task"), explain: need("question"), test: need("what"), doc: need("request"), review: null, commit: null, plan: need("request"), build: null, research: need("question") }[name];
    if (missing) return { text: missing, ok: false };
    let extra = "";
    let reason: string | undefined;
    switch (name) {
      case "fix": {
        const r = await runFixTracked(pi, cfg, ctx, loop, { test: opt("test"), undo: false, task: str("task") }, tool);
        if (r?.solvedBy === "none") {
          // once: a kept tree gets its counts and failing tests (the reviewer's prose describes an earlier tree); an undone tree gets the diagnosis
          extra = r.kept
            ? `${r.kept} Continue by hand: read, edit, run_tests.`
            : `Ladder edits undone; files as before.${tool.handoff ? ` Continue by hand: read, edit, run_tests. ${handoverText(tool.handoff)}` : ""}`;
          reason = r.kept ? "no rung solved it; best tree kept" : "no rung solved it; edits undone";
        }
        break;
      }
      case "edit_file":
        await runEditTracked(pi, cfg, ctx, { path: str("path"), instruction: str("instruction") }, tool);
        break;
      case "add":
        await runAddTracked(pi, cfg, ctx, loop, { file: opt("file"), task: str("task") }, tool);
        break;
      case "explain":
        await runExplainTracked(pi, cfg, ctx, { file: opt("file"), question: str("question") }, tool);
        break;
      case "test":
        await runTestTracked(pi, cfg, ctx, { file: opt("file"), expectFail: false, task: str("what") }, tool);
        break;
      case "doc": {
        const a = docArgsFromText(str("request"), readmeHeadingLevels(ctx.cwd), findReadme(ctx.cwd));
        if (a.mode === "comments") a.file = opt("file");
        await runDocTracked(pi, cfg, ctx, a, tool);
        break;
      }
      case "review":
        await runReviewTracked(pi, cfg, ctx, { diffArgs: str("path") ? ["--", str("path")] : [] }, tool);
        break;
      case "commit":
        // an explicit request with no one to ask (print mode) is the consent; with a UI the workflow asks
        await runCommitTracked(pi, cfg, ctx, { yes: !ctx.hasUI, hint: str("hint") }, tool);
        break;
      case "plan":
        await runPlanTracked(pi, cfg, ctx, parsePlanArgs(str("request")), tool);
        break;
      case "build": {
        const n = Number(p.task);
        await runBuildTracked(pi, cfg, ctx, loop, { task: Number.isInteger(n) && n > 0 ? n : undefined, yes: !ctx.hasUI }, tool);
        break;
      }
      case "research":
        await runResearchTracked(pi, cfg, ctx, { question: str("question") }, tool);
        break;
    }
    const detail = ANSWER_TOOLS.has(name) && tool.lines.length ? `\n${tool.lines.join("\n")}` : "";
    return { text: forTool(`${tool.text || `${name}: no result`}${extra ? `\n${extra}` : ""}${detail}`), ok: tool.ok, ...(reason && !tool.ok ? { reason } : {}), ...(tool.remaining && tool.ok ? { remaining: tool.remaining } : {}) };
  };
  loop.runTool = runner;
  // only the intercepted workflows are declared to the model (config `intercept`); slash commands run every workflow
  registerWorkflowTools(pi, runner, cfg.intercept);
}
