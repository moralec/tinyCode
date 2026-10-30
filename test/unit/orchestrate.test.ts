import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { mergeConfig, type Config } from "../../src/config.ts";
import type { ChatResult, Message } from "../../src/llm.ts";
import { agreement, asToolTurn, choose, CUSTOM_RESULT, directCall, DoneGuard, formatOrchestration, namedFiles, rateFor, resultMessage, runDirect, scopeAfter, scopeBefore, sentenceFor, targetOf, type DecisionRecord, type DirectCall } from "../../src/orchestrate.ts";
import { buildIndex, heuristic, route } from "../../src/router.ts";
import { statusLine } from "../../src/tools.ts";
import type { ChatFn } from "../../src/workflows/fix.ts";

const O = mergeConfig({}).orchestration;
const withMode = (mode: string, extra: object = {}) => mergeConfig({ orchestration: { mode, ...extra } }).orchestration;

function repo() {
  const d = tmpDir("tinycode-orch-");
  mkdirSync(join(d, "orders"));
  writeFileSync(join(d, "orders/report.py"), "def monthly_totals(rows):\n    return rows\n");
  return buildIndex(d);
}
const idx = repo();
const confident = () => ({ ...heuristic("monthly_totals gives me two rows for january, fix it", idx.names), source: "code" as const });
const unsure = () => ({ ...heuristic("sort that out", idx.names), workflow: "fix" as const, file: "", confident: true, source: "model" as const });
const question = () => ({ ...heuristic("what is the difference between a list and a tuple?", idx.names), source: "code" as const });

const res = (text: string): ChatResult => ({ text, usage: { prompt_tokens: 40, cached_tokens: 0, completion_tokens: 12 }, ms: 90, lane: "trunk", model: "gemma-4-12b", fellBack: false });
function fakeChat(reply: string | Error) {
  const calls: { step: string; messages: Message[]; maxTokens?: number }[] = [];
  const fn: ChatFn = async (step, messages, opts) => {
    calls.push({ step, messages, maxTokens: opts?.maxTokens });
    if (reply instanceof Error) throw reply;
    return res(reply);
  };
  return { fn, calls };
}

test("config: orchestration defaults to auto, learn on; a plain string is shorthand; junk is rejected", () => {
  assert.deepEqual(O, { mode: "auto", learn: true, minDecisions: 20, minAgreement: 0.9, window: 50 });
  assert.equal(mergeConfig({ orchestration: "code" }).orchestration.mode, "code");
  assert.equal(mergeConfig({ orchestration: "code" }).orchestration.learn, true);
  assert.equal(mergeConfig({ orchestration: { learn: false } }).orchestration.learn, false);
  assert.throws(() => mergeConfig({ orchestration: "loud" }), /orchestration/);
  assert.throws(() => mergeConfig({ orchestration: { minAgreement: 2 } }), /minAgreement/);
  assert.equal("say" in mergeConfig({}).limits.maxTokens, false);
  assert.equal("say" in mergeConfig({}).steps, false);
});

test("the router's answer maps to a tool call with its parameters; a question or a file-less edit maps to none", () => {
  assert.deepEqual(directCall(confident()), { tool: "fix", params: { task: "monthly_totals gives me two rows for january, fix it" } });
  assert.equal(directCall(question()), null);
  assert.equal(directCall({ workflow: "edit", file: "", goal: "rename it", confident: true }), null);
  assert.deepEqual(directCall({ workflow: "edit", file: "a.py", goal: "rename x", confident: true }), { tool: "edit_file", params: { path: "a.py", instruction: "rename x" } });
  assert.deepEqual(directCall({ workflow: "explain", file: "a.py", goal: "what does a do", confident: true })?.params, { question: "what does a do", file: "a.py" });
});

test("auto: confident -> direct; unsure (small-lane) -> model; question or chat -> model", () => {
  assert.equal(choose(O, confident(), null).direct?.tool, "fix");
  const u = choose(O, unsure(), null);
  assert.equal(u.direct, null);
  assert.match(u.why, /unsure/);
  assert.equal(choose(O, question(), null).direct, null);
  assert.equal(choose(O, { ...heuristic("thanks, that works", idx.names), source: "code" }, null).direct, null);
});

test("code: any workflow the router has runs directly, even a small-lane answer; a question still goes to the model; model: never direct", () => {
  const c = withMode("code");
  assert.equal(choose(c, confident(), null).direct?.tool, "fix");
  assert.equal(choose(c, unsure(), null).direct?.tool, "fix");
  assert.equal(choose(c, question(), null).direct, null);
  const m = withMode("model");
  assert.equal(choose(m, confident(), null).direct, null);
  assert.equal(choose(m, unsure(), null).why, "orchestration model");
});

const rec = (model: string, match: boolean): DecisionRecord => ({ ts: "t", model, request: "r", router: "fix", chose: match ? "fix" : "review", match });

test("adaptive: a model at >= 90 % over >= 20 decisions is handed every case; below either bar it is not; learn off disables it", () => {
  const mk = (model: string, n: number, bad: number) => Array.from({ length: n }, (_, i) => rec(model, i >= bad));
  const good = rateFor(O, "gemma", mk("gemma", 20, 2));
  assert.deepEqual([good.n, good.matched, good.trusted], [20, 18, true]);
  assert.equal(choose(O, confident(), good).direct, null, "trusted model chooses even a confident case");
  assert.equal(choose(O, unsure(), good).direct, null);
  assert.equal(rateFor(O, "gemma", mk("gemma", 19, 0)).trusted, false, "too few decisions");
  assert.equal(rateFor(O, "gemma", mk("gemma", 20, 3)).trusted, false, "85 %");
  assert.equal(choose(O, confident(), rateFor(O, "gemma", mk("gemma", 20, 3))).direct?.tool, "fix");
  assert.equal(choose(withMode("auto", { learn: false }), confident(), good).direct?.tool, "fix", "learn off: still direct");
  assert.equal(rateFor(O, "qwen", mk("gemma", 30, 0)).n, 0, "per model");
  // only the last `window` count: 50 old misses, then 50 hits
  const slid = [...Array.from({ length: 50 }, () => rec("m", false)), ...Array.from({ length: 50 }, () => rec("m", true))];
  assert.equal(rateFor(O, "m", slid).trusted, true);
});

test("agreement: the model's first workflow tool against the router's; a raw tool or no call is no choice", () => {
  assert.equal(agreement("m", "q", "fix", "fix").match, true);
  assert.equal(agreement("m", "q", "fix", "review").match, false);
  assert.equal(agreement("m", "q", "fix", "read").match, false);
  assert.equal(agreement("m", "q", null, null).match, true, "question, model answered");
  assert.equal(agreement("m", "q", null, "fix").match, false);
});

test("stats text: direct runs and one agreement row per model", () => {
  const cfg: Config = mergeConfig({});
  const log = [{ kind: "direct", status: "done" }, { kind: "direct", status: "failed" }, ...Array.from({ length: 4 }, (_, i) => ({ kind: "decision", ...rec("gemma-4-12b", i > 0) }))];
  const t = formatOrchestration(cfg, log);
  assert.match(t, /Orchestration \(mode auto, learn on\)/);
  assert.match(t, /direct runs: 2 \(1 done, 0 partial, 1 failed\)/);
  assert.match(t, /gemma-4-12b: agrees with the router 75 % \(3\/4\) → learning/);
});

const CALL: DirectCall = { tool: "fix", params: { task: "fix it", file: "orders/report.py" } };

test("the sentence before a direct run is fixed text per workflow, from code", () => {
  assert.equal(sentenceFor(CALL), "Fixing the bug in orders/report.py.");
  assert.equal(sentenceFor({ tool: "plan", params: { request: "x" } }), "Making the task list.");
});

function deps(outcome: { text: string; ok: boolean; remaining?: string } | Error) {
  const order: string[] = [];
  return {
    order,
    d: {
      show: (s: string) => void order.push(`show:${s}`),
      run: async (call: DirectCall) => {
        order.push(`run:${call.tool}`);
        if (outcome instanceof Error) throw outcome;
        return outcome;
      },
    },
  };
}

test("confident -> direct run: the sentence is shown BEFORE the run, the result ends with STATUS, then the after-report turn is handed over as the tool's output", async () => {
  const { d, order } = deps({ text: "solved by rung1; files: orders/report.py", ok: true });
  const r = await runDirect(d, CALL);
  assert.deepEqual(order, ["show:Fixing the bug in orders/report.py.", "run:fix"]);
  assert.equal(r.status, "done");
  assert.equal(r.text, `solved by rung1; files: orders/report.py\n${statusLine({ text: "", ok: true })}`);
  // what Pi holds after before_agent_start: the user's request, then the custom result message
  const msgs = [
    { role: "custom", customType: "tinycode-say", content: r.said, display: true, details: { direct: true }, timestamp: 1 },
    { role: "user", content: [{ type: "text", text: "fix it" }], timestamp: 2 },
    { role: "custom", ...resultMessage(r), timestamp: 3 },
  ];
  const turned = asToolTurn(msgs, { id: "gemma-4-12b", provider: "tinycode", api: "openai-completions" })!;
  assert.deepEqual(turned.map((m) => m.role), ["user", "assistant", "toolResult"], "the say message is folded in; the result is a tool turn, not a user message");
  const asst = turned[1]! as unknown as { content: { type: string; text?: string; name?: string; id?: string; arguments?: Record<string, string> }[] };
  assert.equal(asst.content.length, 1, "the sentence is the call's intent, not a second copy as text");
  assert.equal(asst.content[0]!.name, "fix");
  assert.equal(asst.content[0]!.arguments!.intent, r.said);
  assert.equal(asst.content[0]!.arguments!.task, "fix it");
  const tr = turned[2]! as unknown as { toolCallId: string; content: { text: string }[]; isError: boolean };
  assert.equal(tr.toolCallId, asst.content[0]!.id);
  assert.match(tr.content[0]!.text, /STATUS: done/);
  assert.doesNotMatch(tr.content[0]!.text, /^\[result of/);
  assert.equal(tr.isError, false);
  // the model's after turn: a fake chat reads the transcript and reports (it sees a tool result, never user words)
  const after = fakeChat("It's fixed: monthly_totals no longer doubles January.");
  const seenRoles = turned.map((m) => m.role);
  const reply = await after.fn("loop", [{ role: "user", content: JSON.stringify(seenRoles) }]);
  assert.match(reply.text, /fixed/);
  assert.equal(seenRoles.at(-1), "toolResult");
});

test("without a model to build the tool turn the custom message still labels the text as the tool's output", async () => {
  const { d } = deps({ text: "ok", ok: true });
  const m = resultMessage(await runDirect(d, CALL));
  assert.equal(m.customType, CUSTOM_RESULT);
  assert.match(m.content, /^\[result of the fix tool, run by tinyCode\]/);
  assert.equal(asToolTurn([{ role: "user", content: "x" }], { id: "m", provider: "p", api: "a" }), undefined);
});

test("done -> the model reports and does not rerun: the guard refuses the same tool; failed or partial lets it retry", async () => {
  const g = new DoneGuard();
  const done = await runDirect(deps({ text: "solved", ok: true }).d, CALL);
  g.record(done.call.tool, done.status);
  assert.match(g.check("fix")!, /STATUS: done already/);
  assert.equal(g.check("review"), null, "another workflow is fine");
  g.reset();
  const failed = await runDirect(deps({ text: "no rung solved it", ok: false }).d, CALL);
  assert.equal(failed.status, "failed");
  assert.match(failed.text, /STATUS: failed .*raw tools ok/);
  g.record("fix", failed.status);
  assert.equal(g.check("fix"), null, "failed: the model may retry");
  const partial = await runDirect(deps({ text: "half", ok: true, remaining: "tests missing" }).d, CALL);
  assert.equal(partial.status, "partial");
  assert.match(partial.text, /STATUS: partial — tests missing/);
  g.record("fix", partial.status);
  assert.equal(g.check("fix"), null);
  // a failed result reaches the model flagged as an error
  const turned = asToolTurn([{ role: "user", content: "x" }, { role: "custom", ...resultMessage(failed), timestamp: 3 }], { id: "m", provider: "p", api: "a" })!;
  assert.equal((turned[2] as unknown as { isError: boolean }).isError, true);
});

test("a throwing workflow becomes a failed result for the model, never an exception", async () => {
  const r = await runDirect(deps(new Error("boom")).d, CALL);
  assert.equal(r.status, "failed");
  assert.match(r.text, /fix failed: boom/);
});

test("unsure and question requests give the model the tools: no direct call, so no sentence call and no run", async () => {
  const c = fakeChat("never used");
  for (const r of [unsure(), question()]) {
    const ch = choose(O, r, null);
    assert.equal(ch.direct, null);
  }
  assert.equal(c.calls.length, 0);
  // and the router's small-lane path really marks its answer as the model's, which is what makes it "unsure"
  const routed = await route("sort that out", idx, async () => res(JSON.stringify({ workflow: "fix", file: "orders/report.py", goal: "sort that out", confident: true })));
  assert.equal(routed.source, "model");
  assert.equal(choose(O, routed, null).direct, null);
});

test("scope: named files are paths, unique file names and dotted modules; one the request says to leave alone is not", () => {
  const files = ["exporter/cli.py", "exporter/settings.py", "exporter/formats/__init__.py", "app/server.py", "app/config.py", "listutil.py"];
  assert.deepEqual(namedFiles("Add a csv format: `python -m exporter.cli --format csv in.json out.csv`. Register it, with its own extension in exporter/settings.py.", files), ["exporter/cli.py", "exporter/settings.py"]);
  assert.deepEqual(namedFiles("Add an option to `load_config` in app/config.py. app/server.py must keep working unchanged. Add a test.", files), ["app/config.py"]);
  assert.deepEqual(namedFiles("Add `chunk(seq, n)` to listutil.py: it splits a list.", files), ["listutil.py"]);
  assert.deepEqual(namedFiles("Add docstrings to the todo package.", files), []);
});

test("scope: a named file the run did not change, and a removed name untouched files still use, are left; a covered request leaves nothing", () => {
  const tree = new Map<string, string>([
    ["shop/pricing.py", "def calc_total(lines):\n    return 1\n"],
    ["shop/cart.py", "from shop.pricing import calc_total\n\ndef total():\n    return calc_total([])\n"],
    ["shop/invoice.py", "def text():\n    return 'x'\n"],
  ]);
  const read = (p: string) => tree.get(p) ?? null;
  const files = () => [...tree.keys()];
  const req = "Rename `calc_total` to `compute_total` everywhere: its definition in shop/pricing.py and every caller.";
  const b = scopeBefore(req, files(), read);
  assert.deepEqual(b.names, ["calc_total"], "compute_total is not defined yet, so it is not watched");
  assert.equal(scopeAfter(b, files(), read), "named, untouched: shop/pricing.py");
  tree.set("shop/pricing.py", "def compute_total(lines):\n    return 1\n");
  assert.equal(scopeAfter(b, files(), read), "calc_total gone, still used: shop/cart.py");
  tree.set("shop/cart.py", "from shop.pricing import compute_total\n\ndef total():\n    return compute_total([])\n");
  assert.equal(scopeAfter(b, files(), read), "");
  // a name still defined is no question of scope (callers elsewhere are fine)
  const b2 = scopeBefore("In shop/pricing.py, change `compute_total` to round down.", files(), read);
  tree.set("shop/pricing.py", "def compute_total(lines):\n    return 0\n");
  assert.equal(scopeAfter(b2, files(), read), "");
});

test("direct run: done with named files left alone becomes partial (Pi finishes it, the guard lets it retry); fix and README runs are not scope-checked", async () => {
  let asked = 0;
  const scope = () => {
    asked++;
    return () => "named, untouched: exporter/cli.py";
  };
  const edit: DirectCall = { tool: "edit_file", params: { path: "exporter/settings.py", instruction: "add csv" } };
  const r = await runDirect({ ...deps({ text: "edit done: edited exporter/settings.py", ok: true }).d, scope }, edit);
  assert.equal(r.status, "partial");
  assert.match(r.text, /STATUS: partial — named, untouched: exporter\/cli\.py; check, finish with read\/edit$/);
  assert.doesNotMatch(r.text, /Report to user, stop/);
  const g = new DoneGuard();
  g.record(r.call.tool, r.status);
  assert.equal(g.check("edit_file"), null);
  // nothing left: done as before
  const ok = await runDirect({ ...deps({ text: "edit done", ok: true }).d, scope: () => () => "" }, edit);
  assert.equal(ok.status, "done");
  // a failed run stays failed; fix and a README target never ask
  asked = 0;
  const failed = await runDirect({ ...deps({ text: "no", ok: false }).d, scope }, edit);
  assert.equal(failed.status, "failed");
  await runDirect({ ...deps({ text: "solved", ok: true }).d, scope }, CALL);
  const readme = await runDirect({ ...deps({ text: "doc readme done", ok: true }).d, scope }, { tool: "doc", params: { request: "update README", file: "README.md" } });
  assert.equal(readme.status, "done");
  assert.equal(asked, 1, "only the failed edit asked; fix and README did not");
});

test("the done guard keys on (tool, target): the same tool on another file may run; the same file is refused", () => {
  const g = new DoneGuard();
  g.record("edit_file", "done", targetOf({ path: "shop/pricing.py", instruction: "x" }));
  assert.match(g.check("edit_file", targetOf({ path: "./shop/pricing.py" }))!, /edit_file shop\/pricing\.py STATUS: done already/);
  assert.equal(g.check("edit_file", targetOf({ path: "shop/cart.py" })), null, "edit-3 r3: a second file is a new job");
  g.record("doc", "done", targetOf({ request: "docstrings for cal", file: "" }));
  assert.equal(g.check("doc", targetOf({ file: "cal/leap.py" })), null, "doc-1: the file the first run did not pick");
  assert.match(g.check("doc", targetOf({ request: "again" }))!, /^doc STATUS: done already/);
});
