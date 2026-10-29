import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { approxTokens, MEMORY_PROMPT, Todo, tailText, withTail } from "../../src/limits.ts";
import { buildIndex, heuristic } from "../../src/router.ts";
import { todoFirst, statusLine, INTENT_DESCRIPTION, intentOf, compact, forTool, hintFor, isWorkflowTool, RAW_TOOLS, SPECS, TOOLS_FIRST_PROMPT, ToolsFirst, TOOL_FOR, toolResult, WORKFLOW_TOOLS, workflowTools } from "../../src/tools.ts";

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
  for (const w of ["tool fits", "plain words", "decide the next step", "Ask the user before", "tinyCode hint"]) assert.ok(TOOLS_FIRST_PROMPT.includes(w), w);
});

function repo() {
  const d = mkdtempSync(join(tmpdir(), "tinycode-tools-"));
  mkdirSync(join(d, "orders"));
  writeFileSync(join(d, "orders/report.py"), "def monthly_totals(rows):\n    return rows\n");
  return d;
}

test("hint injection: a routed request gets one tail line naming the tool and the file; chat and unsure get none", () => {
  const idx = buildIndex(repo());
  const h = hintFor(heuristic("monthly_totals gives me two rows for january, fix it", idx.names));
  assert.deepEqual(h, { tool: "fix", line: "tinyCode hint: Use `fix` for this (file: orders/report.py)." });
  const m = hintFor({ ...heuristic("sort that out", idx.names), workflow: "fix", file: "", source: "model" });
  assert.deepEqual(m, { tool: "fix", line: "tinyCode hint: This looks like `fix`." }, "model-decided: softer wording");
  const q = hintFor(heuristic("what is the difference between a list and a tuple?", idx.names))!;
  assert.equal(q.tool, null);
  assert.match(q.line, /This is a question; answer it directly, no tool needed\./);
  assert.equal(hintFor(heuristic("thanks, that works", idx.names))?.tool, null);
  assert.deepEqual(hintFor(heuristic("rename it", idx.names)), { tool: "edit_file", line: "tinyCode hint: This looks like `edit_file`." }, "edit without a file: unsure wording");
  assert.equal(hintFor(heuristic("write tests for monthly_totals", idx.names))?.tool, "test");
  assert.equal(hintFor(heuristic("update the readme to match the code", idx.names))?.tool, "doc");
  assert.equal(hintFor(heuristic("what does monthly_totals do", idx.names))?.tool, "explain");
});

test("tools-first nudge: a raw first action with a hint gets one tail line; a tool first does not; never twice; logged yes/no/none", () => {
  const t = new ToolsFirst();
  t.start("fix the bug in orders", "fix");
  assert.equal(t.onCall("read"), "try `fix` first; it is cheaper and checked");
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
  };
  mod.default(pi as never);
  return { handlers, tools, commands, cmdHandlers };
}

test("the extension: `input` only for orchestration (never rewrites the text); workflow tools beside find/todo/run_tests; every slash command kept", async () => {
  const cwd = repo();
  const { handlers, tools, commands } = await load({ TINYCODE_CONFIG: join(cwd, "none.json"), TINYCODE_LOG: join(cwd, "calls.jsonl") });
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
  const { handlers } = await load({ TINYCODE_CONFIG: join(cwd, "none.json"), TINYCODE_LOG: log });
  const call = (name: string, e: Record<string, unknown>, ctx: Record<string, unknown> = { cwd, hasUI: false }) => (handlers.get(name) ?? []).map((h) => h(e, ctx));
  const r = (await call("before_agent_start", { prompt: "monthly_totals gives me two rows for january, fix it", systemPrompt: "BASE" })[0]) as { systemPrompt: string; message?: { customType: string; content: string; display: boolean } };
  assert.ok(r.systemPrompt.startsWith("BASE\n\n") && r.systemPrompt.includes(TOOLS_FIRST_PROMPT) && r.systemPrompt.includes(MEMORY_PROMPT));
  assert.deepEqual(r.message, { customType: "tinycode-hint", content: "tinyCode hint: Use `fix` for this (file: orders/report.py).", display: false });
  // the model's first action is a raw read: allowed, never blocked, and one nudge is queued for the tail
  const verdicts = call("tool_call", { toolName: "read", input: { path: "orders/report.py" } });
  assert.ok(!verdicts.some((v) => (v as { block?: boolean } | undefined)?.block), "never a block");
  const ctxOut = call("context", { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })[0] as { messages: { content: unknown }[] } | undefined;
  assert.ok(JSON.stringify(ctxOut).includes("try `fix` first; it is cheaper and checked"), JSON.stringify(ctxOut));
  call("agent_end", {});
  const rec = JSON.parse(readFileSync(join(cwd, "tools-first.jsonl"), "utf8").trim().split("\n").pop()!);
  assert.deepEqual([rec.tools_first, rec.first, rec.hint, rec.nudged], ["no", "read", "fix", true]);
  // a chat request: no hint message, no nudge
  const c = (await call("before_agent_start", { prompt: "what is the difference between a list and a tuple?", systemPrompt: "BASE" })[0]) as { message?: { content: string } };
  assert.match(c.message!.content, /answer it directly, no tool needed/);
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
  assert.ok(r.content[0]!.text.endsWith("report the result to the user in plain words and stop"));
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
  assert.ok(done.endsWith("STATUS: done \u2014 the request is complete; report the result to the user in plain words and stop"));
  const part = toolResult({ text: "3 of 5 done", ok: true, remaining: "tasks 4 and 5 are not built" }).content[0]!.text;
  assert.ok(part.endsWith("STATUS: partial \u2014 tasks 4 and 5 are not built"));
  assert.ok(!part.includes("STATUS: done"));
  const failed = toolResult({ text: "fix failed: door down\nmore", ok: false }).content[0]!.text;
  assert.ok(failed.endsWith("STATUS: failed \u2014 fix failed: door down; you may continue with raw tools"));
  assert.ok(statusLine({ text: "x", ok: false, reason: "tests still red" }).includes("tests still red"));
  assert.ok(TOOLS_FIRST_PROMPT.includes("When a tool returns STATUS: done, report and stop; don't redo the work with raw tools."));
});

test("prompt: reads the project itself, todo only when no tool fits and not a question", () => {
  assert.ok(TOOLS_FIRST_PROMPT.includes("You can always read this project with your tools; never ask the user for code or paths you can find yourself."));
  assert.ok(TOOLS_FIRST_PROMPT.includes("phases are its plan"));
  assert.match(MEMORY_PROMPT, /no tinyCode tool fits and the request is not a question, start with todo/);
});

test("todo nudge: none when the request routed to a workflow tool or is a question; yes for raw work", () => {
  const idx = buildIndex("/nonexistent", ["monthly_totals.py"]);
  assert.equal(todoFirst(heuristic("monthly_totals gives me two rows for january, fix it", idx.names)), false);
  assert.equal(todoFirst(heuristic("what does monthly_totals do", idx.names)), false);
  assert.equal(todoFirst(heuristic("what is the difference between a list and a tuple?", idx.names)), false);
  assert.equal(todoFirst({ workflow: "none", file: "", goal: "x", confident: false }), true);
  const t = new Todo();
  assert.equal(tailText(t, false, 3, false, [], false), null);
  assert.match(tailText(t, false, 3, false, [], true) as string, /todo is empty/);
  assert.equal(withTail([{ role: "toolResult", toolName: "doc", toolCallId: "1", content: [] } as never], t, false, [], false), undefined);
});
