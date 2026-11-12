// The check runner, first built for E17 (the acceptance check run by code, design docs/designs/acceptance-check/design.md).
// E17's writer was denied and removed on 2026-11-12 (record docs/design-records/acceptance-check.md); its runner stays
// because /build runs a task's own check through it (E21b, stages.buildChecks; design plan-build-fit). A check runs by
// code: argv only, no shell, stdin closed, each check in a fresh empty folder. A missing interpreter is "unavailable",
// never a failure. Python only. scripts/acceptance-run.ts runs a checks file through validateAcceptance and runAcceptance.
import { spawn } from "node:child_process";
import { lstatSync, readFileSync, rmSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve, win32 } from "node:path";
import { writeInside } from "./safewrite.ts";
import { killTree } from "./testrun.ts";

// ---------------------------------------------------------------- shapes and limits

export interface AcceptStep {
  /** argv[0] is "{python}" (config test.python); 1 to 30 strings */
  argv: string[];
  stdin?: string;
  env?: Record<string, string>;
  exit?: number;
  /** exact, after \r\n -> \n and trailing whitespace removed on both sides */
  stdout?: string;
  stdoutHas?: string[];
  stderrHas?: string[];
  /** relative path -> substring the file must hold ("" = exists) */
  files?: Record<string, string>;
  absent?: string[];
}
export interface AcceptCheck {
  name: string;
  /** input files written into the empty folder before step 1: relative path -> content */
  writeFiles?: Record<string, string>;
  steps: AcceptStep[];
}
export interface AcceptFailure {
  name: string;
  /** the failing step's command as shown to the model ({python} -> python, a -c snippet cut) */
  command: string;
  /** one line */
  why: string;
}
export interface AcceptanceRun {
  ok: boolean;
  total: number;
  passed: number;
  failed: AcceptFailure[];
  ms: number;
  /** no interpreter (spawn error or a failing `--version`): nothing failed */
  unavailable?: string;
}

export const RUN_DIR = join(".tinycode", "acceptance-run");
/** the whole set stops here; the rest count as not run */
export const ACCEPT_TOTAL_MS = 120_000;
export const MAX_CHECKS = 8;
export const MAX_STEPS = 4;
const MAX_ARGV = 30;
const MAX_SNIPPET = 600;
const MAX_STR = 400;
const MAX_WRITE_FILES = 4;
const MAX_WRITE_CHARS = 2000;
const MAX_SET_CHARS = 8000;
const OUT_CAP = 8 * 1024;
const PREFLIGHT_MS = 5000;
/** a child whose `close` never comes (a grandchild holds the pipe) is finished this long after exit or kill */
const FINISH_GRACE_MS = 2000;
const VAL_CHARS = 80;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

// ---------------------------------------------------------------- validation

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** relative, no `..`, not absolute on either platform */
export function safeRel(p: unknown): p is string {
  if (typeof p !== "string" || !p || p.length > MAX_STR) return false;
  if (isAbsolute(p) || win32.isAbsolute(p) || /^[A-Za-z]:/.test(p) || p.startsWith("\\")) return false;
  return !p.split(/[\\/]/).includes("..");
}

const isSnippet = (argv: string[], i: number): boolean => i === 2 && argv[1] === "-c";

function checkStep(s: unknown, at: string): { step: AcceptStep | null; error?: string } {
  if (!isObj(s)) return { step: null, error: `${at}: not an object` };
  const argv = s.argv;
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > MAX_ARGV || argv.some((a) => typeof a !== "string")) return { step: null, error: `${at}: argv must be 1 to ${MAX_ARGV} strings` };
  if (argv[0] !== "{python}") return { step: null, error: `${at}: argv[0] must be {python}, got ${JSON.stringify(argv[0]).slice(0, 40)}` };
  for (let i = 1; i < argv.length; i++) {
    const max = isSnippet(argv as string[], i) ? MAX_SNIPPET : MAX_STR;
    if ((argv[i] as string).length > max) return { step: null, error: `${at}: argv[${i}] over ${max} characters` };
  }
  const step: AcceptStep = { argv: [...(argv as string[])] };
  const str = (k: "stdin" | "stdout"): string | undefined => {
    const v = s[k];
    if (v === undefined) return undefined;
    if (typeof v !== "string" || v.length > MAX_STR) throw new Error(`${at}: ${k} must be a string of at most ${MAX_STR} characters`);
    return v;
  };
  const list = (k: "stdoutHas" | "stderrHas" | "absent", paths = false): string[] | undefined => {
    const v = s[k];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.length > 10 || v.some((x) => typeof x !== "string" || x.length > MAX_STR)) throw new Error(`${at}: ${k} must be a list of strings`);
    if (paths && v.some((x) => !safeRel(x))) throw new Error(`${at}: ${k} paths must be relative, without ..`);
    return [...(v as string[])];
  };
  try {
    const stdin = str("stdin");
    if (stdin !== undefined) step.stdin = stdin;
    const stdout = str("stdout");
    if (stdout !== undefined) step.stdout = stdout;
    if (s.env !== undefined) {
      if (!isObj(s.env)) throw new Error(`${at}: env must be an object`);
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(s.env)) {
        if (!ENV_NAME.test(k)) throw new Error(`${at}: env name ${JSON.stringify(k).slice(0, 40)} not allowed`);
        if (typeof v !== "string" || v.length > MAX_STR) throw new Error(`${at}: env ${k} must be a string`);
        env[k] = v;
      }
      step.env = env;
    }
    if (s.exit !== undefined) {
      if (!Number.isInteger(s.exit) || (s.exit as number) < 0 || (s.exit as number) > 255) throw new Error(`${at}: exit must be an integer 0-255`);
      step.exit = s.exit as number;
    }
    for (const k of ["stdoutHas", "stderrHas"] as const) {
      const v = list(k);
      if (v !== undefined) step[k] = v;
    }
    const absent = list("absent", true);
    if (absent !== undefined) step.absent = absent;
    if (s.files !== undefined) {
      if (!isObj(s.files)) throw new Error(`${at}: files must be an object`);
      const files: Record<string, string> = {};
      for (const [k, v] of Object.entries(s.files)) {
        if (!safeRel(k)) throw new Error(`${at}: files path ${JSON.stringify(k).slice(0, 40)} must be relative, without ..`);
        if (typeof v !== "string" || v.length > MAX_STR) throw new Error(`${at}: files ${k} must be a string`);
        files[k] = v;
      }
      step.files = files;
    }
  } catch (e) {
    return { step: null, error: (e as Error).message };
  }
  return { step };
}

function checkOne(c: unknown, at: string): { check: AcceptCheck | null; error?: string } {
  if (!isObj(c)) return { check: null, error: `${at}: not an object` };
  if (typeof c.name !== "string" || !c.name.trim() || c.name.length > MAX_STR) return { check: null, error: `${at}: name must be a non-empty string` };
  const check: AcceptCheck = { name: c.name.trim(), steps: [] };
  if (c.writeFiles !== undefined) {
    if (!isObj(c.writeFiles)) return { check: null, error: `${at}: writeFiles must be an object` };
    const entries = Object.entries(c.writeFiles);
    if (entries.length > MAX_WRITE_FILES) return { check: null, error: `${at}: more than ${MAX_WRITE_FILES} writeFiles` };
    const wf: Record<string, string> = {};
    for (const [k, v] of entries) {
      if (!safeRel(k)) return { check: null, error: `${at}: writeFiles path ${JSON.stringify(k).slice(0, 40)} must be relative, without ..` };
      if (typeof v !== "string" || v.length > MAX_WRITE_CHARS) return { check: null, error: `${at}: writeFiles ${k} must be a string of at most ${MAX_WRITE_CHARS} characters` };
      wf[k] = v;
    }
    if (entries.length) check.writeFiles = wf;
  }
  if (!Array.isArray(c.steps) || c.steps.length < 1 || c.steps.length > MAX_STEPS) return { check: null, error: `${at}: steps must be 1 to ${MAX_STEPS}` };
  for (let i = 0; i < c.steps.length; i++) {
    const r = checkStep(c.steps[i], `${at} step ${i + 1}`);
    if (!r.step) return { check: null, error: r.error };
    check.steps.push(r.step);
  }
  return { check };
}

/**
 * The model's (or the file's) checks, by code: an invalid check is dropped with its reason, not the whole set; more than
 * MAX_CHECKS keeps the first ones; the set is cut from the end to MAX_SET_CHARS. No valid check left: `checks` is [].
 */
export function validateAcceptance(raw: unknown): { checks: AcceptCheck[]; errors: string[] } {
  const errors: string[] = [];
  const list = isObj(raw) ? raw.checks : undefined;
  if (!Array.isArray(list)) return { checks: [], errors: ["checks must be a list"] };
  const checks: AcceptCheck[] = [];
  list.forEach((c, i) => {
    const at = `check ${i + 1}`;
    if (checks.length >= MAX_CHECKS) {
      errors.push(`${at}: more than ${MAX_CHECKS} checks`);
      return;
    }
    const r = checkOne(c, at);
    if (r.check) checks.push(r.check);
    else errors.push(r.error ?? `${at}: invalid`);
  });
  while (checks.length && JSON.stringify(checks).length > MAX_SET_CHARS) {
    checks.pop();
    errors.push(`check ${checks.length + 1}: the set is over ${MAX_SET_CHARS} characters`);
  }
  return { checks, errors };
}

// ---------------------------------------------------------------- running

export interface RunOpts {
  cwd: string;
  /** config test.python; words split on spaces ("py -3") */
  python: string;
  /** per step (default 20) */
  stepSeconds?: number;
  /** the whole set (default ACCEPT_TOTAL_MS) */
  totalMs?: number;
  /** before each check: (1-based index, total) */
  onProgress?: (n: number, total: number) => void;
}

interface Spawned {
  code: number | null;
  stdout: string;
  stderr: string;
  outCut: boolean;
  timedOut: boolean;
  /** spawn error (ENOENT, EACCES ...) */
  error?: string;
}

/** Spawn argv (no shell), stdin closed or fed and ended, 8 KB per stream, killTree on timeout, 2 s finish fallback. */
function spawnStep(cmd: string, args: string[], o: { cwd: string; env: NodeJS.ProcessEnv; stdin?: string; timeoutMs: number }): Promise<Spawned> {
  return new Promise((done) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd: o.cwd, env: o.env, shell: false, detached: process.platform !== "win32", windowsHide: true, stdio: [o.stdin !== undefined ? "pipe" : "ignore", "pipe", "pipe"] });
    } catch (e) {
      done({ code: null, stdout: "", stderr: "", outCut: false, timedOut: false, error: (e as NodeJS.ErrnoException).code ?? (e as Error).message });
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outLen = 0;
    let errLen = 0;
    let outCut = false;
    const keep = (buf: Buffer[], len: number, d: Buffer): number => {
      if (len >= OUT_CAP) {
        outCut = true;
        return len;
      }
      const room = OUT_CAP - len;
      if (d.length > room) outCut = true;
      buf.push(d.subarray(0, room));
      return len + Math.min(d.length, room);
    };
    child.stdout!.on("data", (d: Buffer) => (outLen = keep(out, outLen, d)));
    child.stderr!.on("data", (d: Buffer) => (errLen = keep(err, errLen, d)));
    let timedOut = false;
    let finished = false;
    let spawnError: string | undefined;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // a grandchild may still hold the pipes: stop reading so neither it nor the pipes keep this process waiting
      child.stdout?.destroy();
      child.stderr?.destroy();
      // and what the step left running in its process group (a server started in the background) goes with it
      if (process.platform !== "win32" && !timedOut) killTree(child.pid);
      done({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), outCut, timedOut, ...(spawnError ? { error: spawnError } : {}) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
      setTimeout(() => finish(null), FINISH_GRACE_MS).unref();
    }, o.timeoutMs);
    child.on("error", (e: NodeJS.ErrnoException) => {
      spawnError = e.code ?? e.message;
      finish(null);
    });
    // a grandchild that keeps the pipes open: `close` never comes, so finish shortly after the child's own exit
    child.on("exit", (code) => {
      if (!timedOut) clearTimeout(timer);
      setTimeout(() => finish(code), FINISH_GRACE_MS).unref();
    });
    child.on("close", (code) => finish(code));
    if (o.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(o.stdin);
    }
  });
}

const cut = (s: string, n = VAL_CHARS): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const q = (s: string): string => JSON.stringify(cut(s)).replace(/\\n/g, "\\n");
/** \r\n -> \n, trailing whitespace off every line and off the end */
export const normOut = (s: string): string => s.replace(/\r\n/g, "\n").split("\n").map((l) => l.replace(/\s+$/, "")).join("\n").replace(/\s+$/, "");

/** The step's command as the model sees it: {python} -> python, a -c snippet cut to 40 characters, env shown after. */
export function showCommand(step: AcceptStep): string {
  const parts = step.argv.map((a, i) => {
    if (i === 0 && a === "{python}") return "python";
    if (isSnippet(step.argv, i)) return JSON.stringify(cut(a.replace(/\s*\n\s*/g, "; "), 40));
    return /[\s"']/.test(a) || !a ? JSON.stringify(a) : a;
  });
  const env = step.env && Object.keys(step.env).length ? ` (${Object.entries(step.env).map(([k, v]) => `${k}=${v}`).join(" ")})` : "";
  return parts.join(" ") + env;
}

/** The last non-empty line of a stream (a Python traceback ends with the exception). */
const lastLine = (s: string): string => {
  const l = s.replace(/\r\n/g, "\n").split("\n").map((x) => x.trim()).filter(Boolean).at(-1) ?? "";
  // the end of the line says what went wrong ("/path/to/python3: No module named habits.__main__")
  return l.length > VAL_CHARS ? "…" + l.slice(l.length - VAL_CHARS + 1) : l;
};

/** The first expectation the step's result misses, as one line; null = the step passed. */
export function stepWhy(step: AcceptStep, r: Spawned, runDir: string, stepSeconds: number): string | null {
  if (r.timedOut) return `timed out after ${stepSeconds}s`;
  // a crash says why in its last stderr line (the exception), not in the traceback's first path
  const errLast = lastLine(r.stderr);
  if (step.exit !== undefined && r.code !== step.exit) return `exit ${r.code ?? "none"}, expected ${step.exit}${errLast ? `: ${q(errLast)}` : ""}`;
  if (step.stdout !== undefined) {
    const want = normOut(step.stdout);
    const got = normOut(r.stdout);
    if (want !== got) {
      if (r.outCut && want.length > got.length) return "output over 8 KB";
      return `stdout differs: expected ${q(want)}, got ${q(got)}`;
    }
  }
  const outN = r.stdout.replace(/\r\n/g, "\n");
  for (const s of step.stdoutHas ?? []) if (!outN.includes(s.replace(/\r\n/g, "\n"))) return r.outCut ? "output over 8 KB" : `stdout lacks ${q(s)}${outN.trim() ? `, got ${q(normOut(outN))}` : ", got nothing"}`;
  const errN = r.stderr.replace(/\r\n/g, "\n");
  for (const s of step.stderrHas ?? []) if (!errN.includes(s.replace(/\r\n/g, "\n"))) return `stderr lacks ${q(s)}${errLast ? `, got ${q(errLast)}` : ", got nothing"}`;
  for (const [p, has] of Object.entries(step.files ?? {})) {
    let text: string;
    try {
      text = readFileSync(join(runDir, p), "utf8");
    } catch {
      return `${p} missing`;
    }
    if (has && !text.includes(has)) return `${p} lacks ${q(has)}`;
  }
  for (const p of step.absent ?? []) {
    try {
      lstatSync(join(runDir, p));
      return `${p} exists`;
    } catch {
      // absent, as expected
    }
  }
  return null;
}

/** test.python as argv: words on spaces ("py -3" -> ["py", "-3"]). */
export const pythonArgv = (python: string): string[] => python.trim().split(/\s+/).filter(Boolean);

/**
 * Run a set by code. Availability first (`{python} --version`, 5 s): a spawn error or a non-zero exit there, or a spawn
 * error on any step, is `unavailable`, never a failure. Each check runs in a new empty folder `.tinycode/acceptance-run/<n>/`
 * (writeFiles first), removed afterwards; steps of a check share it and the check stops at its first failing step.
 * Environment: process env + PYTHONPATH (project root first) + NO_COLOR=1, FORCE_COLOR=0, PYTHONDONTWRITEBYTECODE=1, then
 * the step's env. The set stops at `totalMs`; checks not reached count as failed ("not run").
 */
export async function runAcceptance(set: { checks: AcceptCheck[] }, opts: RunOpts): Promise<AcceptanceRun> {
  const t0 = Date.now();
  const stepSeconds = opts.stepSeconds ?? 20;
  const totalMs = opts.totalMs ?? ACCEPT_TOTAL_MS;
  const total = set.checks.length;
  const cwd = resolve(opts.cwd);
  const py = pythonArgv(opts.python);
  const unavailable = (why: string): AcceptanceRun => ({ ok: false, total, passed: 0, failed: [], ms: Date.now() - t0, unavailable: why });
  if (!py.length) return unavailable("no interpreter configured (set test.python)");
  const name = py.join(" ");
  const pre = await spawnStep(py[0]!, [...py.slice(1), "--version"], { cwd, env: process.env, timeoutMs: PREFLIGHT_MS });
  if (pre.error) return unavailable(`${name} not found (set test.python)`);
  if (pre.timedOut || pre.code !== 0) return unavailable(`${name} --version ${pre.timedOut ? "timed out" : `exited ${pre.code}`} (set test.python)`);
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PYTHONPATH: process.env.PYTHONPATH ? `${cwd}${delimiter}${process.env.PYTHONPATH}` : cwd,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    PYTHONDONTWRITEBYTECODE: "1",
  };
  const failed: AcceptFailure[] = [];
  let passed = 0;
  try {
    for (let n = 0; n < total; n++) {
      const check = set.checks[n]!;
      if (Date.now() - t0 > totalMs) {
        failed.push({ name: check.name, command: showCommand(check.steps[0]!), why: `not run: the ${Math.round(totalMs / 1000)}s limit for all checks was reached` });
        continue;
      }
      opts.onProgress?.(n + 1, total);
      const rel = join(RUN_DIR, String(n + 1));
      const dir = join(cwd, rel);
      rmSync(dir, { recursive: true, force: true });
      // created through writeInside: no symlink on the way is followed
      writeInside(cwd, join(rel, ".keep"), "");
      rmSync(join(dir, ".keep"), { force: true });
      for (const [p, text] of Object.entries(check.writeFiles ?? {})) writeInside(dir, p, text);
      let why: string | null = null;
      let failedStep: AcceptStep | null = null;
      for (const step of check.steps) {
        const args = step.argv.slice(1);
        const cmd = step.argv[0] === "{python}" ? py : [step.argv[0]!];
        const r = await spawnStep(cmd[0]!, [...cmd.slice(1), ...args], { cwd: dir, env: { ...baseEnv, ...(step.env ?? {}) }, stdin: step.stdin, timeoutMs: stepSeconds * 1000 });
        if (r.error) return unavailable(`${name} could not start (${r.error}; set test.python)`);
        why = stepWhy(step, r, dir, stepSeconds);
        if (why) {
          failedStep = step;
          break;
        }
      }
      rmSync(dir, { recursive: true, force: true });
      if (why && failedStep) failed.push({ name: check.name, command: showCommand(failedStep), why });
      else passed++;
    }
  } finally {
    rmSync(join(cwd, RUN_DIR), { recursive: true, force: true });
  }
  return { ok: total > 0 && passed === total, total, passed, failed, ms: Date.now() - t0 };
}

// ---------------------------------------------------------------- texts

