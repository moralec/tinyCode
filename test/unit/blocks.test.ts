import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanPath, parseBlocks, parseWholeFiles } from "../../src/protocol/blocks.ts";
import { EDIT_RULES, SYSTEM, TC0_SYSTEM } from "../../src/protocol/prompts.ts";

const blk = (path: string, s: string, r: string) => `${path}\n<<<<<<< SEARCH\n${s}\n=======\n${r}\n>>>>>>> REPLACE`;

test("parses one block", () => {
  assert.deepEqual(parseBlocks(blk("a/b.py", "x = 1", "x = 2")), [{ path: "a/b.py", search: "x = 1", replace: "x = 2" }]);
});

test("path line may be followed by a code fence", () => {
  const r = "pager.py\n```python\n<<<<<<< SEARCH\na\n=======\nb\n>>>>>>> REPLACE\n```";
  assert.equal(parseBlocks(r)[0]!.path, "pager.py");
});

test("cleanPath strips backticks, stars, hashes, spaces and turns backslashes into slashes", () => {
  assert.equal(cleanPath("  ## `src\\a.py` * "), "src/a.py");
});

test("several blocks, prose around them ignored", () => {
  const r = `Here:\n${blk("a.py", "1", "2")}\n\nand\n${blk("b.py", "", "new")}\nDone.`;
  const got = parseBlocks(r);
  assert.deepEqual(got.map((b) => b.path), ["a.py", "b.py"]);
  assert.equal(got[1]!.search, "");
});

test("a CRLF reply parses like an LF one", () => {
  const lf = blk("a.py", "x = 1\ny = 2", "x = 3");
  assert.deepEqual(parseBlocks(lf.replace(/\n/g, "\r\n")), parseBlocks(lf));
});

test("no blocks, no results", () => {
  assert.deepEqual(parseBlocks("I could not find it."), []);
});

test("whole-file fallback parses path + fence, ignores prose fences and blocks", () => {
  const r = "Here you go:\n\n```python\nprint(1)\n```\n\nutil/x.py\n```python\na = 1\nb = 2\n```\n";
  assert.deepEqual(parseWholeFiles(r), [{ path: "util/x.py", content: "a = 1\nb = 2" }]);
  assert.deepEqual(parseWholeFiles(blk("a.py", "1", "2")), []);
});

test("prompts: tc1 rules replace only the tests sentence", () => {
  assert.ok(TC0_SYSTEM.includes("Never edit tests. No explanations."));
  assert.ok(EDIT_RULES.includes("Never edit the given test; add tests only if task asks. No explanations."));
  assert.ok(SYSTEM.endsWith(EDIT_RULES));
  assert.ok(SYSTEM.startsWith("Fix and extend code repos in two steps."));
});

test("cleanPath drops a leading File: / Path: the model echoed from the prompt (doc-2-todo)", () => {
  assert.equal(cleanPath("File: todo/model.py"), "todo/model.py");
  assert.equal(cleanPath("**path:** `a/b.py`"), "a/b.py");
  assert.equal(parseBlocks("File: todo/model.py\n<<<<<<< SEARCH\nclass Task:\n=======\nclass Task:\n    \"\"\"A task.\"\"\"\n>>>>>>> REPLACE")[0]!.path, "todo/model.py");
  assert.equal(cleanPath("profile.py"), "profile.py");
});
