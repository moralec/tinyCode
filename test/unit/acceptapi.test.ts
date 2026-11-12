import { test } from "node:test";
import assert from "node:assert/strict";
import { loadAcceptanceModule } from "../../src/workflows/acceptapi.ts";

test("/build finds the check runner (acceptapi.loadAcceptanceModule)", async () => {
  const m = await loadAcceptanceModule();
  assert.ok(m, "src/acceptance.ts should load");
  assert.equal(typeof m.run, "function");
  const run = await m.run({ checks: [] }, { cwd: process.cwd(), python: "python3", stepSeconds: 5 });
  assert.equal(run.total, 0);
});
