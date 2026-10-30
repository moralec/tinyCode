import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BestTree } from "../../src/besttree.ts";
import { buildNote, Checkpointer, cleaned, headEnd, milestoneOf, NOTE_MAX_CHARS, pairingOk, requestStart, requestText, touchedFiles, turnOf, type CheckpointCtx, type CheckpointInfo } from "../../src/checkpoint.ts";
import { DEFAULTS, mergeConfig } from "../../src/config.ts";
import { contextTokens, lineTokens, Masker, sizeTokens, usableTokens, type Msg } from "../../src/limits.ts";
import { loadFixture, replay } from "./replay-helper.ts";

// ---------------------------------------------------------------- a synthetic Pi loop

let clock = 1000;
const user = (text: string): Msg => ({ role: "user", content: [{ type: "text", text }], timestamp: clock++ });
const call = (id: string, name: string, args: Record<string, unknown> = {}, text = ""): Msg => ({
  role: "assistant",
  content: [...(text ? [{ type: "text", text }] : []), { type: "toolCall", id, name, arguments: args }],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  timestamp: clock++,
});
const result = (id: string, name: string, text: string, isError = false): Msg => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], isError, timestamp: clock++ });
const FAIL = (p: number, f: number) => `FAIL ${f} failed, ${p} passed in 0.1s\nFAILED t_test.py::T::test_a - AssertionError\nFirst error:\nE   AssertionError: 1 != 2`;

/** request, a direct fix turn, then `n` loop turns of read + edit + run_tests (each ~`size` chars of results) */
function session(n: number, size = 4000): Msg[] {
  const ms: Msg[] = [user("Fix it.\nEdit a.py so that the tests in t_test.py pass."), { role: "custom", customType: "tinycode-hint", content: "hint" }, call("tc_direct_1", "fix", { task: "Fix it." }), result("tc_direct_1", "fix", "fix blocked: no rung solved it")];
  for (let i = 0; i < n; i++) {
    ms.push(call(`r${i}`, "read", { path: "/w/a.py" }, "Reading."), result(`r${i}`, "read", "x".repeat(size)));
    ms.push(call(`e${i}`, "edit", { path: "/w/a.py", edits: [{ oldText: "o".repeat(300), newText: "n".repeat(300) }] }), result(`e${i}`, "edit", "Successfully replaced 1 block(s)."));
    ms.push(call(`t${i}`, "run_tests"), result(`t${i}`, "run_tests", FAIL(10 + i, 10 - i)));
  }
  return ms;
}

const ctxFor = (over: Partial<CheckpointCtx> = {}): CheckpointCtx => ({ windowTokens: 16384, systemChars: 2000, usableTokens: usableTokens(16384, 2048), note: () => "[checkpoint] note", ...over });

// ---------------------------------------------------------------- milestones

test("milestoneOf: a new best; an edit then tests at the best count; nothing else (worse, same without an edit, green, unreadable)", () => {
  const c = { passed: 19, failed: 6 };
  assert.equal(milestoneOf("best", false, c), "best");
  assert.equal(milestoneOf("same", true, c), "steady");
  assert.equal(milestoneOf("same", false, c), null, "a re-run without an edit settles nothing new");
  assert.equal(milestoneOf("worse", true, c), null);
  assert.equal(milestoneOf(null, true, c), null);
  assert.equal(milestoneOf("best", true, { passed: 25, failed: 0 }), null, "green: the work is done");
  assert.equal(milestoneOf("best", true, null), null);
});

test("BestTree.verdict: best, same, worse per run, null when unreadable; lastCounts and bestRunNo follow", () => {
  const b = new BestTree(0, 0);
  const noop = () => {};
  b.observe({ passed: 0, failed: 25 }, noop);
  assert.equal(b.verdict, null, "nothing passes yet: no best");
  b.observe({ passed: 19, failed: 6 }, noop);
  assert.deepEqual([b.verdict, b.bestRunNo], ["best", 2]);
  b.observe({ passed: 12, failed: 13 }, noop);
  assert.deepEqual([b.verdict, b.lastCounts], ["worse", { passed: 12, failed: 13 }]);
  b.observe({ passed: 19, failed: 6 }, noop);
  assert.equal(b.verdict, "same");
  b.observe(null, noop);
  assert.equal(b.verdict, null);
  b.reset();
  assert.deepEqual([b.verdict, b.lastCounts, b.bestRunNo], [null, null, 0]);
});

// ---------------------------------------------------------------- the cleaned list

test("cleaned: head (request, hint, direct run) + note + the milestone's turn on; pairing valid; the request object untouched", () => {
  const ms = session(4);
  const head = headEnd(ms, 0);
  assert.equal(head, 4, "request, hint, the direct fix turn and its result");
  const cut = turnOf(ms, "t2");
  const out = cleaned(ms, head, cut, "[checkpoint] N");
  assert.ok(pairingOk(out));
  assert.equal(out[0], ms[0], "request kept as the same message");
  assert.deepEqual(out.slice(0, 4), ms.slice(0, 4));
  assert.equal(out[4]!.role, "user");
  assert.match(JSON.stringify(out[4]!.content), /\[checkpoint\] N/);
  assert.deepEqual(out.slice(5), ms.slice(cut), "the milestone's turn and all after it");
  assert.ok(pairingOk(ms));
});

test("cleaned: no direct run -> the note joins the request message (never two user messages in a row); system messages of the cut part stay", () => {
  const ms = [user("Do it."), call("a", "read", { path: "x" }), result("a", "read", "y".repeat(900)), { role: "system", content: "", toolsAdded: [{ name: "restore_best" }] } as Msg, call("b", "run_tests"), result("b", "run_tests", FAIL(1, 1))];
  const out = cleaned(ms, headEnd(ms, 0), turnOf(ms, "b"), "NOTE");
  assert.deepEqual(out.map((m) => m.role), ["user", "system", "assistant", "toolResult"]);
  assert.equal(out[1], ms[3]);
  assert.match(JSON.stringify(out[0]!.content), /Do it\..*NOTE/);
  assert.equal(JSON.stringify(ms[0]!.content).includes("NOTE"), false, "the session's message is not modified");
  assert.ok(pairingOk(out));
});

test("pairingOk: orphan results and calls without results are refused", () => {
  assert.equal(pairingOk([user("q"), result("x", "read", "r")]), false);
  assert.equal(pairingOk([user("q"), call("x", "read")]), false);
  assert.equal(pairingOk([user("q"), call("x", "read"), result("x", "read", "r")]), true);
});

// ---------------------------------------------------------------- the note

test("buildNote: pidgin lines from code state; fail names only when the kept turn does not show them; capped", () => {
  const base = { request: "Long text.\n\nEdit a.py so that the tests in t_test.py pass.", best: { passed: 19, failed: 6 }, bestRun: 2, last: { passed: 19, failed: 6 }, lastText: FAIL(19, 6), files: [{ path: "a.py", edited: true }, { path: "t_test.py", edited: false }], steps: [{ text: "read", done: true }, { text: "fix init", done: false }], notes: ["init at a.py:4"] };
  const n = buildNote({ ...base, showTests: false });
  assert.equal(
    n,
    "[checkpoint] Older steps removed. Files on disk are current: read before edit.\nTask: Edit a.py so that the tests in t_test.py pass.\nSaved: 19/25 pass (best, test run 2).\nFiles: a.py (edited), t_test.py.\nDone: read.\nNext: fix init.\nNotes: init at a.py:4",
  );
  const p = buildNote({ ...base, showTests: true, last: { passed: 12, failed: 13 } });
  assert.match(p, /Now 12\/25: worse, call restore_best\./);
  assert.match(p, /Still fail: test_a\./);
  assert.match(p, /First error: AssertionError: 1 != 2/);
  const huge = buildNote({ ...base, showTests: true, request: "r".repeat(5000), files: Array.from({ length: 40 }, (_, i) => ({ path: `f${i}.py`, edited: true })), steps: Array.from({ length: 12 }, (_, i) => ({ text: "s".repeat(200) + i, done: false })), notes: Array.from({ length: 12 }, () => "n".repeat(200)) });
  assert.ok(huge.length <= NOTE_MAX_CHARS, `${huge.length} chars`);
  assert.match(huge, /Files: f0\.py \(edited\).*\+34\./);
});

test("touchedFiles / requestText: paths relative to cwd, edited wins; the folded-requests prefix is dropped", () => {
  const ms = [call("a", "read", { path: "/w/a.py" }), call("b", "edit", { path: "/w/a.py" }), call("c", "read", { path: "/w/t.py" }), call("d", "bash", { command: "ls" })];
  assert.deepEqual(touchedFiles(ms, "/w"), [{ path: "a.py", edited: true }, { path: "t.py", edited: false }]);
  assert.equal(requestText(user("[earlier in this session, ...]\n- request: x\n\n[current request]\nFix b.")), "Fix b.");
});

// ---------------------------------------------------------------- the checkpointer

test("Checkpointer: a pending milestone fires over checkpointAt; under it waits; the cut list stays in force on later calls", () => {
  const ms = session(6);
  const ck = new Checkpointer(0.55, 0.1, 4);
  ck.tests("best", "t5");
  // under the line: the window is big
  assert.equal(ck.apply(ms, ctxFor({ windowTokens: 131072, usableTokens: usableTokens(131072, 2048) })), undefined);
  assert.equal(ck.last, null);
  const out = ck.apply(ms, ctxFor())!;
  const info = ck.last as CheckpointInfo | null;
  assert.ok(out && info);
  assert.equal(info.kind, "best");
  assert.ok(info.tokensAfter < info.tokensBefore / 2, JSON.stringify(info));
  assert.equal(out.length, 4 + 1 + 2);
  // the next call: two more messages; the same cut, the new turn appended
  const more = [...ms, call("x", "read", { path: "/w/b.py" }), result("x", "read", "b")];
  const again = ck.apply(more, ctxFor())!;
  assert.equal(ck.last, null, "no second checkpoint");
  assert.deepEqual(again.slice(0, 7), out);
  assert.equal(again.length, 9);
  assert.ok(pairingOk(again));
});

test("Checkpointer: no churn: gap calls between milestone checkpoints, and too small a saving waits", () => {
  const ck = new Checkpointer(0.55, 0.1, 4);
  let ms = session(6);
  ck.tests("best", "t5");
  assert.ok(ck.apply(ms, ctxFor()) && ck.last);
  // two more milestone turns right after: within the gap, not cut again
  for (let i = 6; i < 9; i++) {
    ms = [...ms, call(`e${i}`, "edit", { path: "/w/a.py" }), result(`e${i}`, "edit", "ok"), call(`t${i}`, "run_tests"), result(`t${i}`, "run_tests", "x".repeat(9000) + FAIL(16, 4))];
    ck.tests("steady", `t${i}`);
    ck.apply(ms, ctxFor());
    assert.equal(ck.last, null, `call ${i}: within the gap`);
  }
  ck.apply(ms, ctxFor());
  assert.equal(ck.last?.kind, "steady", "after the gap the pending milestone fires");
  assert.equal(ck.count, 2);
  // a saving under checkpointMinSave never fires
  const small = new Checkpointer(0.01, 0.3, 1);
  const tiny = session(2, 50);
  small.tests("best", "t1");
  assert.equal(small.apply(tiny, ctxFor({ windowTokens: 4096, usableTokens: 0 })), undefined);
  assert.ok(small.hasPending, "kept pending: a later call may save enough");
});

test("Checkpointer: a test run that is no milestone drops the pending one; a new request resets", () => {
  const ck = new Checkpointer(0.55, 0.1, 4);
  const ms = session(6);
  ck.tests("best", "t4");
  ck.tests(null, "t5");
  assert.equal(ck.apply(ms, ctxFor()), undefined);
  ck.tests("best", "t5");
  assert.ok(ck.apply(ms, ctxFor()));
  const next = [...ms, user("Now explain a.py.")];
  assert.equal(ck.apply(next, ctxFor()), undefined, "a new request: the checkpoint is not carried over");
  assert.equal(ck.count, 0);
});

test("Checkpointer: the backstop cuts at the last turn over the usable line, milestone or not, also when stepped back", () => {
  const ms = session(12, 3000); // ~45k chars of results: over 10240 tokens
  for (const milestones of [true, false]) {
    const ck = new Checkpointer(0.55, 0.1, 4);
    const out = ck.apply(ms, ctxFor({ milestones }))!;
    assert.equal(ck.last?.kind, "pressure");
    assert.equal(out[out.length - 1], ms[ms.length - 1], "the last turn is kept");
    assert.deepEqual(out[out.length - 2]!.content, ms[ms.length - 2]!.content);
    assert.equal((out[out.length - 2]!.usage as { input: number }).input, 0, "its usage (the size before the cut) is not read as the size now");
    assert.ok(pairingOk(out));
  }
  const off = new Checkpointer(0, 0.1, 4);
  assert.equal(off.apply(ms, ctxFor()), undefined, "checkpointAt 0 = off, backstop included");
  // stepped back: a pending milestone is not taken
  const ck = new Checkpointer(0.55, 0.1, 4);
  ck.tests("best", "t5");
  assert.equal(ck.apply(session(6), ctxFor({ milestones: false })), undefined);
});

test("Checkpointer: a cut that would orphan a tool result is not made", () => {
  const ms = [user("q"), call("a", "read", { path: "x" }), result("a", "read", "y".repeat(40000)), call("b1", "bash"), call("b2", "run_tests"), result("b1", "bash", "z"), result("b2", "run_tests", FAIL(1, 2))];
  const ck = new Checkpointer(0.55, 0.1, 1);
  ck.tests("best", "b2");
  assert.equal(ck.apply(ms, ctxFor()), undefined);
  assert.equal(ck.last, null);
});

test("Checkpointer with masking: the saving is counted as masking sends it; the masked list after a checkpoint stays paired", () => {
  const ms = session(6);
  const masker = new Masker(1500, 2, 0.7, 400);
  masker.apply(ms); // earlier batches masked the old reads
  const ck = new Checkpointer(0.55, 0.1, 1);
  ck.tests("best", "t5");
  const raw = new Checkpointer(0.55, 0.1, 1);
  raw.tests("best", "t5");
  const out = ck.apply(ms, ctxFor({ view: (m) => masker.view(m) }))!;
  raw.apply(ms, ctxFor());
  assert.ok(out && ck.last && raw.last);
  assert.ok(ck.last.tokensBefore - ck.last.tokensAfter < raw.last.tokensBefore - raw.last.tokensAfter, "masked results do not count as saved twice");
  const sent = masker.apply(out, { windowTokens: 16384, systemChars: 2000, ceilingTokens: usableTokens(16384, 2048) }) ?? out;
  assert.ok(pairingOk(sent));
  assert.equal(sent[0], ms[0]);
});

// ---------------------------------------------------------------- lines and config

test("usableTokens / lineTokens: Pi's 4096 clamp plus the reply reserve caps every share line; 32k lines are unchanged", () => {
  assert.equal(usableTokens(16384, 2048), 10240);
  assert.equal(lineTokens(16384, 0.7, 2048), 10240, "16k: pressure line below the clamp");
  assert.equal(lineTokens(32768, 0.7, 2048), 0.7 * 32768, "32k: as before");
  assert.equal(lineTokens(32768, 0.8, 2048), 0.8 * 32768, "32k: Pi compaction line as before");
  assert.equal(lineTokens(4096, 0.7, 2048), 0.7 * 4096, "a window too small for the line keeps the share");
});

test("limits.outputReserve / checkpointAt / checkpointMinSave / checkpointGap: defaults and validation", () => {
  assert.deepEqual([DEFAULTS.limits.outputReserve, DEFAULTS.limits.checkpointAt, DEFAULTS.limits.checkpointMinSave, DEFAULTS.limits.checkpointGap], [2048, 0.55, 0.1, 4]);
  assert.equal(mergeConfig({ limits: { checkpointAt: 0 } }).limits.checkpointAt, 0);
  for (const [k, bad] of [["checkpointAt", 1.5], ["checkpointAt", "0.3"], ["checkpointMinSave", 1], ["checkpointMinSave", -0.1], ["checkpointGap", 0], ["checkpointGap", 2.5], ["outputReserve", -1], ["outputReserve", 0.5]] as const)
    assert.throws(() => mergeConfig({ limits: { [k]: bad } }), new RegExp(`limits\\.${k}`));
});

// ---------------------------------------------------------------- replay: paasio at 16k (bench/pairs runs-window, 2026-10-30)

test("replay paasio 16k: checkpoints at the run's milestones; every request paired, request and last turn kept; much smaller", (t) => {
  const fx = loadFixture("paasio16-tinycode.json");
  const before = replay(fx, false);
  const after = replay(fx, true);
  assert.equal(before.length, fx.recorded.length, "one replayed call per recorded loop call");
  // the baseline replay tracks the recorded requests (the recorded chars count the JSON body, so they run a little higher)
  for (let i = 0; i < before.length; i++) assert.ok(Math.abs(before[i]!.chars - fx.recorded[i]!.prompt_chars) < 0.16 * fx.recorded[i]!.prompt_chars, `call ${i + 1}`);
  const cps = after.filter((c) => c.checkpoint).map((c) => `${c.call}:${c.checkpoint!.kind}`);
  assert.deepEqual(cps, ["9:best", "19:steady", "31:steady"], "test run 2 reached 19/25; edits then 19/25 again at later test runs");
  for (const c of after) {
    assert.ok(c.valid, `call ${c.call}: tool calls paired`);
    assert.ok(c.requestKept, `call ${c.call}: request kept`);
    assert.ok(c.lastTurnKept, `call ${c.call}: last turn kept`);
  }
  const first = 8; // 0-based index of call 9
  for (let i = first; i < after.length; i++) assert.ok(after[i]!.chars < 0.65 * before[i]!.chars, `call ${i + 1}: ${after[i]!.chars} vs ${before[i]!.chars}`);
  const maxAfter = Math.max(...after.slice(first).map((c) => c.chars));
  const usableChars = usableTokens(fx.window, DEFAULTS.limits.outputReserve) * 4;
  assert.ok(maxAfter < 0.6 * usableChars, `after the first checkpoint the request stays under ${maxAfter} chars`);
  assert.ok(Math.max(...before.map((c) => c.chars)) > 0.9 * usableChars, "the recorded run itself ran into the line");
  for (const c of after.filter((x) => x.checkpoint)) t.diagnostic(`call ${c.call} ${c.checkpoint!.kind}: ${before[c.call - 1]!.chars} -> ${c.chars} chars (~${Math.ceil(before[c.call - 1]!.chars / 4)} -> ~${Math.ceil(c.chars / 4)} tokens)`);
  t.diagnostic(`last call: ${before.at(-1)!.chars} -> ${after.at(-1)!.chars} chars`);
});

// ---------------------------------------------------------------- regression: paasio 16k live run (commit 4dfcb32)

test("regression, paasio 16k live: after Pi's own compaction (no user message, stale usage) the backstop still cuts under the usable line", () => {
  const fx = JSON.parse(readFileSync(new URL("../fixtures/checkpoint/paasio16-live-compacted.json", import.meta.url), "utf8")) as { window: number; systemChars: number; toolsChars: number; sentChars: number; messages: Msg[] };
  const usable = usableTokens(fx.window, DEFAULTS.limits.outputReserve);
  const ms = fx.messages;
  // what went wrong: the last reply's usage says ~9.2k (+ the new result), the list is ~17k by characters
  assert.ok(contextTokens(ms, fx.systemChars) < usable + 200, `usage-based ${contextTokens(ms, fx.systemChars)}`);
  assert.ok(sizeTokens(ms, fx.systemChars) > 1.5 * usable, `by chars ${sizeTokens(ms, fx.systemChars)}`);
  assert.equal(requestStart(ms), 0, "Pi's summary heads the list");
  const ck = new Checkpointer(DEFAULTS.limits.checkpointAt, DEFAULTS.limits.checkpointMinSave, DEFAULTS.limits.checkpointGap);
  const masker = new Masker(DEFAULTS.limits.maskAboveTokens, DEFAULTS.limits.keepRecentResults, DEFAULTS.limits.pressureAt, DEFAULTS.limits.maskArgChars);
  const out = ck.apply(ms, { windowTokens: fx.window, systemChars: fx.systemChars, usableTokens: usable, view: (m) => masker.view(m), note: () => "[checkpoint] note" })!;
  assert.ok(out && ck.last?.kind === "pressure", "backstop fired");
  assert.ok(pairingOk(out));
  assert.equal(out[0]!.role, "compactionSummary");
  assert.match(String(out[0]!.summary), /\[checkpoint\] note$/, "the note joins the summary (no two user messages in a row)");
  assert.deepEqual(out.at(-1), ms.at(-1), "the last turn is kept");
  const sent = masker.apply(out, { windowTokens: fx.window, systemChars: fx.systemChars, ceilingTokens: usable }) ?? out;
  assert.ok(sizeTokens(sent, fx.systemChars) + Math.ceil(fx.toolsChars / 4) < usable, `sent ~${sizeTokens(sent, fx.systemChars)} tokens`);
  assert.ok(sizeTokens(sent, fx.systemChars) * 4 < fx.sentChars / 3, "a third of what was sent live");
});

test("regression: a request the checkpoint cannot cut (one huge last turn) is still masked under pressure, by characters", () => {
  const ms: Msg[] = [user("q")];
  for (let i = 0; i < 6; i++) ms.push(call(`r${i}`, "read", { path: `/w/f${i}.py` }), result(`r${i}`, "read", "y".repeat(9000)));
  // usage of the last reply claims a tiny prompt (stale): the masker must not believe it
  (ms[ms.length - 2]!.usage as { input: number }).input = 500;
  const m = new Masker(1e9, 2, 0.7, 400);
  const out = m.apply(ms, { windowTokens: 16384, systemChars: 0, ceilingTokens: usableTokens(16384, 2048) });
  assert.ok(out && m.pressureBatches === 1, "pressure batch by characters");
  assert.ok(pairingOk(out));
});
