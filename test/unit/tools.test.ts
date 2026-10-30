import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { approxTokens, MEMORY_PROMPT, Todo, tailText, withTail } from "../../src/limits.ts";
import { INTERCEPTABLE } from "../../src/config.ts";
import { buildIndex, heuristic } from "../../src/router.ts";
import { entersRawWork, LOOP_TOOLS, ToolDiet, toolSet, todoFirst, statusLine, INTENT_DESCRIPTION, intentOf, compact, forTool, hintFor, isWorkflowTool, RAW_TOOLS, SPECS, TOOLS_FIRST_PROMPT, ToolsFirst, TOOL_FOR, toolResult, WORKFLOW_TOOLS, workflowTools } from "../../src/tools.ts";

type Exec = (id: string, params: unknown, signal: undefined, onUpdate: undefined, ctx: unknown) => Promise<{ content: { type: string; text: string }[]; details: { ok: boolean } }>;

test("tool wrapping: eleven workflow tools, sequential, each result is one text part and details.ok", async () => {
  const seen: string[] = [];
  const tools = workflowTools(async (name, params) => {
    seen.push(`${name}:${JSON.stringify(params)}`);
    return { text: `${name} done: 1 call`, ok: true };
  });
  assert.deepEqual(tools.map((t) => t.name), [...WORKFLOW_TOOLS]);
  assert.equal(tools.length, 11);
  for (const t of tools) assert.equal(t.executionMode, "sequential");
  const fix = tools.find((t) => t.name === "fix")!;
  const r = await (fix.execute as unknown as Exec)("id1", { task: "fix it" }, undefined, undefined, { cwd: "/x" });
  assert.deepEqual(r, { content: [{ type: "text", text: `fix done: 1 call\n${statusLine({ text: "", ok: true })}` }], details: { ok: true } });
  assert.deepEqual(seen, ['fix:{"task":"fix it"}']);
});

test("tool wrapping: a throw becomes a failed result for the model to read, not an exception", async () => {
  const [t] = workflowTools(async () => {
    throw new Error("door down");
  });
  const r = await (t!.execute as unknown as Exec)("id", { task: "x" }, undefined, undefined, {});
  assert.equal(r.details.ok, false);
  assert.equal(r.content[0]!.text, `fix failed: door down\n${statusLine({ text: "fix failed: door down", ok: false })}`);
});

test("tool results are capped and the cut is announced; /run wording becomes tool wording", () => {
  const long = "x".repeat(5000);
  const c = compact(long);
  assert.ok(c.length <= 2400 && c.endsWith("[cut at 2400 chars]"));
  assert.equal(toolResult({ text: "ok", ok: false }).details.ok, false);
  assert.equal(forTool("Next: run /build to continue"), "Next: call build to continue");
  assert.equal(forTool("retry with /fix and details"), "retry with fix and details");
});

test("tool names: Pi's raw edit is not overridden; the workflow names map from the router's", () => {
  assert.ok(!(WORKFLOW_TOOLS as readonly string[]).includes("edit"));
  assert.equal(TOOL_FOR.edit, "edit_file");
  assert.equal(TOOL_FOR.ask, null);
  assert.ok(isWorkflowTool("explain") && !isWorkflowTool("read") && !isWorkflowTool("run_tests"));
  assert.deepEqual(SPECS.map((s) => s.name), [...WORKFLOW_TOOLS]);
});

test("the tools-first system prompt (with the working method) is at most 300 tokens and names every tool", () => {
  const n = approxTokens(TOOLS_FIRST_PROMPT.length) + approxTokens(MEMORY_PROMPT.length);
  assert.ok(n <= 300, `${n} tokens`);
  for (const t of WORKFLOW_TOOLS) assert.ok(TOOLS_FIRST_PROMPT.includes(t), t);
  for (const w of ["no tool fits", "pick next step", "ask user", "tinyCode' hint", "STATUS done: report, stop"]) assert.ok(TOOLS_FIRST_PROMPT.includes(w) || w === "tinyCode' hint" && TOOLS_FIRST_PROMPT.includes("'tinyCode hint'"), w);
});

function repo() {
  const d = tmpDir("tinycode-tools-");
  mkdirSync(join(d, "orders"));
  writeFileSync(join(d, "orders/report.py"), "def monthly_totals(rows):\n    return rows\n");
  return d;
}

test("hint injection: a routed request gets one tail line naming the tool and the file; chat and unsure get none", () => {
  const idx = buildIndex(repo());
  const h = hintFor(heuristic("monthly_totals gives me two rows for january, fix it", idx.names));
  assert.deepEqual(h, { tool: "fix", line: "tinyCode hint: use `fix` (file: orders/report.py)." });
  const m = hintFor({ ...heuristic("sort that out", idx.names), workflow: "fix", file: "", source: "model" });
  assert.deepEqual(m, { tool: "fix", line: "tinyCode hint: maybe `fix`." }, "model-decided: softer wording");
  const q = hintFor(heuristic("what is the difference between a list and a tuple?", idx.names))!;
  assert.equal(q.tool, null);
  assert.match(q.line, /question; answer, no tool\./);
  assert.equal(hintFor(heuristic("thanks, that works", idx.names))?.tool, null);
  assert.deepEqual(hintFor(heuristic("rename it", idx.names)), { tool: null, line: "tinyCode hint: change spans files; use read/edit, no tinyCode tool." }, "edit without a file: own tools");
  assert.equal(hintFor(heuristic("write tests for monthly_totals", idx.names))?.tool, "test");
  assert.equal(hintFor(heuristic("update the readme to match the code", idx.names))?.tool, "doc");
  assert.equal(hintFor(heuristic("what does monthly_totals do", idx.names))?.tool, "explain");
});

test("tools-first nudge: a raw first action with a hint gets one tail line; a tool first does not; never twice; logged yes/no/none", () => {
  const t = new ToolsFirst();
  t.start("fix the bug in orders", "fix");
  assert.equal(t.onCall("read"), "use `fix` first: cheaper, checked");
  assert.equal(t.onCall("read"), null, "only the first action counts");
  const r1 = t.finish()!;
  assert.deepEqual([r1.tools_first, r1.first, r1.hint, r1.nudged], ["no", "read", "fix", true]);
  assert.equal(t.finish(), null);

  t.start("fix the bug in orders", "fix");
  assert.equal(t.onCall("fix"), null);
  const r2 = t.finish()!;
  assert.deepEqual([r2.tools_first, r2.nudged], ["yes", false]);

  t.start("what is a tuple", null);
  assert.equal(t.onCall("bash"), null, "no hint, no nudge");
  assert.equal(t.finish()!.tools_first, "no");

  t.start("hello", null);
  assert.equal(t.finish()!.tools_first, "none");
  for (const raw of ["read", "bash", "edit", "write"]) assert.ok(RAW_TOOLS.has(raw));
});

// ---------------------------------------------------------------- the extension itself, with a fake Pi

interface Handler {
  (e: Record<string, unknown>, ctx: Record<string, unknown>): unknown;
}
async function load(env: Record<string, string>) {
  Object.assign(process.env, env);
  const mod = await import("../../extensions/tinycode/index.ts");
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, { name: string }>();
  const commands = new Set<string>();
  const cmdHandlers = new Map<string, (a: string, c: Record<string, unknown>) => Promise<void>>();
  const pi = {
    on: (n: string, h: Handler) => void handlers.set(n, [...(handlers.get(n) ?? []), h]),
    registerTool: (t: { name: string }) => void tools.set(t.name, t),
    registerCommand: (n: string, o: { handler: (a: string, c: Record<string, unknown>) => Promise<void> }) => void (commands.add(n), cmdHandlers.set(n, o.handler)),
    registerMessageRenderer: () => {},
    registerProvider: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    setModel: async () => true,
    // the tool-set API: every registered tool starts active, like Pi's
    getActiveTools: () => [...active],
    setActiveTools: (names: string[]) => void (active = [...names], sets.push([...names])),
  };
  const sets: string[][] = [];
  let active: string[] = [];
  const origRegister = pi.registerTool;
  pi.registerTool = (t: { name: string }) => (origRegister(t), void active.push(t.name));
  active.push("read", "bash", "edit", "write");
  mod.default(pi as never);
  return { handlers, tools, commands, cmdHandlers, sets, active: () => active };
}

test("the extension: `input` only for orchestration (never rewrites the text); workflow tools beside find/todo/run_tests; every slash command kept", async () => {
  const cwd = repo();
  writeFileSync(join(cwd, "all.json"), JSON.stringify({ intercept: [...INTERCEPTABLE] })); // the v1 default is fix and test only; this is about every tool
  const { handlers, tools, commands } = await load({ TINYCODE_CONFIG: join(cwd, "all.json"), TINYCODE_LOG: join(cwd, "calls.jsonl") });
  assert.equal(handlers.has("input"), true, "the input hook is back, for the direct path only");
  for (const t of [...WORKFLOW_TOOLS, "find", "todo", "run_tests"]) assert.ok(tools.has(t), t);
  assert.equal(tools.has("edit"), false, "Pi's raw edit is not overridden");
  for (const c of ["fix", "edit", "add", "explain", "ask", "commit", "test", "doc", "review", "plan", "research", "build", "tinycode", "dev"]) assert.ok(commands.has(c), `/${c}`);
});

test("the extension: `input` passes every text through untouched (question, unsure, model mode); no direct run is planned for them", async () => {
  const cwd = repo();
  writeFileSync(join(cwd, "model.json"), JSON.stringify({ orchestration: "model" }));
  for (const [cfgFile, text] of [["none.json", "what is the difference between a list and a tuple?"], ["none.json", "thanks, that works"], ["model.json", "monthly_totals gives me two rows for january, fix it"]] as const) {
    const { handlers } = await load({ TINYCODE_CONFIG: join(cwd, cfgFile), TINYCODE_LOG: join(cwd, "calls.jsonl") });
    const ctx = { cwd, hasUI: false, model: { id: "gemma-4-12b", provider: "tinycode", api: "openai-completions" } };
    const out = await handlers.get("input")![0]!({ text, source: "interactive" }, ctx);
    assert.deepEqual(out, { action: "continue" }, text);
    // the run starts as a plain model run: the hint, no direct result message
    const r = (await handlers.get("before_agent_start")![0]!({ prompt: text, systemPrompt: "B" }, ctx)) as { message?: { customType: string } };
    assert.notEqual(r.message?.customType, "tinycode-result", text);
  }
});

test("the extension: before_agent_start appends the tools-first prompt and adds the hint as a tail message; the nudge and the tools_first log follow", async () => {
  const cwd = repo();
  const log = join(cwd, "calls.jsonl");
  writeFileSync(join(cwd, "all.json"), JSON.stringify({ intercept: [...INTERCEPTABLE] })); // the question hint (ask) and the full tools-first prompt need every workflow intercepted
  const { handlers } = await load({ TINYCODE_CONFIG: join(cwd, "all.json"), TINYCODE_LOG: log });
  const call = (name: string, e: Record<string, unknown>, ctx: Record<string, unknown> = { cwd, hasUI: false }) => (handlers.get(name) ?? []).map((h) => h(e, ctx));
  const r = (await call("before_agent_start", { prompt: "monthly_totals gives me two rows for january, fix it", systemPrompt: "BASE" })[0]) as { systemPrompt: string; message?: { customType: string; content: string; display: boolean } };
  assert.ok(r.systemPrompt.startsWith("BASE\n\n") && r.systemPrompt.includes(TOOLS_FIRST_PROMPT) && r.systemPrompt.includes(MEMORY_PROMPT));
  assert.deepEqual(r.message, { customType: "tinycode-hint", content: "tinyCode hint: use `fix` (file: orders/report.py).", display: false });
  // the model's first action is a raw read: allowed, never blocked, and one nudge is queued for the tail
  const verdicts = call("tool_call", { toolName: "read", input: { path: "orders/report.py" } });
  assert.ok(!verdicts.some((v) => (v as { block?: boolean } | undefined)?.block), "never a block");
  const ctxOut = call("context", { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })[0] as { messages: { content: unknown }[] } | undefined;
  assert.ok(JSON.stringify(ctxOut).includes("use `fix` first: cheaper, checked"), JSON.stringify(ctxOut));
  call("agent_end", {});
  const rec = JSON.parse(readFileSync(join(cwd, "tools-first.jsonl"), "utf8").trim().split("\n").pop()!);
  assert.deepEqual([rec.tools_first, rec.first, rec.hint, rec.nudged], ["no", "read", "fix", true]);
  // a chat request: no hint message, no nudge
  const c = (await call("before_agent_start", { prompt: "what is the difference between a list and a tuple?", systemPrompt: "BASE" })[0]) as { message?: { content: string } };
  assert.match(c.message!.content, /question; answer, no tool/);
  call("tool_call", { toolName: "bash", input: { command: "ls" } });
  call("agent_end", {});
  const rec2 = JSON.parse(readFileSync(join(cwd, "tools-first.jsonl"), "utf8").trim().split("\n").pop()!);
  assert.deepEqual([rec2.tools_first, rec2.hint, rec2.nudged], ["no", null, false]);
});

test("every tool schema requires `intent` first; it is shown when the tool starts; results end with the STATUS line", async () => {
  for (const sp of SPECS) {
    const sch = sp.parameters as unknown as { required?: string[]; properties: Record<string, { description?: string }> };
    assert.equal(Object.keys(sch.properties)[0], "intent", sp.name);
    assert.ok(sch.required?.includes("intent"), sp.name);
    assert.equal(sch.properties.intent!.description, INTENT_DESCRIPTION);
  }
  const shown: string[] = [];
  const tools = workflowTools(async () => ({ text: "done", ok: true }), (t) => void shown.push(t));
  const r = await (tools[0]!.execute as unknown as Exec)("i", { intent: "  I will fix\nthe parser because the test fails.  ", task: "x" }, undefined, undefined, {});
  assert.deepEqual(shown, ["I will fix the parser because the test fails."]);
  assert.ok(r.content[0]!.text.endsWith("STATUS: done. Report to user, stop."));
  assert.equal(intentOf({}), "");
  // a missing intent never blocks the tool
  const r2 = await (tools[0]!.execute as unknown as Exec)("i", { task: "x" }, undefined, undefined, {});
  assert.equal(r2.details.ok, true);
  assert.equal(shown.length, 1);
});

test("tool descriptions + schemas (with intent) stay under 900 tokens", () => {
  const text = JSON.stringify(SPECS.map((s) => ({ name: s.name, description: s.description, parameters: s.parameters })));
  const n = approxTokens(text.length);
  assert.ok(n <= 900, `${n} tokens`);
});

test("the extension: /dev toggles dev mode; the router hint is shown only in dev; /tinycode names the mode", async () => {
  const cwd = repo();
  const { handlers, cmdHandlers } = await load({ TINYCODE_CONFIG: join(cwd, "none.json"), TINYCODE_LOG: join(cwd, "calls.jsonl") });
  const notes: string[] = [];
  const ctx = { cwd, hasUI: true, ui: { notify: (t: string) => void notes.push(t) } };
  const hint = async () => ((await (handlers.get("before_agent_start") ?? [])[0]!({ prompt: "monthly_totals gives me two rows for january, fix it", systemPrompt: "B" }, ctx)) as { message: { display: boolean } }).message.display;
  assert.equal(await hint(), false);
  await cmdHandlers.get("dev")!("on", ctx);
  assert.equal(notes.at(-1), "tinyCode mode: dev");
  assert.equal(await hint(), true);
  await cmdHandlers.get("tinycode")!("", ctx);
  assert.match(notes.at(-1)!, /^tinyCode mode: dev/);
  await cmdHandlers.get("dev")!("off", ctx);
  assert.equal(await hint(), false);
  await cmdHandlers.get("tinycode")!("", ctx);
  assert.match(notes.at(-1)!, /^tinyCode mode: auto/);
});

test("result framing: STATUS done, partial and failed", () => {
  const done = toolResult({ text: "README updated", ok: true }).content[0]!.text;
  assert.ok(done.startsWith("README updated\n"));
  assert.ok(done.endsWith("STATUS: done. Report to user, stop."));
  const part = toolResult({ text: "3 of 5 done", ok: true, remaining: "tasks 4 and 5 are not built" }).content[0]!.text;
  assert.ok(part.endsWith("STATUS: partial \u2014 tasks 4 and 5 are not built"));
  assert.ok(!part.includes("STATUS: done"));
  const failed = toolResult({ text: "fix failed: door down\nmore", ok: false }).content[0]!.text;
  assert.ok(failed.endsWith("STATUS: failed \u2014 fix failed: door down; raw tools ok"));
  assert.ok(statusLine({ text: "x", ok: false, reason: "tests still red" }).includes("tests still red"));
  assert.ok(TOOLS_FIRST_PROMPT.includes("STATUS done: report, stop; no redo."));
});

test("prompt: reads the project itself, todo only when no tool fits and not a question", () => {
  assert.ok(TOOLS_FIRST_PROMPT.includes("Find paths and code yourself; never ask user."));
  assert.ok(TOOLS_FIRST_PROMPT.includes("Tool phases = its plan"));
  assert.match(MEMORY_PROMPT, /No tool fits and not a question: todo first/);
});

test("todo nudge: none when the request routed to a workflow tool or is a question; yes for raw work", () => {
  const idx = buildIndex("/nonexistent", ["monthly_totals.py"]);
  assert.equal(todoFirst(heuristic("monthly_totals gives me two rows for january, fix it", idx.names)), false);
  assert.equal(todoFirst(heuristic("what does monthly_totals do", idx.names)), false);
  assert.equal(todoFirst(heuristic("what is the difference between a list and a tuple?", idx.names)), false);
  assert.equal(todoFirst({ workflow: "none", file: "", goal: "x", confident: false }), true);
  const t = new Todo();
  assert.equal(tailText(t, false, 3, false, [], false), null);
  assert.match(tailText(t, false, 3, false, [], true) as string, /todo empty/);
  assert.equal(withTail([{ role: "toolResult", toolName: "doc", toolCallId: "1", content: [] } as never], t, false, [], false), undefined);
});

test("the extension: the context hook folds finished requests once the window is 60 % full, and only then", async () => {
  const cwd = repo();
  const { handlers } = await load({ TINYCODE_CONFIG: join(cwd, "none.json"), TINYCODE_LOG: join(cwd, "calls.jsonl") });
  const ctx = { cwd, hasUI: false, model: { id: "gemma-4-12b", provider: "tinycode", api: "openai-completions", contextWindow: 10000 }, getSystemPrompt: () => "S" };
  const t = (text: string) => [{ type: "text", text }];
  const turn = (n: number, used: number) => [
    { role: "user", content: t(`request ${n}`), timestamp: 100 + n * 10 },
    { role: "assistant", content: t(`answer ${n}`), usage: { input: used, output: 10, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop", timestamp: 101 + n * 10 },
  ];
  const run = (messages: unknown[]) => handlers.get("context")![0]!({ messages }, ctx) as { messages: { role: string; content: unknown }[] } | undefined;
  assert.equal(run([...turn(1, 1000), ...turn(2, 2000)]), undefined, "20 % full: untouched");
  const out = run([...turn(1, 1000), ...turn(2, 2000), ...turn(3, 6500)])!;
  assert.equal(out.messages.length, 2, "requests 1 and 2 folded into the current request's message; request 3 is current and its reply is kept");
  const roles = out.messages.map((m) => m.role);
  assert.deepEqual(roles, ["user", "assistant"]);
  assert.match(JSON.stringify(out.messages[0]!.content), /request: request 1; result: answer 1; files changed: none[\s\S]*request: request 2/);
});

// ---------------------------------------------------------------- the tool diet (operator 2026-10-29)

test("tool diet decision: a workflow tool without STATUS done, or the model's first raw edit/write/bash, is raw work; nothing else", () => {
  assert.equal(entersRawWork({ tool: "fix", text: "fix failed\nSTATUS: failed \u2014 x; raw tools ok" }), true);
  assert.equal(entersRawWork({ tool: "build", text: "3/5 done\nSTATUS: partial \u2014 tasks 4 and 5" }), true);
  assert.equal(entersRawWork({ tool: "fix", text: "fix done\nSTATUS: done. Report to user, stop." }), false);
  assert.equal(entersRawWork({ tool: "fix", text: "fix STATUS: done already. Report, no rerun." }), false, "the done-guard refusal is not raw work");
  assert.equal(entersRawWork({ tool: "read", text: "anything" }), false, "a raw tool's result is not a workflow result");
  for (const call of ["edit", "write", "bash"]) assert.equal(entersRawWork({ call }), true, call);
  for (const call of ["read", "find", "run_tests", "todo", "fix", "explain"]) assert.equal(entersRawWork({ call }), false, call);
});

test("tool set: the baseline minus workflow tools in a diet; restore_best only when a best tree exists; order kept", () => {
  const all = ["read", "bash", "edit", "write", "find", "run_tests", "todo", ...WORKFLOW_TOOLS, "restore_best"];
  assert.deepEqual(toolSet(all, { diet: false, best: false }), [...all.filter((n) => n !== "restore_best")]);
  assert.deepEqual(toolSet(all, { diet: true, best: false }), ["read", "bash", "edit", "write", "find", "run_tests", "todo"]);
  assert.deepEqual(toolSet(all, { diet: true, best: true }), ["read", "bash", "edit", "write", "find", "run_tests", "todo", "restore_best"]);
  assert.deepEqual(toolSet(all, { diet: false, best: true }).slice(-1), ["restore_best"]);
  assert.equal(toolSet(all, { diet: false, best: true }).filter((n) => n === "restore_best").length, 1);
  assert.deepEqual(toolSet(["read", "edit"], { diet: true, best: false }), ["read", "edit"], "a user's smaller baseline is never widened");
  for (const t of LOOP_TOOLS) assert.ok(!(WORKFLOW_TOOLS as readonly string[]).includes(t));
  const d = new ToolDiet();
  assert.equal(d.enter(), true);
  assert.equal(d.enter(), false, "once per request");
  assert.equal(d.leave(), true);
  assert.equal(d.leave(), false);
});

test("the extension: a workflow that did not finish puts the request on the loop tools until the next user message; the diet saves tool-definition characters", async () => {
  const cwd = repo();
  const { handlers, tools, sets, active } = await load({ TINYCODE_CONFIG: join(cwd, "none.json"), TINYCODE_LOG: join(cwd, "calls.jsonl") });
  const ctx = { cwd, hasUI: false, model: { id: "gemma-4-12b", provider: "tinycode", api: "openai-completions" } };
  const run = (name: string, e: Record<string, unknown>) => (handlers.get(name) ?? []).map((h) => h(e, ctx));
  await run("before_agent_start", { prompt: "what is the difference between a list and a tuple?", systemPrompt: "B" })[0];
  const full = active();
  assert.ok(full.includes("fix") && full.includes("find") && !full.includes("restore_best"), "all tools, no restore_best yet");
  // the first call of the request is a workflow tool that finished: no diet
  run("tool_result", { toolName: "explain", toolCallId: "a", input: {}, isError: false, content: [{ type: "text", text: "explained\nSTATUS: done. Report to user, stop." }] });
  assert.equal(active().length, full.length);
  // a workflow tool that failed: loop tools only
  run("tool_result", { toolName: "fix", toolCallId: "b", input: {}, isError: false, content: [{ type: "text", text: "fix failed\nSTATUS: failed \u2014 x; raw tools ok" }] });
  assert.deepEqual(active(), ["read", "bash", "edit", "write", "find", "run_tests", "todo"]);
  const sizeOf = (names: string[]) => names.reduce((n, name) => n + JSON.stringify(tools.get(name) ? { name, d: (tools.get(name) as { description?: string }).description, p: (tools.get(name) as { parameters?: unknown }).parameters } : { name }).length, 0);
  console.log(`registered tool definitions (tinyCode's own): ${sizeOf(full)} chars -> ${sizeOf(active())} chars in raw-tool work`);
  const nSets = sets.length;
  run("tool_call", { toolName: "bash", toolCallId: "c", input: { command: "ls" } });
  assert.equal(sets.length, nSets, "already in the diet: no second change");
  // the next user message restores the full set
  await run("before_agent_start", { prompt: "now explain report.py", systemPrompt: "B" })[0];
  assert.deepEqual(active(), full);
  // and a raw edit of the model's own starts the diet too
  run("tool_call", { toolName: "edit", toolCallId: "d", input: { path: "a.py", edits: [] } });
  assert.deepEqual(active(), ["read", "bash", "edit", "write", "find", "run_tests", "todo"]);
});

test("the extension: the tool-set API missing (older Pi) leaves all tools and never throws", async () => {
  const cwd = repo();
  const mod = await import("../../extensions/tinycode/index.ts");
  Object.assign(process.env, { TINYCODE_CONFIG: join(cwd, "none.json"), TINYCODE_LOG: join(cwd, "calls.jsonl") });
  const handlers = new Map<string, Handler[]>();
  const pi = { on: (n: string, h: Handler) => void handlers.set(n, [...(handlers.get(n) ?? []), h]), registerTool: () => {}, registerCommand: () => {}, registerMessageRenderer: () => {}, registerProvider: () => {}, sendMessage: () => {}, sendUserMessage: () => {}, setModel: async () => true };
  mod.default(pi as never);
  const ctx = { cwd, hasUI: false };
  await handlers.get("before_agent_start")![0]!({ prompt: "what is a tuple?", systemPrompt: "B" }, ctx);
  handlers.get("tool_call")![0]!({ toolName: "bash", toolCallId: "x", input: { command: "ls" } }, ctx);
  handlers.get("tool_result")![0]!({ toolName: "fix", toolCallId: "y", input: {}, isError: false, content: [{ type: "text", text: "STATUS: failed" }] }, ctx);
});

test("the extension: the system prompt has no Pi docs block, carries the terse line and the path rule", async () => {
  const cwd = repo();
  const { handlers } = await load({ TINYCODE_CONFIG: join(cwd, "none.json"), TINYCODE_LOG: join(cwd, "calls.jsonl") });
  const pi = readFileSync(new URL("../fixtures/pi-system-prompt.txt", import.meta.url), "utf8");
  const r = (await handlers.get("before_agent_start")![0]!({ prompt: "what is a tuple?", systemPrompt: pi }, { cwd, hasUI: false })) as { systemPrompt: string };
  assert.ok(!r.systemPrompt.includes("<docs>"));
  assert.ok(r.systemPrompt.includes("Reply short. Max one line before a tool call. No recap. Debug script over 20 lines: write a file, run it. Paths: relative to cwd."));
  assert.ok(r.systemPrompt.includes("<cwd>"));
});

test("the extension: run_tests keeps the best tree; a worse run says so and restore_best puts the better files back; a whole-file write over a file gets a nudge; a cut read ends with an explicit line", async () => {
  const cwd = repo();
  // undoWorse off: the model restores by itself here (the auto-undo default has its own test below)
  writeFileSync(join(cwd, "cfg.json"), JSON.stringify({ test: { command: "cat out.txt; false" }, limits: { undoWorse: false } }));
  writeFileSync(join(cwd, "bowling.py"), "v1\n");
  writeFileSync(join(cwd, "out.txt"), "FAILED t::a - x\n7 failed, 24 passed in 0.1s\n");
  const { handlers, tools, active } = await load({ TINYCODE_CONFIG: join(cwd, "cfg.json"), TINYCODE_LOG: join(cwd, "calls.jsonl") });
  const ctx = { cwd, hasUI: false };
  const run = (name: string, e: Record<string, unknown>) => (handlers.get(name) ?? []).map((h) => h(e, ctx));
  await run("before_agent_start", { prompt: "what is a tuple?", systemPrompt: "B" })[0];
  assert.ok(!active().includes("restore_best"), "not declared before a best tree exists");
  const exec = (name: string, params: unknown = {}) => (tools.get(name) as unknown as { execute: Exec }).execute("id", params, undefined, undefined, ctx);
  const first = await exec("run_tests");
  assert.ok(!first.content[0]!.text.includes("Worse than best"));
  assert.ok(active().includes("restore_best"), "declared once a best exists");
  writeFileSync(join(cwd, "bowling.py"), "v2 rewrite\n");
  writeFileSync(join(cwd, "out.txt"), "FAILED t::a - x\n28 failed, 3 passed in 0.1s\n");
  const worse = await exec("run_tests");
  assert.match(worse.content[0]!.text, /\nWorse than best \(24\/31 at test run 1\)\. Restore: call restore_best\.$/);
  const back = await exec("restore_best");
  assert.equal(back.content[0]!.text, "Restored best tree (24/31).");
  assert.equal(readFileSync(join(cwd, "bowling.py"), "utf8"), "v1\n");
  // a write over an existing file once tests pass: a nudge on its result, never a block
  const call = run("tool_call", { toolName: "write", toolCallId: "w1", input: { path: "bowling.py", content: "x" } });
  assert.ok(!call.some((v) => (v as { block?: boolean } | undefined)?.block));
  const res = run("tool_result", { toolName: "write", toolCallId: "w1", input: { path: "bowling.py" }, isError: false, content: [{ type: "text", text: "Wrote 1 bytes" }] })[0] as { content: { text: string }[] };
  assert.equal(res.content[0]!.text, "Wrote 1 bytes\nWhole-file rewrite. Prefer edit.");
  run("tool_call", { toolName: "write", toolCallId: "w2", input: { path: "new_file.py", content: "x" } });
  assert.equal(run("tool_result", { toolName: "write", toolCallId: "w2", input: { path: "new_file.py" }, isError: false, content: [{ type: "text", text: "Wrote 1 bytes" }] })[0], undefined, "a new file: no nudge");
  // a read cut by the view cap ends with an explicit line
  const cut = run("tool_result", { toolName: "read", toolCallId: "r1", input: { path: "bowling.py" }, isError: false, content: [{ type: "text", text: "line\n\n[16 more lines in file. Use offset=101 to continue.]" }] })[0] as { content: { text: string }[] };
  assert.equal(cut.content[0]!.text, "line\n[lines 1-100 of 116; file continues: read offset=101]");
  // a new request forgets the best tree
  await run("before_agent_start", { prompt: "and another question about lists", systemPrompt: "B" })[0];
  assert.ok(!active().includes("restore_best"));
  assert.equal((await exec("restore_best")).content[0]!.text, "No best tree yet.");
});

test("the extension, undoWorse: a worse run puts the best tree back at once (undoWorseFrom 1), the test file untouched; the same break a third time turns it off", async () => {
  const cwd = repo();
  // stuck rule off here: with it on, the third run without progress is its stop (src/besttree.ts, unit-tested);
  // undoWorseFrom 1 (at once): the default 2 lets a first break through (unit-tested in besttree.test.ts)
  writeFileSync(join(cwd, "cfg.json"), JSON.stringify({ test: { command: "cat out.txt; false" }, limits: { stuckTestRuns: 0, undoWorseFrom: 1 } }));
  writeFileSync(join(cwd, "bowling.py"), "v1\n");
  writeFileSync(join(cwd, "bowling_test.py"), "t1\n");
  writeFileSync(join(cwd, "out.txt"), "FAILED t::a - x\n7 failed, 24 passed in 0.1s\n");
  // the log (and the undo dir beside it) outside the tree, as in a real run: a restore removes files created since
  const { handlers, tools } = await load({ TINYCODE_CONFIG: join(cwd, "cfg.json"), TINYCODE_LOG: join(tmpDir("tc-undo-log-"), "calls.jsonl") });
  const ctx = { cwd, hasUI: false };
  await (handlers.get("before_agent_start") ?? [])[0]!({ prompt: "what is a tuple?", systemPrompt: "B" }, ctx);
  const exec = (name: string) => (tools.get(name) as unknown as { execute: Exec }).execute("id", {}, undefined, undefined, ctx);
  await exec("run_tests"); // the best: 24/31, snapshot of v1 and t1
  const breakIt = async () => {
    writeFileSync(join(cwd, "bowling.py"), "v2 broken\n");
    writeFileSync(join(cwd, "bowling_test.py"), "t2 (the model's)\n");
    writeFileSync(join(cwd, "helper.py"), "new\n");
    writeFileSync(join(cwd, "test_extra.py"), "new test\n");
    writeFileSync(join(cwd, "out.txt"), "FAILED t::a - x\nFAILED t::b - y\n28 failed, 3 passed in 0.1s\n");
    return (await exec("run_tests")).content[0]!.text;
  };
  const first = await breakIt();
  assert.match(first, /\nEdit made 21 more fail: best tree back \(24\/31\)\. Try another way\.$/);
  assert.equal(readFileSync(join(cwd, "bowling.py"), "utf8"), "v1\n", "the source is back");
  assert.equal(existsSync(join(cwd, "helper.py")), false, "a source file created since is removed");
  assert.equal(readFileSync(join(cwd, "bowling_test.py"), "utf8"), "t2 (the model's)\n", "a test file is never restored");
  assert.equal(existsSync(join(cwd, "test_extra.py")), true, "nor removed");
  assert.match(await breakIt(), /best tree back/);
  assert.match(await breakIt(), /\nSame break 3 times: best tree back \(24\/31\)\. No more auto-restore until new best\. Change approach\.$/);
  assert.match(await breakIt(), /\nWorse than best \(24\/31 at test run 1\)\. Restore: call restore_best\.$/, "off until a new best");
  assert.equal(readFileSync(join(cwd, "bowling.py"), "utf8"), "v2 broken\n");
});

test("the extension: heartbeats and stuck lines never reach the model's context; the hint stays", async () => {
  const cwd = repo();
  const { handlers } = await load({ TINYCODE_CONFIG: join(cwd, "none.json"), TINYCODE_LOG: join(cwd, "calls.jsonl") });
  const ctx = { cwd, hasUI: false, model: { id: "gemma-4-12b", provider: "tinycode", api: "openai-completions" }, getSystemPrompt: () => "S" };
  const t = (text: string) => [{ type: "text", text }];
  const out = (handlers.get("context") ?? [])[0]!({ messages: [
    { role: "user", content: t("fix it"), timestamp: 1 },
    { role: "custom", customType: "tinycode-beat", content: "Still working on your request \u2014 4 steps so far.", display: true, timestamp: 2 },
    { role: "custom", customType: "tinycode-hint", content: "tinyCode hint: use `fix`.", display: false, timestamp: 3 },
  ] }, ctx) as { messages: { customType?: string; role: string }[] };
  assert.deepEqual(out.messages.map((m) => m.customType ?? m.role), ["user", "tinycode-hint"]);
});

test("the extension, undoWorse default (undoWorseFrom 2): a first break gets the old line and is left for the model; the same break again is undone", async () => {
  const cwd = repo();
  writeFileSync(join(cwd, "cfg.json"), JSON.stringify({ test: { command: "cat out.txt; false" }, limits: { stuckTestRuns: 0 } }));
  writeFileSync(join(cwd, "bowling.py"), "v1\n");
  writeFileSync(join(cwd, "out.txt"), "FAILED t::a - x\n7 failed, 24 passed in 0.1s\n");
  const { handlers, tools } = await load({ TINYCODE_CONFIG: join(cwd, "cfg.json"), TINYCODE_LOG: join(tmpDir("tc-undo2-log-"), "calls.jsonl") });
  const ctx = { cwd, hasUI: false };
  await (handlers.get("before_agent_start") ?? [])[0]!({ prompt: "what is a tuple?", systemPrompt: "B" }, ctx);
  const exec = (name: string) => (tools.get(name) as unknown as { execute: Exec }).execute("id", {}, undefined, undefined, ctx);
  await exec("run_tests");
  writeFileSync(join(cwd, "bowling.py"), "v2 broken\n");
  writeFileSync(join(cwd, "out.txt"), "FAILED t::b - y\n28 failed, 3 passed in 0.1s\n");
  assert.match((await exec("run_tests")).content[0]!.text, /\nWorse than best \(24\/31 at test run 1\)\. Restore: call restore_best\.$/);
  assert.equal(readFileSync(join(cwd, "bowling.py"), "utf8"), "v2 broken\n", "a first break may be fixed forward");
  assert.match((await exec("run_tests")).content[0]!.text, /\nEdit made 21 more fail: best tree back \(24\/31\)\. Try another way\.$/);
  assert.equal(readFileSync(join(cwd, "bowling.py"), "utf8"), "v1\n");
});
