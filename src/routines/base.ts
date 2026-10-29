// Shared types and helpers for routines (no imports from the routines themselves, so no import cycle).
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface CheckOptions {
  cwd: string;
  /** interpreter for the .py routine (config test.python) */
  python: string;
  /** a test to run after the compile check: `--test PATH` or config test.command; absent = compile only */
  test?: { path?: string; command: string | null };
}
export interface Loaded {
  /** the text the model edits (LF) */
  text: string;
  /** a file holding that text, for display / editors; the original for text routines */
  viewPath: string;
}
export interface Routine {
  name: string;
  /** lower-case extensions with the dot; empty = the fallback routine */
  exts: string[];
  available(): { ok: boolean; why?: string };
  load(path: string): Promise<Loaded>;
  /** throws RoutineError (with the tool output) when the text cannot be saved; the original is then untouched */
  save(path: string, text: string, opts?: { backup?: boolean }): Promise<void>;
  check(path: string, opts: CheckOptions): Promise<{ ok: boolean; out: string }>;
  /** the extension the model sees the file under (".applescript" for .scpt) */
  viewExt?: string;
}

export class RoutineError extends Error {}

export interface RunResult {
  code: number;
  out: string;
}

/** Run a program without a shell; never throws. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        timeout: opts.timeoutMs ?? 120_000,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        const out = `${stdout ?? ""}${stderr ?? ""}`.replace(/\r\n/g, "\n").trim();
        if (!err) return resolve({ code: 0, out });
        const e = err as NodeJS.ErrnoException & { code?: number | string };
        const code = typeof e.code === "number" ? e.code : 1;
        resolve({ code, out: out || e.message });
      },
    );
  });
}

/** Is `name` an executable file on PATH? (Node search; `.exe` etc. via PATHEXT on Windows.) */
export function onPath(name: string, env: Record<string, string | undefined> = process.env): boolean {
  const exts = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")] : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const x of exts) if (existsSync(join(dir, name + x))) return true;
  }
  return false;
}

