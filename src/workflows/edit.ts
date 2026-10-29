// /edit <path> <instruction>: one file, one instruction, through the file-type routine (src/routines).
//   outline + the file (a window around named symbols when it is long) -> one edit call -> apply to the routine's text
//   -> save -> check -> on failure one retry with the check output appended -> still failing: restore the original
//   bytes and offer rung 3 (/fix). Pure logic with injected dependencies, like fix.ts.
import { NOOP_PROGRESS, type Progress } from "../progress.ts";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Config } from "../config.ts";
import { outline } from "../context/outline.ts";
import { lintPass, type LintOptions } from "../lint.ts";
import type { Message } from "../llm.ts";
import { applyReply } from "../protocol/apply.ts";
import { EDIT_RULES } from "../protocol/prompts.ts";
import { KNOWN_EXTS, routineFor, type Routine } from "../routines/index.ts";
import { atomicWrite } from "../routines/util.ts";
import type { ChatFn } from "./fix.ts";

export const LONG_FILE_LINES = 300;

export interface EditArgs {
  test?: string;
  /** the file, when the first word names one (an existing file, or a type with a routine) */
  path?: string;
  instruction: string;
}

/** `[--test PATH] <path> <instruction>`. The path is the first word when it exists as a file or has a routine's extension. */
export function parseEditArgs(raw: string, cwd: string): EditArgs {
  let rest = raw.trim();
  let test: string | undefined;
  const t = rest.match(/^--test(?:=|\s+)(\S+)\s*/);
  if (t) {
    test = t[1]!.replace(/^["']|["']$/g, "");
    rest = rest.slice(t[0].length);
  }
  const q = rest.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))\s*/);
  if (q) {
    const word = q[1] ?? q[2] ?? q[3]!;
    const ext = word.includes(".") ? word.slice(word.lastIndexOf(".")).toLowerCase() : "";
    let isFile = false;
    try {
      isFile = statSync(resolve(cwd, word)).isFile();
    } catch {
      isFile = false;
    }
    if (isFile || KNOWN_EXTS.includes(ext)) return { test, path: word, instruction: rest.slice(q[0].length).trim() };
  }
  return { test, instruction: rest };
}

/** Identifiers in the instruction that could name a symbol (4+ chars, or with an underscore / camelCase). */
function symbolsIn(instruction: string): string[] {
  const ids = instruction.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [];
  return [...new Set(ids.filter((s) => s.length >= 4 || /[_]|[a-z][A-Z]/.test(s)))];
}

/**
 * The text the model sees. Files up to LONG_FILE_LINES lines: whole. Longer: windows of `viewLines` lines around the
 * first line naming each symbol the instruction mentions, merged, with omitted ranges marked. Window text is verbatim,
 * so SEARCH blocks copied from it still match the file. No symbol found: the first `viewLines` lines.
 */
export function viewText(text: string, instruction: string, viewLines: number): string {
  const lines = text.split("\n");
  const n = text.endsWith("\n") ? lines.length - 1 : lines.length;
  if (n <= LONG_FILE_LINES) return text;
  const half = Math.max(1, Math.floor(viewLines / 2));
  const spans: [number, number][] = [];
  for (const sym of symbolsIn(instruction)) {
    const re = new RegExp(`\\b${sym}\\b`);
    // prefer a definition line; else the first mention
    let at = lines.findIndex((l) => re.test(l) && /^\s*(def|class|function|async\s+def|const|let|var|on|to)\b/.test(l));
    if (at < 0) at = lines.findIndex((l) => re.test(l));
    if (at >= 0) spans.push([Math.max(0, at - Math.floor(half / 2)), Math.min(n, at + half)]);
  }
  if (!spans.length) spans.push([0, Math.min(n, viewLines)]);
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const s of spans) {
    const last = merged[merged.length - 1];
    if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
    else merged.push([...s]);
  }
  const out: string[] = [];
  let pos = 0;
  for (const [a, b] of merged) {
    if (a > pos) out.push(`... [lines ${pos + 1}-${a} omitted]`);
    out.push(...lines.slice(a, b));
    pos = b;
  }
  if (pos < n) out.push(`... [lines ${pos + 1}-${n} omitted]`);
  return out.join("\n") + "\n";
}

/** The phases /edit reports, in order. */
export const EDIT_PHASES = ["edit", "check", "lint"];

export interface EditDeps {
  /** progress display (src/progress.ts); absent = none */
  progress?: Progress;
  cwd: string;
  config: Config;
  chat: ChatFn;
  report: (line: string) => void;
  env?: Record<string, string | undefined>;
  /** override for tests */
  routine?: Routine;
  /** test hook for the lint auto-fix runner */
  lint?: Pick<LintOptions, "exec" | "find">;
}

export interface EditResult {
  ok: boolean;
  /** direct model calls */
  calls: number;
  /** true when the edit failed and /fix (rung 3) is the next thing to offer */
  offerFix: boolean;
  lines: string[];
  /** the routine's `why` when it is unavailable on this machine */
  unavailable?: string;
}

const fence = (name: string, text: string) => `${name}\n\`\`\`\n${text}\`\`\``;

export async function runEdit(args: EditArgs, deps: EditDeps): Promise<EditResult> {
  const { cwd, config: cfg } = deps;
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    deps.report(l);
  };
  const pg = deps.progress ?? NOOP_PROGRESS;
  let calls = 0;
  const result = (ok: boolean, offerFix = false, unavailable?: string): EditResult => ({ ok, calls, offerFix, lines, unavailable });

  if (!args.path) {
    say("usage: /edit [--test PATH] <path> <instruction>");
    return result(false);
  }
  if (!args.instruction) {
    say(`/edit ${args.path}: say what to change`);
    return result(false);
  }
  const abs = resolve(cwd, args.path);
  const routine = deps.routine ?? routineFor(abs);
  const av = routine.available();
  if (!av.ok) {
    say(av.why ?? `the ${routine.name} routine is not available here`);
    return result(false, false, av.why ?? "unavailable");
  }
  try {
    if (!statSync(abs).isFile()) throw new Error("not a file");
  } catch {
    say(`/edit: ${args.path} is not a file`);
    return result(false);
  }

  const inside = (() => {
    const rel = relative(resolve(cwd), abs);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel) ? rel.split("\\").join("/") : null;
  })();
  const shown = (inside ?? basename(abs)).replace(/\.scpt$/i, routine.viewExt ?? ".scpt");
  const original = readFileSync(abs); // exact bytes, restored on final failure
  const checkOpts = {
    cwd,
    python: cfg.test.python,
    test: args.test || cfg.test.command ? { path: args.test, command: cfg.test.command } : undefined,
  };

  const loaded = await routine.load(abs);
  const work = mkdtempSync(join(tmpdir(), "tinycode-edit-"));
  const restore = async () => {
    await atomicWrite(abs, original);
  };
  try {
    const sys = EDIT_RULES;
    const head = `Repository outline:\n${outline(cwd, 3000)}\n\n`;
    const msgs: Message[] = [
      { role: "system", content: sys },
      {
        role: "user",
        content:
          head +
          fence(shown, viewText(loaded.text, args.instruction, cfg.limits.viewLines)) +
          `\n\nTask (edit only this file, ${shown}):\n${args.instruction}\n\nReply with edit blocks only.`,
      },
    ];
    let text = loaded.text;
    let firstSave = true;
    for (let attempt = 1; attempt <= 2; attempt++) {
      calls++;
      pg.step("edit", attempt, 2);
      const r = await deps.chat("edit", msgs, { workflow: "edit", config: cfg, env: deps.env });
      msgs.push({ role: "assistant", content: r.text });
      // apply to the routine's text in a scratch dir holding only that file, so nothing else can be touched
      const scratch = join(work, String(attempt));
      const target = join(scratch, shown);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
      const res = await applyReply(r.text, { cwd: scratch, protected: [], maxWholeFileLines: 400 });
      const hit = res.applied.includes(shown);
      const extra = res.applied.filter((p) => p !== shown);
      let problem: string | null = null;
      if (!hit) {
        const why = res.results.filter((x) => !x.ok).map((x) => `${x.path} (${x.reason})`).join(", ");
        problem = `No edit was applied to ${shown}${why ? `; not applied: ${why}` : "; the reply held no edit block for it"}.`;
      } else {
        const next = readFileSync(target, "utf8");
        if (extra.length) say(`ignored edits to other files: ${extra.join(", ")}`);
        try {
          await routine.save(abs, next, { backup: firstSave });
          firstSave = false;
          text = next;
          pg.touch(args.path);
          pg.step("check");
          const c = await routine.check(abs, checkOpts);
          say(`attempt ${attempt}: applied, check ${c.ok ? "ok" : "failed"}`);
          if (c.ok) {
            if (routine.name !== "scpt") {
              pg.step("lint");
              await lintPass(
                { cwd, files: [abs], env: deps.env },
                {
                  report: say,
                  lint: deps.lint,
                  verify: async () => {
                    text = readFileSync(abs, "utf8");
                    return (await routine.check(abs, checkOpts)).ok;
                  },
                },
              );
            }
            say(`edited: ${args.path}`);
            say(`calls: ${calls}`);
            return result(true);
          }
          problem = `Check failed:\n${c.out}`;
        } catch (e) {
          problem = `Saving failed:\n${(e as Error).message}`;
          say(`attempt ${attempt}: ${problem.split("\n")[0]}`);
        }
      }
      if (attempt === 1) {
        if (!hit) say(`attempt 1: ${problem}`);
        msgs.push({
          role: "user",
          content: `${problem}\n\nReply with corrected edit blocks against ${shown} as it is now:\n${fence(shown, viewText(text, args.instruction, cfg.limits.viewLines))}`,
        });
      } else {
        await restore();
        say(`/edit failed after ${calls} calls; ${args.path} restored to the original`);
        say(`last problem: ${problem.slice(0, 400)}`);
        say(`calls: ${calls}`);
        return result(false, true);
      }
    }
    return result(false, true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
