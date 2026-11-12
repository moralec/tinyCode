import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { alternate, checkAlternation, needsAlternation, type AltMsg } from "../../src/alternate.ts";

const u = (text: string): AltMsg => ({ role: "user", content: [{ type: "text", text }] });
const a = (text = "", calls = false): AltMsg => ({ role: "assistant", content: [{ type: "text", text }], ...(calls ? { tool_calls: [1] } : {}) });
const t = (text: string): AltMsg => ({ role: "toolResult", toolCallId: "x", content: [{ type: "text", text }] });
const s: AltMsg = { role: "system", content: "sys" };
const texts = (m: AltMsg) => (m.content as Array<{ text?: string }>).map((p) => p.text);

test("two adjacent user messages become one, joined by a blank line", () => {
  const r = alternate([s, u("one"), u("two"), a("ok")]);
  assert.deepEqual(r.messages.map((m) => m.role), ["system", "user", "assistant"]);
  assert.deepEqual(texts(r.messages[1]!), ["one\n\ntwo"]);
  assert.equal(r.merged, 1);
});

test("three adjacent user messages become one, order kept", () => {
  const r = alternate([s, u("a"), u("b"), u("c")]);
  assert.equal(r.messages.length, 2);
  assert.deepEqual(texts(r.messages[1]!), ["a\n\nb\n\nc"]);
  assert.equal(r.merged, 2);
});

test("a user message after a tool result is folded into the result; calls and results stay paired", () => {
  const input = [s, u("go"), a("", true), t("r1"), a("", true), t("r2"), u("[note]")];
  const r = alternate(input);
  assert.deepEqual(r.messages.map((m) => m.role), ["system", "user", "assistant", "toolResult", "assistant", "toolResult"]);
  assert.deepEqual(texts(r.messages[5]!), ["r2\n\n[note]"]);
  assert.equal(r.folded, 1);
  assert.deepEqual(checkAlternation(r.messages), []);
  assert.equal((input[5] as AltMsg & { content: unknown[] }).content.length, 1, "input not mutated");
});

test("user messages are never merged across an assistant or a tool result", () => {
  const r = alternate([s, u("q1"), a("x", true), t("res"), a("done"), u("q2")]);
  assert.equal(r.merged + r.folded, 0);
  assert.equal(r.messages.length, 6);
});

test("images and other parts are kept in order", () => {
  const img = { type: "image", data: "AAA", mimeType: "image/png" };
  const r = alternate([s, { role: "user", content: [{ type: "text", text: "see" }, img] }, u("then"), { role: "user", content: "plain string" }]);
  assert.equal(r.messages.length, 2);
  const c = r.messages[1]!.content as Array<Record<string, unknown>>;
  assert.deepEqual(c.map((p) => p.type), ["text", "image", "text"]);
  assert.equal(c[2]!.text, "then\n\nplain string");
});

test("string contents (workflow lists) merge as strings", () => {
  const r = alternate([{ role: "system", content: "s" }, { role: "user", content: "a" }, { role: "user", content: "b" }]);
  assert.equal(r.messages[1]!.content, "a\n\nb");
});

test("idempotent and deterministic; unchanged lists keep their identity", () => {
  const input = [s, u("a"), u("b"), a("", true), t("r"), u("c")];
  const once = alternate(input);
  const twice = alternate(once.messages);
  assert.deepEqual(twice.messages, once.messages);
  assert.equal(twice.merged + twice.folded, 0);
  assert.equal(twice.messages, once.messages);
  assert.deepEqual(alternate(input).messages, once.messages);
  const plain = [s, u("a"), a("b")];
  assert.equal(alternate(plain).messages, plain);
});

test("Pi internal roles are converted first, then merged", () => {
  const convert = (ms: AltMsg[]) => ms.map((m) => (m.role === "custom" ? { role: "user", content: m.content } : m));
  const r = alternate([s, u("task"), { role: "custom", customType: "tinycode-continue", content: "continue" }, a("ok")], convert);
  assert.deepEqual(r.messages.map((m) => m.role), ["system", "user", "assistant"]);
  assert.deepEqual(texts(r.messages[1]!), ["task\n\ncontinue"]);
});

test("checker: flags user straight after a tool result and adjacent users", () => {
  assert.deepEqual(checkAlternation([s, u("a"), a("", true), t("r"), a("x"), u("b")]), []);
  assert.equal(checkAlternation([s, u("a"), u("b")]).length, 1);
  assert.equal(checkAlternation([s, u("a"), a("", true), t("r"), u("b")]).length, 1);
});

// recorded requests of the Devstral failure (trimmed copies of bench/pairs/runs-radar/*devs-connect-r1/tinycode/bodies)
for (const n of ["004", "005", "006"]) {
  test(`recorded request ${n}: violated before, strictly alternating after`, () => {
    const body = JSON.parse(readFileSync(new URL(`../fixtures/alternate/req${n}.json`, import.meta.url), "utf8")) as { messages: AltMsg[] };
    const before = checkAlternation(body.messages);
    assert.ok(before.length > 0, "the recorded request breaks the rule");
    assert.match(before[0]!, /user after tool/);
    const r = alternate(body.messages);
    assert.deepEqual(checkAlternation(r.messages), []);
    assert.equal(r.messages[0]!.role, "system");
    // the calls and results are untouched, in the same order
    const shape = (ms: AltMsg[]) => ms.filter((m) => m.role !== "user").map((m) => m.role + (m.tool_calls ? "T" : ""));
    assert.deepEqual(shape(r.messages), shape(body.messages));
    const last = r.messages[r.messages.length - 1]!;
    assert.equal(last.role, "tool");
    assert.match(String(last.content), /\[note findings in todo\]/);
  });
}

test("needsAlternation: a strictRoles entry inside the model id, any case; \"*\" is every model; [] none", () => {
  const strict = ["mistral", "devstral", "ministral", "magistral", "codestral"];
  assert.equal(needsAlternation("devstral-small-2-24b", strict), true);
  assert.equal(needsAlternation("Mistral-Small-3.2", strict), true);
  for (const id of ["qwen3.6-35b-a3b", "gemma-4-12b", "qwen3-coder-30b-a3b", ""]) assert.equal(needsAlternation(id, strict), false, id);
  assert.equal(needsAlternation("qwen3.6-35b-a3b", ["*"]), true);
  assert.equal(needsAlternation("devstral-small-2-24b", []), false);
});

test("D5: without the fold, turn N minus its tail is a prefix of turn N+1; the fold edits the last tool result instead", () => {
  const tail = u("[todo]\n1. [ ] fix it");
  const turnN = [s, u("task"), a("", true), t("result 1"), tail];
  const turnN1 = [s, u("task"), a("", true), t("result 1"), a("", true), t("result 2"), tail];
  const prefixKept = (x: AltMsg[], y: AltMsg[]) => x.slice(0, -1).every((m, i) => JSON.stringify(m) === JSON.stringify(y[i]));
  assert.ok(prefixKept(turnN, turnN1), "plain: only the tail changes, at a message boundary");
  const f = (ms: AltMsg[]) => alternate(ms).messages;
  assert.equal(f(turnN).length, 4, "folded: the tail is inside result 1");
  assert.notEqual(JSON.stringify(f(turnN)[3]), JSON.stringify(f(turnN1)[3]), "folded: result 1 differs between the turns");
});
