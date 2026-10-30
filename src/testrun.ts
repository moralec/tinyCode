// Run the project's tests and trim the output for a small model. Port of ladder.run_test:
// PASS + summary line, or FAIL + summary + failing names + the first error block, at most 3200 chars.
import { spawn } from "node:child_process";

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
  /** counts from the runner's summary, when they could be read (absent = unknown) */
  counts?: TestCounts | null;
  /** the trimmed text the model sees, starting `PASS` or `FAIL` */
  text: string;
  /** the runner's whole output (absent when a test double gives none); `failureBlocks` reads it */
  raw?: string;
  code: number | null;
  timedOut: boolean;
}

/**
 * Passed / failed counts from a runner's summary line (pure): pytest `4 failed, 6 passed in 0.5s`, jest and vitest
 * `Tests: 4 failed, 6 passed, 10 total`, unittest `Ran 10 tests` + `FAILED (failures=4)` / `OK`. null = not recognised.
 */
export function parseCounts(output: string): TestCounts | null {
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

/** Trim raw pytest output (pure; unit-tested without running anything). */
export function trimTestOutput(output: string, code: number | null): { ok: boolean; text: string } {
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
    .map((n) => n.slice(n.indexOf("::") + 2 || 0));
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
export function failureBlocks(raw: string, maxBlocks: number, maxLines: number): string {
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

const quote = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

/** The command line to run: `test.command` as written, else `<python> -m pytest -q -p no:cacheprovider [test]`. */
export function testCommand(cfg: TestConfig, test?: string): string {
  if (cfg.command) return cfg.command;
  return [quote(cfg.python), "-m", "pytest", "-q", "-p", "no:cacheprovider", ...(test ? [quote(test)] : [])].join(" ");
}

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
}

export function runTests(opts: {
  cwd: string;
  test?: string;
  config: TestConfig;
  timeoutMs?: number;
}): Promise<TestRun> {
  const timeoutMs = opts.timeoutMs ?? 300_000;
  return new Promise((resolve) => {
    const child = spawn(testCommand(opts.config, opts.test), {
      cwd: opts.cwd,
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
    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const out = Buffer.concat(chunks).toString("utf8").replace(/\r\n/g, "\n");
      if (timedOut) {
        resolve({ ok: false, text: `FAIL tests timed out after ${Math.round(timeoutMs / 1000)}s\n${out.split("\n").slice(-12).join("\n")}`.slice(0, TEST_CHARS), code, timedOut });
        return;
      }
      resolve({ ...trimTestOutput(out, code), raw: out, counts: parseCounts(out), code, timedOut });
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
