// Block paths in tinyCode's own edit-block protocol (src/protocol/apply.ts resolveBlockPath). Nemotron-Nano-9B-v2's
// 8 ladder replies (runs-radar 2026-10-30, test/fixtures/forgive/nemotron-ladder-replies.json) were all addressed to
// `path/to/<file>`, the prompt's old example: every block was "not found".
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { applyReply, resolveBlockPath } from "../../src/protocol/apply.ts";
import { PATH_RULE, SYSTEM, TC0_SYSTEM } from "../../src/protocol/prompts.ts";
import { DOC_RULES } from "../../src/workflows/doc.ts";
import { TEST_SYSTEM } from "../../src/workflows/build.ts";

const block = (path: string, search: string, replace: string) => `${path}\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n`;

function tree(): string {
  const d = tmpDir("tc-blockpath-");
  mkdirSync(join(d, "pkg/sub"), { recursive: true });
  mkdirSync(join(d, "tests"), { recursive: true });
  writeFileSync(join(d, "connect.py"), "class ConnectGame:\n    pass\n");
  writeFileSync(join(d, "connect_test.py"), "# t\n");
  writeFileSync(join(d, "pkg/sub/deep.py"), "x = 1\n");
  writeFileSync(join(d, "pkg/util.py"), "u = 1\n");
  writeFileSync(join(d, "pkg/sub/util.py"), "u = 2\n");
  writeFileSync(join(d, "tests/test_deep.py"), "# t\n");
  return d;
}

test("resolveBlockPath: an existing path stays; `path/to/` is dropped; then the one non-test file with that name", () => {
  const cwd = tree();
  assert.equal(resolveBlockPath(cwd, "connect.py", true), "connect.py");
  assert.equal(resolveBlockPath(cwd, "path/to/connect.py", true), "connect.py");
  assert.equal(resolveBlockPath(cwd, "./path/to/connect.py", true), "connect.py");
  assert.equal(resolveBlockPath(cwd, "path/to/pkg/sub/deep.py", true), "pkg/sub/deep.py");
  assert.equal(resolveBlockPath(cwd, "path/to/deep.py", true), "pkg/sub/deep.py", "by name: exactly one");
  assert.equal(resolveBlockPath(cwd, "src/deep.py", true), "pkg/sub/deep.py", "a wrong directory, same rule");
});

test("resolveBlockPath never guesses: 0 or 2+ files of that name, a test file, a new file", () => {
  const cwd = tree();
  assert.equal(resolveBlockPath(cwd, "path/to/util.py", true), "path/to/util.py", "two util.py");
  assert.equal(resolveBlockPath(cwd, "path/to/nothing.py", true), "path/to/nothing.py", "none");
  assert.equal(resolveBlockPath(cwd, "src/test_deep.py", true), "src/test_deep.py", "a test file is never found by name");
  assert.equal(resolveBlockPath(cwd, "lib/connect_test.py", true), "lib/connect_test.py");
  // a new file (empty SEARCH): only the placeholder is dropped, never a match by name
  assert.equal(resolveBlockPath(cwd, "path/to/new.py", false), "new.py");
  assert.equal(resolveBlockPath(cwd, "lib/deep.py", false), "lib/deep.py");
});

test("applyReply: a placeholder path applies to the real file, logged as path X -> Y; a test file reached that way stays protected", async () => {
  const cwd = tree();
  const log = join(tmpDir("tc-blockpath-log-"), "calls.jsonl");
  const r = await applyReply(block("path/to/connect.py", "class ConnectGame:\n    pass", "class ConnectGame:\n    x = 1"), { cwd, protected: ["connect_test.py"], env: { TINYCODE_LOG: log } });
  assert.deepEqual(r.results, [{ path: "connect.py", from: "path/to/connect.py", kind: "search", ok: true }]);
  assert.equal(readFileSync(join(cwd, "connect.py"), "utf8"), "class ConnectGame:\n    x = 1\n");
  const recs = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(recs.map((x) => [x.step, x.status]), [["path_resolve", "path path/to/connect.py -> connect.py"]]);
  const t = await applyReply(block("path/to/connect_test.py", "# t", "# changed"), { cwd, protected: ["connect_test.py"], env: { TINYCODE_LOG: log } });
  assert.deepEqual(t.results, [{ path: "connect_test.py", from: "path/to/connect_test.py", kind: "search", ok: false, reason: "protected" }]);
  assert.equal(readFileSync(join(cwd, "connect_test.py"), "utf8"), "# t\n");
  // a new file under the placeholder lands at the root, not in path/to/
  const n = await applyReply(block("path/to/new.py", "", "y = 1"), { cwd, protected: [], env: { TINYCODE_LOG: log } });
  assert.equal(n.results[0]!.ok, true);
  assert.ok(existsSync(join(cwd, "new.py")) && !existsSync(join(cwd, "path")));
  // the whole-file fallback resolves like an edit
  const w = await applyReply("path/to/deep.py\n```python\nx = 2\n```\n", { cwd, protected: [], env: { TINYCODE_LOG: log } });
  assert.deepEqual(w.results, [{ path: "pkg/sub/deep.py", kind: "file", ok: true }]);
  assert.equal(readFileSync(join(cwd, "pkg/sub/deep.py"), "utf8"), "x = 2\n");
});

test("prompts: no placeholder path in any edit-block example; the path rule is fixed text in the system prompt", () => {
  for (const p of [TC0_SYSTEM, SYSTEM, DOC_RULES, TEST_SYSTEM]) assert.ok(!p.includes("path/to/"), p.slice(0, 40));
  assert.ok(TC0_SYSTEM.startsWith("Fix Python repos. Reply ONLY edit blocks, one per change, exactly:\n\nshop/cart.py\n<<<<<<< SEARCH\n"));
  assert.ok(SYSTEM.includes(PATH_RULE) && DOC_RULES.includes(PATH_RULE));
  assert.match(TEST_SYSTEM, /^Write the test[^\n]*\n\ntests\/test_cart\.py\n<<<<<<< SEARCH\n/);
});

const FX = JSON.parse(readFileSync(new URL("../fixtures/forgive/nemotron-ladder-replies.json", import.meta.url), "utf8")) as {
  stubs: Record<string, { solution: string; test: string; text: string }>;
  replies: { run: string; task: string; n: number; reply: string }[];
};

test("replay of the 8 recorded Nemotron ladder replies: 6 now apply (were 0); 1 SEARCH not in the file, 1 reply without a REPLACE line", async () => {
  const got: string[] = [];
  for (const r of FX.replies) {
    const s = FX.stubs[r.task]!;
    const cwd = tmpDir("tc-ladder-replay-");
    writeFileSync(join(cwd, s.solution), s.text);
    writeFileSync(join(cwd, s.test), "# tests\n");
    const res = await applyReply(r.reply, { cwd, protected: [s.test], env: { TINYCODE_LOG: join(tmpDir("tc-ladder-log-"), "calls.jsonl") } });
    for (const b of res.results) assert.equal(b.path, s.solution, "every block reaches the solution file");
    got.push(`${r.task} ${r.n}: ${res.results.length ? res.results.map((b) => (b.ok ? "applied" : b.reason)).join(",") : "no blocks"}`);
  }
  assert.deepEqual(got, [
    "connect 1: applied",
    "connect 2: applied",
    "connect 1: applied",
    "connect 2: applied",
    "bowling 1: not found", // SEARCH has lines the stub never had (self.frames = [])
    "bowling 2: applied,applied", // applies; its REPLACE drops the def lines (the reply's own error, the tests judge it)
    "dot-dsl 1: applied",
    "dot-dsl 2: no blocks", // a second ======= and no >>>>>>> REPLACE: not an edit block
  ]);
});
