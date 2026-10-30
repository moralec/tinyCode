// /test <task>: "write tests for X". Tests only; never code. Follows add.ts and explain.ts.
//   Code finds X (explain.ts's findTarget), detects the test framework (pytest, unittest, node:test, jest, vitest,
//   from config files and the tests already there), gathers X with its callers and callees (explain.ts's gather) and
//   the existing tests -> ONE call writes the tests as SEARCH/REPLACE blocks -> code enforces "test files only"
//   (blocks for any other path are dropped before applying; after applying, every non-test file is compared with
//   what it was and put back if it changed; an existing test file may only grow) -> code runs the tests.
//   Normal mode: new tests must pass on the current code. A failure that looks like a behaviour mismatch is reported
//   as "tests failing on current code: possible bug" with the failure; the code is never touched and the test never
//   weakened. A failure for the test's own reasons (import error, wrong fixture) gets ONE retry. `--expect-fail`:
//   the tests must fail. Coverage delta only when pytest-cov is already installed; nothing is ever installed.
//   Pure logic with injected dependencies; pure Node (no Unix tools).
import { NOOP_PROGRESS, type Progress } from "../progress.ts";
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, posix, sep } from "node:path";
import type { Config } from "../config.ts";
import { repoFiles } from "../context/outline.ts";
import { trackedFiles } from "../context/evidence.ts";
import { execShell, lintPass, type ExecFn, type LintOptions } from "../lint.ts";
import type { Message } from "../llm.ts";
import { applyBlocks } from "../protocol/apply.ts";
import { parseBlocks } from "../protocol/blocks.ts";
import { EDIT_RULES, TESTS_RULE } from "../protocol/prompts.ts";
import { runTests as realRunTests, testCommand, type TestRun } from "../testrun.ts";
import { isTestPath } from "./add.ts";
import { isCachePath } from "./cachefiles.ts";
import { viewText } from "./edit.ts";
import { findTarget, gather, type Target } from "./explain.ts";
import type { ChatFn } from "./fix.ts";

export type Framework = "pytest" | "unittest" | "node:test" | "jest" | "vitest";

export const TEST_RULES =
  EDIT_RULES.replace(TESTS_RULE, "") +
  "\n\nWrite tests for existing code. Edit test files only: never the code under test. Assert INTENDED behaviour " +
  "(from request, function name, docstring, callers), not what the code returns today: odd behaviour (repeated " +
  "separators, empty result, off-by-one): assert what it should do, even if the test fails. Cover normal cases, edge " +
  "cases, bad input. Use the framework named in the task and the style of existing tests. New test file: empty SEARCH; " +
  "existing test file: add after its last test with an anchor of a few existing lines repeated in REPLACE; never change " +
  "or remove an existing test. Never weaken an assertion to pass.";

export interface TestGenArgs {
  /** the code under test (else found from the task) */
  file?: string;
  /** where the new tests go (else the existing test file for the target, else a new one by convention) */
  test?: string;
  /** the tests must fail on the current code */
  expectFail: boolean;
  /** put the tests in a new file of their own (`..._repro`), so only they run: used for /fix's reproduction */
  fresh?: boolean;
  task: string;
}

/** `[--file PATH] [--test PATH] [--expect-fail] <task>`: flags from the front only. */
export function parseTestArgs(raw: string): TestGenArgs {
  let rest = raw.trim();
  const out: TestGenArgs = { expectFail: false, task: "" };
  for (;;) {
    const ef = rest.match(/^--expect-fail\s*/);
    if (ef) {
      out.expectFail = true;
      rest = rest.slice(ef[0].length);
      continue;
    }
    const m = rest.match(/^--(test|file)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))\s*/);
    if (!m) break;
    out[m[1] as "test" | "file"] = m[2] ?? m[3] ?? m[4]!;
    rest = rest.slice(m[0].length);
  }
  out.task = rest.trim();
  return out;
}

const normpath = (p: string): string => normalize(p).split(sep).join("/").split("\\").join("/");

function readText(cwd: string, p: string): string | null {
  try {
    if (statSync(join(cwd, p)).size > 400_000) return null;
    return readFileSync(join(cwd, p), "utf8");
  } catch {
    return null;
  }
}

const isPy = (p: string) => /\.pyi?$/.test(p);
const isJs = (p: string) => /\.(js|jsx|ts|tsx|mjs|cjs|mts|cts)$/.test(p);

export interface FrameworkInfo {
  name: Framework;
  /** what decided it, for the report */
  why: string;
}

/** Test files of the repo (by name), the ones that mention the target first. */
export function existingTests(cwd: string, target: string, files = repoFiles(cwd)): string[] {
  const stem = basename(target, extname(target));
  const sym = new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const tests = files.filter((f) => isTestPath(f) && (isPy(f) ? isPy(target) : isJs(f) && isJs(target)));
  const named = tests.filter((f) => basename(f).toLowerCase().includes(stem.toLowerCase()));
  const mention = tests.filter((f) => !named.includes(f) && sym.test(readText(cwd, f) ?? ""));
  return [...named, ...mention].slice(0, 3);
}

/** The framework from config files, then from the tests that exist; null for a language we have no routine for. */
export function detectFramework(cwd: string, target: string, files = repoFiles(cwd)): FrameworkInfo | null {
  const tests = files.filter((f) => isTestPath(f));
  const has = (n: string) => existsSync(join(cwd, n));
  if (isPy(target)) {
    const pyproject = readText(cwd, "pyproject.toml") ?? "";
    const cfgs = [readText(cwd, "tox.ini") ?? "", readText(cwd, "setup.cfg") ?? ""].join("\n");
    if (has("pytest.ini") || has("conftest.py") || /^\s*\[tool\.pytest/m.test(pyproject) || /^\s*\[(tool:)?pytest\]/m.test(cfgs)) {
      return { name: "pytest", why: "pytest config" };
    }
    let usesPytest = 0;
    let usesUnittest = 0;
    for (const f of tests.filter(isPy)) {
      const t = readText(cwd, f) ?? "";
      if (/^\s*(import pytest|from pytest\b)|^def test_/m.test(t)) usesPytest++;
      else if (/unittest\.TestCase|^\s*(import unittest|from unittest\b)/m.test(t)) usesUnittest++;
    }
    if (usesUnittest > usesPytest) return { name: "unittest", why: "existing tests use unittest" };
    return { name: "pytest", why: usesPytest ? "existing tests use pytest" : "default for Python" };
  }
  if (isJs(target)) {
    let pkg: { dependencies?: object; devDependencies?: object; scripts?: Record<string, string> } = {};
    try {
      pkg = JSON.parse(readText(cwd, "package.json") ?? "{}");
    } catch {
      pkg = {};
    }
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) } as Record<string, unknown>;
    const script = pkg.scripts?.test ?? "";
    const anyCfg = (stem: string) => files.some((f) => !f.includes("/") && f.startsWith(stem + "."));
    if ("vitest" in deps || anyCfg("vitest.config") || /\bvitest\b/.test(script)) return { name: "vitest", why: "vitest in package.json or config" };
    if ("jest" in deps || anyCfg("jest.config") || /\bjest\b/.test(script)) return { name: "jest", why: "jest in package.json or config" };
    if (/node\s+--test/.test(script)) return { name: "node:test", why: "scripts.test runs node --test" };
    for (const f of tests.filter(isJs)) {
      const t = readText(cwd, f) ?? "";
      if (/from\s+['"]node:test['"]|require\(['"]node:test['"]\)/.test(t)) return { name: "node:test", why: "existing tests import node:test" };
      if (/from\s+['"]vitest['"]/.test(t)) return { name: "vitest", why: "existing tests import vitest" };
      if (/\b(describe|it|test)\s*\(/.test(t) && !/node:test/.test(t)) return { name: "jest", why: "existing tests use describe/it globals" };
    }
    return { name: "node:test", why: "default for JavaScript" };
  }
  return null;
}

const q = (s: string) => (/[\s"&|<>^()]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

/** The command that runs one test file with the framework (a configured `test.command` wins, as in testrun.ts). */
export function frameworkCommand(fw: Framework, cfg: Config["test"], testFile: string): string {
  if (cfg.command) return cfg.command;
  switch (fw) {
    case "pytest":
      return testCommand(cfg, testFile);
    case "unittest":
      return `${q(cfg.python)} -m unittest ${q(testFile)}`;
    case "node:test":
      return `node --test ${q(testFile)}`;
    case "jest":
      return `npx jest ${q(testFile)}`;
    case "vitest":
      return `npx vitest run ${q(testFile)}`;
  }
}

/** Where new tests go when no test file exists for the target. */
export function newTestPath(target: string): string {
  const stem = basename(target, extname(target));
  if (isPy(target)) return `tests/test_${stem}.py`;
  return posix.join(posix.dirname(target) === "." ? "" : posix.dirname(target), `${stem}.test${extname(target).replace(/^\.(ts|tsx|mts|cts)$/, ".ts")}`);
}

export type FailKind = "own" | "mismatch";

const OWN =
  /ModuleNotFoundError|ImportError|cannot import name|NameError|SyntaxError|IndentationError|fixture '[^']*' not found|ERROR collecting|errors? during collection|no tests ran|has no attribute '(?!.*\bobject\b)|takes \d+ positional arguments? but|missing \d+ required (positional|keyword)|unexpected keyword argument|Cannot find module|ERR_MODULE_NOT_FOUND|ReferenceError|is not defined|is not a function|Unexpected token|Failed to resolve import|No test suite found|timed out/i;

/** Own reasons (the test is broken) or a behaviour mismatch (the test ran and the code did something else). */
export function classifyFailure(text: string): FailKind {
  return OWN.test(text) ? "own" : "mismatch";
}

/** A file of its own beside where the target's tests would go: `tests/test_x_repro.py`, `x.repro.test.ts`. */
export function reproTestPath(target: string): string {
  const p = newTestPath(target);
  return isPy(target) ? p.replace(/\.py$/, "_repro.py") : p.replace(/\.test(\.\w+)$/, ".repro.test$1");
}

/** Names on `FAILED`/`ERROR` lines of trimmed pytest output. */
const failingNames = (text: string): string[] => [...new Set(text.split("\n").filter((l) => /^(FAILED|ERROR) /.test(l)).map((l) => l.replace(/\s+-\s.*$/, "")))];

/** The phases /test reports. */
export const TEST_PHASES = ["find target", "baseline", "write tests", "run tests", "retry", "lint"];

export interface TestGenDeps {
  progress?: Progress;
  cwd: string;
  config: Config;
  chat: ChatFn;
  report: (line: string) => void;
  env?: Record<string, string | undefined>;
  runTests?: typeof realRunTests;
  lint?: Pick<LintOptions, "exec" | "find">;
  /** runs coverage probes and coverage commands (default: real shell) */
  exec?: ExecFn;
}

export type TestGenOutcome = "pass" | "possible-bug" | "expected-fail" | "unexpected-pass" | "broken" | "not-applied" | "no-target" | "usage";

export interface TestGenResult {
  ok: boolean;
  outcome: TestGenOutcome;
  calls: number;
  target: string | null;
  framework: Framework | null;
  testFile: string | null;
  /** test files written and kept */
  files: string[];
  retried: boolean;
  /** `[before, after]` percent for the target, only when pytest-cov was already installed */
  coverage: [number, number] | null;
  lines: string[];
}

/** Everything that is not a test file, as it is now: path -> text. */
function codeSnapshot(cwd: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of trackedFiles(cwd).concat(repoFiles(cwd))) {
    if (isTestPath(f) || isCachePath(f) || m.has(f)) continue;
    const t = readText(cwd, f);
    if (t !== null) m.set(f, t);
  }
  return m;
}

/** Put back any non-test file that changed, was removed, or appeared; returns the paths touched. */
function guardCode(cwd: string, before: Map<string, string>): string[] {
  const bad: string[] = [];
  const now = new Map<string, string>();
  for (const f of repoFiles(cwd)) {
    if (isTestPath(f) || isCachePath(f)) continue;
    const t = readText(cwd, f);
    if (t !== null) now.set(f, t);
  }
  for (const [f, t] of before) {
    if (now.get(f) !== t) {
      writeFileSync(join(cwd, f), t);
      bad.push(f);
    }
  }
  for (const f of now.keys()) {
    if (!before.has(f)) {
      rmSync(join(cwd, f), { force: true });
      bad.push(f);
    }
  }
  return bad;
}

/** True when every non-blank line of `orig` is still there in order: the file only grew. */
export function onlyGrew(orig: string, next: string): boolean {
  const have = next.split(/\r?\n/);
  let i = 0;
  for (const l of orig.split(/\r?\n/)) {
    if (!l.trim()) continue;
    while (i < have.length && have[i] !== l) i++;
    if (i >= have.length) return false;
    i++;
  }
  return true;
}

/** Keep only the edit blocks whose path is a test file (and not the code under test); rebuild the reply. */
export function testBlocksOnly(reply: string, target: string): { reply: string; kept: string[]; refused: string[] } {
  const kept: string[] = [];
  const refused: string[] = [];
  let out = "";
  for (const b of parseBlocks(reply)) {
    if (isTestPath(b.path) && b.path !== target && !isAbsolute(b.path)) {
      kept.push(b.path);
      out += `${b.path}\n<<<<<<< SEARCH\n${b.search}\n=======\n${b.replace}\n>>>>>>> REPLACE\n\n`;
    } else refused.push(b.path);
  }
  return { reply: out, kept, refused };
}

/** The "Intended behaviour:" statements the model wrote before its edit blocks (plain `- ` lines). */
export function parseIntended(reply: string): string[] {
  const head = reply.split(/^[^\n]*\n<<<<<<< SEARCH/m)[0] ?? "";
  const m = head.match(/intended behaviou?r:?\s*\n([\s\S]*)$/i);
  if (!m) return [];
  return m[1]!.split("\n").map((l) => l.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim()).filter((l) => l && !/^```/.test(l)).slice(0, 12);
}

/** Added assert lines that pass only because they mirror a suspicious output; each entry is the assertion text. */
export function suspiciousAsserts(added: string[]): string[] {
  const out: string[] = [];
  for (const raw of added) {
    const l = raw.trim();
    if (!/^(assert\b|self\.assert|expect\(|assert\w*\()/.test(l) && !/\b(assert|expect)\b/.test(l)) continue;
    const str = [...l.matchAll(/(["'])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]!);
    // expected side: after == / toBe / toEqual / assertEqual's last argument
    const rhs = l.split(/==|\btoBe\(|\btoEqual\(|\btoStrictEqual\(|,\s*(?=["'\[{(\d-]|None)/).slice(-1)[0] ?? "";
    const lits = [...rhs.matchAll(/(["'])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]!);
    const repeated = lits.some((x) => /([^\w\s])\1{1,}|([-_ ])\2{2,}/.test(x) || /[A-Za-z0-9]([-_.])\1+[A-Za-z0-9]/.test(x) || /^[-_]|[-_]$/.test(x) && x.length > 1);
    const emptyRes = /(==|toBe\(|toEqual\(|,)\s*(""|''|\[\]|\{\}|None|null|0)\s*\)?\s*$/.test(l) && str.some((x) => x.trim().length > 0) && /\(\s*["'\[{\d]/.test(l);
    const offByOne = /\blen\([^)]*\)\s*[+-]\s*1\b/.test(rhs);
    if (repeated || emptyRes || offByOne) out.push(l);
  }
  return out;
}

const COV_LINE = (file: string) => new RegExp(`^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+\\d+\\s+\\d+\\s+(\\d+)%`, "m");

export async function runTestGen(args: TestGenArgs, deps: TestGenDeps): Promise<TestGenResult> {
  const { cwd, config: cfg } = deps;
  const env = deps.env ?? process.env;
  const run = deps.runTests ?? realRunTests;
  const exec = deps.exec ?? execShell;
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    deps.report(l);
  };
  const pg = deps.progress ?? NOOP_PROGRESS;
  pg.step("find target");
  let calls = 0;
  let retried = false;
  const written = new Set<string>();
  const res = (ok: boolean, outcome: TestGenOutcome, target: string | null, framework: Framework | null, testFile: string | null, coverage: [number, number] | null = null): TestGenResult => ({
    ok,
    outcome,
    calls,
    target,
    framework,
    testFile,
    files: [...written],
    retried,
    coverage,
    lines,
  });
  if (!args.task && !args.file) {
    say("usage: /test [--file PATH] [--test PATH] [--expect-fail] <what to write tests for>");
    return res(false, "usage", null, null, null);
  }
  const task = args.task || `write tests for ${args.file}`;
  const target = findTarget(cwd, { file: args.file, question: task });
  if (!target) {
    say(`/test: no file or symbol found for ${JSON.stringify(task.slice(0, 60))}; name a file or a function (or use --file PATH)`);
    return res(false, "no-target", null, null, null);
  }
  const fw = detectFramework(cwd, target.file);
  if (!fw) {
    say(`/test: no test routine for ${extname(target.file) || target.file} files (pytest, unittest, node:test, jest and vitest are supported)`);
    return res(false, "no-target", target.file, null, null);
  }
  const existing = existingTests(cwd, target.file);
  const testFile = args.test ? normpath(args.test) : args.fresh ? reproTestPath(target.file) : (existing[0] ?? newTestPath(target.file));
  const isNew = readText(cwd, testFile) === null;
  say(`target: ${target.file}${target.line ? `:${target.line}` : ""}${target.symbol ? ` (${target.symbol})` : ""}; framework: ${fw.name} (${fw.why}); tests: ${testFile}${isNew ? " (new file)" : ""}`);
  const command = frameworkCommand(fw.name, cfg.test, testFile);
  const runCfg = { python: cfg.test.python, command };
  const runIt = (): Promise<TestRun> => run({ cwd, test: testFile, config: runCfg });

  // ---- coverage (only when pytest-cov is already importable; nothing is installed)
  let covAvailable = false;
  if (fw.name === "pytest" && !cfg.test.command) {
    covAvailable = (await exec(`${q(cfg.test.python)} -c "import pytest_cov"`, cwd)).code === 0;
  }
  const coverage = async (files: string[]): Promise<number | null> => {
    if (!covAvailable) return null;
    const cmd = `${q(cfg.test.python)} -m pytest -q -p no:cacheprovider --cov=${q(dirname(target.file) === "." ? "." : dirname(target.file))} --cov-report=term ${files.map(q).join(" ")}`;
    const r = await exec(cmd, cwd);
    const m = r.out.match(COV_LINE(target.file));
    return m ? Number(m[1]) : null;
  };
  const covBefore = covAvailable ? (existing.length || !isNew ? await coverage(isNew ? existing : [testFile, ...existing.filter((e) => e !== testFile)]) : 0) : null;

  // ---- baseline: do the tests that are already in the file pass?
  let baseline: TestRun | null = null;
  if (!isNew) {
    pg.step("baseline");
    baseline = await runIt();
    if (!baseline.ok) {
      const names = failingNames(baseline.text);
      say(`${names.length} tests were already failing before /test${names.length ? `: ${names.join(", ")}` : ""}`);
    }
  }

  // ---- one call writes the tests
  const origs = new Map<string, string | null>();
  const codeBefore = codeSnapshot(cwd);
  const g = gather(cwd, target as Target, task);
  const parts = [g.text];
  const tp = readText(cwd, testFile);
  if (tp !== null) parts.push(`Existing tests ${testFile} (add to it, keep what is there):\n\`\`\`\n${viewText(tp, task, cfg.limits.viewLines)}\`\`\``);
  for (const e of existing.filter((x) => x !== testFile).slice(0, 1)) parts.push(`Another test file for style, ${e}:\n\`\`\`\n${viewText(readText(cwd, e) ?? "", task, cfg.limits.viewLines)}\`\`\``);
  const rel = posix.relative(posix.dirname(testFile), target.file);
  const mode = args.expectFail
    ? "Task describes behaviour the code lacks: assert that behaviour; tests are expected to fail on current code."
    : "Assert intended behaviour; if the code differs the test fails, reported as possible bug, never weakened.";
  const instruction =
    `Task: ${task}\nTest framework: ${fw.name}. Write tests in ${testFile}${isNew ? " (new file)" : " (exists; add to it)"}. ` +
    `Code under test: ${target.file}${isJs(target.file) ? ` (import it from ${rel.startsWith(".") ? rel : "./" + rel})` : ""}. ${mode}\n\n` +
    "First line `Intended behaviour:`, under it 2-6 plain statements (each starting `- `) of what the code should do, from the request, function name, docstring, callers (not from what the code does today). " +
    "Then edit blocks. Tests must encode those statements.";

  /** Apply a reply under the test-files-only rules; returns the test paths written. */
  const applyGuarded = async (reply: string): Promise<string[]> => {
    const f = testBlocksOnly(reply, target.file);
    if (f.refused.length) say(`refused (not a test file): ${JSON.stringify(f.refused)}`);
    for (const p of f.kept) if (!origs.has(p)) origs.set(p, readText(cwd, p));
    const r = await applyBlocks(f.reply, { cwd, protected: [] });
    if (r.failed.length) say(`not applied: ${JSON.stringify(r.failed)}`);
    const bad = guardCode(cwd, codeBefore);
    if (bad.length) say(`refused: code files changed by the edit were put back: ${JSON.stringify(bad)}`);
    const ok: string[] = [];
    for (const p of r.applied) {
      const o = origs.get(p);
      const now = readText(cwd, p);
      if (o !== null && o !== undefined && now !== null && !onlyGrew(o, now)) {
        writeFileSync(join(cwd, p), o);
        say(`refused: ${p} lost lines that were already there (tests are only added, never changed); put back`);
        continue;
      }
      ok.push(p);
      written.add(p);
    }
    return ok;
  };
  const revert = () => {
    for (const p of written) {
      const o = origs.get(p);
      if (o === null || o === undefined) rmSync(join(cwd, p), { force: true });
      else writeFileSync(join(cwd, p), o);
    }
    written.clear();
  };
  const call = async (content: string): Promise<string> => {
    calls++;
    return (await deps.chat("edit", [{ role: "system", content: TEST_RULES }, { role: "user", content }] as Message[], { workflow: "test", config: cfg, env })).text;
  };

  pg.step("write tests");
  const firstReply = await call(`${parts.join("\n\n")}\n\n${instruction}`);
  const intended = parseIntended(firstReply);
  if (intended.length) say(`intended behaviour:\n${intended.map((i) => `  - ${i}`).join("\n")}`);
  let applied = await applyGuarded(firstReply);
  say(`applied: ${JSON.stringify(applied)}`);
  if (!applied.length) {
    say("/test: no test could be applied; nothing was changed");
    return res(false, "not-applied", target.file, fw.name, testFile);
  }

  for (const p of written) pg.touch(p);
  pg.step("run tests");
  let t = await runIt();
  say(`tests ${testFile}: ${t.ok ? "pass" : "fail"}`);
  if (!t.ok && classifyFailure(t.text) === "own") {
    // one retry for the test's own failure: fix the test, not its claims
    retried = true;
    pg.step("retry");
    say("the test failed for its own reasons (not a behaviour mismatch): one retry");
    const cur = readText(cwd, testFile) ?? "";
    const reply = await call(
      `${g.text}\n\nCurrent ${testFile}:\n\`\`\`\n${viewText(cur, task, cfg.limits.viewLines)}\`\`\`\n\nRunning it gave:\n${t.text}\n\n` +
        `Test file itself is broken (import, fixture or syntax). Fix only ${testFile}. Not the code under test; not what an assertion expects.\n\nEdit blocks only.`,
    );
    applied = await applyGuarded(reply);
    say(`retry applied: ${JSON.stringify(applied)}`);
    t = await runIt();
    say(`tests ${testFile}: ${t.ok ? "pass" : "fail"}`);
  }
  const kind = t.ok ? null : classifyFailure(t.text);
  // failures that were already there before /test are not the new tests' doing
  const before = new Set(baseline ? failingNames(baseline.text) : []);
  const newFails = failingNames(t.text).filter((n) => !before.has(n));
  const onlyOld = !t.ok && baseline !== null && !baseline.ok && failingNames(t.text).length > 0 && newFails.length === 0;

  /** tests added by this run that only pass by mirroring a suspicious output */
  const lockIns = (): string[] => {
    if (t.ok === false && !onlyOld) return []; // a failing new test is the signal itself
    const added: string[] = [];
    for (const p of written) {
      const o = origs.get(p);
      const old = new Set((o ?? "").split(/\r?\n/));
      for (const l of (readText(cwd, p) ?? "").split(/\r?\n/)) if (!old.has(l)) added.push(l);
    }
    return suspiciousAsserts(added);
  };
  const flagLockIns = (): void => {
    for (const a of lockIns()) say(`this test may lock in a bug: ${a}`);
  };

  if (kind === "own") {
    revert();
    say(`the tests could not be made to run, so they were not kept (${testFile} is as it was). ${t.text.split("\n").slice(0, 8).join("\n")}`);
    say(`calls: ${calls}`);
    return res(false, "broken", target.file, fw.name, testFile);
  }
  if (args.expectFail) {
    if (t.ok) {
      say("expected the new tests to fail on the current code (--expect-fail), but they pass: they do not catch the behaviour described");
      say(`calls: ${calls}`);
      return res(false, "unexpected-pass", target.file, fw.name, testFile);
    }
    say("tests fail on current code, as expected (--expect-fail):");
    say(t.text);
    say(`kept: ${[...written].join(", ")}`);
    say(`calls: ${calls}`);
    return res(true, "expected-fail", target.file, fw.name, testFile);
  }
  if (!t.ok && !onlyOld) {
    say("tests failing on current code: possible bug");
    say("The code was not changed and the tests were not weakened; the failing test is kept so you can look at it:");
    say(t.text);
    say(`kept: ${[...written].join(", ")}`);
    say(`calls: ${calls}`);
    return res(false, "possible-bug", target.file, fw.name, testFile);
  }
  if (onlyOld) say("the new tests add no failures; the failures listed above were there before");
  if (!args.expectFail) flagLockIns();

  pg.step("lint");
  await lintPass(
    { cwd, files: [...written], env },
    { report: say, lint: deps.lint, verify: async () => (await runIt()).ok || onlyOld },
  );
  let cov: [number, number] | null = null;
  if (covAvailable) {
    const after = await coverage([testFile, ...existing.filter((e) => e !== testFile)]);
    if (covBefore !== null && after !== null) {
      cov = [covBefore, after];
      say(`coverage of ${target.file}: ${covBefore}% -> ${after}%`);
    } else say("coverage: pytest-cov is installed but the report had no line for the target");
  } else say("coverage: not reported (no coverage tooling installed; none was installed)");
  say(`tests added: ${[...written].join(", ")}`);
  say(`calls: ${calls}`);
  return res(true, "pass", target.file, fw.name, testFile, cov);
}
