import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { mergeConfig } from "../../src/config.ts";
import { parseDiff } from "../../src/context/diff.ts";
import type { ChatResult, Message } from "../../src/llm.ts";
import { CUT_RETRY, mergeFindings, parseFindings, parseReviewArgs, readFindings, runReview, selectHunks } from "../../src/workflows/review.ts";

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
  const env = { TINYCODE_LOG: join(tmpDir("tc-review-"), "calls.jsonl") };
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

test("a cut hunk reply is retried once asking for 1 finding; cut again it is reported unread, never as no findings", async () => {
  const hunks = parseDiff(DIFF).slice(0, 2);
  const cut = (text: string): ChatResult => ({ ...reply({}), text, finish: "length" });
  const seen: { content: string; max?: number }[] = [];
  const run = async (replies: ChatResult[]) => {
    let i = 0;
    seen.length = 0;
    const chat = async (_s: string, messages: Message[], opts?: { maxTokens?: number }) => {
      seen.push({ content: String(messages[1]!.content), max: opts?.maxTokens });
      return replies[i++]!;
    };
    const out: string[] = [];
    const r = await runReview(parseReviewArgs(""), { cwd: ".", config: mergeConfig({}), chat, report: (l) => out.push(l), env: { TINYCODE_LOG: join(tmpDir("tc-review-cut-"), "calls.jsonl") }, hunks, readFile: () => "x\n" });
    return { r, out };
  };
  // review-1-money r3: cut at the cap with the bugs in the cut part -> the retry finds them
  const a = await run([cut('{"findings":[{"line":11,"severity":"high","issue":"%d is the day'), reply({ findings: [{ line: 11, severity: "high", issue: "%d is the day, not the month", fix: "%m" }] }), reply({ findings: [] })]);
  assert.equal(a.r.calls, 3);
  assert.ok(seen[1]!.content.endsWith(`\n${CUT_RETRY}`) && !seen[0]!.content.includes(CUT_RETRY) && !seen[2]!.content.includes(CUT_RETRY));
  assert.equal(a.r.findings.length, 1);
  assert.equal(a.r.unread, 0);
  // cut twice: unread, and the result does not say "no findings"
  const b = await run([cut("{"), cut('{"findings":['), reply({ findings: [] })]);
  assert.equal(b.r.unread, 1);
  assert.ok(b.out.some((l) => /orders\/dates\.py @@ .*: reply cut, hunk not reviewed/.test(l)), b.out.join("\n"));
  assert.ok(!b.out.includes("no findings") && b.out.includes("no findings in the hunks read"));
  // not the expected JSON (no findings array, then prose) is unread too, even with finish stop
  const c = await run([reply({}), { ...reply({}), text: "Looks fine to me." }, reply({ findings: [] })]);
  assert.equal(c.r.unread, 1);
  assert.equal(readFindings('{"findings":[{"line":1'), null);
  assert.deepEqual(readFindings('{"findings":[]}'), []);
});

test("hunk replies get 600 tokens by default", () => {
  assert.equal(mergeConfig({}).limits.maxTokens.hunk, 600);
});
