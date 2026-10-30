import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { BestTree, LOOP_SLOT, rewriteNudge } from "../../src/besttree.ts";
import { restoreSnapshot, takeSnapshot } from "../../src/workflows/fix.ts";
import { dropDisplayOnly } from "../../src/orchestrate.ts";
import { CUSTOM_BEAT } from "../../src/progress.ts";

const c = (passed: number, failed: number) => ({ passed, failed });

test("best tree: the first passing run is the best; a better run replaces it (snapshot each time); a worse one gets one line, no snapshot", () => {
  const t = new BestTree();
  let shots = 0;
  const snap = () => void shots++;
  assert.equal(t.observe(c(0, 31), snap), null, "nothing passes: not worth keeping");
  assert.equal(t.has, false);
  assert.equal(t.observe(c(24, 7), snap), null);
  assert.deepEqual([t.has, shots], [true, 1]);
  assert.equal(t.observe(c(27, 4), snap), null, "improved");
  assert.equal(shots, 2);
  assert.equal(t.observe(c(27, 4), snap), null, "same: no snapshot");
  assert.equal(shots, 2);
  const worse = t.observe(c(3, 28), snap);
  assert.equal(worse, "Worse than best (27/31 at test run 3). Restore: call restore_best.");
  assert.equal(shots, 2);
  assert.equal(t.observe(null, snap), null, "unreadable counts: no verdict");
  assert.equal(t.restoreText(() => ({})), "Restored best tree (27/31).");
  assert.equal(t.restoreText(() => null), "No snapshot found.");
  t.reset();
  assert.equal(new BestTree().restoreText(() => ({})), "No best tree yet.");
  assert.equal(t.has, false);
});

test("best tree: the hand-over's tree is the starting best; fewer failures with no test lost counts as better", () => {
  const t = new BestTree();
  let shots = 0;
  t.seed(c(24, 7), () => void shots++);
  assert.equal(shots, 1);
  assert.equal(t.observe(c(20, 11), () => void shots++), "Worse than best (24/31, the hand-over). Restore: call restore_best.");
  assert.equal(t.observe(c(24, 7), () => void shots++), null, "same counts: not better, no snapshot");
  assert.equal(t.observe(c(24, 5), () => void shots++), null, "fewer failures but tests lost (29 of 31): not better");
  assert.equal(shots, 1);
  assert.equal(t.observe(c(25, 6), () => void shots++), null, "more passing: better");
  assert.equal(shots, 2);
  const none = new BestTree();
  none.seed(null, () => assert.fail("no counts: no snapshot"));
  none.seed(c(0, 5), () => assert.fail("nothing passing: no snapshot"));
  assert.equal(none.has, false);
});

test("best tree with real files: improve, rewrite worse, restore_best puts the better file back", () => {
  const cwd = tmpDir("tc-best-");
  const env = { TINYCODE_LOG: join(tmpDir("tc-best-log-"), "c.jsonl") };
  writeFileSync(join(cwd, "bowling.py"), "v1\n");
  const t = new BestTree();
  t.seed(c(24, 7), () => void takeSnapshot(cwd, env, LOOP_SLOT));
  writeFileSync(join(cwd, "bowling.py"), "v2 rewrite\n");
  writeFileSync(join(cwd, "extra.py"), "new\n");
  assert.match(t.observe(c(3, 28), () => assert.fail("worse: no snapshot"))!, /^Worse than best \(24\/31/);
  assert.equal(t.restoreText(() => restoreSnapshot(cwd, env, LOOP_SLOT)), "Restored best tree (24/31).");
  assert.equal(readFileSync(join(cwd, "bowling.py"), "utf8"), "v1\n");
  assert.equal(existsSync(join(cwd, "extra.py")), false, "files created since are removed, like the ladder's own restore");
});

test("whole-file rewrite nudge: only a write over an existing file once tests pass; never a block", () => {
  assert.equal(rewriteNudge("write", true, true), "Whole-file rewrite. Prefer edit.");
  assert.equal(rewriteNudge("write", false, true), null, "a new file");
  assert.equal(rewriteNudge("write", true, false), null, "no passing tests yet");
  assert.equal(rewriteNudge("edit", true, true), null);
});

test("display-only messages (heartbeats, stuck lines, the sentence) never reach the model; the hint and results do", () => {
  const msgs = [
    { role: "user", content: "x" },
    { role: "custom", customType: CUSTOM_BEAT, content: "Still working on your request \u2014 3 steps so far" },
    { role: "custom", customType: "tinycode-say", content: "I will fix it" },
    { role: "custom", customType: "tinycode-hint", content: "tinyCode hint: use `fix`." },
    { role: "custom", customType: "tinycode", content: "fix done: ..." },
    { role: "assistant", content: [] },
  ];
  const out = dropDisplayOnly(msgs);
  assert.deepEqual(out.map((m) => (m as { customType?: string }).customType ?? m.role), ["user", "tinycode-hint", "tinycode", "assistant"]);
  const clean = [msgs[0]!, msgs[5]!];
  assert.equal(dropDisplayOnly(clean), clean, "the same list when there is nothing to drop");
});

test("stuck: the stuckRuns-th test run without beating the best restores it once and says stop", () => {
  const t = new BestTree(3);
  let restored = 0;
  const snap = () => {};
  const back = () => void restored++;
  assert.equal(t.observe({ passed: 24, failed: 7 }, snap, back), null); // first best
  assert.equal(t.observe({ passed: 24, failed: 7 }, snap, back), null); // same: 1
  assert.match(t.observe({ passed: 3, failed: 28 }, snap, back) ?? "", /^Worse than best/); // 2
  assert.equal(t.observe({ passed: 20, failed: 11 }, snap, back), "No progress 3 test runs. Best restored (24/31). Stop: report what still fails.");
  assert.equal(restored, 1);
  assert.equal(t.observe({ passed: 20, failed: 11 }, snap, back)?.startsWith("Worse than best"), true); // once per request
  assert.equal(restored, 1);
  assert.equal(t.observe({ passed: 30, failed: 1 }, snap, back), null); // progress resets the count
  t.reset();
  assert.equal(new BestTree(0).observe({ passed: 1, failed: 1 }, snap, back), null); // 0 = off
});

test("stuck: equal counts say stop but keep the tree; green runs never count (add-1-chunk r2: 2/2 three times wiped the new function)", () => {
  let restored = 0;
  const snap = () => {};
  const back = () => void restored++;
  const green = new BestTree(3);
  for (let i = 0; i < 6; i++) assert.equal(green.observe({ passed: 2, failed: 0 }, snap, back), null);
  assert.equal(restored, 0, "a green tree is never put back");
  const flat = new BestTree(3);
  flat.observe({ passed: 7, failed: 3 }, snap, back);
  flat.observe({ passed: 7, failed: 3 }, snap, back);
  flat.observe({ passed: 7, failed: 3 }, snap, back);
  assert.equal(flat.observe({ passed: 7, failed: 3 }, snap, back), "No progress 3 test runs (7/10). Stop: report what still fails.");
  assert.equal(restored, 0, "same counts: the tree may hold work the tests do not see");
});

test("continue: one follow-up when the last test run fails; none after the stuck stop, none when passing, reset per request", () => {
  const snap = () => {};
  const t = new BestTree(3, 1);
  assert.equal(t.continueLine(), null); // no test run yet
  t.observe({ passed: 7, failed: 3 }, snap, snap);
  assert.equal(t.continueLine(), "Tests still fail (7/10). Continue.");
  assert.equal(t.continueLine(), null); // once per request
  t.reset();
  t.observe({ passed: 10, failed: 0 }, snap, snap);
  assert.equal(t.continueLine(), null); // passing
  t.reset();
  t.observe({ passed: 7, failed: 3 }, snap, snap);
  for (let i = 0; i < 3; i++) t.observe({ passed: 7, failed: 3 }, snap, snap); // stuck rule fires
  assert.equal(t.continueLine(), null);
  assert.equal(new BestTree(3, 0).continueLine(), null); // 0 = off
});

test("end restore: a request ending below its best gets the best tree back, once; at or above best nothing", () => {
  const snap = () => {};
  let restored = 0;
  const back = () => void restored++;
  const t = new BestTree(0, 0);
  t.observe({ passed: 22, failed: 3 }, snap, back);
  assert.equal(t.endRestore(back), null); // at best
  t.observe({ passed: 0, failed: 1 }, snap, back); // a tree that no longer imports
  assert.equal(t.endRestore(back), "Ended below best: restored best tree (22/25).");
  assert.equal(restored, 1);
  assert.equal(t.endRestore(back), null); // once
  assert.equal(new BestTree().endRestore(back), null); // no best
});
