import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mergeConfig } from "../../src/config.ts";
import { confirmFor, explicitlyAsked, isDev, parseDevArgs, setMode, stuckConfirmFor, type ConfirmCtx } from "../../src/mode.ts";

afterEach(() => setMode("auto"));

function ctx(hasUI = true) {
  const asked: string[] = [];
  const c: ConfirmCtx = { hasUI, ui: { confirm: async (_t, q) => (asked.push(q), true) } };
  return { c, asked };
}

test("config: mode defaults to auto and rejects anything else", () => {
  assert.equal(mergeConfig({}).mode, "auto");
  assert.equal(mergeConfig({ mode: "dev" }).mode, "dev");
  assert.throws(() => mergeConfig({ mode: "loud" }), /mode/);
});

test("auto never calls ctx.ui.confirm for stuck; dev does", async () => {
  const { c, asked } = ctx();
  assert.equal(stuckConfirmFor(c), undefined);
  setMode("dev");
  const f = stuckConfirmFor(c)!;
  assert.equal(await f(25), true);
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, /25 calls/);
  assert.equal(stuckConfirmFor(ctx(false).c), undefined, "no UI, nothing to ask");
});

test("irreversible actions confirm only when not explicitly requested (auto)", async () => {
  const { c, asked } = ctx();
  const explicit = confirmFor(c, { kind: "commit", explicit: true })!;
  assert.equal(await explicit("commit?"), true);
  assert.equal(asked.length, 0, "explicit ask proceeds without a question");
  const implicit = confirmFor(c, { kind: "commit", explicit: false })!;
  await implicit("commit?");
  assert.deepEqual(asked, ["commit?"]);
  assert.equal(confirmFor(ctx(false).c, { kind: "git-init", explicit: false }), undefined, "no UI to ask");
});

test("routine questions never ask in auto (proceed, or stay absent); dev asks", async () => {
  const { c, asked } = ctx();
  assert.equal(await confirmFor(c)!("hand to /fix?"), true);
  assert.equal(confirmFor(c, { dflt: false }), undefined);
  assert.equal(asked.length, 0);
  setMode("dev");
  await confirmFor(c)!("hand to /fix?");
  assert.deepEqual(asked, ["hand to /fix?"]);
  await confirmFor(c, { kind: "commit", explicit: true })!("commit?");
  assert.equal(asked.length, 2, "dev asks even when explicit");
});

test("explicitlyAsked: the user's own words", () => {
  assert.ok(explicitlyAsked("commit", "ok, commit this please"));
  assert.ok(!explicitlyAsked("commit", "add a habit tracker"));
  assert.ok(explicitlyAsked("git-init", "run git init first"));
  assert.ok(explicitlyAsked("readme-rewrite", "rewrite the README"));
  assert.ok(!explicitlyAsked("readme-rewrite", "fix the bug in parse"));
  assert.ok(explicitlyAsked("delete", "delete the old tests"));
});

test("/dev toggles: on, off, bare toggles, junk is rejected", () => {
  assert.equal(parseDevArgs("on"), "dev");
  assert.equal(parseDevArgs("off"), "auto");
  assert.equal(parseDevArgs("maybe"), null);
  setMode("dev");
  assert.equal(isDev(), true);
  assert.equal(parseDevArgs(""), "auto");
  setMode("auto");
  assert.equal(parseDevArgs(""), "dev");
});
