import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { ANSWER_SCHEMA, BRANCH_SYSTEM, branchMessages, findAnswer, formatAnswer, restoreTool, timedRun } from "../../src/branch.ts";
import { BestTree } from "../../src/besttree.ts";
import { Type } from "@earendil-works/pi-ai";
import { TestClock } from "../../src/testrun.ts";
import { DEFAULTS } from "../../src/config.ts";
import type { ChatResult, Message } from "../../src/llm.ts";

test("formatAnswer: json answer + citations; plain text and empty fall back", () => {
  assert.equal(
    formatAnswer(JSON.stringify({ answer: "It is set in config.", citations: ["config/app.ini:3", "uploader/limits.py:9"] })),
    "It is set in config.\n- config/app.ini:3\n- uploader/limits.py:9",
  );
  assert.equal(formatAnswer("not json"), "not json");
  assert.equal(formatAnswer(""), "(branch returned nothing)");
});

test("find: evidence goes to one 'branch' call with the answer schema; only the answer comes back", async () => {
  const d = tmpDir("tinycode-branch-");
  mkdirSync(join(d, "uploader"));
  writeFileSync(join(d, "uploader/limits.py"), "MAX_UPLOAD_MB = 5\n\ndef check(size):\n    return size <= MAX_UPLOAD_MB\n");
  const calls: { step: string; messages: Message[]; schema?: object }[] = [];
  const fake = async (step: string, messages: Message[], o?: { schema?: object }): Promise<ChatResult> => {
    calls.push({ step, messages, schema: o?.schema });
    return {
      text: JSON.stringify({ answer: "In limits.py.", citations: ["uploader/limits.py:1"] }),
      usage: { prompt_tokens: 1, cached_tokens: 0, completion_tokens: 1 },
      ms: 1,
      lane: "small",
      model: "m",
      fellBack: false,
    };
  };
  const out = await findAnswer(d, "where is the upload limit set?", { config: DEFAULTS, chat: fake });
  assert.equal(out, "In limits.py.\n- uploader/limits.py:1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].step, "branch");
  assert.equal(calls[0].schema, ANSWER_SCHEMA);
  assert.equal(calls[0].messages[0].content, BRANCH_SYSTEM);
  assert.match(calls[0].messages[1].content, /uploader\/limits\.py:1: MAX_UPLOAD_MB = 5/);
  assert.match(calls[0].messages[1].content, /Question: where is the upload limit set\?/);
});

test("branchMessages: outline, hits, question in that order", () => {
  const m = branchMessages("q?", { outline: "O", hits: "H" });
  assert.equal(m[1].content, "Outline:\nO\n\nGrep hits:\nH\nQuestion: q?");
});

test("E24 run_tests: the scaled limit and the timeout text; off, 300 s and today's text with the shadow lines", () => {
  const lines: [string, boolean, string][] = [];
  const hooks = { clock: new TestClock(), shadow: (s: string, on: boolean, t: string) => void lines.push([s, on, t]) };
  const clean = { ok: false, text: "FAIL 1 failed, 3 passed", counts: { passed: 3, failed: 1 }, code: 1, timedOut: false, ms: 200 };
  const hang = { ok: false, text: "FAIL tests timed out after 30s\n...", counts: null, code: null, timedOut: true, ms: 30_000 };
  // on
  const a = timedRun(10, hooks);
  assert.equal(a.limitMs, 300_000, "no clean run yet");
  assert.equal(a.done(clean), clean.text);
  const b = timedRun(10, hooks);
  assert.equal(b.limitMs, 30_000);
  assert.equal(b.done(hang), "FAIL tests timed out after 30s (10x the longest clean run, 0.2s): likely an endless loop. The next run gets 300s.\n...");
  assert.deepEqual(lines.map((l) => [l[0], l[1]]), [["test_timeout", true]]);
  assert.equal(timedRun(10, hooks).limitMs, 300_000, "back-off after the timeout");
  // off: today's 300 s and text; the shadow says what the arm would have done
  lines.length = 0;
  const off = { clock: new TestClock(), shadow: hooks.shadow };
  timedRun(0, off).done(clean);
  const c = timedRun(0, off);
  assert.equal(c.limitMs, 300_000);
  const long = { ...hang, text: "FAIL tests timed out after 300s\n..." };
  assert.equal(c.done(long), long.text);
  timedRun(0, off).done(clean);
  timedRun(0, off).done({ ...clean, ms: 45_000 });
  assert.deepEqual(lines.map((l) => [l[0], l[1]]), [["test_timeout", false], ["test_kill", false]]);
  assert.match(lines[1][2], /a 45000 ms run is over the scaled limit 30s/);
});

test("E22 restore_best: the schema without startOver is today's; with it an optional to: best|start; to=start calls restoreStart", async () => {
  const calls: string[] = [];
  const mk = (on: boolean, taken = true) => {
    const tree = new BestTree(3, 0, false, 1, true, on);
    tree.observe({ passed: 6, failed: 4 }, () => {}, undefined, {});
    const hooks = { tree, snapshot: () => {}, restore: () => void calls.push("best"), onFirstBest: () => {}, restoreStart: () => void calls.push("start"), startTaken: () => taken };
    return { tree, tool: restoreTool(hooks, on) };
  };
  const off = mk(false).tool;
  assert.equal(JSON.stringify(off.parameters), JSON.stringify(Type.Object({})), "off: exactly today's schema");
  assert.deepEqual(Object.keys((off.parameters as { properties: object }).properties), [], "off: no parameters, as before");
  assert.equal(off.description, "Put files back to the best tree seen (most tests passing).");
  const on = mk(true);
  const props = (on.tool.parameters as { properties: Record<string, { enum?: string[] }>; required?: string[] }).properties;
  assert.deepEqual(props.to.enum, ["best", "start"]);
  assert.ok(!((on.tool.parameters as { required?: string[] }).required ?? []).includes("to"), "optional");
  const exec = (t: typeof on.tool, p: Record<string, unknown>) => t.execute("id", p as never, undefined, undefined, { cwd: "/w" } as never) as Promise<{ content: { text: string }[] }>;
  assert.equal((await exec(on.tool, {})).content[0].text, "Restored best tree (6/10).", "default best");
  assert.equal((await exec(on.tool, { to: "start" })).content[0].text, "Original files back (tests kept; best tree 6/10 saved). Rebuild, then run_tests.");
  assert.equal(on.tree.freshAttempt, true);
  assert.deepEqual(calls, ["best", "start"]);
  assert.equal((await exec(mk(true, false).tool, { to: "start" })).content[0].text, "No start snapshot in this request.");
});
