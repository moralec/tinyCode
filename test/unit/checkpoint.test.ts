import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BestTree } from "../../src/besttree.ts";
import { BACKOFF_MAX, buildNote, Checkpointer, cleaned, editedBefore, headEnd, keptTurn, milestoneOf, NOTE_MAX_CHARS, pairingOk, requestStart, requestText, touchedFiles, turnOf, type CheckpointCtx, type CheckpointInfo } from "../../src/checkpoint.ts";
import { DEFAULTS, mergeConfig } from "../../src/config.ts";
import { contextTokens, KEPT_REREAD, lineTokens, Masker, ReadMemory, sizeTokens, usableTokens, windowHash, workingSet, type Msg } from "../../src/limits.ts";
import { loadFixture, replay, undoReplay, V2_LIMITS, type ReplayCall } from "./replay-helper.ts";

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

test("limits.checkpointKeepFiles / checkpointBackoff / undoWorse: defaults on, validation", () => {
  assert.deepEqual([DEFAULTS.limits.checkpointKeepFiles, DEFAULTS.limits.checkpointBackoff, DEFAULTS.limits.checkpointSkipSame, DEFAULTS.limits.undoWorse, DEFAULTS.limits.undoWorseFrom], [0.25, true, true, true, 2]);
  const off = mergeConfig({ limits: { checkpointKeepFiles: 0, checkpointBackoff: false, undoWorse: false } }).limits;
  assert.deepEqual([off.checkpointKeepFiles, off.checkpointBackoff, off.undoWorse], [0, false, false]);
  for (const [k, bad] of [["checkpointKeepFiles", 1], ["checkpointKeepFiles", -0.1], ["checkpointKeepFiles", "0.2"], ["checkpointBackoff", 1], ["checkpointSkipSame", "no"], ["undoWorse", "yes"], ["undoWorseFrom", 0], ["undoWorseFrom", 1.5]] as const)
    assert.throws(() => mergeConfig({ limits: { [k]: bad } }), new RegExp(`limits\\.${k}`));
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
  const after = replay(fx, true, V2_LIMITS); // the v2 rules this test was written for (the steadiness rules: below)
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

// ---------------------------------------------------------------- steadiness: kept files

/** a loop where the model edits a.py (relative and absolute names) and b.py, then runs the tests */
function editSession(n: number, size = 4000): Msg[] {
  const ms: Msg[] = [user("Fix it.\nEdit a.py so that the tests in t_test.py pass."), { role: "custom", customType: "tinycode-hint", content: "hint" }, call("tc_direct_1", "fix", { task: "Fix it." }), result("tc_direct_1", "fix", "fix blocked: no rung solved it")];
  for (let i = 0; i < n; i++) {
    ms.push(call(`r${i}`, "read", { path: "/w/t_test.py" }, "Reading."), result(`r${i}`, "read", "x".repeat(size)));
    ms.push(call(`b${i}`, "edit", { path: "/w/b.py", edits: [{ oldText: "o", newText: "n" }] }), result(`b${i}`, "edit", "Successfully replaced 1 block(s)."));
    ms.push(call(`e${i}`, "edit", { path: "/w/a.py", edits: [{ oldText: "o".repeat(300), newText: "n".repeat(300) }] }), result(`e${i}`, "edit", "Successfully replaced 1 block(s)."));
    ms.push(call(`t${i}`, "run_tests"), result(`t${i}`, "run_tests", FAIL(10 + i, 10 - i)));
  }
  return ms;
}
const disk: Record<string, string> = { "/w/a.py": "def a():\n    return 1\n", "/w/b.py": "B = 2\n", "/w/t_test.py": "assert a() == 2\n" };

test("editedBefore: successful edits before the cut, most recent first; a failed edit and a file edited again in the kept part are left out", () => {
  const ms = [user("q"), call("e1", "edit", { path: "a.py" }), result("e1", "edit", "ok"), call("e2", "write", { path: "b.py" }), result("e2", "write", "ok"), call("e3", "edit", { path: "c.py" }), result("e3", "edit", "no match", true), call("e4", "edit", { path: "a.py" }), result("e4", "edit", "ok"), call("t", "run_tests"), result("t", "run_tests", FAIL(1, 1)), call("e5", "edit", { path: "b.py" }), result("e5", "edit", "ok")];
  assert.deepEqual(editedBefore(ms.slice(0, -2), 0, turnOf(ms, "t")), ["a.py", "b.py"], "a.py last edited after b.py; c.py's edit failed");
  assert.deepEqual(editedBefore(ms, 0, turnOf(ms, "t")), ["a.py"], "b.py is edited again in the kept part: its edit is there");
  assert.deepEqual(editedBefore(ms, 3, turnOf(ms, "t")), ["a.py"], "only the request's edits (from `from` on)");
  const two = [user("q"), call("e1", "edit", { path: "/w/a.py" }), result("e1", "edit", "ok"), call("e2", "edit", { path: "b.py" }), result("e2", "edit", "ok"), call("e3", "edit", { path: "a.py" }), result("e3", "edit", "ok"), call("t", "run_tests"), result("t", "run_tests", FAIL(1, 1))];
  const key = (p: string) => (p.startsWith("/w/") ? p : `/w/${p}`);
  assert.deepEqual(editedBefore(two, 0, turnOf(two, "t"), key), ["a.py", "b.py"], "two names of one file: once, by its latest name");
  assert.deepEqual(keptTurn([], 1, ms[1]), []);
});

test("kept files: the cleaned list carries the edited files' current text as one read turn after the note; pairing valid; the note says so", () => {
  const ms = editSession(6);
  const ck = new Checkpointer(0.55, 0.1, 4, { keepFiles: 0.25 });
  ck.tests("best", "t5");
  let keptSeen: string[] = [];
  const out = ck.apply(ms, ctxFor({ fileText: (p) => disk[p] ?? null, note: (_s, kept) => ((keptSeen = kept), `[checkpoint] kept ${kept.join(",")}`) }))!;
  assert.ok(out && ck.last);
  assert.ok(pairingOk(out));
  assert.deepEqual(keptSeen, ["/w/a.py", "/w/b.py"], "most recently edited first");
  assert.deepEqual(ck.last.kept.map((f) => f.path), ["/w/a.py", "/w/b.py"]);
  // head (4) + note + the kept turn (1 call message, 2 results) + the milestone's turn (2)
  assert.deepEqual(out.map((m) => m.role), ["user", "custom", "assistant", "toolResult", "user", "assistant", "toolResult", "toolResult", "assistant", "toolResult"]);
  const keep = out[5]!;
  assert.deepEqual((keep.content as { name: string; arguments: unknown }[]).map((p) => [p.name, p.arguments]), [["read", { path: "/w/a.py" }], ["read", { path: "/w/b.py" }]]);
  assert.equal(((out[6]!.content as { text: string }[])[0]!).text, disk["/w/a.py"]);
  assert.equal((keep.usage as { input: number }).input, 0, "no stale usage on the made-up turn");
  assert.equal(keep.stopReason, "toolUse");
  assert.ok(workingSet(out).has(out[6]!.toolCallId as string), "the kept reads are the working set: masking keeps them");
  // the next call: the same kept text (frozen), so the prefix stays the same
  disk["/w/a.py"] = "changed later\n";
  const again = ck.apply([...ms, call("x", "read", { path: "/w/c.py" }), result("x", "read", "c")], ctxFor({ fileText: (p) => disk[p] ?? null }))!;
  assert.deepEqual(again.slice(0, out.length), out);
  disk["/w/a.py"] = "def a():\n    return 1\n";
  // the note: kept files named, no "read before edit" for them
  const note = buildNote({ request: "Edit a.py.", best: null, bestRun: 0, last: null, lastText: "", showTests: false, kept: ["a.py", "b.py"], files: [], steps: [], notes: [] });
  assert.match(note, /^\[checkpoint\] Older steps removed\. Current text below: a\.py, b\.py\. Other files: read before edit\./);
});

test("kept files: within the share of the usable prompt, most recent first, whole or not at all; too long or unreadable files skipped; off = as before", () => {
  const ms = editSession(6);
  const big: Record<string, string> = { "/w/a.py": "a".repeat(5000), "/w/b.py": "b".repeat(300) };
  const ck = new Checkpointer(0.55, 0.1, 4, { keepFiles: 0.1 }); // 1024 tokens of 10240
  ck.tests("best", "t5");
  ck.apply(ms, ctxFor({ fileText: (p) => big[p] ?? null }));
  assert.deepEqual(ck.last?.kept.map((f) => f.path), ["/w/b.py"], "a.py (~1250 tokens) does not fit, b.py does");
  const long = new Checkpointer(0.55, 0.1, 4, { keepFiles: 0.25 });
  long.tests("best", "t5");
  long.apply(ms, ctxFor({ fileText: (p) => (p === "/w/a.py" ? "x\n".repeat(400) : null), maxFileLines: 300 }));
  assert.deepEqual(long.last?.kept, [], "over maxFileLines, and b.py unreadable");
  const off = new Checkpointer(0.55, 0.1, 4);
  off.tests("best", "t5");
  const plain = off.apply(ms, ctxFor({ fileText: (p) => disk[p] ?? null }))!;
  assert.deepEqual(off.last?.kept, []);
  assert.equal(plain.length, 4 + 1 + 2, "keepFiles 0: the v2 list");
});

test("kept files: never over the usable line for them; the cut is then made without them (backstop kept)", () => {
  const ms = session(12, 3000); // over the usable line: the backstop
  const ck = new Checkpointer(0.55, 0.1, 4, { keepFiles: 0.9 });
  const huge = "y".repeat(39000); // ~9750 tokens: with it the list stays over 10240
  const out = ck.apply(ms, ctxFor({ fileText: () => huge }))!;
  assert.equal(ck.last?.kind, "pressure");
  assert.deepEqual(ck.last?.kept, [], "made without the kept file");
  assert.ok(sizeTokens(out, 2000) < usableTokens(16384, 2048));
  assert.ok(pairingOk(out));
});

test("read memory: a kept file counts as served; a re-read gets the kept pointer once (no intervention), then is served; an edited window is served at once", () => {
  const r = new ReadMemory();
  const text = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`).join("\n");
  r.serve("/w/a.py", text, 7, 100);
  assert.equal(r.check(ReadMemory.key("/w/a.py", {}, 100), 8, windowHash(text, 1, 100)), KEPT_REREAD);
  assert.equal(r.keptHit, true, "a pointer that is always true: not counted toward stepBackAt");
  assert.equal(r.check(ReadMemory.key("/w/a.py", {}, 100), 9, windowHash(text, 1, 100)), null, "asked again: served");
  assert.equal(r.check(ReadMemory.key("/w/a.py", { offset: 101 }, 100), 9, windowHash(text, 101, 100)), KEPT_REREAD, "the second window too");
  assert.equal(r.check(ReadMemory.key("/w/a.py", { offset: 101 }, 100), 10, "changed"), null);
  assert.equal(r.check(ReadMemory.key("/w/b.py", {}, 100), 10, "h"), null);
  assert.equal(r.keptHit, false);
  assert.match(r.check(ReadMemory.key("/w/b.py", {}, 100), 11, "h") ?? "", /^Unchanged since your read at turn 10/, "an ordinary read: the ordinary pointer");
  assert.equal(r.keptHit, false);
});

// ---------------------------------------------------------------- steadiness: back-off

test("back-off: nextGap doubles within 2x the gap (capped), resets after a quiet stretch", () => {
  assert.equal(Checkpointer.nextGap(4, 4, Number.POSITIVE_INFINITY), 4, "the first checkpoint");
  assert.equal(Checkpointer.nextGap(4, 4, 5), 8);
  assert.equal(Checkpointer.nextGap(8, 4, 10), 16);
  assert.equal(Checkpointer.nextGap(16, 4, 31), 16, "at most BACKOFF_MAX x the base");
  assert.equal(BACKOFF_MAX, 4);
  assert.equal(Checkpointer.nextGap(16, 4, 32), 4, "2x the gap or more: quiet, back to the base");
  assert.equal(Checkpointer.nextGap(5, 5, 9), 10);
  assert.equal(Checkpointer.nextGap(4, 4, 8), 4);
});

test("back-off: milestone checkpoints close together space out; the backstop still cuts over the usable line; a new request resets the gap", () => {
  // a low gate (0.1 of the usable prompt) so every milestone is over it: only the gap decides; never near the usable line
  const run = (backoff: boolean) => {
    const ck = new Checkpointer(0.1, 0.01, 4, { backoff });
    let ms = session(6);
    const at: number[] = [];
    for (let i = 6; i < 60; i++) {
      ms = [...ms, call(`e${i}`, "edit", { path: "/w/a.py" }), result(`e${i}`, "edit", "ok"), call(`t${i}`, "run_tests"), result(`t${i}`, "run_tests", "x".repeat(1200) + FAIL(16, 4))];
      ck.tests("steady", `t${i}`);
      ck.apply(ms, ctxFor());
      if (ck.last) {
        assert.equal(ck.last.kind, "steady");
        at.push(i);
      }
      ck.apply(ms, ctxFor()); // the edit call in between
    }
    return { at, ck };
  };
  const plain = run(false);
  const backed = run(true);
  assert.ok(plain.at.length >= 8, `v2: ${plain.at.join(",")}`);
  assert.ok(backed.at.length < plain.at.length / 2, `back-off: ${backed.at.join(",")} vs ${plain.at.join(",")}`);
  const gaps = backed.at.slice(1).map((x, i) => x - backed.at[i]!);
  assert.ok(gaps.every((g, i) => i === 0 || g >= gaps[i - 1]!), `spacing grows: ${gaps.join(",")}`);
  assert.ok(gaps.at(-1)! > gaps[0]!, `spacing grows: ${gaps.join(",")}`);
  assert.equal(backed.ck.gap, 16, "capped at 4x");
  // the backstop ignores the gap
  const ck = new Checkpointer(0.55, 0.1, 4, { backoff: true });
  ck.tests("best", "t5");
  ck.apply(session(6), ctxFor());
  const big = session(12, 3000);
  assert.ok(ck.apply(big, ctxFor()) && ck.last?.kind === "pressure", "over the line: cut at once");
  ck.apply([...big, user("Next request.")], ctxFor());
  assert.equal(ck.gap, 4, "a new request: base gap");
});

// ---------------------------------------------------------------- steadiness: replay of the two capped 16k runs

const cpCalls = (r: ReplayCall[]): string[] => r.filter((c) => c.checkpoint).map((c) => `${c.call}:${c.checkpoint!.kind}`);
const peak = (r: ReplayCall[]): number => Math.max(...r.map((c) => c.chars));

for (const [name, task, want] of [
  // v2 replays the recorded run's checkpoints: 16 (dot-dsl) and 14 (bowling), as in their tinycode-calls.jsonl
  // v2: 10 of dot-dsl's 16 and 9 of bowling's 14 checkpoints were made on the tree of the checkpoint before
  ["dotdsl16-r3-tinycode.json", "dot-dsl r3", { v2: 16, steady: 7, v2Same: 10 }],
  ["bowling16-r3-tinycode.json", "bowling r3", { v2: 14, steady: 4, v2Same: 9 }],
] as const) {
  test(`replay ${task} 16k (capped at 10 min with v2): the steadiness rules make far fewer checkpoints; paired, request and last turn kept, under the usable line`, (t) => {
    const fx = loadFixture(name);
    assert.equal(JSON.stringify(fx).includes("/" + "home/"), false, "paths scrubbed");
    const v2 = replay(fx, true, V2_LIMITS);
    const steady = replay(fx, true);
    assert.equal(v2.length, fx.recorded.length);
    assert.equal(cpCalls(v2).length, want.v2, `v2: ${cpCalls(v2).join(" ")}`);
    assert.equal(cpCalls(steady).length, want.steady, `steady: ${cpCalls(steady).join(" ")}`);
    for (const c of steady) assert.ok(c.valid && c.requestKept && c.lastTurnKept, `call ${c.call}`);
    const sameAsPrev = (r: ReplayCall[], milestonesOnly: boolean) => {
      const cps = r.filter((c) => c.checkpoint);
      return cps.filter((c, i) => i > 0 && c.tree === cps[i - 1]!.tree && (!milestonesOnly || c.checkpoint!.kind !== "pressure")).length;
    };
    assert.equal(sameAsPrev(v2, false), want.v2Same, "the identical-state cycle in the recorded run");
    assert.equal(sameAsPrev(steady, true), 0, "no milestone checkpoint on the tree of the one before: the cycle is broken");
    const noSkip = replay(fx, true, { ...DEFAULTS.limits, checkpointSkipSame: false });
    const usableChars = usableTokens(fx.window, DEFAULTS.limits.outputReserve) * 4;
    assert.ok(peak(steady) < usableChars + fx.toolsChars + fx.systemChars, `peak ${peak(steady)} chars`);
    const kept = steady.filter((c) => c.checkpoint?.kept.length).length;
    assert.ok(kept >= Math.ceil(want.steady / 2), `kept files at ${kept} of ${want.steady} checkpoints`);
    const u = undoReplay(fx);
    t.diagnostic(`${task}: without the same-tree skip ${cpCalls(noSkip).length} checkpoints, ${sameAsPrev(noSkip, true)} on the previous tree; with it ${sameAsPrev(steady, true)}; backstop cuts ${steady.filter((c) => c.checkpoint?.kind === "pressure").length}`);
    t.diagnostic(`${task}: checkpoints ${want.v2} -> ${want.steady}; peak request ${peak(v2)} -> ${peak(steady)} chars (~${Math.ceil(peak(v2) / 4)} -> ~${Math.ceil(peak(steady) / 4)} tokens); kept files at ${kept}`);
    t.diagnostic(`${task}: v2 ${cpCalls(v2).join(" ")}`);
    t.diagnostic(`${task}: steady ${steady.filter((c) => c.checkpoint).map((c) => `${c.call}:${c.checkpoint!.kind}${c.checkpoint!.kept.length ? "+kept" : ""}`).join(" ")}`);
    t.diagnostic(`${task}: auto-undo would fire at test runs ${u.undos.join(",")} of ${u.runs}${u.guard ? `, guard at ${u.guard}` : ""} (only the first is an exact replay)`);
  });
}

test("replay paasio 16k with the steadiness rules: still 3 checkpoints, same peak (a run that passed is not slowed by them)", () => {
  const fx = loadFixture("paasio16-tinycode.json");
  const v2 = replay(fx, true, V2_LIMITS);
  const steady = replay(fx, true);
  assert.equal(cpCalls(steady).length, 3, cpCalls(steady).join(" "));
  assert.equal(peak(steady), peak(v2));
  for (const c of steady) assert.ok(c.valid && c.requestKept && c.lastTurnKept, `call ${c.call}`);
});

// ---------------------------------------------------------------- steadiness: same tree

test("same tree: a steady milestone on the tree of the last checkpoint is skipped; a new best, another tree, off, or no hash are not", () => {
  // a low gate (0.1 of the usable prompt): every milestone is over it; results small enough to stay off the backstop
  const ck = new Checkpointer(0.1, 0.01, 1, { skipSame: true });
  let ms = session(6);
  ck.tests("best", "t5", "T1");
  assert.ok(ck.apply(ms, ctxFor()) && ck.last, "the first checkpoint, on tree T1");
  const turn = (i: number, tree: string | undefined, kind: "steady" | "best" = "steady") => {
    ms = [...ms, call(`e${i}`, "edit", { path: "/w/a.py" }), result(`e${i}`, "edit", "ok"), call(`t${i}`, "run_tests"), result(`t${i}`, "run_tests", "x".repeat(2000) + FAIL(16, 4))];
    ck.tests(kind, `t${i}`, tree);
    ck.apply(ms, ctxFor());
    return ck.last?.kind ?? null;
  };
  assert.equal(turn(6, "T1"), null, "same tree: skipped");
  assert.deepEqual([ck.lastSkipped, ck.skipped, ck.hasPending], [true, 1, false]);
  assert.equal(turn(7, "T2"), "steady", "another tree: a checkpoint");
  assert.equal(ck.lastSkipped, false);
  assert.equal(turn(8, "T2"), null, "and now T2 is the last checkpoint's tree");
  assert.equal(turn(9, "T2", "best"), "best", "a new best is never skipped");
  assert.equal(turn(10, undefined), "steady", "no hash: as before");
  const off = new Checkpointer(0.55, 0.1, 1);
  off.tests("best", "t5", "T1");
  off.apply(session(6), ctxFor());
  off.tests("steady", "t5", "T1");
  assert.equal(off.lastSkipped, false, "skipSame off");
  ck.reset();
  assert.equal(ck.skipped, 0);
});
