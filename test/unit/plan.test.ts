import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { mergeConfig } from "../../src/config.ts";
import { actionable, heuristic } from "../../src/router.ts";
import type { ChatResult, Message } from "../../src/llm.ts";
import { gatherContext, isRelativePath, parsePlan, planMarkdown, runPlan, validatePlan } from "../../src/workflows/plan.ts";

const task = (id: number, over: Record<string, unknown> = {}) => ({ id, title: `task ${id}`, files: [`src/m${id}.py`], test: `tests/test_m${id}.py checks m${id}`, ...over });
const good = (n = 4) => ({ spec: "A habit tracker.", stack: "Python, pytest", tasks: Array.from({ length: n }, (_, i) => task(i + 1)) });
const reply = (o: unknown): ChatResult => ({ text: typeof o === "string" ? o : JSON.stringify(o), usage: { prompt_tokens: 300, cached_tokens: 0, completion_tokens: 200 }, ms: 1, lane: "trunk", model: "m", fellBack: false });
const tmp = () => tmpDir("tc-plan-");

test("validatePlan: a good plan passes and every task gets done:false", () => {
  const r = validatePlan(good(5));
  assert.ok(r.plan);
  assert.equal(r.plan.tasks.length, 5);
  assert.ok(r.plan.tasks.every((t) => t.done === false));
});

test("validatePlan: task count, duplicate ids, absolute or escaping files, missing tests", () => {
  assert.match(validatePlan(good(2)).errors.join(), /2 entries/);
  assert.match(validatePlan(good(13)).errors.join(), /13 entries/);
  assert.match(validatePlan({ ...good(), tasks: [task(1), task(1), task(3)] }).errors.join(), /used twice/);
  for (const f of ["/etc/x.py", "C:\\x.py", "../x.py", "a/../../x.py", ""]) {
    assert.match(validatePlan({ ...good(), tasks: [task(1, { files: [f] }), task(2), task(3)] }).errors.join(), /relative path|files is empty/, f);
  }
  assert.match(validatePlan({ ...good(), tasks: [task(1, { test: " " }), task(2), task(3)] }).errors.join(), /test is empty/);
  assert.match(validatePlan({ ...good(), tasks: [task(1, { files: [] }), task(2), task(3)] }).errors.join(), /files is empty/);
  assert.match(validatePlan({ ...good(), spec: "" }).errors.join(), /spec/);
  assert.match(validatePlan(null).errors.join(), /spec/);
  assert.ok(isRelativePath("a/b.py") && !isRelativePath("/a"));
});

test("parsePlan: fences tolerated, junk rejected", () => {
  assert.ok(parsePlan("```json\n" + JSON.stringify(good()) + "\n```").plan);
  assert.match(parsePlan("no json here").errors[0]!, /not JSON/);
  assert.match(parsePlan("{broken").errors[0]!, /not JSON|not valid/);
});

test("gatherContext: empty folder gives none; project gives outline + README head within budget", () => {
  const empty = tmp();
  mkdirSync(join(empty, ".git"));
  assert.equal(gatherContext(empty), "");
  const d = tmp();
  writeFileSync(join(d, "app.py"), "def main():\n    pass\n");
  writeFileSync(join(d, "README.md"), "# Demo\n" + "x".repeat(5000));
  const c = gatherContext(d);
  assert.match(c, /app\.py/);
  assert.match(c, /README\.md \(start\)/);
  assert.ok(c.length < 8500, String(c.length));
});

test("runPlan: scripted valid reply writes plan.json + PLAN.md, shows a numbered list, asks run it?", async () => {
  const d = tmp();
  const seen: { step: string; messages: Message[]; schema?: object }[] = [];
  const lines: string[] = [];
  const asked: string[] = [];
  const r = await runPlan({ request: "a CLI habit tracker" }, {
    cwd: d,
    config: mergeConfig({}),
    chat: async (step, messages, o) => {
      seen.push({ step, messages: [...messages], schema: o?.schema });
      return reply(good(5));
    },
    report: (l) => lines.push(l),
    confirm: async (q) => (asked.push(q), true),
    env: { TINYCODE_LOG: join(d, "calls.jsonl") },
  });
  assert.equal(r.calls, 1);
  assert.equal(seen[0]!.step, "plan");
  assert.ok(seen[0]!.schema);
  assert.match(seen[0]!.messages[1]!.content, /folder is empty/);
  assert.ok(r.confirmed);
  assert.deepEqual(asked, ["run it?"]);
  assert.ok(lines.some((l) => l.startsWith("1. task 1")) && lines.some((l) => l.startsWith("5. task 5")));
  const saved = JSON.parse(readFileSync(join(d, ".tinycode/plan.json"), "utf8"));
  assert.equal(saved.tasks.length, 5);
  assert.match(readFileSync(join(d, ".tinycode/PLAN.md"), "utf8"), /1\. \[ \] task 1/);
  // a second plan keeps the first as plan.prev.json
  await runPlan({ request: "again" }, { cwd: d, config: mergeConfig({}), chat: async () => reply(good(3)), report: () => {} });
  assert.ok(existsSync(join(d, ".tinycode/plan.prev.json")));
  assert.equal(JSON.parse(readFileSync(join(d, ".tinycode/plan.json"), "utf8")).tasks.length, 3);
});

test("runPlan: an invalid reply gets one retry with the errors appended; a second failure writes nothing", async () => {
  const d = tmp();
  const prompts: Message[][] = [];
  const bad = { ...good(), tasks: [task(1, { test: "" }), task(2), task(3)] };
  const ok = await runPlan({ request: "x" }, {
    cwd: d, config: mergeConfig({}), report: () => {},
    chat: async (_s, m) => (prompts.push([...m]), reply(prompts.length === 1 ? bad : good())),
  });
  assert.equal(ok.calls, 2);
  assert.ok(ok.plan);
  assert.equal(prompts[1]!.length, 4);
  assert.deepEqual(prompts[1]!.slice(0, 2), prompts[0]!.slice(0, 2));
  assert.match(prompts[1]![3]!.content, /test is empty/);
  const d2 = tmp();
  const fail = await runPlan({ request: "x" }, { cwd: d2, config: mergeConfig({}), report: () => {}, chat: async () => reply(bad) });
  assert.equal(fail.plan, null);
  assert.equal(fail.calls, 2);
  assert.ok(!existsSync(join(d2, ".tinycode")));
});

test("runPlan: no UI means no confirm; empty request prints usage without a call", async () => {
  const lines: string[] = [];
  const noCall = async () => { throw new Error("no call expected"); };
  const u = await runPlan({ request: "" }, { cwd: tmp(), config: mergeConfig({}), chat: noCall, report: (l) => lines.push(l) });
  assert.match(lines[0]!, /usage/);
  assert.equal(u.calls, 0);
  const r = await runPlan({ request: "x" }, { cwd: tmp(), config: mergeConfig({}), chat: async () => reply(good()), report: () => {} });
  assert.equal(r.confirmed, false);
  assert.ok(r.plan);
});

test("config: the plan step defaults to trunk and may name the cloud lane", () => {
  assert.equal(mergeConfig({}).steps.plan.lane, "trunk");
  const c = mergeConfig({ lanes: { cloud: { baseUrl: "https://x/v1", model: "m", apiKeyEnv: "K" } }, steps: { plan: { lane: "cloud" } } });
  assert.equal(c.steps.plan.lane, "cloud");
  assert.throws(() => mergeConfig({ steps: { plan: { lane: "cloud" } } }), /null/);
});

test("router: 'build a ... app' with no matching file routes to plan; with a matching file it does not", () => {
  const none = new Map<string, string>();
  const r = heuristic("build a CLI habit tracker app with pytest", none);
  assert.deepEqual([r.workflow, r.confident, actionable(r)], ["plan", true, "plan"]);
  assert.equal(heuristic("create a small script that renames photos", none).workflow, "plan");
  assert.equal(heuristic("make a tool for tracking habits", none).workflow, "plan");
  const names = new Map([["tracker.py", "tracker.py"]]);
  assert.notEqual(heuristic("make a tool out of tracker.py", names).workflow, "plan");
  // S18: a general how-to question is no plan request; it now goes to /ask (was "none" before /ask existed)
  assert.equal(heuristic("how do I build an app?", none).workflow, "ask");
  assert.equal(heuristic("fix the failing test", none).workflow, "fix");
  assert.ok(planMarkdown(good() as never).includes("# Plan"));
});
