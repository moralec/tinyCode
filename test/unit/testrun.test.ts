import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runTests, testCommand, trimTestOutput } from "../../src/testrun.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PY = (process.env.TINYCODE_TEST_PYTHON ?? "python3");
const R201 = join(ROOT, "test/fixtures/task-repos/r2-01-orders-monthly");

test("trimTestOutput: PASS line and FAIL block", () => {
  assert.deepEqual(trimTestOutput("..\n2 passed in 0.01s\n", 0), { ok: true, text: "PASS 2 passed in 0.01s" });
  const out = [
    "F", "=== FAILURES ===", "def test_x():", ">       assert f() == 1", "E       assert 2 == 1",
    "tests/test_a.py:4: AssertionError", "=== short test summary info ===",
    "FAILED tests/test_a.py::test_x - assert 2 == 1", "1 failed in 0.02s",
  ].join("\n");
  const r = trimTestOutput(out, 1);
  assert.equal(r.ok, false);
  assert.match(r.text, /^FAIL 1 failed in 0.02s\nFAILED tests\/test_a.py::test_x/);
  assert.match(r.text, /First error:\n/);
  assert.ok(trimTestOutput("x".repeat(9000) + "\nError: boom", 1).text.length <= 3200);
});

test("testCommand: config command wins; default is python -m pytest", () => {
  assert.equal(testCommand({ python: "python3", command: "npm test" }), "npm test");
  assert.equal(testCommand({ python: "python3", command: null }, "tests/t.py"), "python3 -m pytest -q -p no:cacheprovider tests/t.py");
  assert.match(testCommand({ python: "C:\\Program Files\\Py\\python.exe", command: null }), /^"C:\\Program Files/);
});

test("runTests on r2-01: FAIL naming tests/test_task.py", { skip: !existsSync(R201) || !existsSync(PY) }, async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "tinycode-tr-")), "repo");
  cpSync(R201, dir, { recursive: true });
  const r = await runTests({ cwd: dir, config: { python: PY, command: null } });
  assert.equal(r.ok, false);
  assert.match(r.text, /^FAIL/);
  assert.match(r.text, /tests\/test_task\.py/);
});

test("runTests: shell command, exit code, and timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tinycode-tr-"));
  writeFileSync(join(dir, "ok.js"), "console.log('1 passed in 0.01s')");
  const ok = await runTests({ cwd: dir, config: { python: "x", command: `"${process.execPath}" ok.js` } });
  assert.equal(ok.ok, true);
  assert.equal(ok.text, "PASS 1 passed in 0.01s");
  writeFileSync(join(dir, "slow.js"), "setTimeout(()=>{}, 60000)");
  const slow = await runTests({ cwd: dir, config: { python: "x", command: `"${process.execPath}" slow.js` }, timeoutMs: 400 });
  assert.equal(slow.timedOut, true);
  assert.match(slow.text, /^FAIL tests timed out/);
});
