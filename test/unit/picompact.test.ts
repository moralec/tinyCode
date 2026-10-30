import assert from "node:assert/strict";
import { test } from "node:test";
import { decidePiCompact, loadPrepareCompaction, runPiCompact, type PiCompactDeps } from "../../src/picompact.ts";
import { DEFAULTS, mergeConfig } from "../../src/config.ts";

const base = { windowTokens: 32768, reserveShare: 0.2, keepShare: 0.25 };

test("decidePiCompact: threshold under 1 - reserve is cancelled, over it is resized to the window", () => {
  assert.deepEqual(decidePiCompact({ ...base, reason: "threshold", tokensBefore: 17000 }), { action: "cancel" });
  assert.deepEqual(decidePiCompact({ ...base, reason: "threshold", tokensBefore: 26214 }), { action: "cancel" }, "exactly on the line is still cancelled");
  assert.deepEqual(decidePiCompact({ ...base, reason: "threshold", tokensBefore: 27000 }), {
    action: "resize",
    settings: { enabled: true, reserveTokens: 6554, keepRecentTokens: 8192 },
  });
});

test("decidePiCompact: overflow and manual are never cancelled; an unknown window passes to Pi", () => {
  for (const reason of ["overflow", "manual"] as const) assert.equal(decidePiCompact({ ...base, reason, tokensBefore: 1000 }).action, "resize");
  assert.equal(decidePiCompact({ ...base, windowTokens: 0, reason: "threshold", tokensBefore: 1000 }).action, "pass");
  assert.equal(decidePiCompact({ ...base, windowTokens: NaN, reason: "threshold", tokensBefore: 1000 }).action, "pass");
});

const prep = { tokensBefore: 28000, firstKeptEntryId: "e9" };
const res = { summary: "s", firstKeptEntryId: "e9", tokensBefore: 28000, usage: { output: 900 } };

test("runPiCompact: cancel, resize (settings reach prepare, result is returned), and every failure passes to Pi", async () => {
  const never = async (): Promise<PiCompactDeps> => assert.fail("deps must not be loaded");
  const c = await runPiCompact({ ...base, reason: "threshold", tokensBefore: 20000, branchEntries: [], deps: never });
  assert.deepEqual([c.status, c.result], ["cancelled", { cancel: true }]);

  let seen: unknown;
  const ok = async (): Promise<PiCompactDeps> => ({ prepare: (_e, s) => ((seen = s), prep), compact: async () => res });
  const r = await runPiCompact({ ...base, reason: "threshold", tokensBefore: 28000, branchEntries: [], deps: ok });
  assert.deepEqual(seen, { enabled: true, reserveTokens: 6554, keepRecentTokens: 8192 });
  assert.equal(r.status, "resized");
  assert.deepEqual(r.result, { compaction: res });
  assert.equal(r.summaryTokens, 900);

  const cases: [string, () => Promise<PiCompactDeps>][] = [
    ["deps throw", async () => { throw new Error("no auth"); }],
    ["nothing to cut", async () => ({ prepare: () => undefined, compact: async () => res })],
    ["compact throws", async () => ({ prepare: () => prep, compact: async () => { throw new Error("boom"); } })],
    ["empty summary", async () => ({ prepare: () => prep, compact: async () => ({ ...res, summary: " " }) })],
  ];
  for (const [name, deps] of cases) {
    const p = await runPiCompact({ ...base, reason: "overflow", tokensBefore: 30000, branchEntries: [], deps });
    assert.equal(p.status, "passed", name);
    assert.equal(p.result, undefined, name);
    assert.ok(p.why, name);
  }
});

// A synthetic session: 40 request/answer pairs of ~1000 tokens each (4000 chars), each with a usage report.
function session(n: number) {
  const entries: unknown[] = [];
  let parent: string | null = null;
  const add = (message: unknown) => {
    const id = `e${entries.length}`;
    entries.push({ type: "message", id, parentId: parent, timestamp: new Date(1e12 + entries.length * 1000).toISOString(), message });
    parent = id;
  };
  for (let i = 0; i < n; i++) {
    add({ role: "user", content: [{ type: "text", text: `request ${i} ` + "u".repeat(2000) }], timestamp: 1e12 + i * 2 });
    add({ role: "assistant", content: [{ type: "text", text: `answer ${i} ` + "a".repeat(2000) }], api: "x", provider: "p", model: "m", stopReason: "stop", timestamp: 1e12 + i * 2 + 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  }
  return entries;
}

test("Pi's prepareCompaction with window-sized settings keeps at most about piKeepRecent x window", async () => {
  const prepare = await loadPrepareCompaction();
  const window = 32768;
  const entries = session(40); // ~40k tokens
  const keep = Math.round(window * DEFAULTS.limits.piKeepRecent);
  const p = prepare(entries as never[], { enabled: true, reserveTokens: Math.round(window * DEFAULTS.limits.piCompactReserve), keepRecentTokens: keep });
  assert.ok(p, "a preparation");
  const at = entries.findIndex((e) => (e as { id: string }).id === p.firstKeptEntryId);
  assert.ok(at > 0);
  const keptTokens = entries.slice(at).reduce<number>((n, e) => n + Math.ceil(JSON.stringify((e as { message: { content: unknown } }).message.content).length / 4), 0);
  assert.ok(keptTokens <= keep * 1.2, `kept ${keptTokens} tokens, budget ${keep}`);
  assert.ok(keptTokens < 20000, "far below Pi's default 20000");
  // and Pi's default settings would have kept more than the trigger on this window
  const dflt = prepare(entries as never[], { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 })!;
  const dAt = entries.findIndex((e) => (e as { id: string }).id === dflt.firstKeptEntryId);
  assert.ok(dAt < at, "default settings keep more");
});

test("limits.piCompactReserve / piKeepRecent: defaults, shares in (0, 1), sum capped", () => {
  assert.equal(DEFAULTS.limits.piCompactReserve, 0.2);
  assert.equal(DEFAULTS.limits.piKeepRecent, 0.25);
  assert.equal(mergeConfig({ limits: { piKeepRecent: 0.4 } }).limits.piKeepRecent, 0.4, "0.2 + 0.4 = 0.6 is allowed");
  for (const bad of [0, 1, -0.1, 1.5, "0.2"]) {
    assert.throws(() => mergeConfig({ limits: { piCompactReserve: bad } }), /limits\.piCompactReserve/);
    assert.throws(() => mergeConfig({ limits: { piKeepRecent: bad } }), /limits\.piKeepRecent/);
  }
  assert.throws(() => mergeConfig({ limits: { piKeepRecent: 0.45 } }), /at most 0\.6/);
  assert.throws(() => mergeConfig({ limits: { piCompactReserve: 0.5 } }), /at most 0\.6/);
});

test("16k root cause: Pi's own settings (keep 20000) find nothing to cut in a window-sized session, so Pi never asks the hook", async () => {
  const prepare = await loadPrepareCompaction();
  const entries = session(6); // ~6k tokens: what a 16k window holds before Pi's clamp ends the replies
  assert.equal(prepare(entries as never[], { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }), undefined, "no preparation: session_before_compact is never emitted");
  const window = 16384;
  assert.ok(prepare(entries as never[], { enabled: true, reserveTokens: Math.round(window * 0.2), keepRecentTokens: Math.round(window * 0.25) }), "window-sized settings would cut");
});

test("decidePiCompact: the cancel line never sits above the usable line (16k: 10240, not 13107); 32k unchanged", () => {
  const w16 = { windowTokens: 16384, reserveShare: 0.2, keepShare: 0.25, ceilingTokens: 10240 };
  assert.equal(decidePiCompact({ ...w16, reason: "threshold", tokensBefore: 10000 }).action, "cancel");
  assert.equal(decidePiCompact({ ...w16, reason: "threshold", tokensBefore: 11000 }).action, "resize", "between the usable line and 0.8 x window: compact");
  const w32 = { ...base, ceilingTokens: 32768 - 4096 - 2048 };
  assert.equal(decidePiCompact({ ...w32, reason: "threshold", tokensBefore: 26214 }).action, "cancel");
  assert.equal(decidePiCompact({ ...w32, reason: "threshold", tokensBefore: 27000 }).action, "resize");
});

test("selfManaged (checkpoints on): threshold compactions are cancelled; a failed resize is cancelled, never handed to Pi (live paasio 16k)", async () => {
  const w16 = { windowTokens: 16384, reserveShare: 0.2, keepShare: 0.25, ceilingTokens: 10240, selfManaged: true };
  assert.equal(decidePiCompact({ ...w16, reason: "threshold", tokensBefore: 10314 }).action, "cancel", "the live run's 10314 -> resize -> failed summary");
  assert.equal(decidePiCompact({ ...w16, reason: "overflow", tokensBefore: 10314 }).action, "resize", "overflow still compacts");
  const fails = async (): Promise<PiCompactDeps> => ({ prepare: () => prep, compact: async () => { throw new Error("summary hit the token cap"); } });
  const o = await runPiCompact({ ...w16, reason: "overflow", tokensBefore: 12000, branchEntries: [], deps: fails });
  assert.deepEqual([o.status, o.result], ["cancelled", { cancel: true }]);
  assert.match(o.why ?? "", /token cap/);
  const p = await runPiCompact({ ...w16, selfManaged: false, reason: "overflow", tokensBefore: 12000, branchEntries: [], deps: fails });
  assert.equal(p.status, "passed", "without checkpoints: as before");
});
