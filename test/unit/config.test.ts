import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, mergeConfig, loadConfig, ConfigError } from "../../src/config.ts";

test("defaults validate and are untouched by merge", () => {
  const c = mergeConfig({});
  assert.deepEqual(c, DEFAULTS);
  mergeConfig({ lanes: { cloud: { baseUrl: "http://x/v1", model: "m" } } });
  assert.equal(DEFAULTS.lanes.cloud, null);
});

test("deep merge keeps sibling keys", () => {
  const c = mergeConfig({ limits: { turnCap: 5, maxTokens: { edit: 10 } }, steps: { pick: { lane: "small" } } });
  assert.equal(c.limits.turnCap, 5);
  assert.equal(c.limits.maxTokens.edit, 10);
  assert.equal(c.limits.maxTokens.pick, 300);
  assert.equal(c.steps.pick.lane, "small");
  assert.equal(c.steps.pick.fallback, null);
  assert.equal(c.limits.viewLines, 100);
});

test("unknown lane error names the key", () => {
  assert.throws(() => mergeConfig({ steps: { edit: { lane: "nope" } } }), (e: Error) => e instanceof ConfigError && e.message.includes("steps.edit.lane"));
  assert.throws(() => mergeConfig({ steps: { hunk: { fallback: "ghost" } } }), /steps\.hunk\.fallback/);
});

test("null lane cannot be referenced; malformed lane named", () => {
  assert.throws(() => mergeConfig({ steps: { route: { fallback: "cloud" } } }), /steps\.route\.fallback.*null/);
  assert.throws(() => mergeConfig({ lanes: { trunk: { baseUrl: "" } } }), /lanes\.trunk/);
});

test("loadConfig: missing file gives defaults; bad JSON errors", () => {
  assert.deepEqual(loadConfig({ TINYCODE_CONFIG: "/nonexistent/tc.json" }), DEFAULTS);
  assert.throws(() => loadConfig({ TINYCODE_CONFIG: new URL(import.meta.url).pathname }), ConfigError);
});
