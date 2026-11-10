import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { guardLine, pyParseError, rewriteFindings, topNames } from "../../src/rewriteguard.ts";
import { DEFAULTS, mergeConfig } from "../../src/config.ts";

const BOWLING = "class Game:\n    def roll(self, pins):\n        pass\n\ndef score(rolls):\n    return 0\n\nasync def later():\n    pass\n";

test("rewrite guard: top-level names by language, methods and other languages skipped", () => {
  assert.deepEqual(topNames(BOWLING, ".py"), ["Game", "score", "later"]);
  assert.deepEqual(topNames("export function a() {}\nclass B {}\nexport const c = 1;\nconst d = () => 0;\n  function inner() {}\nasync function e() {}\nexport default function f() {}\n", ".ts"), ["a", "B", "c", "d", "e", "f"]);
  assert.deepEqual(topNames("fn main() {}\n", ".rs"), []);
});

test("rewrite guard: cut to under half and dropped names are findings; a same-size rewrite keeping every name is none", () => {
  assert.deepEqual(rewriteFindings("bowling.py", BOWLING, "x = 1\n"), ["cut bowling.py from 112 to 6 chars", "dropped Game, score, later"]);
  assert.deepEqual(rewriteFindings("bowling.py", BOWLING, BOWLING.replace("return 0", "return sum(rolls)")), []);
  assert.deepEqual(rewriteFindings("bowling.py", BOWLING, BOWLING.replace("def score(rolls):\n    return 0\n", "def total(rolls):\n    return 0\n")), ["dropped score"]);
  const many = Array.from({ length: 7 }, (_, i) => `def f${i}():\n    pass\n`).join("");
  assert.deepEqual(rewriteFindings("m.py", many, many.replace(/def f\d/g, "def g")), ["dropped f0, f1, f2, f3, f4 (+2)"]);
});

test("rewrite guard: the line names the findings and the way back; no findings keeps C21's line (null)", () => {
  const best = { passed: 28, failed: 3 };
  assert.equal(guardLine(["cut bowling.py from 4210 to 30 chars", "dropped roll, score"], best, true),
    "Whole-file rewrite: cut bowling.py from 4210 to 30 chars; dropped roll, score. Best tree 28/31 pass: restore_best puts it back.");
  assert.equal(guardLine(["dropped roll"], best, false), "Whole-file rewrite: dropped roll. Best tree 28/31 pass.");
  assert.equal(guardLine([], best, true), null);
});

test("rewrite guard: a Python file that no longer parses says so with the line; other files and no interpreter: null", { skip: spawnSync("python3", ["-c", "0"]).status !== 0 && "no python3" }, () => {
  const d = tmpDir("tc-guard-");
  writeFileSync(join(d, "ok.py"), BOWLING);
  writeFileSync(join(d, "bad.py"), "def roll(:\n    pass\n");
  writeFileSync(join(d, "bad.js"), "function (\n");
  assert.equal(pyParseError("python3", join(d, "ok.py")), null);
  assert.equal(pyParseError("python3", join(d, "bad.py")), "does not parse: SyntaxError line 1");
  assert.equal(pyParseError("python3", join(d, "bad.js")), null);
  assert.equal(pyParseError(join(d, "no-such-python"), join(d, "bad.py")), null);
});

test("config: rewriteGuard defaults off (E1, until measured), takes booleans only", () => {
  assert.equal(DEFAULTS.limits.rewriteGuard, false);
  assert.equal(mergeConfig({ limits: { rewriteGuard: true } }).limits.rewriteGuard, true);
  assert.throws(() => mergeConfig({ limits: { rewriteGuard: "yes" } }), /limits\.rewriteGuard: must be true or false/);
});
