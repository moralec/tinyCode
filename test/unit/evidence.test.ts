import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { evidence, keywords } from "../../src/context/evidence.ts";
import { gitHunks, parseDiff } from "../../src/context/diff.ts";

function repo(git: boolean): string {
  const d = mkdtempSync(join(tmpdir(), "tinycode-ev-"));
  mkdirSync(join(d, "pkg"));
  writeFileSync(join(d, "pkg/orders.py"), "def monthly_total(rows):\n    return sum(rows)\n\nclass OrderBook:\n    pass\n");
  writeFileSync(join(d, "README.md"), "# orders\nline two\n");
  writeFileSync(join(d, "bin.dat"), Buffer.from([0, 1, 2]));
  if (git) {
    execFileSync("git", ["init", "-q"], { cwd: d });
    execFileSync("git", ["add", "."], { cwd: d });
  }
  return d;
}

test("keywords: stop words dropped, split on _ and ., capped at 12", () => {
  assert.deepEqual(keywords("Where is monthly_total defined?"), ["monthly_total", "monthly", "total"]);
  assert.equal(keywords("alpha1 beta22 gamma33 delta44 eps555 zeta66 eta777 theta8 iota99 kappa0 lambda1 mu234 nu567").length, 12);
});

test("evidence: git repo and plain folder give outline + scored hits", () => {
  for (const git of [true, false]) {
    const ev = evidence(repo(git), "where is monthly_total used");
    assert.match(ev.outline, /pkg\/orders\.py: monthly_total, OrderBook/);
    assert.match(ev.outline, /README\.md \(3 lines\)/);
    assert.doesNotMatch(ev.outline, /bin\.dat/);
    assert.match(ev.hits, /^pkg\/orders\.py:1: def monthly_total\(rows\):/);
  }
  assert.equal(evidence(repo(true), "zzzqqq").hits, "(no matching lines)");
});

test("evidence: caps", () => {
  const d = mkdtempSync(join(tmpdir(), "tinycode-ev-"));
  writeFileSync(join(d, "a.py"), Array.from({ length: 400 }, (_, i) => `def target_${i}(): pass`).join("\n"));
  const ev = evidence(d, "target", { hitsCap: 300, outlineCap: 40 });
  assert.ok(ev.hits.length <= 300);
  assert.ok(ev.outline.length <= 44 && ev.outline.endsWith("\n..."));
});

test("parseDiff / gitHunks", () => {
  const text = [
    "diff --git a/src/a.py b/src/a.py", "index 1..2 100644", "--- a/src/a.py", "+++ b/src/a.py",
    "@@ -3,4 +3,5 @@ def f():", " keep", "-old", "+new", "+more", " ", "@@ -20 +21 @@", "-x", "+y",
    "diff --git a/b.txt b/b.txt", "--- a/b.txt", "+++ b/b.txt", "@@ -1 +1 @@", "--- not a header", "+++ also body",
  ].join("\n");
  const h = parseDiff(text);
  assert.equal(h.length, 3);
  assert.deepEqual([h[0].file, h[0].oldStart, h[0].newStart, h[0].header], ["src/a.py", 3, 3, "@@ -3,4 +3,5 @@ def f():"]);
  assert.deepEqual(h[0].lines, [" keep", "-old", "+new", "+more", " "]);
  assert.deepEqual([h[1].oldStart, h[1].newStart], [20, 21]);
  assert.equal(h[2].file, "b.txt");
  assert.deepEqual(h[2].lines, ["--- not a header", "+++ also body"]);

  const d = repo(true);
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "i"], { cwd: d });
  writeFileSync(join(d, "README.md"), "# orders\nline TWO\n");
  const hs = gitHunks(d);
  assert.equal(hs.length, 1);
  assert.equal(hs[0].file, "README.md");
  assert.ok(hs[0].lines.includes("+line TWO"));
  assert.deepEqual(gitHunks(mkdtempSync(join(tmpdir(), "tinycode-nogit-"))), []);
});
