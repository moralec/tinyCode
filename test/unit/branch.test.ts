import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { ANSWER_SCHEMA, BRANCH_SYSTEM, branchMessages, findAnswer, formatAnswer } from "../../src/branch.ts";
import { DEFAULTS } from "../../src/config.ts";
import type { ChatResult, Message } from "../../src/llm.ts";

test("formatAnswer: json answer + citations; plain text and empty fall back", () => {
  assert.equal(
    formatAnswer(JSON.stringify({ answer: "It is set in config.", citations: ["config/app.ini:3", "uploader/limits.py:9"] })),
    "It is set in config.\n- config/app.ini:3\n- uploader/limits.py:9",
  );
  assert.equal(formatAnswer("not json"), "not json");
  assert.equal(formatAnswer(""), "(branch returned nothing)");
});

test("find: evidence goes to one 'branch' call with the answer schema; only the answer comes back", async () => {
  const d = tmpDir("tinycode-branch-");
  mkdirSync(join(d, "uploader"));
  writeFileSync(join(d, "uploader/limits.py"), "MAX_UPLOAD_MB = 5\n\ndef check(size):\n    return size <= MAX_UPLOAD_MB\n");
  const calls: { step: string; messages: Message[]; schema?: object }[] = [];
  const fake = async (step: string, messages: Message[], o?: { schema?: object }): Promise<ChatResult> => {
    calls.push({ step, messages, schema: o?.schema });
    return {
      text: JSON.stringify({ answer: "In limits.py.", citations: ["uploader/limits.py:1"] }),
      usage: { prompt_tokens: 1, cached_tokens: 0, completion_tokens: 1 },
      ms: 1,
      lane: "small",
      model: "m",
      fellBack: false,
    };
  };
  const out = await findAnswer(d, "where is the upload limit set?", { config: DEFAULTS, chat: fake });
  assert.equal(out, "In limits.py.\n- uploader/limits.py:1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].step, "branch");
  assert.equal(calls[0].schema, ANSWER_SCHEMA);
  assert.equal(calls[0].messages[0].content, BRANCH_SYSTEM);
  assert.match(calls[0].messages[1].content, /uploader\/limits\.py:1: MAX_UPLOAD_MB = 5/);
  assert.match(calls[0].messages[1].content, /Question: where is the upload limit set\?/);
});

test("branchMessages: outline, hits, question in that order", () => {
  const m = branchMessages("q?", { outline: "O", hits: "H" });
  assert.equal(m[1].content, "Outline:\nO\n\nGrep hits:\nH\nQuestion: q?");
});
