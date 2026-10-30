// Config `intercept` (operator 2026-10-30, tally-1): tinyCode takes over only the workflows in the list; a request the
// router gives to another workflow reaches Pi as plain Pi sees it (no hint, no direct run, no todo nudge, its tool not
// declared, the system prompt names only the listed tools). Slash commands and the background layer are unaffected.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { ConfigError, DEFAULTS, INTERCEPTABLE, mergeConfig } from "../../src/config.ts";
import { MEMORY_PROMPT, approxTokens } from "../../src/limits.ts";
import { choose } from "../../src/orchestrate.ts";
import { composePrompt } from "../../src/prompt.ts";
import { buildIndex, heuristic } from "../../src/router.ts";
import { hintFor, interceptKey, intercepts, SPECS, todoFirst, TOOLS_FIRST_PROMPT, toolsFirstPrompt, triage, WORKFLOW_TOOLS, workflowTools } from "../../src/tools.ts";

const LITE = ["fix", "test"];
const ALL = [...INTERCEPTABLE]; // an explicit full list: the pre-v1 default (every workflow)

function repo() {
  const d = tmpDir("tinycode-intercept-");
  mkdirSync(join(d, "orders"));
  writeFileSync(join(d, "orders/report.py"), "def monthly_totals(rows):\n    return rows\n");
  // no door: every lane points at a closed local port, so a workflow that does run fails at once
  const lane = { baseUrl: "http://127.0.0.1:9/v1", model: "m" };
  const base = { lanes: { trunk: lane, small: lane } };
  writeFileSync(join(d, "all.json"), JSON.stringify({ ...base, intercept: ALL }));
  writeFileSync(join(d, "lite.json"), JSON.stringify({ ...base, intercept: LITE }));
  writeFileSync(join(d, "lite-model.json"), JSON.stringify({ ...base, intercept: LITE, orchestration: "model" }));
  writeFileSync(join(d, "all-model.json"), JSON.stringify({ ...base, intercept: ALL, orchestration: "model" }));
  return d;
}
const idx = () => buildIndex(repo());
const R = {
  fix: "monthly_totals gives me two rows for january, fix it",
  test: "write tests for monthly_totals",
  explain: "what does monthly_totals do",
  doc: "update the readme to match the code",
  question: "what is the difference between a list and a tuple?",
  spans: "rename it",
  unsure: "sort that out",
};

// ---------------------------------------------------------------- config

test("intercept: default is fix and test (v1); an explicit full list restores every workflow; a list replaces it; edit is edit_file; unknown names refused", () => {
  assert.deepEqual(DEFAULTS.intercept, ["fix", "test"]);
  assert.equal(DEFAULTS.route.model, false, "v1: code router only");
  assert.equal(DEFAULTS.ladder.rung2, false, "v1: one shot");
  assert.deepEqual(mergeConfig({}).intercept, ["fix", "test"]);
  const full = mergeConfig({ intercept: [...INTERCEPTABLE] }).intercept;
  assert.deepEqual(full, [...INTERCEPTABLE], "an explicit full list is every workflow, as before v1");
  for (const t of WORKFLOW_TOOLS) assert.ok(full.includes(t), t);
  assert.ok(full.includes("ask"));
  assert.deepEqual(mergeConfig({ intercept: ["fix", "test"] }).intercept, ["fix", "test"]);
  assert.deepEqual(mergeConfig({ intercept: ["edit", "edit_file", "fix"] }).intercept, ["edit_file", "fix"]);
  assert.deepEqual(mergeConfig({ intercept: [] }).intercept, []);
  assert.throws(() => mergeConfig({ intercept: ["fix", "refactor"] }), (e) => e instanceof ConfigError && /intercept: unknown workflow "refactor"/.test(e.message));
  assert.throws(() => mergeConfig({ intercept: "fix" }), ConfigError);
  assert.deepEqual(DEFAULTS.intercept, ["fix", "test"], "merge never touches the defaults");
});

// ---------------------------------------------------------------- the router's answer, gated

test("interceptKey: each routing answer names one intercept entry; questions, chat and unclear fall under ask", () => {
  const i = idx();
  const key = (t: string) => interceptKey(heuristic(t, i.names));
  assert.equal(key(R.fix), "fix");
  assert.equal(key(R.test), "test");
  assert.equal(key(R.explain), "explain");
  assert.equal(key(R.doc), "doc");
  assert.equal(key(R.spans), "edit_file", "a change across files is still the edit workflow");
  assert.equal(key(R.question), "ask");
  assert.equal(key("thanks, that works"), "ask");
  assert.equal(interceptKey({ workflow: "edit", file: "a.py", goal: "x", confident: true }), "edit_file");
  assert.equal(interceptKey({ workflow: "review", file: "", goal: "x", confident: true }), "review");
});

test("triage: a gated workflow gives no hint line and no todo nudge; fix and test keep theirs; the default list is hintFor/todoFirst exactly", () => {
  const i = idx();
  for (const t of [R.explain, R.doc, R.question, R.spans, R.unsure, "thanks, that works", "add a --verbose option to report.py"]) {
    const r = heuristic(t, i.names);
    assert.deepEqual(triage(r, LITE), { hint: null, nudgeTodo: false }, t);
    assert.deepEqual(triage(r, ALL), { hint: hintFor(r), nudgeTodo: todoFirst(r) }, `default: ${t}`);
    assert.equal(intercepts(LITE, r), false, t);
  }
  assert.deepEqual(triage(heuristic(R.fix, i.names), LITE).hint, { tool: "fix", line: "tinyCode hint: use `fix` (file: orders/report.py)." });
  assert.equal(triage(heuristic(R.test, i.names), LITE).hint?.tool, "test");
  assert.deepEqual(triage({ ...heuristic(R.unsure, i.names), workflow: "fix", file: "", source: "model" }, LITE).hint, { tool: "fix", line: "tinyCode hint: maybe `fix`." }, "a small-lane fix answer still hints");
});

test("choose: a gated workflow is never run directly (auto and code); fix and test still are; no list = today's", () => {
  const i = idx();
  const O = DEFAULTS.orchestration;
  const code = { ...O, mode: "code" as const };
  const routed = (t: string) => ({ ...heuristic(t, i.names), source: "code" as const });
  for (const o of [O, code]) {
    assert.equal(choose(o, routed(R.explain), null, LITE).direct, null);
    assert.match(choose(o, routed(R.explain), null, LITE).why, /not intercepted \(explain\)/);
    assert.equal(choose(o, routed(R.doc), null, LITE).direct, null);
    assert.equal(choose(o, routed(R.fix), null, LITE).direct?.tool, "fix");
    assert.equal(choose(o, routed(R.test), null, LITE).direct?.tool, "test");
    for (const t of [R.explain, R.fix, R.test, R.doc]) assert.deepEqual(choose(o, routed(t), null, ALL), choose(o, routed(t), null), t);
  }
  assert.equal(choose(O, routed(R.explain), null).direct?.tool, "explain", "today: explain runs directly");
});

// ---------------------------------------------------------------- tools and system prompt

test("only intercepted workflow tools are built; the tools-first line names only them; the default prompt is unchanged", () => {
  const run = async () => ({ text: "x", ok: true });
  assert.deepEqual(workflowTools(run, undefined, LITE).map((t) => t.name), ["fix", "test"]);
  assert.deepEqual(workflowTools(run, undefined, ALL).map((t) => t.name), [...WORKFLOW_TOOLS]);
  assert.deepEqual(workflowTools(run).map((t) => t.name), [...WORKFLOW_TOOLS]);
  assert.equal(toolsFirstPrompt(ALL), TOOLS_FIRST_PROMPT);
  assert.equal(toolsFirstPrompt([...WORKFLOW_TOOLS]), TOOLS_FIRST_PROMPT);
  assert.equal(toolsFirstPrompt([]), "");
  assert.equal(toolsFirstPrompt(["ask"]), "", "ask has no tool");
  const lite = toolsFirstPrompt(LITE);
  assert.match(lite, /^Workflow tools: fix, test\. /);
  const listed = lite.split(". ")[0]!;
  for (const t of WORKFLOW_TOOLS.filter((n) => !LITE.includes(n))) assert.ok(!new RegExp(`\\b${t}\\b`).test(listed), `${t} not listed`);
  for (const t of ["edit_file", "explain", "review", "commit", "research"]) assert.ok(!lite.includes(t), `${t} not named`);
  assert.ok(!lite.includes("Many-file change"), "README/build/commit line only when one of them is intercepted");
  for (const w of ["no tool fits", "pick next step", "STATUS done: report, stop; no redo.", "'tinyCode hint' line = likely tool."]) assert.ok(lite.includes(w), w);
  assert.match(toolsFirstPrompt(["fix", "doc", "commit"]), /Many-file change \(README, commit\): ask user first\./);
  assert.ok(lite.length < TOOLS_FIRST_PROMPT.length);
  // composePrompt: default = today's text; lite = the shorter line; none = no line at all
  assert.equal(composePrompt("P", 20), composePrompt("P", 20, ALL));
  assert.ok(composePrompt("P", 20).includes(TOOLS_FIRST_PROMPT));
  assert.ok(composePrompt("P", 20, LITE).includes(`${lite}\n${MEMORY_PROMPT}`));
  assert.ok(composePrompt("P", 20, []).endsWith(`cwd.\n${MEMORY_PROMPT}`));
  const before = approxTokens(composePrompt("", 20).length) + approxTokens(JSON.stringify(SPECS.map((s) => ({ name: s.name, description: s.description, parameters: s.parameters }))).length);
  const liteSpecs = SPECS.filter((s) => LITE.includes(s.name));
  const after = approxTokens(composePrompt("", 20, LITE).length) + approxTokens(JSON.stringify(liteSpecs.map((s) => ({ name: s.name, description: s.description, parameters: s.parameters }))).length);
  console.log(`tinyCode prompt text + workflow tool specs (chars/4): ${before} -> ${after} tokens with intercept=${JSON.stringify(LITE)}`);
  assert.ok(after < before);
});

// ---------------------------------------------------------------- the extension, with a fake Pi

interface Handler {
  (e: Record<string, unknown>, ctx: Record<string, unknown>): unknown;
}
async function load(env: Record<string, string>) {
  Object.assign(process.env, env);
  const mod = await import("../../extensions/tinycode/index.ts");
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, { name: string }>();
  const cmdHandlers = new Map<string, (a: string, c: Record<string, unknown>) => Promise<void>>();
  let active: string[] = ["read", "bash", "edit", "write"];
  const sent: string[] = [];
  const pi = {
    on: (n: string, h: Handler) => void handlers.set(n, [...(handlers.get(n) ?? []), h]),
    registerTool: (t: { name: string }) => void (tools.set(t.name, t), active.push(t.name)),
    registerCommand: (n: string, o: { handler: (a: string, c: Record<string, unknown>) => Promise<void> }) => void cmdHandlers.set(n, o.handler),
    registerMessageRenderer: () => {},
    registerProvider: () => {},
    sendMessage: (m: { content: unknown }) => void sent.push(String(m.content)),
    sendUserMessage: () => {},
    setModel: async () => true,
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => void (active = [...names]),
  };
  mod.default(pi as never);
  return { handlers, tools, cmdHandlers, sent, active: () => active };
}
type Exec = (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<{ content: { type: string; text: string }[] }>;
const MODEL = { id: "m", provider: "tinycode", api: "openai-completions", contextWindow: 10000 };
// a UI context: the workflows report through ctx.ui and pi.sendMessage (stdout is the test runner's)
const uiCtx = (cwd: string, notes: string[] = []) => ({ cwd, hasUI: true, model: MODEL, abort: () => {}, ui: { notify: (t: string) => void notes.push(t), setStatus: () => {}, setWidget: () => {} } });

test("the extension, lite: gated tools are not registered or active; fix and test are; run_tests, find, todo stay; every slash command stays", async () => {
  const cwd = repo();
  const { tools, active, cmdHandlers } = await load({ TINYCODE_CONFIG: join(cwd, "lite.json"), TINYCODE_LOG: join(cwd, "calls.jsonl") });
  for (const t of WORKFLOW_TOOLS) assert.equal(tools.has(t), LITE.includes(t), t);
  for (const t of ["find", "todo", "run_tests", "restore_best"]) assert.ok(tools.has(t), t);
  assert.ok(!active().includes("explain") && active().includes("fix") && active().includes("test"));
  for (const c of ["fix", "edit", "add", "explain", "ask", "commit", "test", "doc", "review", "plan", "research", "build"]) assert.ok(cmdHandlers.has(c), `/${c}`);
  const all = await load({ TINYCODE_CONFIG: join(cwd, "all.json"), TINYCODE_LOG: join(cwd, "calls.jsonl") });
  for (const t of WORKFLOW_TOOLS) assert.ok(all.tools.has(t), `default: ${t}`);
});

test("the extension, lite: a gated request gets no hint message, no direct run, no todo nudge and no tools-first nudge; the system prompt names only fix and test", async () => {
  const cwd = repo();
  const pi = readFileSync(new URL("../fixtures/pi-system-prompt.txt", import.meta.url), "utf8");
  for (const cfgFile of ["lite.json", "lite-model.json"]) {
    const { handlers } = await load({ TINYCODE_CONFIG: join(cwd, cfgFile), TINYCODE_LOG: join(cwd, "calls.jsonl") });
    const ctx = { cwd, hasUI: false, model: MODEL };
    const call = (name: string, e: Record<string, unknown>) => (handlers.get(name) ?? []).map((h) => h(e, ctx));
    for (const text of [R.explain, R.doc, R.question, R.spans, "thanks, that works"]) {
      assert.deepEqual(await call("input", { text, source: "interactive" })[0], { action: "continue" });
      const r = (await call("before_agent_start", { prompt: text, systemPrompt: pi })[0]) as { systemPrompt: string; message?: unknown };
      assert.equal(r.message, undefined, `${cfgFile}: ${text}: no hint, no direct result`);
      assert.ok(r.systemPrompt.includes(toolsFirstPrompt(LITE)) && !r.systemPrompt.includes(TOOLS_FIRST_PROMPT));
      assert.ok(r.systemPrompt.includes("Reply short."), "the terse line stays");
      // raw work without a todo: no "[todo empty]" nudge and no "use `x` first" line in the tail
      call("tool_call", { toolName: "bash", toolCallId: "b", input: { command: `ls # ${text}` } });
      const out = call("context", { messages: [{ role: "user", content: [{ type: "text", text }] }, { role: "toolResult", toolName: "bash", toolCallId: "b", content: [{ type: "text", text: "ok" }] }] })[0];
      assert.equal(out, undefined, `${cfgFile}: ${text}: the context goes to Pi untouched`);
      call("agent_end", {});
    }
  }
});

test("the extension, lite: fix and test still get the hint (model mode) and fix still runs directly (auto mode)", async () => {
  const cwd = repo();
  {
    const { handlers } = await load({ TINYCODE_CONFIG: join(cwd, "lite-model.json"), TINYCODE_LOG: join(cwd, "calls.jsonl") });
    const ctx = { cwd, hasUI: false, model: MODEL };
    const r = (await handlers.get("before_agent_start")![0]!({ prompt: R.fix, systemPrompt: "B" }, ctx)) as { message?: { customType: string; content: string } };
    assert.deepEqual([r.message?.customType, r.message?.content], ["tinycode-hint", "tinyCode hint: use `fix` (file: orders/report.py)."]);
    const t = (await handlers.get("before_agent_start")![0]!({ prompt: R.test, systemPrompt: "B" }, ctx)) as { message?: { content: string } };
    assert.match(t.message!.content, /use `test`/);
  }
  {
    const { handlers } = await load({ TINYCODE_CONFIG: join(cwd, "lite.json"), TINYCODE_LOG: join(cwd, "calls.jsonl") });
    const ctx = uiCtx(cwd);
    await handlers.get("input")![0]!({ text: R.fix, source: "interactive" }, ctx);
    const r = (await handlers.get("before_agent_start")![0]!({ prompt: R.fix, systemPrompt: "B" }, ctx)) as { message?: { customType: string; details: { tool: string } } };
    assert.equal(r.message?.customType, "tinycode-result", "the direct run happened (it fails here: no door)");
    assert.equal(r.message?.details.tool, "fix");
  }
});

test("the extension, lite: a typed slash command of a gated workflow still runs it", async () => {
  const cwd = repo();
  const log = join(cwd, "calls-slash.jsonl");
  const { cmdHandlers, sent } = await load({ TINYCODE_CONFIG: join(cwd, "lite.json"), TINYCODE_LOG: log });
  const notes: string[] = [];
  await cmdHandlers.get("explain")!("what does monthly_totals do", uiCtx(cwd, notes));
  assert.match([...sent, ...notes].join("\n"), /explain/i, [...sent, ...notes].join("\n"));
  const rows = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { workflow: string });
  assert.ok(rows.some((r) => r.workflow === "explain"), "the explain workflow made its call");
});

test("the extension, lite: the background layer is unchanged (compaction, read nudge, todo tail, best tree); auto-continue needs a test run, and a plain request also its own edit", async () => {
  const cwd = repo();
  writeFileSync(join(cwd, "out.txt"), "FAILED t::a - x\n7 failed, 24 passed in 0.1s\n");
  const tcfg = (f: string, extra: Record<string, unknown>) => {
    const lane = { baseUrl: "http://127.0.0.1:9/v1", model: "m" };
    writeFileSync(join(cwd, f), JSON.stringify({ lanes: { trunk: lane, small: lane }, orchestration: "model", test: { command: "cat out.txt; false" }, ...extra }));
    return join(cwd, f);
  };
  const results: Record<string, unknown[]> = {};
  // undoWorse off: this pins the "Worse than best" line (auto-undo has its own test in tools.test.ts)
  for (const [name, file] of [["lite", tcfg("bg-lite.json", { intercept: LITE, limits: { undoWorse: false } })], ["all", tcfg("bg-all.json", { intercept: ALL, limits: { undoWorse: false } })]] as const) {
    const { handlers, tools } = await load({ TINYCODE_CONFIG: file, TINYCODE_LOG: join(cwd, "calls.jsonl") });
    const ctx = { cwd, hasUI: false, model: MODEL, getSystemPrompt: () => "S" };
    const call = (n: string, e: Record<string, unknown>) => (handlers.get(n) ?? []).map((h) => h(e, ctx));
    const exec = (n: string) => (tools.get(n) as unknown as { execute: Exec }).execute("id", {}, undefined, undefined, ctx);
    const row: unknown[] = [];
    // compaction at 60 % of the window
    await call("before_agent_start", { prompt: R.explain, systemPrompt: "B" })[0];
    const t = (s: string) => [{ type: "text", text: s }];
    const turn = (n: number, used: number) => [
      { role: "user", content: t(`request ${n}`), timestamp: 100 + n * 10 },
      { role: "assistant", content: t(`answer ${n}`), usage: { input: used, output: 10, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop", timestamp: 101 + n * 10 },
    ];
    const folded = call("context", { messages: [...turn(1, 1000), ...turn(2, 2000), ...turn(3, 6500)] })[0] as { messages: unknown[] };
    row.push(folded.messages.length);
    // the read nudge after a read result, and the todo at the tail
    const afterRead = call("context", { messages: [{ role: "user", content: t("q") }, { role: "toolResult", toolName: "read", toolCallId: "r", content: t("x") }] })[0];
    row.push(JSON.stringify(afterRead).includes("[note findings in todo]"));
    await (tools.get("todo") as unknown as { execute: Exec }).execute("id", { steps: [{ text: "look", done: false }] }, undefined, undefined, ctx);
    const withTodo = call("context", { messages: [{ role: "user", content: t("q") }] })[0];
    row.push(JSON.stringify(withTodo).includes("look"));
    // a plain explain request that only ran the (failing) tests: no "tests still fail, continue" in lite
    await call("before_agent_start", { prompt: R.explain, systemPrompt: "B" })[0];
    await exec("run_tests");
    row.push(call("agent_before_settle", { outcome: "completed" })[0] !== undefined);
    // the same request after an edit of its own: the follow-up is back
    await call("before_agent_start", { prompt: R.explain, systemPrompt: "B" })[0];
    call("tool_result", { toolName: "edit", toolCallId: "e", input: { path: "orders/report.py" }, isError: false, content: t("ok") });
    await exec("run_tests");
    const more = call("agent_before_settle", { outcome: "completed" })[0] as { entries: { content: string }[] } | undefined;
    row.push(more?.entries[0]?.content ?? null);
    // no test run at all: nothing test-related
    await call("before_agent_start", { prompt: R.explain, systemPrompt: "B" })[0];
    call("tool_result", { toolName: "edit", toolCallId: "e2", input: { path: "orders/report.py" }, isError: false, content: t("ok") });
    row.push(call("agent_before_settle", { outcome: "completed" })[0] ?? null);
    // the best tree: a worse run says so
    await call("before_agent_start", { prompt: R.fix, systemPrompt: "B" })[0];
    await exec("run_tests");
    writeFileSync(join(cwd, "out.txt"), "FAILED t::a - x\n28 failed, 3 passed in 0.1s\n");
    row.push(/Worse than best \(24\/31/.test((await exec("run_tests")).content[0]!.text));
    writeFileSync(join(cwd, "out.txt"), "FAILED t::a - x\n7 failed, 24 passed in 0.1s\n");
    results[name] = row;
  }
  const want = (plainContinues: boolean) => [2, true, true, plainContinues, "Tests still fail (24/31). Continue.", null, true];
  assert.deepEqual(results.all, want(true), "default: today's behaviour, a test run is enough");
  assert.deepEqual(results.lite, want(false), "lite: same layer; a plain request that only looked at tests is not pushed on");
});

test("the extension: a run_tests milestone checkpoints what is sent (note, request and last turn kept, pairs intact, logged); Pi's messages untouched", async () => {
  const cwd = repo();
  writeFileSync(join(cwd, "out.txt"), "FAILED t::a - x\n7 failed, 24 passed in 0.1s\n");
  const lane = { baseUrl: "http://127.0.0.1:9/v1", model: "m" };
  const file = join(cwd, "ckpt.json");
  writeFileSync(file, JSON.stringify({ lanes: { trunk: lane, small: lane }, orchestration: "model", intercept: LITE, test: { command: "cat out.txt; false" } }));
  const log = join(cwd, "calls-ckpt.jsonl");
  const { handlers, tools } = await load({ TINYCODE_CONFIG: file, TINYCODE_LOG: log });
  const ctx = { cwd, hasUI: false, model: { ...MODEL, contextWindow: 16384 }, getSystemPrompt: () => "S".repeat(2000) };
  const call = (n: string, e: Record<string, unknown>) => (handlers.get(n) ?? []).map((h) => h(e, ctx));
  const t = (s: string) => [{ type: "text", text: s }];
  await call("before_agent_start", { prompt: R.explain, systemPrompt: "B" })[0];
  const msgs: Record<string, unknown>[] = [{ role: "user", content: t(R.explain), timestamp: 1 }];
  for (let i = 0; i < 8; i++) {
    msgs.push({ role: "assistant", content: [{ type: "toolCall", id: `r${i}`, name: "read", arguments: { path: join(cwd, "orders/report.py"), offset: i * 100 + 1 } }], timestamp: 10 + i * 3 });
    msgs.push({ role: "toolResult", toolCallId: `r${i}`, toolName: "read", content: t("x".repeat(4000)), isError: false, timestamp: 11 + i * 3 });
  }
  msgs.push({ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "run_tests", arguments: {} }], timestamp: 50 });
  const r = await (tools.get("run_tests") as unknown as { execute: Exec }).execute("t1", {}, undefined, undefined, ctx);
  msgs.push({ role: "toolResult", toolCallId: "t1", toolName: "run_tests", content: r.content, isError: false, timestamp: 51 });
  call("tool_result", { toolName: "run_tests", toolCallId: "t1", input: {}, isError: false, content: r.content });
  const copy = JSON.stringify(msgs);
  const out = (call("context", { messages: msgs })[0] as { messages: { role: string; content: unknown; toolCallId?: string }[] }).messages;
  assert.equal(JSON.stringify(msgs), copy, "Pi's list is not modified");
  assert.match(JSON.stringify(out[0]!.content), /\[checkpoint\] Older steps removed[\s\S]*Saved: 24\/31 pass \(best, test run 1\)/);
  assert.match(JSON.stringify(out[0]!.content), /what does monthly_totals do/, "the request is kept");
  assert.deepEqual(out.slice(1, 3).map((m) => m.role), ["assistant", "toolResult"]);
  assert.equal(out[2]!.toolCallId, "t1", "the milestone's turn is kept");
  assert.ok(out.length <= 4, "request + note, the last turn, the tail");
  const rows = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { step: string; status: string });
  assert.ok(rows.some((x) => x.step === "checkpoint" && /^best: \d+ -> \d+ tokens/.test(x.status)), "one checkpoint record");
});

test("the extension, kept files: a checkpoint after an edit sends the file's text on disk after the note; a re-read is pointed at it once, then served", async () => {
  const cwd = repo();
  writeFileSync(join(cwd, "out.txt"), "FAILED t::a - x\n7 failed, 24 passed in 0.1s\n");
  const src = readFileSync(join(cwd, "orders/report.py"), "utf8");
  const lane = { baseUrl: "http://127.0.0.1:9/v1", model: "m" };
  const file = join(cwd, "ckpt-keep.json");
  writeFileSync(file, JSON.stringify({ lanes: { trunk: lane, small: lane }, orchestration: "model", intercept: LITE, test: { command: "cat out.txt; false" } }));
  const log = join(cwd, "calls-keep.jsonl");
  const { handlers, tools } = await load({ TINYCODE_CONFIG: file, TINYCODE_LOG: log });
  const ctx = { cwd, hasUI: false, model: { ...MODEL, contextWindow: 16384 }, getSystemPrompt: () => "S".repeat(2000) };
  const call = (n: string, e: Record<string, unknown>) => (handlers.get(n) ?? []).map((h) => h(e, ctx));
  const t = (s: string) => [{ type: "text", text: s }];
  await call("before_agent_start", { prompt: R.explain, systemPrompt: "B" })[0];
  const msgs: Record<string, unknown>[] = [{ role: "user", content: t(R.explain), timestamp: 1 }];
  for (let i = 0; i < 8; i++) {
    msgs.push({ role: "assistant", content: [{ type: "toolCall", id: `r${i}`, name: "read", arguments: { path: join(cwd, "orders/other.py"), offset: i * 100 + 1 } }], timestamp: 10 + i * 3 });
    msgs.push({ role: "toolResult", toolCallId: `r${i}`, toolName: "read", content: t("x".repeat(4000)), isError: false, timestamp: 11 + i * 3 });
  }
  msgs.push({ role: "assistant", content: [{ type: "toolCall", id: "e1", name: "edit", arguments: { path: "orders/report.py", edits: [{ oldText: "a", newText: "b" }] } }], timestamp: 40 });
  msgs.push({ role: "toolResult", toolCallId: "e1", toolName: "edit", content: t("Successfully replaced 1 block(s)."), isError: false, timestamp: 41 });
  call("tool_result", { toolName: "edit", toolCallId: "e1", input: { path: "orders/report.py" }, isError: false, content: t("ok") });
  msgs.push({ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "run_tests", arguments: {} }], timestamp: 50 });
  const r = await (tools.get("run_tests") as unknown as { execute: Exec }).execute("t1", {}, undefined, undefined, ctx);
  msgs.push({ role: "toolResult", toolCallId: "t1", toolName: "run_tests", content: r.content, isError: false, timestamp: 51 });
  call("tool_result", { toolName: "run_tests", toolCallId: "t1", input: {}, isError: false, content: r.content });
  const out = (call("context", { messages: msgs })[0] as { messages: { role: string; content: unknown; toolCallId?: string; toolName?: string }[] }).messages;
  assert.match(JSON.stringify(out[0]!.content), /\[checkpoint\] Older steps removed\. Current text below: orders\/report\.py\. Other files: read before edit\./);
  assert.deepEqual(out.slice(1, 5).map((m) => m.role), ["assistant", "toolResult", "assistant", "toolResult"]);
  assert.equal(out[2]!.toolName, "read");
  assert.equal((out[2]!.content as { text: string }[])[0]!.text, src, "the text on disk");
  assert.equal(out[4]!.toolCallId, "t1", "the milestone's turn is kept after it");
  const rows = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { step: string; status: string });
  assert.ok(rows.some((x) => x.step === "checkpoint" && /kept orders\/report\.py, gap 4\)$/.test(x.status)), "logged with the kept file and the gap");
  // the model reads the kept file again: one pointer (not an intervention), then it is served
  const read = (id: string) => call("tool_call", { toolName: "read", toolCallId: id, input: { path: "orders/report.py" } })[0] as { block?: boolean; reason?: string } | undefined;
  assert.deepEqual(read("rr1"), { block: true, reason: "Unchanged since the checkpoint; its text is above. Need it again: ask again, it is served." });
  assert.equal(read("rr2"), undefined, "asked again: served");
  // an unkept file read before the checkpoint is served at once (its read was cut away)
  assert.equal(call("tool_call", { toolName: "read", toolCallId: "rr3", input: { path: join(cwd, "orders/other.py"), offset: 1 } })[0], undefined);
});
