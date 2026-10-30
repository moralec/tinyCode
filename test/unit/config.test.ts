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

test("trunk lane output cap defaults to 4096; the edit step is not below it", () => {
  const c = mergeConfig({});
  assert.equal(c.lanes.trunk?.maxTokens, 4096);
  assert.ok(c.limits.maxTokens.edit >= 4096);
  assert.throws(() => mergeConfig({ lanes: { trunk: { maxTokens: 0 } } }), /lanes\.trunk\.maxTokens/);
});

test("limits.compactAt: default 0.6, 0 turns it off, out of range is refused", () => {
  assert.equal(mergeConfig({}).limits.compactAt, 0.6);
  assert.equal(mergeConfig({ limits: { compactAt: 0 } }).limits.compactAt, 0);
  assert.throws(() => mergeConfig({ limits: { compactAt: 1.5 } }), /limits\.compactAt/);
});

test("limits.pressureAt and maskArgChars: defaults and validation", async () => {
  const { mergeConfig, DEFAULTS, ConfigError } = await import("../../src/config.ts");
  assert.equal(DEFAULTS.limits.pressureAt, 0.7);
  assert.equal(DEFAULTS.limits.maskArgChars, 400);
  assert.equal(mergeConfig({ limits: { pressureAt: 0 } }).limits.pressureAt, 0);
  assert.throws(() => mergeConfig({ limits: { pressureAt: 1.5 } }), ConfigError);
  assert.throws(() => mergeConfig({ limits: { maskArgChars: 0 } }), ConfigError);
});

test("lane temperature (0-2) and seed (integer) are validated", () => {
  const lane = (x: object) => ({ lanes: { trunk: { baseUrl: "http://x/v1", model: "m", ...x } } });
  const c = mergeConfig(lane({ temperature: 0.3, seed: 42 }));
  assert.equal(c.lanes.trunk!.temperature, 0.3);
  assert.equal(c.lanes.trunk!.seed, 42);
  assert.equal(DEFAULTS.lanes.trunk!.temperature, undefined);
  assert.equal(DEFAULTS.lanes.trunk!.seed, undefined);
  mergeConfig(lane({ temperature: 0 }));
  mergeConfig(lane({ temperature: 2 }));
  assert.throws(() => mergeConfig(lane({ temperature: -0.1 })), /lanes\.trunk\.temperature/);
  assert.throws(() => mergeConfig(lane({ temperature: 2.5 })), /lanes\.trunk\.temperature/);
  assert.throws(() => mergeConfig(lane({ temperature: "hot" })), /lanes\.trunk\.temperature/);
  assert.throws(() => mergeConfig(lane({ seed: 1.5 })), /lanes\.trunk\.seed/);
});
