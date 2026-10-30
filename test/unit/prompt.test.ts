import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MEMORY_PROMPT } from "../../src/limits.ts";
import { composePrompt, trimPiDocs } from "../../src/prompt.ts";
import { TOOLS_FIRST_PROMPT, tersePrompt } from "../../src/tools.ts";
import { DEFAULTS, mergeConfig } from "../../src/config.ts";

// A system prompt captured from Pi 1.4.0 (bench/pairs run 20261029-212936 Pi alone, first call).
const PI = readFileSync(new URL("../fixtures/pi-system-prompt.txt", import.meta.url), "utf8");

test("Pi's documentation block is removed by its markers; every other section, including cwd, stays", () => {
  assert.ok(PI.includes("<docs>\nPi documentation") && PI.includes("</docs>"));
  const out = trimPiDocs(PI);
  assert.ok(!out.includes("<docs>") && !out.includes("Pi documentation") && !out.includes("docs/extensions.md"));
  for (const keep of ["<tools>", "</tools>", "<rules>", "</rules>", "<cwd>\n/work/bowling\n</cwd>", "You are an expert coding assistant"]) assert.ok(out.includes(keep), keep);
  assert.ok(out.length < PI.length - 1300, `${PI.length} -> ${out.length}`);
  assert.ok(/<\/rules>\n\n<cwd>/.test(out), "one blank line between the sections that were around the block");
});

test("the custom-tools and PI_* env lines are dropped; the tool list and other rules stay", () => {
  assert.ok(PI.includes("In addition to the tools above") && PI.includes("PI_* environment variables"));
  const out = trimPiDocs(PI);
  assert.ok(!out.includes("In addition to the tools above") && !out.includes("PI_* environment"));
  assert.ok(out.includes("- Use read to examine files") && /<\/tools>/.test(out));
});

test("no docs block, or a prompt in another shape: returned unchanged", () => {
  assert.equal(trimPiDocs("custom prompt\n<cwd>\n/x\n</cwd>"), "custom prompt\n<cwd>\n/x\n</cwd>");
  const odd = "<docs>\nsomething else\n</docs>";
  assert.equal(trimPiDocs(odd), odd);
  assert.ok(trimPiDocs(PI.replace("</docs>", "")).includes("<docs>\nPi documentation"), "an unclosed block is not touched");
  assert.equal(trimPiDocs(""), "");
});

test("composed prompt: trimmed Pi prompt, then the terse line with the path rule, tools-first text and working method; smaller than Pi's own before", () => {
  const out = composePrompt(PI, DEFAULTS.limits.scriptLines);
  assert.ok(out.startsWith("You are an expert coding assistant"));
  assert.ok(out.endsWith(`${tersePrompt(20)}\n${TOOLS_FIRST_PROMPT}\n${MEMORY_PROMPT}`));
  assert.match(tersePrompt(20), /^Reply short\. Max one line before a tool call\. No recap\. Debug script over 20 lines: write a file, run it\. Paths: relative to cwd\.$/);
  assert.match(tersePrompt(35), /over 35 lines/);
  assert.ok(!out.includes("Pi documentation"));
  console.log(`system prompt: Pi's ${PI.length} chars -> trimmed ${trimPiDocs(PI).length}, composed ${out.length}`);
});

test("config: limits.scriptLines, maskAboveTokens and freshFileLines are validated positive integers with named defaults", () => {
  assert.equal(DEFAULTS.limits.scriptLines, 20);
  assert.equal(DEFAULTS.limits.maskAboveTokens, 1500);
  assert.equal(DEFAULTS.limits.freshFileLines, 300);
  for (const k of ["scriptLines", "maskAboveTokens", "freshFileLines"]) {
    assert.throws(() => mergeConfig({ limits: { [k]: 0 } }), new RegExp(k));
    assert.throws(() => mergeConfig({ limits: { [k]: 2.5 } }), new RegExp(k));
    assert.equal((mergeConfig({ limits: { [k]: 7 } }).limits as unknown as Record<string, number>)[k], 7);
  }
});
