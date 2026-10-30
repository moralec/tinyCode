import assert from "node:assert/strict";
import { test } from "node:test";
import { Compactor, contextTokens, currentStart, requests, summarizeRequest } from "../../src/compact.ts";
import type { Msg } from "../../src/limits.ts";

let ts = 1000;
const user = (text: string): Msg => ({ role: "user", content: [{ type: "text", text }], timestamp: ts++ });
const asst = (text: string, calls: { id: string; name: string; arguments: unknown }[] = [], usage?: number): Msg => ({
  role: "assistant",
  content: [{ type: "text", text }, ...calls.map((c) => ({ type: "toolCall", ...c }))],
  usage: usage ? { input: usage, output: 0, cacheRead: 0, cacheWrite: 0 } : undefined,
  timestamp: ts++,
});
const res = (id: string, name: string, text: string): Msg => ({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], timestamp: ts++ });
const big = (n: number) => "x".repeat(n * 4);

/** A scripted session: each request = user, read, edit, reply. `usage` plays the server's prompt-size report. */
function request(n: number, usage: number): Msg[] {
  return [
    user(`please change thing ${n} in module_${n}.py`),
    asst("looking", [{ id: `r${n}`, name: "read", arguments: { path: `module_${n}.py` } }]),
    res(`r${n}`, "read", big(500)),
    asst("editing", [{ id: `e${n}`, name: "edit", arguments: { path: `module_${n}.py`, edits: [] } }]),
    res(`e${n}`, "edit", "ok"),
    asst(`Done with thing ${n}.`, [], usage),
  ];
}

test("summarizeRequest: request, result, files changed", () => {
  const note = summarizeRequest(request(1, 100));
  assert.equal(note, "request: please change thing 1 in module_1.py; result: Done with thing 1.; files changed: module_1.py");
  assert.match(summarizeRequest([user("what is a tuple?"), asst("An immutable list.")]), /files changed: none$/);
  // a direct workflow's result text can name files too
  assert.match(summarizeRequest([user("add x"), asst("on it", [{ id: "a", name: "add", arguments: {} }]), res("a", "add", "added to a.py\nfiles: a.py, tests/test_a.py\nSTATUS: done")]), /files changed: a\.py, tests\/test_a\.py/);
});

test("below the threshold nothing is folded; over it, ALL finished requests fold at once into one note each, the current request stays intact", () => {
  const c = new Compactor(0.6);
  const win = 10000;
  const m1 = [...request(1, 1500), ...request(2, 3000)];
  assert.equal(c.apply(m1, win), undefined, "30 % of the window: no change");
  const m2 = [...m1, ...request(3, 6500), ...request(4, 7000)]; // the last reply reports 7000 tokens = 70 %
  const out = c.apply(m2, win)!;
  assert.equal(c.batches, 1);
  assert.equal(c.last!.folded, 3, "requests 1-3 fold together");
  assert.equal(c.notes.length, 3);
  // result: one user message holding 3 notes + the current request's text, then its turns exactly as they were
  assert.equal(out.length, 1 + (request(4, 0).length - 1));
  assert.equal(out[0]!.role, "user");
  const text = (out[0]!.content as { text: string }[]).map((p) => p.text).join("");
  assert.equal([...text.matchAll(/^- request: /gm)].length, 3);
  assert.match(text, /request: please change thing 2 in module_2\.py; result: Done with thing 2\.; files changed: module_2\.py/);
  assert.match(text, /please change thing 4 in module_4\.py/);
  assert.deepEqual(out.slice(1), m2.slice(m2.length - 5), "the current request's turns are the same objects");
  assert.ok(contextTokens(out, 0, true) < 0.6 * win);
  assert.ok(c.last!.tokensAfter < c.last!.tokensBefore);
  assert.equal(out.filter((m) => m.role === "user").length, 1, "roles still alternate: no two user messages");
  // the input list is not modified
  assert.equal(m2.length, 24);
});

test("batching: the folded prefix is identical on every later turn, and the next batch is only when the limit is passed again", () => {
  const c = new Compactor(0.6);
  const win = 10000;
  const base = [...request(1, 2000), ...request(2, 7000)];
  const a = c.apply(base, win)!;
  assert.equal(c.batches, 1);
  // the current request goes on (more turns): same head object content, no new batch
  const more = [...base, asst("one more", [], 3500), res("z", "read", "small")];
  const b = c.apply(more, win)!;
  assert.equal(c.batches, 1);
  assert.deepEqual(b[0], a[0], "the head message is byte-identical, so the server's cache prefix holds");
  assert.equal(b.length, a.length + 2);
  // a new request that is still small: still no new batch; the old notes stay in front
  const next = [...more, ...request(3, 3600)];
  const d = c.apply(next, win)!;
  assert.equal(c.batches, 1);
  assert.match(String((d[0]!.content as { text: string }[])[0]!.text), /thing 1/);
  assert.equal(c.apply(next, win)![0]!.content instanceof Array, true);
  // passing the limit again folds what finished since (request 2's current turns and 3), notes accumulate
  const grown = [...next, ...request(4, 6800)];
  const e = c.apply(grown, win)!;
  assert.equal(c.batches, 2);
  assert.equal(c.notes.length, 3, "requests 1, 2 and 3");
  assert.equal(e.length, request(4, 0).length);
});

test("compactAt 0 is off; a single huge current request has nothing to fold; another session resets the state", () => {
  const off = new Compactor(0);
  assert.equal(off.apply([...request(1, 9900), ...request(2, 9900)], 10000), undefined);
  const one = new Compactor(0.6);
  assert.equal(one.apply(request(1, 9900), 10000), undefined);
  const c = new Compactor(0.6);
  assert.ok(c.apply([...request(1, 2000), ...request(2, 7000)], 10000));
  // a different conversation (other messages at the folded index): state is dropped, nothing stale is shown
  const other = [...request(8, 1000), ...request(9, 1200)];
  assert.equal(c.apply(other, 10000), undefined);
  assert.equal(c.notes.length, 0);
});

test("requests / currentStart; contextTokens falls back to an estimate with no usage", () => {
  const ms = [...request(1, 0), ...request(2, 0)];
  assert.equal(requests(ms).length, 2);
  assert.equal(currentStart(ms), 6);
  assert.ok(contextTokens(ms, 400) > 1000);
  assert.equal(contextTokens([...request(1, 123)]), 123);
});
