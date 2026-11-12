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

test("strictRoles (C20, D5): Mistral-family ids by default; a list of non-empty strings, else refused", () => {
  assert.deepEqual(mergeConfig({}).strictRoles, DEFAULTS.strictRoles);
  assert.deepEqual(DEFAULTS.strictRoles, ["*"]); // public v1.0.4: D5 off until measured
  assert.deepEqual(mergeConfig({ strictRoles: [] }).strictRoles, []);
  assert.deepEqual(mergeConfig({ strictRoles: ["*"] }).strictRoles, ["*"]);
  for (const bad of ["mistral", [""], [3]])
    assert.throws(() => mergeConfig({ strictRoles: bad }), (e: Error) => e instanceof ConfigError && e.message.includes("strictRoles"));
});

test("languages: default [\"py\",\"ts\"] (gate passed, D8); [\"py\"] turns ts off; an unknown entry or a missing \"py\" is an error", () => {
  assert.deepEqual(DEFAULTS.languages, ["py", "ts"]);
  assert.deepEqual(mergeConfig({ languages: ["py"] }).languages, ["py"]);
  assert.throws(() => mergeConfig({ languages: ["py", "go"] }), (e: unknown) => e instanceof ConfigError && /languages/.test((e as Error).message));
  assert.throws(() => mergeConfig({ languages: ["ts"] }), /includes "py"/);
  assert.throws(() => mergeConfig({ languages: "py" }), /languages/);
});

test("research.localFirst and research.grounded (design research-grounding): booleans, off by default", () => {
  assert.equal(DEFAULTS.research.localFirst, false);
  assert.equal(DEFAULTS.research.grounded, false);
  assert.throws(() => mergeConfig({ research: { localFirst: "yes" } }), (e: Error) => e instanceof ConfigError && /research\.localFirst: must be true or false/.test(e.message));
  assert.throws(() => mergeConfig({ research: { grounded: 1 } }), (e: Error) => e instanceof ConfigError && /research\.grounded: must be true or false/.test(e.message));
  const c = mergeConfig({ research: { localFirst: true, grounded: true } });
  assert.equal(c.research.localFirst, true);
  assert.equal(c.research.grounded, true);
});

test("stages (plan-build-fit E21a, E21b, E25): planReview on by default (E21a accepted 2026-11-12), the rest off; validated with the key named", () => {
  const c = mergeConfig({});
  assert.deepEqual(c.stages, { planReview: true, buildChecks: false, planReadChars: 8000, wholeCheck: false });
  assert.throws(() => mergeConfig({ stages: { planReview: "yes" } }), (e: Error) => e instanceof ConfigError && e.message.includes("stages.planReview"));
  assert.throws(() => mergeConfig({ stages: { buildChecks: "yes" } }), (e: Error) => e instanceof ConfigError && e.message.includes("stages.buildChecks"));
  assert.throws(() => mergeConfig({ stages: { buildChecks: 1 } }), /stages\.buildChecks: must be true or false/);
  assert.equal(mergeConfig({ stages: { buildChecks: true } }).stages.buildChecks, true);
  assert.equal(mergeConfig({ stages: { buildChecks: true } }).stages.planReview, true, "one switch does not change the other: planReview stays at its default");
  assert.equal(mergeConfig({ stages: { planReview: false, buildChecks: true } }).stages.planReview, false);
  assert.throws(() => mergeConfig({ stages: { wholeCheck: 1 } }), (e: Error) => e instanceof ConfigError && e.message.includes("stages.wholeCheck"));
  assert.throws(() => mergeConfig({ stages: { planReadChars: 999 } }), (e: Error) => e instanceof ConfigError && e.message.includes("stages.planReadChars"));
  assert.throws(() => mergeConfig({ stages: { planReadChars: 1500.5 } }), /stages\.planReadChars/);
  assert.equal(mergeConfig({ stages: { planReview: true, planReadChars: 1000, wholeCheck: true } }).stages.planReadChars, 1000);
});

test("loop guards 2: every key off by default and validated", () => {
  const bools = ["stepBackKeepsMasks", "retirePlan", "startOver"] as const;
  for (const k of bools) {
    assert.equal(DEFAULTS.limits[k], false, `${k} off`);
    assert.equal(mergeConfig({ limits: { [k]: true } }).limits[k], true);
    assert.throws(() => mergeConfig({ limits: { [k]: 1 } }), new RegExp(`limits\\.${k}`));
  }
  const ints = ["freshServeLines", "bashTestSeconds", "bashMaxLines", "writeMaxLines"] as const;
  for (const k of ints) {
    assert.equal(DEFAULTS.limits[k], 0, `${k} off`);
    assert.equal(mergeConfig({ limits: { [k]: 150 } }).limits[k], 150);
    for (const bad of [-1, 1.5, "40", null]) assert.throws(() => mergeConfig({ limits: { [k]: bad } }), new RegExp(`limits\\.${k}`));
  }
  assert.equal(DEFAULTS.limits.testTimeScale, 0);
  assert.equal(mergeConfig({ limits: { testTimeScale: 2.5 } }).limits.testTimeScale, 2.5);
  for (const bad of [-1, "10", null, Infinity]) assert.throws(() => mergeConfig({ limits: { testTimeScale: bad } }), /limits\.testTimeScale/);
});
