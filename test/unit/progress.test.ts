import assert from "node:assert/strict";
import {  } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { logCall } from "../../src/log.ts";
import { createProgress, fmtTime, fmtTok, type ProgressOptions, type ProgressSink } from "../../src/progress.ts";

/** A sink that records everything; a clock the test moves. */
function rig(over: Partial<ProgressOptions> & { interactive?: boolean; confirm?: (n: number) => Promise<boolean>; width?: number } = {}) {
  const t = { ms: 1_000_000 };
  const log = { status: [] as (string | undefined)[], widget: [] as (string[] | undefined)[], message: [] as string[], err: [] as string[], stops: 0, asked: [] as number[] };
  const sink: ProgressSink = {
    interactive: over.interactive ?? true,
    status: (x) => log.status.push(x),
    widget: (x) => log.widget.push(x),
    message: (x) => log.message.push(x),
    err: (x) => log.err.push(x),
    width: over.width !== undefined ? () => over.width! : undefined,
    confirmStuck: over.confirm
      ? (n) => {
          log.asked.push(n);
          return over.confirm!(n);
        }
      : undefined,
    onStop: () => log.stops++,
  };
  const p = createProgress({ workflow: "doc readme", sink, now: () => t.ms, noLog: true, ...over });
  const call = (prompt = 100, completion = 20, cached = 0) => p.count({ prompt_tokens: prompt, completion_tokens: completion, cached_tokens: cached });
  const last = () => {
    p.tick();
    return log.status.filter((x) => x !== undefined).at(-1)!;
  };
  return { p, t, log, call, last };
}

test("time and token formats", () => {
  assert.deepEqual([0, 40_000, 100_000, 273_000, 3_720_000].map(fmtTime), ["0s", "40s", "1m40s", "4m33s", "1h02m"]);
  assert.deepEqual([812, 8400, 24_300, 84_000].map(fmtTok), ["812", "8.4k", "24k", "84k"]);
});

test("the live line: tinyCode · workflow · phase i/n · calls · tokens · elapsed; starts at running…", () => {
  const { p, t, call, last } = rig({ phases: ["scan", "summarising files", "folders"] });
  assert.equal(last(), "tinyCode · doc readme · running… · 0 calls · 0 tok · 0s");
  for (let k = 0; k < 31; k++) call(700, 80);
  p.step("summarising files", 12, 46);
  t.ms += 100_000;
  assert.equal(last(), "tinyCode · doc readme · summarising files 12/46 · 31 calls · 24k tok · 1m40s");
});

test("narrow terminals drop tokens first, then calls, never the phase or the elapsed time; no estimate", () => {
  const { p, t, call } = rig({ phases: ["a", "b", "c", "d"] });
  for (let k = 0; k < 9; k++) call(500, 100);
  p.step("a");
  p.step("b", 3, 10);
  t.ms += 60_000;
  const full = p.render(500);
  assert.match(full, /doc readme · b 3\/10 · 9 calls · 5\.4k tok · 1m00s$/);
  assert.ok(!full.includes("left"));
  const noTok = p.render(full.length - 1);
  assert.ok(!noTok.includes("tok") && noTok.includes("9 calls"), noTok);
  const bare = p.render(noTok.length - 1);
  assert.ok(!bare.includes("calls") && bare.includes("b 3/10") && bare.includes("1m00s"), bare);
  assert.ok(p.render(20).length <= 20 && p.render(20).endsWith("…"));
});

test("nesting: build · task → fix · review; add → fix · loop; plan · research 4/8", () => {
  const b = rig({ phases: [] });
  b.p.declare(["task 3/5: parser"]);
  b.p.step("task 3/5: parser");
  const fix = b.p.nest("fix");
  fix.step("review");
  assert.match(b.last(), /^tinyCode · doc readme · task 3\/5: parser → fix · review · /);
  fix.end();
  assert.ok(!b.p.render().includes("→"));
  const a = rig();
  const f = a.p.nest("fix");
  f.step("loop");
  assert.match(a.last(), /^tinyCode · doc readme → fix · loop · /);
  const pl = rig({ phases: ["research", "plan", "save"] });
  pl.p.step("research", 4, 8);
  assert.match(pl.last(), /^tinyCode · doc readme · research 4\/8 · /);
});

test("checklist: ✓ done (dimmed), ▸ current with its count, ○ pending; six lines at most, then +N more", () => {
  const { p } = rig({ phases: ["scan", "summarising files", "folders", "sections", "self-check", "render"] });
  p.step("summarising files", 12, 46);
  assert.deepEqual(p.checklist(), ["\x1b[2m✓ scan\x1b[22m", "▸ summarising files 12/46", "○ folders", "○ sections", "○ self-check", "○ render"]);
  const many = rig({ phases: Array.from({ length: 10 }, (_, k) => `s${k}`) });
  many.p.step("s6");
  const c = many.p.checklist();
  assert.equal(c.length, 6);
  assert.ok(c.some((l) => l === "▸ s6") && c.at(-1) === "+5 more", c.join("|"));
  const quiet = rig({ phases: ["a", "b"], interactive: false });
  quiet.p.step("b");
  assert.deepEqual(quiet.p.checklist(), ["✓ a", "▸ b"], "no ANSI without a UI");
  assert.deepEqual(rig().p.checklist(), [], "nothing declared, nothing listed");
});

test("plain chat: the model's todo is the checklist, with todo n/m and cache % on the line", () => {
  const { p, call, last, log } = rig({ showCache: true });
  p.setTodo([{ text: "read file", done: true }, { text: "edit it", done: false }, { text: "run test", done: false }]);
  call(1000, 100, 750);
  assert.match(last(), /todo 1\/3 · 1 calls · 1\.1k tok \(75% cached\) · /);
  assert.deepEqual(log.widget.at(-1), ["\x1b[2m✓ read file\x1b[22m", "▸ edit it", "○ run test"]);
  p.note("step", "stepped back");
  assert.match(last(), /todo 1\/3 · stepped back · /);
  p.note("step", "");
  assert.ok(!last().includes("stepped back"));
});

test("stuck: N calls with no phase step and no file change -> the line says so and the operator is asked once; stop only on a no", async () => {
  const yes = rig({ stuckCalls: 3, confirm: async () => true });
  yes.call();
  yes.call();
  assert.ok(!yes.last().includes("stuck"));
  yes.call();
  assert.match(yes.last(), /looks stuck after 3 calls/);
  yes.call();
  yes.call();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(yes.log.asked, [3], "asked once");
  assert.equal(yes.p.stopped, false);
  assert.equal(yes.log.stops, 0);
  await yes.p.chat(async () => "ok")(); // continues

  const no = rig({ stuckCalls: 2, confirm: async () => false });
  no.call();
  no.call();
  await new Promise((r) => setImmediate(r));
  assert.equal(no.p.stopped, true);
  assert.equal(no.log.stops, 1);
  await assert.rejects(no.p.chat(async () => "x")(), /stopped at your request/);

  // a file change or a phase step resets the count
  const r = rig({ stuckCalls: 3, confirm: async () => true });
  r.call();
  r.call();
  r.p.touch("a.py");
  r.call();
  r.call();
  r.p.step("next");
  r.call();
  r.call();
  assert.ok(!r.p.stuck && r.log.asked.length === 0);
  r.call();
  assert.ok(r.p.stuck, "three since the last step");
  r.p.touch();
  assert.ok(!r.p.stuck && !r.last().includes("stuck"), "progress clears the warning");
});

test("stuck without a UI: a warning on stderr and the run continues", () => {
  const q = rig({ stuckCalls: 2, interactive: false });
  q.call();
  q.call();
  assert.ok(q.log.err.some((l) => /^tinyCode · doc readme · This has gone 2 calls without visible progress/.test(l)), q.log.err.join("\n"));
  assert.equal(q.p.stopped, false);
});

test("no UI: progress lines on stderr at each phase, the summary as the message (stdout), nothing on status or widget", () => {
  const q = rig({ interactive: false, phases: ["a", "b"] });
  q.p.step("a", 1, 2);
  q.p.step("b");
  assert.equal(q.log.err.length, 2);
  assert.match(q.log.err[0]!, /^tinyCode · doc readme · a 1\/2 · 0 calls/);
  assert.equal(q.log.status.filter((x) => x !== undefined).length, 0);
  q.p.done("ok");
  assert.equal(q.log.message.length, 1);
});

test("end summary: outcome, what changed, calls, tokens (cached %), time, next step; clears status and checklist; once", () => {
  const { p, t, call, log } = rig({ phases: ["a", "b"] });
  for (let k = 0; k < 46; k++) call(1500, 300, 1000);
  t.ms += 273_000;
  const text = p.done({ text: "docs/overview.html written", files: ["docs/overview.html"], next: "open it in a browser" });
  assert.equal(text, "Done — docs/overview.html written.\ndoc readme done: docs/overview.html written, 46 calls, 83k tokens (67% cached), 4m33s\nNext: open it in a browser");
  assert.deepEqual(log.message, [text]);
  assert.equal(log.status.at(-1), undefined);
  assert.equal(log.widget.at(-1), undefined);
  p.done("again");
  assert.equal(log.message.length, 1, "done twice posts once");
  const f = rig();
  f.p.touch("a.py");
  f.p.touch("b.py");
  assert.match(f.p.fail("the test still fails", { next: "/fix --undo to revert" }), /^That didn't work — the test still fails\.\ndoc readme failed: the test still fails, changed a\.py, b\.py, 0 calls, 0 tokens, 0s\nNext: \/fix --undo to revert$/);
  const b = rig();
  assert.match(b.p.done({ outcome: "blocked", reason: "stopped at task 2" }), /^I had to stop — stopped at task 2\.\ndoc readme blocked: stopped at task 2, /);
});

test("counters come from the call log, the records /tinycode stats reads; stop listening when done", () => {
  const env = { TINYCODE_LOG: join(tmpDir("tc-prog-"), "calls.jsonl") };
  const sink = { status() {}, widget() {}, message() {}, err() {}, interactive: true } satisfies ProgressSink;
  const p = createProgress({ workflow: "x", sink });
  const rec = (n: number) => ({ ts: "", session: "s", workflow: "x", step: "edit", lane: "l", model: "m", prompt_tokens: n, cached_tokens: n / 2, completion_tokens: 1, ms: 1, status: 200 });
  logCall(rec(100), env);
  logCall(rec(200), env);
  logCall({ ...rec(0), step: "step_back" }, env);
  assert.equal(p.calls, 2);
  assert.equal(p.tokens, 302);
  p.done("x");
  logCall(rec(100), env);
  assert.equal(p.calls, 2, "a finished progress no longer counts");
});

test("a workflow end to end with a fake chat: phases in order, counts, checklist, one summary", async () => {
  const { runAsk, ASK_PHASES } = await import("../../src/workflows/ask.ts");
  const { mergeConfig } = await import("../../src/config.ts");
  const r = rig({ phases: ASK_PHASES });
  const chat = r.p.chat(async () => {
    r.call(40, 10);
    return { text: "An answer.", usage: { prompt_tokens: 40, cached_tokens: 0, completion_tokens: 10 }, ms: 1, lane: "l", model: "m", fellBack: false };
  });
  const res = await runAsk({ question: "why?" }, { config: mergeConfig({}), chat, progress: r.p, report: () => {} });
  assert.equal(res.ok, true);
  assert.ok(r.log.status.some((s) => s?.includes("· answer ·")));
  r.p.done({ text: "answered" });
  assert.equal(r.log.message[0], "Done — answered.\ndoc readme done: answered, 1 call, 50 tokens, 0s");
});

test("heartbeat: cadence, skip when idle, waiting message, off at 0, cleanup", () => {
  const r = rig({ heartbeatSeconds: 60 });
  r.p.step("checking sections", 3, 5);
  r.call();
  r.t.ms += 59_000;
  r.p.tick();
  assert.equal(r.log.message.length, 0);
  r.t.ms += 1_000;
  r.p.tick();
  assert.equal(r.log.message.length, 1);
  assert.match(r.log.message[0]!, /^Checking sections \(3 of 5\)\. After this I'll sum up what changed\. \(1m in, 1 call, 120 tok\)$/);
  // idle: two skipped beats, then the waiting message on the third
  for (let k = 0; k < 2; k++) {
    r.t.ms += 60_000;
    r.p.tick();
  }
  assert.equal(r.log.message.length, 1);
  r.t.ms += 60_000;
  r.p.tick();
  assert.equal(r.log.message.length, 2);
  assert.match(r.log.message[1]!, /^Still waiting on the model; no reply for 4 minutes\. Nothing is stuck on my side\.$/);
  // activity resumes the normal line
  r.call();
  r.t.ms += 60_000;
  r.p.tick();
  assert.match(r.log.message[2]!, /2 calls/);
  // done stops it
  r.p.done("ok");
  const n = r.log.message.length;
  r.t.ms += 120_000;
  r.p.tick();
  assert.equal(r.log.message.length, n);
});

test("heartbeat: off at 0, stderr without a UI, none after fail, timer cleared", () => {
  const off = rig({ heartbeatSeconds: 0 });
  off.call();
  off.t.ms += 300_000;
  off.p.tick();
  assert.equal(off.log.message.length, 0);
  const q = rig({ heartbeatSeconds: 60, interactive: false });
  q.call();
  q.t.ms += 60_000;
  q.p.tick();
  assert.equal(q.log.message.length, 0);
  assert.match(q.log.err.at(-1)!, /^I'm working on doc readme\./);
  q.p.fail("boom");
  const e = q.log.err.length;
  q.t.ms += 120_000;
  q.p.tick();
  assert.equal(q.log.err.length, e);
  const real = rig({ heartbeatSeconds: 60, timer: true });
  real.p.clear();
  assert.equal(real.p.finished, true);
});

test("heartbeat sentences: phase, position, what comes next, collapsed checks and tasks", () => {
  const checks = ["check \"Usage\"", "check \"How It Works\"", "check \"Install\""];
  const a = rig({ phases: ["scan", "summarising files", "summarising folders", ...checks, "self-check"], heartbeatSeconds: 60 });
  a.p.step("summarising files", 8, 11);
  assert.match(a.p.heartbeatLine(), /^I'm summarising the project's files \(8 of 11\)\. Next I'll summarise the folders, then check the README's 3 sections one by one\. \(/);
  a.p.step(checks[1]!);
  assert.match(a.p.heartbeatLine(), /^Checking the 'How It Works' section against the code \(2 of 3\)\. Next I'll check the 'Install' section, then do a quick self-check\./);
  a.p.step("self-check");
  assert.match(a.p.heartbeatLine(), /^I'm running a self-check against the code\. After this I'll sum up what changed\./);
  assert.ok(!/left|~/.test(a.p.heartbeatLine()));
});

test("heartbeat sentences: nested work inside a plan task, and plain chat with a todo", () => {
  const tasks = ["task 3/5: Add the check command", "task 4/5: Wire it", "task 5/5: Docs"];
  const b = rig({ phases: tasks });
  b.p.step(tasks[0]!);
  const fix = b.p.nest("fix");
  fix.step("review");
  assert.match(b.p.heartbeatLine(), /^I'm working on task 3 of 5 of your plan, add the check command — now in the fix step, reviewing the change\. Next I'll work through the remaining 2 tasks\./);
  const c = rig({ workflow: "chat" } as never);
  c.p.setTodo([{ text: "read app.py", done: true }, { text: "edit app.py", done: true }, { text: "run tests", done: false }]);
  for (let k = 0; k < 14; k++) c.call();
  assert.match(c.p.heartbeatLine(), /^Still working on your request — 14 steps so far, 2 of 3 todo items done\. Current step: run tests\./);
});

test("sub-steps count as progress: /doc readme chunking pattern (big files, one call per chunk + merge) is never stuck", () => {
  const { p, call, log } = rig({ stuckCalls: 5, phases: ["scan", "summarising files", "summarising folders"] });
  // file 8 of 11: 9 chunks + 1 merge = 10 calls under ONE step label; with sub() each call is progress
  p.step("summarising files", 8, 11);
  for (let k = 0; k < 9; k++) {
    call();
    p.sub();
  }
  call();
  p.sub();
  assert.ok(!p.stuck && log.asked.length === 0 && log.message.length === 0);
  // without sub() the same calls would trip it
  const bare = rig({ stuckCalls: 5, phases: ["scan", "summarising files"] });
  bare.p.step("summarising files", 8, 11);
  for (let k = 0; k < 10; k++) bare.call();
  assert.ok(bare.p.stuck);
});

test("auto mode (no confirmStuck): stuck posts one plain sentence in the chat and asks nothing", () => {
  const r = rig({ stuckCalls: 3 });
  for (let k = 0; k < 6; k++) r.call();
  const said = r.log.message.filter((m) => /without visible progress/.test(m));
  assert.equal(said.length, 1);
  assert.match(said[0]!, /I'll keep going, and step back to plain Pi if it doesn't move/);
  assert.equal(r.log.asked.length, 0);
});
