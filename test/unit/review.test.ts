import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mergeConfig } from "../../src/config.ts";
import { parseDiff } from "../../src/context/diff.ts";
import type { ChatResult, Message } from "../../src/llm.ts";
import { mergeFindings, parseFindings, parseReviewArgs, runReview, selectHunks } from "../../src/workflows/review.ts";

const DIFF = `diff --git a/orders/dates.py b/orders/dates.py
--- a/orders/dates.py
+++ b/orders/dates.py
@@ -10,3 +10,3 @@ def parse_day(text):
 def month_key(day):
-    return day.strftime("%Y-%m")
+    return day.strftime("%Y-%d")
 
diff --git a/orders/totals.py b/orders/totals.py
--- a/orders/totals.py
+++ b/orders/totals.py
@@ -1,3 +1,4 @@
 def total(xs):
+    t = sum(xs)
-    return sum(xs)
+    return t
 
diff --git a/package-lock.json b/package-lock.json
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,2 +1,2 @@
-a
+b
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,2 +1,2 @@
-old
+new
`;

const reply = (o: unknown): ChatResult => ({ text: JSON.stringify(o), usage: { prompt_tokens: 100, cached_tokens: 0, completion_tokens: 20 }, ms: 1, lane: "small", model: "m", fellBack: false });

test("runReview: 3 hunk calls (lockfile skipped), merged findings match the fixture", async () => {
  const calls: { step: string; messages: Message[]; schema?: object }[] = [];
  const replies = [
    reply({ findings: [
      { line: 11, severity: "high", issue: "strftime uses %d (day) instead of %m", fix: "use %m" },
      { line: 99, severity: "high", issue: "outside the hunk", fix: "x" },
      { line: 11, severity: "low", issue: "strftime uses %d (day) instead of %m again", fix: "dup" },
    ] }),
    reply({ findings: [] }),
    reply({ findings: [{ line: 1, severity: "low", issue: "wording", fix: "reword" }] }),
  ];
  let i = 0;
  const chat = async (step: string, messages: Message[], opts?: { schema?: object }) => {
    calls.push({ step, messages, schema: opts?.schema });
    return replies[i++]!;
  };
  const env = { TINYCODE_LOG: join(mkdtempSync(join(tmpdir(), "tc-review-")), "calls.jsonl") };
  const out: string[] = [];
  const r = await runReview(parseReviewArgs(""), {
    cwd: ".", config: mergeConfig({}), chat, report: (l) => out.push(l), env, hunks: parseDiff(DIFF),
    readFile: (f) => (f.endsWith(".py") ? "def month_key(day):\n    return 1\n" : "x\n"),
  });
  assert.equal(r.calls, 3);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.step === "hunk" && (c.schema as { required: string[] }).required[0] === "findings"));
  assert.match(calls[0]!.messages[1]!.content, /orders\/dates\.py: def month_key\(day\)/);
  assert.match(calls[0]!.messages[1]!.content, /  11 \+    return day\.strftime\("%Y-%d"\)/);
  const expected = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/review/expected-findings.json"), "utf8"));
  assert.deepEqual(r.findings, expected);
  assert.deepEqual(JSON.parse(readFileSync(r.file!, "utf8")).findings, expected);
  assert.equal(r.skipped, 1);
  assert.ok(out.some((l) => l.startsWith("orders/dates.py:11 high strftime uses %d")));
});

test("selectHunks: over 40 keeps the 40 largest and counts the rest", () => {
  const mk = (n: number) => ({ file: `f${n}.py`, header: "@@", oldStart: 1, newStart: 1, lines: Array(n).fill("+x") });
  const all = Array.from({ length: 45 }, (_, i) => mk(i + 1));
  const s = selectHunks(all);
  assert.equal(s.hunks.length, 40);
  assert.equal(s.skippedCap, 5);
  assert.ok(!s.hunks.some((h) => h.file === "f1.py") && s.hunks.some((h) => h.file === "f45.py"));
});

test("parseFindings and mergeFindings: junk tolerated, severity order, no findings", () => {
  assert.deepEqual(parseFindings("not json"), []);
  assert.deepEqual(parseFindings('```json\n{"findings":[{"line":3,"severity":"bogus","issue":"x","fix":"y"}]}\n```')[0]!.severity, "low");
  const h = parseDiff(DIFF)[0]!;
  const m = mergeFindings([{ hunk: h, raw: [{ line: 10, severity: "low", issue: "b", fix: "" }, { line: 11, severity: "high", issue: "a", fix: "" }] }]);
  assert.deepEqual(m.map((f) => f.severity), ["high", "low"]);
});
