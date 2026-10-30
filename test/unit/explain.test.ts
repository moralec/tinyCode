import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { mergeConfig } from "../../src/config.ts";
import type { ChatResult, Message } from "../../src/llm.ts";
import { actionable, buildIndex, heuristic, route } from "../../src/router.ts";
import { checkCitations, clampWords, findTarget, gather, parseExplainArgs, runExplain } from "../../src/workflows/explain.ts";

function repo(): string {
  const d = tmpDir("explain-");
  mkdirSync(join(d, "orders"));
  writeFileSync(join(d, "orders/dates.py"), "import re\n\ndef parse_day(text):\n    m = re.match(r'(\\d+)', text)\n    return month_key(m)\n\ndef month_key(day):\n    return str(day)\n");
  writeFileSync(join(d, "orders/report.py"), "from orders.dates import parse_day\n\ndef report(rows):\n    return [parse_day(r) for r in rows]\n");
  return d;
}
const reply = (text: string): ChatResult => ({ text, usage: { prompt_tokens: 100, cached_tokens: 0, completion_tokens: 20 }, ms: 1, lane: "trunk", model: "m", fellBack: false });
function scripted(replies: string[]) {
  const calls: { step: string; messages: Message[] }[] = [];
  let i = 0;
  const chat = async (step: string, messages: Message[]): Promise<ChatResult> => {
    calls.push({ step, messages });
    return reply(replies[Math.min(i++, replies.length - 1)]!);
  };
  return { chat, calls };
}

test("parseExplainArgs: --file from the front only", () => {
  assert.deepEqual(parseExplainArgs("--file a/b.py what is this"), { file: "a/b.py", question: "what is this" });
  assert.deepEqual(parseExplainArgs("what does --file mean"), { question: "what does --file mean" });
});

test("findTarget: a symbol resolves to its definition, a file name to the file", () => {
  const d = repo();
  assert.deepEqual(findTarget(d, { question: "what does parse_day do?" }), { file: "orders/dates.py", line: 3, symbol: "parse_day" });
  assert.deepEqual(findTarget(d, { question: "explain report.py" }), { file: "orders/report.py" });
  assert.equal(findTarget(d, { question: "explain recursion" }), null);
  assert.equal(findTarget(d, { file: "../x.py", question: "q" }), null);
});

test("gather: numbered definition, callers and callees, within the 4k-token cap", () => {
  const d = repo();
  const g = gather(d, { file: "orders/dates.py", line: 3, symbol: "parse_day" }, "what does parse_day do?");
  assert.match(g.text, /^3: def parse_day/m);
  assert.match(g.text, /orders\/report\.py:\d+:.*parse_day/);
  assert.match(g.text, /Callees \(numbered\):\norders\/dates\.py lines 7-8:\n7: def month_key\(day\):\n8:     return str\(day\)/);
  assert.ok(g.text.length <= 16000);
  const big = tmpDir("explain-big-");
  writeFileSync(join(big, "big.py"), Array.from({ length: 3000 }, (_, i) => `x${i} = call_${i}(${i})`).join("\n"));
  assert.ok(gather(big, { file: "big.py" }, "explain big.py").text.length <= 16000);
});

test("gather: callee bodies (one level down too) within the caps, the rest as signatures", () => {
  const d = tmpDir("explain-callees-");
  mkdirSync(join(d, "led"));
  const long = Array.from({ length: 30 }, (_, i) => `    x${i} = ${i}`).join("\n");
  writeFileSync(join(d, "led/money.py"), `def to_cents(a):\n    return int(round(a * 100))\n\ndef split(c, n):\n    base, extra = divmod(c, n)\n    return spread(base, extra, n)\n\ndef spread(b, e, n):\n    return [b + 1 if i < e else b for i in range(n)]\n\ndef audit(v):\n${long}\n    return v\n\ndef fmt(c):\n    return "%d.%02d" % (c // 100, c % 100)\n`);
  writeFileSync(join(d, "led/bill.py"), "from led.money import to_cents, split, audit, fmt\n\ndef share(amount, payers):\n    audit(amount)\n    shares = split(to_cents(amount), len(payers))\n    return [fmt(c) for c in shares]\n");
  const q = "Explain what `share` in led/bill.py does, and how rounding is handled.";
  const t = { file: "led/bill.py", line: 3, symbol: "share" };
  const g = gather(d, t, q);
  // call order: audit (cut at 15 lines), split, to_cents, fmt = 4 bodies; spread (one level down) has no room left
  assert.match(g.text, /led\/money\.py lines 11-25:\n11: def audit\(v\):[\s\S]*?\n\.\.\./);
  assert.match(g.text, /led\/money\.py lines 4-6:\n4: def split\(c, n\):\n5:     base, extra = divmod\(c, n\)/);
  assert.match(g.text, /led\/money\.py lines 1-2:\n1: def to_cents/);
  assert.match(g.text, /led\/money\.py lines 44-45:\n44: def fmt\(c\):/);
  assert.doesNotMatch(g.text, /def spread/);
  // fewer direct callees: the one called by a shown body comes in (by_month -> group_by in the matrix repo)
  writeFileSync(join(d, "led/bill.py"), "from led.money import to_cents, split, audit\n\ndef share(amount, payers):\n    return split(to_cents(amount), len(payers))\n");
  const g2 = gather(d, t, q);
  assert.match(g2.text, /led\/money\.py lines 8-9:\n8: def spread\(b, e, n\):/);
  // more than fit: the rest are signatures
  writeFileSync(join(d, "led/bill.py"), "from led.money import *\n\ndef share(amount, payers):\n    audit(amount)\n    audit2(amount)\n    shares = split(to_cents(amount), len(payers))\n    return [fmt(c) for c in shares]\n");
  writeFileSync(join(d, "led/more.py"), `def audit2(v):\n${long}\n    return v\n`);
  const g3 = gather(d, t, q);
  assert.match(g3.text, /More callees:\nled\/money\.py:44: def fmt\(c\):/);
  assert.equal((g3.text.match(/^led\/(?:money|more)\.py lines /gm) ?? []).length, 4, "at most 4 bodies");
});

test("checkCitations: real citations stay, missing file / past-the-end line / bad range are removed and listed", () => {
  const d = repo();
  const r = checkCitations(d, "It parses (orders/dates.py:3) then keys it (orders/dates.py:7-8), see nope.py:1 and orders/dates.py:99 and orders/report.py:4-2.");
  assert.deepEqual(r.valid, ["orders/dates.py:3", "orders/dates.py:7-8"]);
  assert.deepEqual(r.dropped, ["nope.py:1", "orders/dates.py:99", "orders/report.py:4-2"]);
  assert.ok(!r.answer.includes("nope.py") && r.answer.includes("orders/dates.py:3"));
  assert.equal(checkCitations(d, "see ../etc/passwd.txt:1").dropped.length, 1);
});

test("clampWords cuts at 200", () => {
  assert.equal(clampWords("a ".repeat(300)).cut, true);
  assert.equal(clampWords("a b c").cut, false);
});

test("runExplain: one scripted call, bad citation dropped and reported, no edits", async () => {
  const d = repo();
  const { chat, calls } = scripted(["parse_day matches digits (orders/dates.py:4) and returns month_key (orders/dates.py:5), also see orders/ghost.py:2."]);
  const lines: string[] = [];
  const r = await runExplain({ question: "what does parse_day do?" }, { cwd: d, config: mergeConfig({}), chat, report: (l) => lines.push(l) });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.step, "explain");
  assert.equal(r.calls, 1);
  assert.deepEqual(r.citations.valid, ["orders/dates.py:4", "orders/dates.py:5"]);
  assert.deepEqual(r.citations.dropped, ["orders/ghost.py:2"]);
  assert.ok(lines.some((l) => l.startsWith("citations dropped") && l.includes("orders/ghost.py:2")));
  assert.ok(!r.answer.includes("ghost"));
  assert.equal(r.ok, true);
  // no edits: the sources are untouched and the prompt carries numbered code
  assert.match(String(calls[0]!.messages[1]!.content), /3: def parse_day/);
});

test("runExplain with --file (the direct run's router file): a symbol the question names in it is the target; findTarget alone keeps the file", async () => {
  const d = repo();
  const { chat, calls } = scripted(["It keys the day (orders/dates.py:8)."]);
  const r = await runExplain({ file: "orders/dates.py", question: "what does month_key in orders/dates.py do?" }, { cwd: d, config: mergeConfig({}), chat, report: () => {} });
  assert.deepEqual(r.target, { file: "orders/dates.py", line: 7, symbol: "month_key" });
  assert.match(String(calls[0]!.messages[1]!.content), /^orders\/dates\.py lines 5-8 \(numbered\):/);
  assert.deepEqual(findTarget(d, { file: "orders/dates.py", question: "add docstrings to month_key" }), { file: "orders/dates.py" }, "/doc and /test keep the whole file");
});

test("runExplain: no valid citation warns; unknown target makes no call", async () => {
  const d = repo();
  const { chat, calls } = scripted(["It does things."]);
  const lines: string[] = [];
  const r = await runExplain({ question: "explain parse_day" }, { cwd: d, config: mergeConfig({}), chat, report: (l) => lines.push(l) });
  assert.equal(r.ok, false);
  assert.ok(lines.some((l) => l.startsWith("warning")));
  const n = calls.length;
  const r2 = await runExplain({ question: "explain recursion" }, { cwd: d, config: mergeConfig({}), chat, report: () => {} });
  assert.equal(calls.length, n);
  assert.equal(r2.target, null);
});

test("router: named-file explain questions go to explain; general questions and other verbs do not", () => {
  const names = new Map([["report.py", "orders/report.py"], ["month_key", "orders/dates.py"]]);
  for (const q of ["what does month_key do?", "explain report.py", "how does report.py work?", "walk me through month_key"]) {
    const r = heuristic(q, names);
    assert.equal(r.workflow, "explain", q);
    assert.equal(r.confident, true);
    assert.equal(actionable(r), "explain");
  }
  for (const q of ["what is a closure?", "how does git rebase work?", "explain recursion", "why does report.py crash?", "fix report.py", "review report.py", "add a function to report.py"]) {
    assert.notEqual(heuristic(q, names).workflow, "explain", q);
  }
});

test("router: explain is decided by code, no model call", async () => {
  const d = repo();
  const r = await route("what does parse_day do?", buildIndex(d), async () => {
    throw new Error("network must not be called");
  });
  assert.deepEqual([r.workflow, r.source, r.file], ["explain", "code", "orders/dates.py"]);
});
