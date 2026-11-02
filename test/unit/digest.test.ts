import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { test } from "node:test";
import { contextFileLimit, digestKey, makeSummarize, outline, sections, shrinkContextFiles, type Summarize } from "../../src/context/digest.ts";
import type { Message } from "../../src/llm.ts";
import { tmpDir } from "./tmpdir.ts";

const RULES = [
  "# Project rules",
  "Some history about how this started, long ago, in prose nobody needs every call.",
  "## Commands",
  "- Run tests with `make test`.",
  "- Never push to main.",
  "```sh",
  "echo inside a fence",
  "```",
  "You must keep line length under 100.",
  "Plain prose again that is neither a rule nor a list item.",
].join("\n");
const BIG = `${RULES}\n${"Filler prose line that repeats and repeats without any rule in it.\n".repeat(400)}`;
const prompt = (content: string, path = "/w/CLAUDE.md") =>
  `head\n\nProject-specific instructions and guidelines:\n\n<project_instructions path="${path}">\n${content}\n</project_instructions>\n\n<cwd>\n/w\n</cwd>`;
const settle = () => new Promise((r) => setTimeout(r, 20));

test("outline keeps headings, list items and rule lines; drops fenced code and plain prose", () => {
  const o = outline(RULES, 10_000);
  for (const keep of ["# Project rules", "## Commands", "- Run tests with `make test`.", "- Never push to main.", "You must keep line length under 100."])
    assert.ok(o.includes(keep), keep);
  for (const drop of ["Some history", "echo inside a fence", "Plain prose again"]) assert.ok(!o.includes(drop), drop);
});

test("outline stops at its budget with a cut marker", () => {
  const o = outline(Array.from({ length: 200 }, (_, i) => `- rule number ${i}`).join("\n"), 300);
  assert.ok(o.length <= 300 + "\n[…cut]".length && o.endsWith("[…cut]"), o);
});

test("a context file under the limit, or the feature off, leaves the prompt unchanged", () => {
  const dir = tmpDir("digest-");
  const small = prompt(RULES);
  assert.deepEqual(shrinkContextFiles(small, { maxTokens: 1500, charsPerToken: 2.6, dir }), { prompt: small, shrunk: [] });
  const big = prompt(BIG);
  assert.equal(shrinkContextFiles(big, { maxTokens: 0, charsPerToken: 2.6, dir }).prompt, big);
});

test("a big file: outline at once, one background digest (even across two requests), then the digest is used", async () => {
  const dir = tmpDir("digest-");
  const calls: string[] = [];
  const done: Array<[string, boolean]> = [];
  const summarize: Summarize = async (path) => {
    calls.push(path);
    return "- tests: make test\n- never push main\n- line length < 100";
  };
  const pending = new Set<string>();
  const opts = { maxTokens: 200, charsPerToken: 2.6, dir, summarize, pending, onDigest: (p: string, ok: boolean) => done.push([p, ok]) };
  const first = shrinkContextFiles(prompt(BIG), opts);
  assert.equal(first.shrunk[0].kind, "outline");
  assert.ok(first.prompt.includes("[tinyCode outline of /w/CLAUDE.md:") && first.prompt.includes("- Never push to main."));
  assert.ok(!first.prompt.includes("Filler prose") && first.prompt.includes("<cwd>\n/w\n</cwd>"), "the rest of the prompt stays");
  shrinkContextFiles(prompt(BIG), opts);   // a second request before the digest is back
  await settle();
  assert.deepEqual(calls, ["/w/CLAUDE.md"], "summarised once");
  assert.deepEqual(done, [["/w/CLAUDE.md", true]]);
  const later = shrinkContextFiles(prompt(BIG), opts);
  assert.equal(later.shrunk[0].kind, "digest");
  assert.ok(later.prompt.includes("- never push main") && later.shrunk[0].toTokens < later.shrunk[0].fromTokens / 20, JSON.stringify(later.shrunk));
});

test("a changed file gets a new digest; a failed or useless digest leaves the outline and writes nothing", async () => {
  const dir = tmpDir("digest-");
  assert.notEqual(digestKey(BIG, 520), digestKey(`${BIG}x`, 520));
  assert.notEqual(digestKey(BIG, 520), digestKey(BIG, 4000), "a bigger window gets its own, bigger digest");
  const done: Array<[boolean, string]> = [];
  const onDigest = (_p: string, ok: boolean, d: string) => done.push([ok, d]);
  shrinkContextFiles(prompt(BIG), { maxTokens: 200, charsPerToken: 2.6, dir, onDigest, summarize: async () => { throw new Error("400 model not served"); } });
  shrinkContextFiles(prompt(`${BIG}x`), { maxTokens: 200, charsPerToken: 2.6, dir, onDigest, summarize: async () => "" });
  await settle();
  assert.deepEqual(done.map((d) => d[0]), [false, false]);
  assert.ok(done[0][1].includes("400 model not served"));
  assert.ok(!existsSync(dir) || readdirSync(dir).length === 0, "no digest file");
  assert.equal(shrinkContextFiles(prompt(BIG), { maxTokens: 200, charsPerToken: 2.6, dir }).shrunk[0].kind, "outline");
});

test("the limit is a share of the window with a floor; floor 0 turns it off", () => {
  assert.equal(contextFileLimit(1500, 0.05, 16384), 1500);
  assert.equal(contextFileLimit(1500, 0.05, 32768), 1638);
  assert.equal(contextFileLimit(1500, 0.05, 131072), 6554);
  assert.equal(contextFileLimit(0, 0.05, 131072), 0);
});

test("sections split at headings within the size; makeSummarize calls in order, then one reduce when still long", async () => {
  const md = ["# A", "a ".repeat(200), "# B", "b ".repeat(200), "# C", "c ".repeat(200)].join("\n");
  const parts = sections(md, 500);
  assert.equal(parts.length, 3);
  assert.ok(parts.every((p) => p.length <= 500) && parts[1].startsWith("# B"));
  const seen: Message[][] = [];
  const chat = async (m: Message[]) => {
    seen.push(m);
    return seen.length <= 3 ? "word ".repeat(100) : "- merged";
  };
  const out = await makeSummarize(chat, 500)("/w/AGENTS.md", md, 60);
  assert.equal(out, "- merged");
  assert.equal(seen.length, 4, "three parts + one reduce");
  assert.ok(seen[0][1].content.includes("part 1 of 3") && seen[3][1].content.startsWith("Digest notes of /w/AGENTS.md"));
  assert.ok(seen[0][0].content.includes("pidgin English"));
});
