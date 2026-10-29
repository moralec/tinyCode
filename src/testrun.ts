// Run the project's tests and trim the output for a small model. Port of ladder.run_test:
// PASS + summary line, or FAIL + summary + failing names + the first error block, at most 3200 chars.
import { spawn } from "node:child_process";

export const TEST_CHARS = 3200;

export interface TestConfig {
  python: string;
  command: string | null;
}
export interface TestRun {
  ok: boolean;
  /** the trimmed text the model sees, starting `PASS` or `FAIL` */
  text: string;
  code: number | null;
  timedOut: boolean;
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
      resolve({ ...trimTestOutput(out, code), code, timedOut });
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
