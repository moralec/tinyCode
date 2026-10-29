import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Masker,
  RepeatGuard,
  TurnCap,
  canonicalJson,
  capText,
  capView,
  createLimits,
  obsSaver,
  MEMORY_PROMPT,
  ReadMemory,
  Todo,
  TODO_NOOP,
  approxTokens,
  oversizeReason,
  tailText,
  toolCallVerdict,
  withTail,
  type Msg,
} from "../../src/limits.ts";
import { DEFAULTS } from "../../src/config.ts";

interface Fixture {
  source: string;
  expect: "loop" | "pass";
  /** malformed: Pi's argument validation rejects it before any tool_call handler; ok: an edit/write that succeeded */
  calls: { name: string; input: unknown; malformed?: boolean; ok?: boolean }[];
}
const dir = new URL("../fixtures/loops/", import.meta.url);
const load = (n: string): Fixture => JSON.parse(readFileSync(new URL(n, dir), "utf8"));
const names = readdirSync(dir).filter((f) => f.endsWith(".json"));

/** A temp call log so step_back rows never touch the real one. */
const tmpEnv = () => ({ TINYCODE_LOG: join(mkdtempSync(join(tmpdir(), "tc-")), "c.jsonl") });

/**
 * Feed a recorded call sequence through the real pre-call rules (toolCallVerdict). Indices are 1-based. A window's
 * content changes when its file was edited, as it does in a real run. Never stops: records the first nudge, the
 * step-back, and every refusal.
 */
function replay(f: Fixture): { firstNudge: number | null; stepBack: number | null; refusals: number[]; calls: number } {
  const lim = createLimits(DEFAULTS.limits, "t-replay", tmpEnv());
  const edits = new Map<string, number>();
  const e = { resolvePath: (p: string) => p, windowHash: (p: string, o: number, l: number) => `${p}|${o}|${l}|${edits.get(p) ?? 0}` };
  let firstNudge: number | null = null;
  let stepBack: number | null = null;
  const refusals: number[] = [];
  f.calls.forEach((c, i) => {
    if (c.malformed) return;
    lim.turns.turnStarted();
    const before = lim.tailNotes.length;
    const v = toolCallVerdict(lim, DEFAULTS.limits, c.name, structuredClone(c.input) as Record<string, unknown>, e);
    if (lim.tailNotes.length > before) firstNudge ??= i + 1;
    if (lim.stepped) stepBack ??= i + 1;
    if (v.action === "block") {
      refusals.push(i + 1);
      return;
    }
    lim.guard.result(c.name, c.input, c.ok === false);
    const path = (c.input as { path?: string })?.path;
    if ((c.name === "edit" || c.name === "write") && c.ok !== false && path) edits.set(path, (edits.get(path) ?? 0) + 1);
  });
  return { firstNudge, stepBack, refusals, calls: f.calls.length };
}

/** 1-based index where the loop starts: the first call of the first run of 3 or more identical consecutive calls. */
function loopStart(f: Fixture): number {
  const key = (c: { name: string; input: unknown }) => c.name + canonicalJson(c.input);
  const i = f.calls.findIndex((c, idx) => key(c) === key(f.calls[idx + 1] ?? { name: "", input: null }) && key(c) === key(f.calls[idx + 2] ?? { name: "", input: null }));
  return i + 1;
}

test("loops: nudge on the third identical call, step back when it continues; 3/3, nothing is stopped", () => {
  const loops = names.filter((n) => n.startsWith("cap-"));
  assert.equal(loops.length, 3);
  let steppedBack = 0;
  for (const n of loops) {
    const f = load(n);
    const r = replay(f);
    const s = loopStart(f);
    const nudgeAt = r.firstNudge === null ? Infinity : r.firstNudge - s + 1;
    const stepAt = r.stepBack === null ? Infinity : r.stepBack - s + 1;
    console.log(
      `  ${n}: ${f.calls.length} calls, loop from call ${s}: first nudge at call ${r.firstNudge} (loop call ${nudgeAt}), step-back at call ${r.stepBack} (loop call ${stepAt}); ${r.stepBack === null ? 0 : r.stepBack - s + 1} loop calls before step-back, ${r.stepBack === null ? 0 : f.calls.length - r.stepBack} calls served normally after it`,
    );
    assert.ok(nudgeAt <= 3, `${n}: nudge at loop call ${nudgeAt}`);
    assert.ok(stepAt <= 5, `${n}: step-back at loop call ${stepAt}`);
    steppedBack++;
  }
  console.log(`loops nudged then stepped back ${steppedBack}/3`);
  assert.equal(steppedBack, 3);
});

test("false blocks 0 on successful runs: no refusal that is not a genuine re-read", () => {
  const passes = names.filter((n) => n.startsWith("pass-") && !n.includes("r2-10"));
  assert.equal(passes.length, 5);
  let falseBlocks = 0;
  for (const n of passes) {
    const f = load(n);
    const r = replay(f);
    for (const at of r.refusals) {
      const c = f.calls[at - 1];
      const genuine = f.calls.slice(0, at - 1).some((o) => o.name === c.name && canonicalJson(o.input) === canonicalJson(c.input));
      console.log(`  ${n}: call ${at} (${c.name}) nudged${genuine ? ": a real re-read of an earlier identical call (the model asks again and is served)" : ": NOT a re-read"}`);
      if (!genuine) falseBlocks++;
    }
  }
  console.log(`false blocks ${falseBlocks}`);
  assert.equal(falseBlocks, 0);
});

test("repeat guard: third identical call in the last six nudges once; a repeat after the nudge continues; never blocks", () => {
  const g = new RepeatGuard(2);
  assert.equal(g.check("read", { path: "a.py" }), "ok");
  assert.equal(g.check("read", { path: "a.py" }), "ok", "the second identical call is served");
  assert.equal(g.check("read", { path: "a.py" }), "nudge");
  assert.equal(g.check("read", { path: "a.py" }), "continues");
  const h = new RepeatGuard(2);
  assert.equal(h.check("read", { path: "a.py" }), "ok");
  assert.equal(h.check("read", { path: "b.py" }), "ok");
  assert.equal(h.check("read", { path: "a.py" }), "ok");
  assert.equal(h.check("bash", { command: "ls" }), "ok");
  assert.equal(h.check("read", { path: "a.py" }), "nudge", "third a.py in the last six");
});

test("repeat guard: key order does not matter; an edit lets the tests run again", () => {
  const g = new RepeatGuard(2);
  assert.equal(g.check("find", { a: 1, b: 2 }), "ok");
  assert.equal(g.check("find", { b: 2, a: 1 }), "ok");
  assert.equal(g.check("find", { a: 1, b: 2 }), "nudge");
  const h = new RepeatGuard(2);
  for (let i = 0; i < 4; i++) {
    assert.equal(h.check("test", {}), "ok", `test run ${i}`);
    assert.equal(h.check("edit", { path: "x", edits: [{ n: i }] }), "ok");
  }
});

test("view cap: read without limit gets viewLines; an explicit limit stays", () => {
  const a: Record<string, unknown> = { path: "x.py" };
  assert.equal(capView("read", a, 100), true);
  assert.equal(a.limit, 100);
  const b: Record<string, unknown> = { path: "x.py", limit: 400 };
  assert.equal(capView("read", b, 100), false);
  assert.equal(b.limit, 400);
  const c: Record<string, unknown> = { command: "ls" };
  assert.equal(capView("bash", c, 100), false);
  assert.equal("limit" in c, false);
});

test("result cap: head + tail + pointer, full text saved; within the cap untouched", () => {
  const d = mkdtempSync(join(tmpdir(), "tinycode-obs-"));
  const env = { TINYCODE_LOG: join(d, "calls.jsonl") };
  const save = obsSaver("sess1", env);
  assert.equal(capText("short", { toolResultTokens: 1500 }, save), null);
  const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
  const out = capText(big, { toolResultTokens: 1500 }, save) as string;
  assert.ok(out.length < 6400, `capped length ${out.length}`);
  assert.ok(out.startsWith("line 0\n") && out.endsWith("line 1999"));
  const m = out.match(/full output saved to (.+?) \.\.\.\]/);
  assert.ok(m);
  assert.equal(readFileSync(m[1], "utf8"), big);
  assert.ok(m[1].includes(join("obs", "sess1", "1.txt")));
});

function convo(n: number, tokens: number): Msg[] {
  const msgs: Msg[] = [{ role: "user", content: "task" }];
  for (let i = 1; i <= n; i++) {
    msgs.push({ role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "read", arguments: { path: `f${i}.py` } }] });
    msgs.push({ role: "toolResult", toolCallId: `c${i}`, toolName: "read", content: [{ type: "text", text: "x\n".repeat((tokens * 4) / 2) }] });
  }
  return msgs;
}

test("masking: 10 results of 1k tokens mask in two batches, not ten times; newest 2 untouched; prefix stable", () => {
  const m = new Masker(3000, 2);
  const seen: string[] = [];
  let fired = 0;
  let prevBatches = 0;
  for (let turn = 1; turn <= 10; turn++) {
    const out = m.apply(convo(turn, 1000)) ?? convo(turn, 1000);
    if (m.batches !== prevBatches) fired++;
    prevBatches = m.batches;
    const results = out.filter((x) => x.role === "toolResult");
    for (const r of results.slice(-2)) assert.ok(!String((r.content as { text: string }[])[0].text).startsWith("[masked"), `turn ${turn}: newest 2 untouched`);
    // monotonic: a masked placeholder never reverts
    const now = results.map((r) => String((r.content as { text: string }[])[0].text).startsWith("[masked")).join("");
    seen.push(now);
  }
  console.log(`mask batches ${fired} in 10 turns (per-turn masking would be 10)`);
  assert.equal(fired, 2);
  for (let i = 1; i < seen.length; i++) {
    for (let j = 0; j < seen[i - 1].length; j++) if (seen[i - 1][j] === "1") assert.equal(seen[i][j], "1");
  }
  const last = m.apply(convo(10, 1000)) as Msg[];
  const ph = (last.find((x) => x.toolCallId === "c1")?.content as { text: string }[])[0].text;
  assert.equal(ph, "[masked: read f1.py, 2000 lines; see your notes]");
});

test("masking: nothing masked returns undefined; default threshold 6000 fires once in 10 turns", () => {
  const m = new Masker(6000, 2);
  assert.equal(m.apply(convo(3, 1000)), undefined);
  for (let t = 1; t <= 10; t++) m.apply(convo(t, 1000));
  assert.equal(m.batches, 1);
});

test("call budget: 0 means none; over a cap it only says so, and tool calls get the answer-now reason", () => {
  const none = new TurnCap(0);
  for (let i = 0; i < 100; i++) assert.equal(none.turnStarted(), false);
  const t = new TurnCap(3);
  assert.deepEqual([t.turnStarted(), t.turnStarted(), t.turnStarted(), t.turnStarted()], [false, false, false, true]);
  t.reset();
  assert.equal(t.turnStarted(), false);
  assert.equal(DEFAULTS.limits.turnCap, 0, "off by default");
  const lim = createLimits(DEFAULTS.limits, "t-budget", tmpEnv());
  lim.newRun(1);
  lim.turns.turnStarted();
  assert.equal(toolCallVerdict(lim, DEFAULTS.limits, "bash", { command: "ls" }, env()).action, "allow");
  lim.turns.turnStarted();
  const v = toolCallVerdict(lim, DEFAULTS.limits, "bash", { command: "ls" }, env());
  assert.equal(v.action, "block");
  assert.match((v as { reason: string }).reason, /final answer now/);
});

test("createLimits: newRun resets guard and turn counter and sets a rung-3 cap", () => {
  const s = createLimits(DEFAULTS.limits, "s", tmpEnv());
  s.guard.check("read", { path: "a" });
  s.guard.check("read", { path: "a" });
  s.intervene("x");
  s.stepBack("test");
  assert.equal(s.guard.check("read", { path: "a" }), "nudge");
  s.newRun(20);
  assert.equal(s.turns.cap, 20);
  assert.equal(s.stepped, false);
  assert.equal(s.interventions, 0);
  assert.equal(s.guard.check("read", { path: "a" }), "ok");
});

// ---------------------------------------------------------------- S4b: working memory

const env = (h: (p: string, offset: number, limit: number) => string = () => "v1") => ({ resolvePath: (p: string) => `/work/${p}`, windowHash: h });

test("todo tool: replace-whole, limits, and the tail text", () => {
  const t = new Todo();
  assert.equal(t.format(), "");
  const r = t.set({ steps: [{ text: "read app.py", done: true }, { text: "edit README" }], notes: ["MAX_BATCH_SIZE = 1000 at app.py:42"] });
  assert.equal(r.ok, true);
  assert.match(r.text, /1\/2 steps done, 1 notes/);
  assert.equal(t.format(), "[your todo]\n1. [x] read app.py\n2. [ ] edit README\n[your notes]\n- MAX_BATCH_SIZE = 1000 at app.py:42");
  // replace-whole: the second call drops the first list
  t.set({ steps: [{ text: "only" }] });
  assert.deepEqual(t.steps, [{ text: "only", done: false }]);
  assert.deepEqual(t.notes, []);
  // long items are cut at 200 characters; more than 12 of either is refused and the old todo stays
  t.set({ steps: [{ text: "x".repeat(500) }] });
  assert.equal(t.steps[0].text.length, 200);
  const many = t.set({ steps: Array.from({ length: 13 }, (_, i) => ({ text: `s${i}` })) });
  assert.equal(many.ok, false);
  assert.equal(t.steps[0].text.length, 200);
  assert.equal(t.set({ notes: Array.from({ length: 13 }, () => "n") }).ok, false);
  assert.equal(t.set({ steps: Array.from({ length: 12 }, (_, i) => ({ text: `s${i}` })), notes: Array.from({ length: 12 }, () => "n") }).ok, true);
});

test("tail: appended last as a user message, prefix untouched; empty todo nudges only once work has started", () => {
  const t = new Todo();
  const user: Msg = { role: "user", content: [{ type: "text", text: "do it" }] };
  const res: Msg = { role: "toolResult", toolCallId: "1", toolName: "read", content: [{ type: "text", text: "x" }] };
  assert.equal(withTail([user], t, false), undefined, "nothing to say on the first turn");
  assert.match(tailText(t, false, 1) as string, /todo is empty/);
  t.set({ steps: [{ text: "a" }], notes: ["n1"] });
  const msgs = [user, res];
  const out = withTail(msgs, t, false) as Msg[];
  assert.equal(out.length, 3);
  assert.equal(out[0], user);
  assert.equal(out[1], res);
  assert.equal(out[2].role, "user");
  assert.match((out[2].content as { text: string }[])[0].text, /\[your todo\]\n1\. \[ \] a\n\[your notes\]\n- n1/);
  assert.equal(msgs.length, 2, "input list not mutated");
  // the output-limit notice comes first and says so explicitly
  const lim = (withTail(msgs, t, true) as Msg[])[2].content as { text: string }[];
  assert.match(lim[0].text, /^\[your last reply hit the output limit/);
  assert.match(lim[0].text, /smaller pieces/);
});

test("memory prompt: fixed text, 150 tokens at most", () => {
  assert.ok(approxTokens(MEMORY_PROMPT.length) <= 150, `${approxTokens(MEMORY_PROMPT.length)} tokens`);
  for (const w of ["todo", "find before read", "re-read", "40 lines", "test"]) assert.ok(MEMORY_PROMPT.includes(w), w);
});

test("mask stub says to see the notes and names the read window", () => {
  const m = new Masker(100, 1);
  const msgs: Msg[] = [];
  for (const [i, off] of [1, 101, 201].entries()) {
    msgs.push({ role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "read", arguments: { path: "README.html", offset: off } }] });
    msgs.push({ role: "toolResult", toolCallId: `c${i}`, toolName: "read", content: [{ type: "text", text: "line\n".repeat(200) }] });
  }
  const out = m.apply(msgs) as Msg[];
  assert.equal((out[1].content as { text: string }[])[0].text, "[masked: read README.html from line 1, 200 lines; see your notes]");
  assert.match((out[3].content as { text: string }[])[0].text, /from line 101, 200 lines; see your notes/);
});

test("read memory: the first re-read gets a pointer to the notes, the second is served; a changed window is served at once", () => {
  const lim = createLimits({ ...DEFAULTS.limits, stepBackAt: 99 }, "t-mem", tmpEnv());
  let edited = false;
  const e = env((p, offset) => (edited && p.endsWith("a.html") && offset === 101 ? "changed" : `same-${p}-${offset}`));
  const read = (input: Record<string, unknown>) => toolCallVerdict(lim, DEFAULTS.limits, "read", input, e);
  const fill = (...fs: string[]) => fs.forEach((f) => read({ path: f })); // keep the guard's last-six window clear
  assert.equal(read({ path: "a.html" }).action, "allow"); // no offset = line 1, limit 100
  assert.equal(read({ path: "a.html", offset: 101 }).action, "allow");
  assert.equal(read({ path: "b.py" }).action, "allow");
  const again = read({ path: "a.html" });
  assert.equal(again.action, "block");
  assert.match((again as { reason: string }).reason, /You read this at turn 0; check your notes/);
  fill("c", "d", "e", "f");
  assert.equal(read({ path: "a.html" }).action, "allow", "asking again serves it: never refused twice");
  fill("g", "h", "i", "j");
  assert.equal(read({ path: "a.html", offset: 1, limit: 100 }).action, "block", "explicit offset 1 / limit 100 is the same window, and a fresh re-read");
  // an edit changed lines 101-200: that window is served at once; another unchanged one is still nudged
  edited = true;
  fill("k", "l", "m", "n");
  assert.equal(read({ path: "a.html", offset: 101 }).action, "allow");
  assert.equal(read({ path: "a.html", offset: 301 }).action, "allow", "a new window");
  new ReadMemory().reset();
});

test("read refusals count as interventions; the third steps back and every read is served in full after it", () => {
  const lim = createLimits(DEFAULTS.limits, "t-step", tmpEnv());
  const read = (input: Record<string, unknown>) => toolCallVerdict(lim, DEFAULTS.limits, "read", input, env());
  for (const f of ["a", "b", "c", "d"]) assert.equal(read({ path: f }).action, "allow");
  // re-read each once: nudged (interventions 1, 2, 3); the guard's window keeps clear since each key appears twice at most
  assert.equal(read({ path: "a" }).action, "block");
  assert.equal(read({ path: "b" }).action, "block");
  assert.equal(lim.stepped, false);
  assert.equal(read({ path: "c" }).action, "block");
  assert.equal(lim.stepped, true, "stepped back after 3 interventions");
  assert.match(lim.stepBackReason as string, /3 interventions/);
  // stepped back: no refusal, no view cap, no masking, no result cap, no oversized-edit refusal
  const input: Record<string, unknown> = { path: "d" };
  assert.equal(read(input).action, "allow");
  assert.equal("limit" in input, false, "no view cap");
  assert.equal(read({ path: "d" }).action, "allow");
  assert.equal(toolCallVerdict(lim, DEFAULTS.limits, "edit", { path: "x", edits: [{ oldText: "a", newText: "y".repeat(40000) }] }, env()).action, "allow");
  assert.equal(lim.cap("z".repeat(50000)), null);
  const big: Msg[] = [];
  for (let i = 0; i < 5; i++) big.push({ role: "toolResult", toolCallId: `c${i}`, toolName: "read", content: [{ type: "text", text: "x".repeat(40000) }] });
  assert.equal(lim.mask(big), undefined);
});

test("step-back is logged once with its reason", () => {
  const e2 = tmpEnv();
  const lim = createLimits(DEFAULTS.limits, "t-log", e2);
  lim.stepBack("because");
  lim.stepBack("again");
  const rows = readFileSync(e2.TINYCODE_LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].step, "step_back");
  assert.equal(rows[0].status, "because");
});

test("repeat: nudge on the third identical call (served, tail note added); a repeat after the nudge steps back", () => {
  const lim = createLimits(DEFAULTS.limits, "t-rep", tmpEnv());
  const run = () => toolCallVerdict(lim, DEFAULTS.limits, "bash", { command: "pytest" }, env());
  assert.equal(run().action, "allow");
  assert.equal(run().action, "allow");
  assert.deepEqual(lim.tailNotes, []);
  assert.equal(run().action, "allow", "the third is served");
  assert.equal(lim.tailNotes.length, 1);
  assert.match(lim.tailNotes[0], /same call as the last two; try a different approach or update your todo/);
  assert.equal(lim.interventions, 1);
  assert.equal(lim.stepped, false);
  assert.equal(run().action, "allow");
  assert.equal(lim.stepped, true);
  assert.match(lim.stepBackReason as string, /repeat continued/);
  // the nudge reaches the model as a tail message
  const tail = withTail([{ role: "user", content: [{ type: "text", text: "go" }] }], lim.todo, false, lim.tailNotes.splice(0)) as Msg[];
  assert.match((tail[1].content as { text: string }[])[0].text, /same call as the last two/);
});

test("oversized edit/write: refused with 'split into smaller edits' until step-back (3 interventions)", () => {
  const small = { path: "a", edits: [{ oldText: "x", newText: "y".repeat(8000) }] }; // ~2000 tokens
  const big = { path: "a", edits: [{ oldText: "x", newText: "y".repeat(7000) }, { oldText: "z", newText: "y".repeat(7000) }] }; // ~3500
  assert.equal(oversizeReason("edit", small, 3000), null);
  assert.match(oversizeReason("edit", big, 3000) as string, /Split it into smaller edits/);
  assert.match(oversizeReason("write", { path: "a", content: "y".repeat(13000) }, 3000) as string, /Split it/);
  assert.equal(oversizeReason("read", big, 3000), null);
  const lim = createLimits(DEFAULTS.limits, "t-big", tmpEnv());
  const call = () => toolCallVerdict(lim, DEFAULTS.limits, "edit", structuredClone(big), env());
  assert.equal(call().action, "block");
  assert.equal(call().action, "block");
  assert.equal(call().action, "block");
  assert.equal(lim.stepped, true);
  assert.equal(call().action, "allow", "after step-back Pi's own handling applies");
});

test("tail: one nudge after a read, none after other tools", () => {
  const t = new Todo();
  t.set({ steps: [{ text: "a" }] });
  const user: Msg = { role: "user", content: [{ type: "text", text: "go" }] };
  const rr: Msg = { role: "toolResult", toolCallId: "1", toolName: "read", content: [{ type: "text", text: "x" }] };
  const bb: Msg = { role: "toolResult", toolCallId: "2", toolName: "bash", content: [{ type: "text", text: "x" }] };
  const txt = (m: Msg[]) => ((withTail(m, t, false) as Msg[]).at(-1)?.content as { text: string }[])[0].text;
  assert.match(txt([user, rr]), /\[note what you learned in your todo\]$/);
  assert.doesNotMatch(txt([user, rr, bb]), /note what you learned/);
});

test("nothing in the loop code aborts or terminates a run", () => {
  for (const f of ["../../src/limits.ts", "../../src/branch.ts", "../../extensions/tinycode/index.ts"]) {
    const code = readFileSync(new URL(f, import.meta.url), "utf8")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
      .join("\n");
    assert.doesNotMatch(code, /\.abort\(|terminate\s*:|process\.exit|\.kill\(/, `${f} must not abort, terminate or exit`);
  }
  assert.equal("stopped" in new TurnCap(1), false);
});

test("todo: a save that changes nothing is a no-op with its own message; a real change still saves", () => {
  const t = new Todo();
  const input = { steps: [{ text: "a", done: true }, { text: "b" }], notes: ["n1"] };
  assert.equal(t.isNoop(input), false);
  const first = t.set(input);
  assert.match(first.text, /^Saved: 1\/2 steps done, 1 notes\.$/);
  assert.equal(t.isNoop(structuredClone(input)), true);
  const again = t.set(structuredClone(input));
  assert.deepEqual(again, { ok: true, noop: true, text: TODO_NOOP });
  assert.match(again.text, /^no change: your todo is already saved; continue with the next step or finish$/);
  assert.equal(t.isNoop({ steps: [{ text: "a", done: true }, { text: "b", done: true }], notes: ["n1"] }), false);
  assert.equal(t.isNoop({ steps: input.steps, notes: ["n1", "n2"] }), false);
  const changed = t.set({ steps: [{ text: "a", done: true }, { text: "b", done: true }], notes: ["n1"] });
  assert.match(changed.text, /^Saved: 2\/2/);
});

test("todo: a replay of 10 identical saves nudges at the 3rd and steps back at the 4th, never stops", () => {
  const lim = createLimits(DEFAULTS.limits, "t-todo", tmpEnv());
  const e = { resolvePath: (p: string) => p, windowHash: () => "h" };
  const input = { steps: [{ text: "a", done: true }, { text: "b" }, { text: "c" }], notes: ["x"] };
  const texts: string[] = [];
  let nudge: number | null = null;
  let step: number | null = null;
  for (let i = 1; i <= 10; i++) {
    lim.turns.turnStarted();
    const before = lim.tailNotes.length;
    const v = toolCallVerdict(lim, DEFAULTS.limits, "todo", structuredClone(input), e);
    assert.equal(v.action, "allow");
    if (lim.tailNotes.length > before) nudge ??= i;
    if (lim.stepped) step ??= i;
    texts.push(lim.todo.set(structuredClone(input)).text);
  }
  assert.match(texts[0]!, /^Saved/);
  for (const x of texts.slice(1)) assert.equal(x, TODO_NOOP);
  assert.equal(nudge, 3);
  assert.equal(step, 4);
  // after the step-back the tool itself still answers "no change"
  assert.equal(lim.todo.set(structuredClone(input)).text, TODO_NOOP);
});
