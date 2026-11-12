// Run the project's tests and trim the output for a small model. Port of ladder.run_test:
// PASS + summary line, or FAIL + summary + failing names + the first error block, at most 3200 chars.
// Which command runs is checkFor's rule (design docs/designs/languages-and-oracles/design.md §1): the configured
// command, pytest for Python, the project's own `npm test` for JS/TS with "ts" in languages, or "none" with a reason.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { repoFiles } from "./context/outline.ts";

export const TEST_CHARS = 3200;

export interface TestConfig {
  python: string;
  command: string | null;
}
/** Test counts read from a runner's summary; failed includes errors. */
export interface TestCounts {
  passed: number;
  failed: number;
}
export interface TestRun {
  ok: boolean;
  /** set when no check could be run (checkFor's reason); nothing was spawned */
  none?: string;
  /** which runner produced the output (absent = pytest, as from a test double) */
  runner?: Runner;
  /** counts from the runner's summary, when they could be read (absent = unknown) */
  counts?: TestCounts | null;
  /** the trimmed text the model sees, starting `PASS` or `FAIL` */
  text: string;
  /** the runner's whole output (absent when a test double gives none); `failureBlocks` reads it */
  raw?: string;
  code: number | null;
  timedOut: boolean;
  /** wall-clock milliseconds of the run (absent: nothing was spawned, or a test double) */
  ms?: number;
}

/**
 * Passed / failed counts from a runner's summary line (pure): pytest `4 failed, 6 passed in 0.5s`, jest and vitest
 * `Tests: 4 failed, 6 passed, 10 total`, unittest `Ran 10 tests` + `FAILED (failures=4)` / `OK`. null = not recognised.
 */
export function parseCounts(output: string, runner: Runner = "pytest"): TestCounts | null {
  if (isJsRunner(runner)) return jsCounts(output, runner);
  const lines = output.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (/^\s*Tests:\s/.test(l) && /\btotal\b/.test(l)) {
      const n = (w: string) => Number(l.match(new RegExp(`(\\d+) ${w}`))?.[1] ?? 0);
      return { passed: n("passed"), failed: n("failed") };
    }
    if (/\b(passed|failed|errors?)\b/.test(l) && /\bin [\d.]+s\b/.test(l)) {
      const n = (w: string) => Number(l.match(new RegExp(`(\\d+) ${w}\\b`))?.[1] ?? 0);
      return { passed: n("passed"), failed: n("failed") + n("errors?") };
    }
  }
  const ran = output.match(/^Ran (\d+) tests? in /m);
  if (ran) {
    const bad = output.match(/^FAILED \((.*)\)/m);
    const failed = bad ? [...bad[1]!.matchAll(/(?:failures|errors)=(\d+)/g)].reduce((s, m) => s + Number(m[1]), 0) : 0;
    return { passed: Math.max(0, Number(ran[1]) - failed), failed };
  }
  return null;
}

/** Trim raw test output (pure; unit-tested without running anything). pytest and custom commands: today's rules. */
export function trimTestOutput(output: string, code: number | null, runner: Runner = "pytest"): { ok: boolean; text: string } {
  if (isJsRunner(runner)) return jsTrim(output, code, runner);
  const lines = output.split("\n");
  let summary = "";
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/\b(passed|failed|error)\b/.test(lines[i]) && /in [\d.]+s/.test(lines[i])) {
      summary = lines[i];
      break;
    }
  }
  if (code === 0) return { ok: true, text: "PASS " + summary };
  const failing = lines.filter((l) => /^(FAILED|ERROR) /.test(l)).map((l) => l.slice(0, 200));
  const first = lines.findIndex((l) => /^E\s|.*(Error|error:)/.test(l));
  const start = Math.max(0, first - 4);
  const block = first >= 0 ? lines.slice(start, start + 12) : lines.slice(-12);
  const text = `FAIL ${summary}\n${failing.join("\n")}\nFirst error:\n${block.join("\n")}`;
  return { ok: false, text: text.slice(0, TEST_CHARS) };
}

/** Names of the failing tests in a trimmed test text (`FAILED path::name - msg` lines): at most `max`, and how many failed lines there were. */
export function failingNames(text: string, max: number): { names: string[]; total: number } {
  const all = text
    .split("\n")
    .map((l) => l.match(/^(?:FAILED|ERROR) (.+?)(?: - .*)?$/)?.[1]?.trim())
    .filter((n): n is string => !!n)
    // pytest names are `path::name`; other runners' names have no path (indexOf -1 used to cut their first letter)
    .map((n) => (n.includes("::") ? n.slice(n.indexOf("::") + 2) : n));
  return { names: all.slice(0, max), total: all.length };
}

/** The first `E ...` line of a test text (the assertion message of the first failing test), at most 200 chars; null when there is none. */
export function firstErrorLine(text: string): string | null {
  const m = text.match(/^E\s+(.+)$/m);
  return m ? m[1]!.trim().slice(0, 200) : null;
}

/**
 * Per failing test, the lines pytest prints for it in the raw output: its header, the `>` line (the failing statement),
 * the `E` lines and the `file.py:N: Error` location line. At most `maxBlocks` blocks of `maxLines` lines each; "" when
 * the output has no such sections (another runner).
 */
export function failureBlocks(raw: string, maxBlocks: number, maxLines: number, runner: Runner = "pytest"): string {
  if (isJsRunner(runner)) return jsBlocks(raw, runner).slice(0, maxBlocks).map((b) => b.slice(0, maxLines).join("\n")).join("\n\n");
  const lines = raw.split("\n");
  const blocks: string[] = [];
  let cur: string[] | null = null;
  const flush = () => {
    if (cur && cur.length > 1) blocks.push(cur.slice(0, maxLines).join("\n"));
    cur = null;
  };
  for (const l of lines) {
    const h = l.match(/^_{3,} (.+?) _{3,}$/);
    if (h) {
      flush();
      cur = [h[1]!];
    } else if (/^={3,} /.test(l)) flush();
    else if (cur && (/^>/.test(l) || /^E(\s|$)/.test(l) || /^\S+:\d+: \w/.test(l))) cur.push(l.slice(0, 200));
  }
  flush();
  return blocks.slice(0, maxBlocks).join("\n\n");
}

// ---------------------------------------------------------------- jest, vitest, node:test (design §2)

/** The runners checkFor can pick. "custom" = a configured test.command; "npm" = a test script whose runner is not one of the three. */
export type Runner = "custom" | "pytest" | "jest" | "vitest" | "node:test" | "npm";
const JS_RUNNERS: ReadonlySet<Runner> = new Set(["jest", "vitest", "node:test", "npm"]);
const isJsRunner = (r: Runner): boolean => JS_RUNNERS.has(r);
/** The forms tried for a runner; "npm" (runner unknown) tries all of them, in this order. */
type Form = "jest" | "vitest" | "node-spec" | "node-tap";
const formsOf = (r: Runner): Form[] => (r === "jest" ? ["jest"] : r === "vitest" ? ["vitest"] : r === "node:test" ? ["node-spec", "node-tap"] : ["jest", "vitest", "node-spec", "node-tap"]);
/** Shown in place of counts when no form matched: pass or fail then comes from the exit code alone. */
export const NOT_RECOGNISED = "(test output not recognised: pass/fail from exit code only)";
const JS_TAIL_LINES = 12;
const JS_MAX_NAMES = 20;
const ERROR_LINE = /\b(?:Expected|Received)\b|Error\b/;

/** One form's summary line: jest `Tests: …`, vitest `Tests  N failed | M passed (T)`, node:test the `ℹ`/`#` tests, pass and fail lines joined. */
function formSummary(lines: string[], f: Form): string {
  if (f === "jest") return lines.find((l) => /^\s*Tests:\s/.test(l))?.trim() ?? "";
  if (f === "vitest") return lines.find((l) => /^\s*Tests\s{2,}\d/.test(l))?.trim() ?? "";
  const mark = f === "node-spec" ? "ℹ" : "#";
  const pick = (w: string) => lines.find((l) => l.startsWith(`${mark} ${w} `)) ?? "";
  const parts = ["tests", "pass", "fail"].map(pick).filter(Boolean);
  return parts.length === 3 ? parts.join(" ") : "";
}

function formCounts(text: string, f: Form): TestCounts | null {
  // the kept text starts `PASS <summary>` / `FAIL <summary>`: read the summary behind the word too
  const lines = text.split("\n").map((l) => l.replace(/^(?:PASS|FAIL) /, ""));
  if (f === "jest") {
    const t = lines.find((l) => /^\s*Tests:\s/.test(l) && /\btotal\b/.test(l));
    if (!t) return null;
    const n = (l: string, w: string) => Number(l.match(new RegExp(`(\\d+) ${w}`))?.[1] ?? 0);
    const counts = { passed: n(t, "passed"), failed: n(t, "failed") };
    // a suite that fails to load adds no failed test ("Tests: 0 total", or only the other suites' passes): with no
    // failed test, its failed suites are the failures, so a broken file never reads as all green (better(): green wins)
    const suites = lines.find((l) => /^\s*Test Suites:\s/.test(l));
    if (suites && counts.failed === 0) counts.failed = n(suites, "failed");
    return counts;
  }
  if (f === "vitest") {
    const t = lines.find((l) => /^\s*Tests\s{2,}\d/.test(l));
    const files = lines.find((l) => /^\s*Test Files\s{2,}\d/.test(l));
    if (!t && !files) return null;
    const n = (l: string | undefined, w: string) => Number(l?.match(new RegExp(`(\\d+) ${w}`))?.[1] ?? 0);
    const counts = { passed: n(t, "passed"), failed: n(t, "failed") };
    if (counts.failed === 0) counts.failed = n(files, "failed");
    return counts;
  }
  const mark = f === "node-spec" ? "ℹ" : "#";
  const pass = text.match(new RegExp(`(?:^|\\s)${mark} pass (\\d+)`));
  const fail = text.match(new RegExp(`(?:^|\\s)${mark} fail (\\d+)`));
  return pass && fail ? { passed: Number(pass[1]), failed: Number(fail[1]) } : null;
}

function jsCounts(text: string, runner: Runner): TestCounts | null {
  for (const f of formsOf(runner)) {
    const c = formCounts(text, f);
    if (c) return c;
  }
  return null;
}

/** node:test TAP: true when the `not ok` at `i` is a suite (its own YAML says type 'suite'), whose failing tests are listed on their own. */
function tapSuite(lines: string[], i: number): boolean {
  for (let j = i + 1; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j]!); j++) if (/^\s*type: 'suite'/.test(lines[j]!)) return true;
  return false;
}

/** The failing tests of one form, each as [name, its block of lines]. */
function formFailures(raw: string, f: Form): [string, string[]][] {
  const lines = raw.split("\n");
  const out: [string, string[]][] = [];
  const blockFrom = (i: number, end: (l: string) => boolean): string[] => {
    const b: string[] = [];
    for (let j = i; j < lines.length && (j === i || !end(lines[j]!)); j++) if (lines[j]!.trim()) b.push(lines[j]!.slice(0, 200));
    return b;
  };
  if (f === "jest") {
    lines.forEach((l, i) => {
      const m = l.match(/^\s*● (.+)$/);
      if (m) out.push([m[1]!.trim(), blockFrom(i, (x) => /^\s*●/.test(x) || /^\s*(?:Test Suites|Tests):\s/.test(x))]);
    });
  } else if (f === "vitest") {
    lines.forEach((l, i) => {
      const m = l.match(/^\s*FAIL\s+\S+ > (.+)$/);
      if (m) out.push([m[1]!.trim(), blockFrom(i, (x) => /^\s*FAIL\s/.test(x) || /^⎯/.test(x) || /^\s*Test Files\s/.test(x))]);
    });
    // the run's `×` lines name the same tests; a name seen only there still counts
    for (const l of lines) {
      const m = l.match(/^\s*× (.+?)(?: \d+(?:\.\d+)?m?s)?$/);
      if (m && !out.some(([n]) => n === m[1]!.trim())) out.push([m[1]!.trim(), [l.trim()]]);
    }
  } else if (f === "node-spec") {
    const at = lines.findIndex((l) => /^✖ failing tests:/.test(l));
    if (at >= 0)
      for (let i = at + 1; i < lines.length; i++) {
        const m = lines[i]!.match(/^✖ (.+?)(?: \([\d.]+ms\))?$/);
        if (m) out.push([m[1]!.trim(), blockFrom(i, (x) => /^✖ /.test(x) || /^test at /.test(x))]);
      }
  } else {
    lines.forEach((l, i) => {
      const m = l.match(/^\s*not ok \d+ - (.+)$/);
      if (m && !tapSuite(lines, i)) out.push([m[1]!.trim(), blockFrom(i, (x) => /^\s*\.\.\.\s*$/.test(x))]);
    });
  }
  return out;
}

function jsFailures(raw: string, runner: Runner): [string, string[]][] {
  for (const f of formsOf(runner)) {
    const got = formFailures(raw, f);
    if (got.length) return got;
  }
  return [];
}

function jsBlocks(raw: string, runner: Runner): string[][] {
  return jsFailures(raw, runner).map(([, b]) => b);
}

/**
 * The kept text for jest, vitest, node:test and npm: `FAIL <summary>`, a `FAILED <name>` line per failing test and an
 * `E   <first error>` line (the shapes failingNames and firstErrorLine already read), then the first failure block.
 * Output no form recognises keeps its last lines and says so.
 */
function jsTrim(output: string, code: number | null, runner: Runner): { ok: boolean; text: string } {
  const lines = output.split("\n");
  const ok = code === 0;
  const form = formsOf(runner).find((f) => formCounts(output, f) || formFailures(output, f).length);
  if (!form) return { ok, text: `${ok ? "PASS" : "FAIL"} \n${lines.slice(-JS_TAIL_LINES).join("\n")}\n${NOT_RECOGNISED}`.slice(0, TEST_CHARS) };
  const summary = formSummary(lines, form);
  if (ok) return { ok, text: `PASS ${summary}` };
  const fails = formFailures(output, form);
  const block = fails[0]?.[1] ?? [];
  const err = block.slice(1).find((l) => ERROR_LINE.test(l))?.trim().slice(0, 200);
  const text = [
    `FAIL ${summary}`,
    ...fails.slice(0, JS_MAX_NAMES).map(([n]) => `FAILED ${n}`),
    ...(err ? [`E   ${err}`] : []),
    "First error:",
    ...block.slice(0, JS_TAIL_LINES),
  ].join("\n");
  return { ok, text: text.slice(0, TEST_CHARS) };
}

/**
 * One shell word. POSIX: plain when it holds only safe characters, else single-quoted, so $(), backticks, ";" and "|"
 * in a test path stay text (security audit 2026-11-09; the model's fix `test` argument and repo file names reach here).
 * Windows (cmd.exe): double-quoted when it holds a space, a quote or a cmd metacharacter.
 */
export function shellQuote(s: string, win = process.platform === "win32"): string {
  if (win) return /[\s"&|<>^()%!]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;
}
const quote = (s: string) => shellQuote(s);

/** The command line to run: `test.command` as written, else `<python> -m pytest -q -p no:cacheprovider [test]`. */
export function testCommand(cfg: TestConfig, test?: string): string {
  if (cfg.command) return cfg.command;
  return [quote(cfg.python), "-m", "pytest", "-q", "-p", "no:cacheprovider", ...(test ? [quote(test)] : [])].join(" ");
}

// ---------------------------------------------------------------- which check runs (design §1.1)

/** What checkFor decided: a command to run in `dir` (relative to cwd), or why none can run. */
export type Check = { runner: Runner; command: string; dir: string; note?: string } | { none: string };
/** The languages tinyCode treats as its own (config `languages`); Python is always on. */
export const DEFAULT_LANGS: readonly string[] = ["py"];
const JS_TEST = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/** npm init's placeholder: a script, but not a test */
const NPM_PLACEHOLDER = /no test specified/;
const WATCH = /--watch(?:All)?\b/;
const CHAINED = /&&|;|\|/;
const SUITE = "npm test --silent";

export const noScript = (from: string): string => `no test command found: no package.json with a "test" script between ${from} and the repo root; set test.command`;
export const NOT_TS = 'no test command found: this is a JavaScript/TypeScript project (package.json) and "ts" is not in languages; add it, or set test.command';
export const notInstalled = (runner: string, dir: string): string => `${runner} is not installed in ${dir} (no node_modules/.bin/${runner}); run npm install there, or set test.command`;

/** `{test}` in a configured command: the quoted test path, or (no test) nothing, with the space before it. */
export function fill(command: string, test: string | undefined): string {
  return test ? command.split("{test}").join(quote(test)) : command.replace(/\s*\{test\}/g, "");
}

/** The `test` script of `dir/package.json` when it is a real, non-watching test script; null otherwise. */
function testScript(cwd: string, dir: string): string | null {
  let pkg: { scripts?: Record<string, unknown> };
  try {
    pkg = JSON.parse(readFileSync(join(cwd, dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const t = pkg.scripts?.test;
  return typeof t === "string" && t.trim() && !NPM_PLACEHOLDER.test(t) && !WATCH.test(t) ? t.trim() : null;
}

/** The runner a test script calls: its first word (jest, vitest) or `node --test`; "npm" when it is none of them. */
export function scriptRunner(script: string): Runner {
  const first = script.split(/\s+/)[0];
  if (first === "jest") return "jest";
  if (first === "vitest") return "vitest";
  if (/^node\s+(?:\S+\s+)*--test\b/.test(script)) return "node:test";
  return "npm";
}

/** vitest's subcommands: words after `vitest` that are not files */
const VITEST_SUB = new Set(["run", "watch", "dev", "related", "bench"]);
/**
 * Does the script already name what to run (`jest ./*`, `node --test test/`)? Then one more path runs that test twice
 * and doubles its counts (affine-cipher on the TS gate: 14/16 read as 28/32, so a later 16/16 looked worse and the end
 * restore put the failing tree back). A word that is not a flag, after the runner, and not a flag's value; a glob or
 * `./` word counts even after a flag (`jest --ci ./*`).
 */
export function namesTargets(script: string): boolean {
  const words = script.split(/\s+/).slice(1);
  return words.some((w, i) => {
    if (w.startsWith("-") || VITEST_SUB.has(w)) return false;
    const prev = words[i - 1];
    return /[*]|^\.\/|\/$/.test(w) || !prev || !prev.startsWith("-") || prev.includes("=") || prev === "--test";
  });
}

/**
 * The check to run, by the first rule that applies (design §1.1): 1 a configured command; 2 pytest for a .py test;
 * 3 with "ts" on, the nearest package.json test script above a JS/TS test (or at the root for the whole suite);
 * 4 a JS/TS-only repo with "ts" off: none; 5 pytest, as always before.
 */
export function checkFor(cwd: string, test: string | undefined, langs: readonly string[], cfg: TestConfig): Check {
  if (cfg.command) return { runner: "custom", command: fill(cfg.command, test), dir: "." };
  if (test?.endsWith(".py")) return { runner: "pytest", command: testCommand(cfg, test), dir: "." };
  const rootPkg = existsSync(join(cwd, "package.json"));
  if (langs.includes("ts") && (test ? JS_TEST.test(test) : rootPkg)) {
    const from = test ? posix.dirname(test.replace(/\\/g, "/")) : ".";
    let dir = from;
    let script = testScript(cwd, dir);
    while (!script && dir !== ".") {
      dir = posix.dirname(dir);
      script = testScript(cwd, dir);
    }
    if (!script) return { none: noScript(from) };
    const runner = scriptRunner(script);
    if ((runner === "jest" || runner === "vitest") && !existsSync(join(cwd, dir, "node_modules", ".bin", runner))) return { none: notInstalled(runner, dir) };
    if (!test) return { runner, command: SUITE, dir };
    if (runner === "npm" || CHAINED.test(script))
      return { runner, command: SUITE, dir, note: "ran the whole suite: the test script does more than call one runner" };
    if (namesTargets(script))
      return { runner, command: SUITE, dir, note: "ran the whole suite: the test script names its own files" };
    const rel = relative(join(cwd, dir), join(cwd, test)).replace(/\\/g, "/");
    return { runner, command: `${SUITE} -- ${runner === "jest" ? "--runTestsByPath " : ""}${quote(rel)}`, dir };
  }
  if (!langs.includes("ts") && rootPkg && !repoFiles(cwd).some((f) => f.endsWith(".py"))) return { none: NOT_TS };
  return { runner: "pytest", command: testCommand(cfg, test), dir: "." };
}

/** Why no check can run here (checkFor's reason), or null when one can. Workflows ask before their first model call. */
export function noCheck(cwd: string, test: string | undefined, langs: readonly string[], cfg: TestConfig): string | null {
  const c = checkFor(cwd, test, langs, cfg);
  return "none" in c ? c.none : null;
}

export function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/**
 * The environment for jest, vitest and node:test: no colour (FORCE_COLOR makes jest and vitest colour piped output,
 * and the readers need plain lines), and no NODE_TEST_CONTEXT, which a tinyCode run started under `node --test` would
 * pass on, making a nested `node --test` report to that parent instead of printing its summary.
 */
function jsEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" };
  delete env.NODE_TEST_CONTEXT;
  return env;
}

export function runTests(opts: {
  cwd: string;
  test?: string;
  config: TestConfig;
  timeoutMs?: number;
  /** config `languages`; default Python only */
  langs?: readonly string[];
}): Promise<TestRun> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  const check = checkFor(opts.cwd, opts.test, opts.langs ?? DEFAULT_LANGS, opts.config);
  if ("none" in check) return Promise.resolve({ ok: false, none: check.none, text: `FAIL ${check.none}`, counts: null, code: null, timedOut: false });
  const { runner, command, dir } = check;
  const js = isJsRunner(runner);
  // what ran, for the model (design §1.4); pytest and configured commands keep today's text
  const ran = js ? `\n(ran: ${command} in ${dir}${check.note ? `; ${check.note}` : ""})` : "";
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: join(opts.cwd, dir),
      ...(js ? { env: jsEnv() } : {}),
      shell: true,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => chunks.push(d));
    let timedOut = false;
    let done = false;
    const started = Date.now();
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const ms = Date.now() - started;
      const out = Buffer.concat(chunks).toString("utf8").replace(/\r\n/g, "\n");
      if (timedOut) {
        resolve({ ok: false, text: `FAIL tests timed out after ${Math.round(timeoutMs / 1000)}s\n${out.split("\n").slice(-12).join("\n")}`.slice(0, TEST_CHARS) + ran, code, timedOut, runner, ms });
        return;
      }
      const t = trimTestOutput(out, code, runner);
      resolve({ ...t, text: t.text + ran, raw: out, counts: parseCounts(out, runner), code, timedOut, runner, ms });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      setTimeout(() => finish(null), 2000).unref();
    }, timeoutMs);
    child.on("error", (e) => {
      chunks.push(Buffer.from(String(e.message)));
      finish(1);
    });
    child.on("close", (code) => finish(code));
  });
}

// ---------------------------------------------------------------- E24: test time limits (docs/designs/loop-guards-2/design.md)

/** run_tests' limit today and E24's ceiling and back-off */
export const TEST_LIMIT_MS = 300_000;
/** E24's floor: a scaled limit is never below this */
export const TEST_FLOOR_MS = 30_000;
/** the arm values the shadow lines use while the keys are off (design: "Suggested value: 10", "Suggested: 120") */
export const TEST_SCALE_ARM = 10;
export const BASH_TEST_ARM = 120;

/**
 * The request's longest clean test run (did not time out, counts parsed, at least one test ran: a crash at collection
 * never sets it), and a back-off after a timeout: the next run gets TEST_LIMIT_MS. Reset at every request boundary.
 */
export class TestClock {
  private longest = 0;
  private backoff = false;

  reset(): void {
    this.longest = 0;
    this.backoff = false;
  }

  /** The longest clean run of this request in ms (0 = none yet). */
  get longestMs(): number {
    return this.longest;
  }

  /** run_tests' next limit: clamp(scale x the longest clean run, 30 s, 300 s); 300 s with scale 0 (off), no clean run yet, or right after a timeout. */
  limitMs(scale: number): number {
    if (!(scale > 0) || this.longest <= 0 || this.backoff) return TEST_LIMIT_MS;
    return Math.min(TEST_LIMIT_MS, Math.max(TEST_FLOOR_MS, Math.ceil(scale * this.longest)));
  }

  /** Records a finished run: a timeout arms the back-off; any other run clears it, and a clean one may raise the longest. */
  record(run: Pick<TestRun, "timedOut" | "counts" | "ms">): void {
    if (run.timedOut) {
      this.backoff = true;
      return;
    }
    this.backoff = false;
    const c = run.counts;
    if (c && c.passed + c.failed > 0 && typeof run.ms === "number") this.longest = Math.max(this.longest, run.ms);
  }
}

/** A bash/powershell call's timeout in seconds for a test command (E24, limits.bashTestSeconds): 0 = none; with testTimeScale on, the scaled limit when it is smaller. */
export function bashTestSeconds(limits: { bashTestSeconds: number; testTimeScale: number }, clock: TestClock): number {
  if (!(limits.bashTestSeconds > 0)) return 0;
  if (!(limits.testTimeScale > 0)) return limits.bashTestSeconds;
  return Math.min(limits.bashTestSeconds, Math.ceil(clock.limitMs(limits.testTimeScale) / 1000));
}

/** "10x the longest clean run, 0.2s": why a scaled limit was what it was. */
const secs = (ms: number): string => `${Math.round(ms / 100) / 10}s`;

/** run_tests' timeout text with the reason, when the limit was a scaled one (below TEST_LIMIT_MS); the text unchanged otherwise. */
export function explainTimeout(text: string, limitMs: number, scale: number, longestMs: number): string {
  if (limitMs >= TEST_LIMIT_MS) return text;
  return text.replace(/^FAIL tests timed out after \d+s/, `FAIL tests timed out after ${Math.round(limitMs / 1000)}s (${scale}x the longest clean run, ${secs(longestMs)}): likely an endless loop. The next run gets ${TEST_LIMIT_MS / 1000}s.`);
}

/**
 * Does this shell command run tests (pure; E24)? Split on &&, ||, ; and |; in each segment drop a leading `cd <dir>`,
 * VAR=value assignments and a `timeout N` prefix; then match npm/pnpm/yarn test, npx/pnpm exec/yarn + jest/vitest/
 * mocha/pytest, a bare jest/vitest/pytest, node/tsx --test, or python/python3/py -m pytest/unittest.
 */
export function isTestCommand(command: string): boolean {
  for (const seg of String(command ?? "").split(/&&|\|\||;|\||\n/)) {
    let w = seg.trim().split(/\s+/).filter(Boolean);
    for (;;) {
      if (w[0] === "cd") w = w.slice(2);
      else if (w[0] && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1);
      else if (w[0] === "timeout" && w[1] && /^\d+(\.\d+)?[smhd]?$/.test(w[1])) w = w.slice(2);
      else break;
    }
    const [a, b, c] = w;
    if (!a) continue;
    if ((a === "npm" || a === "pnpm" || a === "yarn") && (b === "test" || (b === "run" && c === "test"))) return true;
    const runners = ["jest", "vitest", "mocha", "pytest"];
    if ((a === "npx" || a === "yarn") && b && runners.includes(b)) return true;
    if (a === "pnpm" && b === "exec" && c && runners.includes(c)) return true;
    if (a === "jest" || a === "vitest" || a === "pytest") return true;
    if ((a === "node" || a === "tsx") && b === "--test") return true;
    if ((a === "python" || a === "python3" || a === "py") && b === "-m" && (c === "pytest" || c === "unittest")) return true;
  }
  return false;
}
