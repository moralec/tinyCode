// /add <task>: new code ("add a function / CLI option / endpoint that ..."). Follows fix.ts and edit.ts.
//   code picks the target file (the router's hint or `--file`, else one pick call from the outline), then gathers its
//   imports and the files that import it -> ONE call writes the new code as SEARCH/REPLACE blocks (an insertion is an
//   anchor of existing lines repeated in REPLACE with the new code added) plus a test -> code applies and runs the
//   test -> pass: lint auto-fix on the changed files, done. Fail (or nothing applied): hand over to /fix's ladder
//   (runFix) with the new test protected. Pure logic with injected dependencies.
import { NOOP_PROGRESS, type Progress } from "../progress.ts";
import { readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type { Config } from "../config.ts";
import { outline, repoFiles } from "../context/outline.ts";
import { lintPass, type LintOptions } from "../lint.ts";
import type { Message } from "../llm.ts";
import { applyReply } from "../protocol/apply.ts";
import { EDIT_RULES } from "../protocol/prompts.ts";
import { runTests as realRunTests } from "../testrun.ts";
import { viewText } from "./edit.ts";
import { PICK_SCHEMA, changedSinceSnapshot, runFix, takeSnapshot, type ChatFn, type FixResult, type PiHandoff } from "./fix.ts";

export const ADD_RULES =
  EDIT_RULES +
  "\n\nYou are adding new code. To insert, put a few existing lines where the code belongs in SEARCH and repeat " +
  "them in REPLACE with the new code added next to them (never an empty SEARCH for a file that exists). Also add a " +
  "test for the new code, in the test file named in the task (an existing test file: add after existing tests with " +
  "an anchor; a new file: empty SEARCH). Match the style of the surrounding code.";

export interface AddArgs {
  test?: string;
  /** where the new code goes (the router's hint); else one pick call chooses */
  file?: string;
  task: string;
}

/** `[--test PATH] [--file PATH] <task>`: flags from the front only. */
export function parseAddArgs(raw: string): AddArgs {
  let rest = raw.trim();
  const out: AddArgs = { task: "" };
  for (;;) {
    const m = rest.match(/^--(test|file)(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))\s*/);
    if (!m) break;
    out[m[1] as "test" | "file"] = m[2] ?? m[3] ?? m[4]!;
    rest = rest.slice(m[0].length);
  }
  out.task = rest.trim();
  return out;
}

/** The phases /add reports, in order (a failing test hands over to /fix, shown as a nested `fix`). */
export const ADD_PHASES = ["pick file", "write", "test", "lint"];

export interface AddDeps {
  /** progress display (src/progress.ts); absent = none */
  progress?: Progress;
  cwd: string;
  config: Config;
  chat: ChatFn;
  /** the rung-3 hand-off, passed on to /fix's ladder */
  pi?: (h: PiHandoff) => Promise<{ turns: number }>;
  report: (line: string) => void;
  env?: Record<string, string | undefined>;
  runTests?: typeof realRunTests;
  lint?: Pick<LintOptions, "exec" | "find">;
}

export interface AddResult {
  /** the new code and its test pass (directly, or after /fix's ladder) */
  ok: boolean;
  /** direct calls made by /add itself (pick + write); the ladder's are in `fix` */
  calls: number;
  target: string | null;
  test: string | null;
  files: string[];
  /** set when the ladder took over */
  fix?: FixResult;
  lines: string[];
}

const normpath = (p: string): string => normalize(p).split(sep).join("/").split("\\").join("/");
export const isTestPath = (p: string) => /(^|\/)(tests?|__tests__)\/|(^|\/)test_[^/]*$|[._](test|spec)\.[a-z]+$|_test\.[a-z]+$/i.test(p);

function insideFile(cwd: string, p: string): boolean {
  if (!p || isAbsolute(p)) return false;
  const rel = relative(resolve(cwd), resolve(cwd, p));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
  try {
    return statSync(join(cwd, p)).isFile();
  } catch {
    return false;
  }
}

const fence = (name: string, text: string) => `${name}\n\`\`\`\n${text}\`\`\``;

/** Files that import the target (Python `import x` / `from x import`, JS `from './x'` / `require('./x')`), with line numbers. */
export function importers(cwd: string, target: string, max = 6): string[] {
  const stem = basename(target, extname(target));
  if (!stem) return [];
  const e = stem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^\\s*(from\\s+[\\w.]*\\b${e}\\b|import\\s+[\\w., ]*\\b${e}\\b|.*\\b(from|require\\()\\s*['"][^'"]*\\b${e}['"])`);
  const out: string[] = [];
  for (const f of repoFiles(cwd)) {
    if (f === target) continue;
    let src: string;
    try {
      src = readFileSync(join(cwd, f), "utf8");
    } catch {
      continue;
    }
    const lines = src.split(/\r?\n/);
    const i = lines.findIndex((l) => re.test(l));
    if (i >= 0) out.push(`${f}:${i + 1}: ${lines[i]!.trim().slice(0, 120)}`);
    if (out.length >= max) break;
  }
  return out;
}

/** The file's own import lines (first 20), so the model reuses what is already imported. */
export function importLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((l) => /^\s*(import\s|from\s+\S+\s+import\s)|^\s*(const|let|var)\s.*require\(|^\s*import\s.*from\s/.test(l))
    .slice(0, 20);
}

/** Where the new test goes: `--test`, else the existing tests/test_<stem>.py (or test_<stem>.py), else a new tests/test_<stem>.py. Python targets only. */
export function testPathFor(cwd: string, target: string, given?: string): string | null {
  if (given) return normpath(given);
  if (extname(target).toLowerCase() !== ".py") return null;
  const stem = basename(target, ".py");
  for (const c of [`tests/test_${stem}.py`, `test_${stem}.py`, `test/test_${stem}.py`]) if (insideFile(cwd, c)) return c;
  return `tests/test_${stem}.py`;
}

export async function runAdd(args: AddArgs, deps: AddDeps): Promise<AddResult> {
  const { cwd, config: cfg } = deps;
  const env = deps.env ?? process.env;
  const tests = deps.runTests ?? realRunTests;
  const lines: string[] = [];
  const say = (l: string) => {
    lines.push(l);
    deps.report(l);
  };
  const pg = deps.progress ?? NOOP_PROGRESS;
  let calls = 0;
  const res = (ok: boolean, target: string | null, test: string | null, files: string[], fix?: FixResult): AddResult => ({ ok, calls, target, test, files, fix, lines });
  if (!args.task) {
    say("usage: /add [--test PATH] [--file PATH] <what to add>");
    return res(false, null, null, []);
  }
  const call = async (step: string, msgs: Message[], opts: { schema?: object; schemaName?: string } = {}): Promise<string> => {
    calls++;
    return (await deps.chat(step, msgs, { ...opts, workflow: "add", config: cfg, env })).text;
  };

  // ---- target file: the hint, else one pick call
  const head = `Repository outline:\n${outline(cwd, 3000)}`;
  let target: string | null = null;
  let extra: string[] = [];
  const hint = args.file ? normpath(args.file) : "";
  if (hint && insideFile(cwd, hint)) target = hint;
  else {
    pg.step("pick file");
    const raw = await call(
      "pick",
      [
        { role: "system", content: ADD_RULES },
        {
          role: "user",
          content:
            `${head}\n\nTask:\n${args.task}\n\nStep 1: reply with JSON {"files": [the one existing file where the new code belongs first, ` +
            `then up to 4 files it uses or that use that area], "reason": "..."}.`,
        },
      ],
      { schema: PICK_SCHEMA, schemaName: "pick" },
    );
    let picked: string[] = [];
    try {
      const j = JSON.parse(raw) as { files?: unknown };
      picked = (Array.isArray(j.files) ? j.files : []).filter((p): p is string => typeof p === "string").map(normpath).slice(0, 5);
    } catch {
      picked = [];
    }
    say(`picked: ${JSON.stringify(picked)}`);
    const have = picked.filter((p) => insideFile(cwd, p));
    target = have.find((p) => !isTestPath(p)) ?? have[0] ?? null;
    extra = have.filter((p) => p !== target).slice(0, 3);
  }
  if (!target) {
    say("/add: could not tell which file the new code belongs in; name it with --file PATH");
    return res(false, null, null, []);
  }
  const testPath = testPathFor(cwd, target, args.test);
  say(`target: ${target}${testPath ? `; test: ${testPath}` : ""}`);

  // ---- context: the target (windowed when long), its imports and importers, the test file if it exists, picked extras
  const targetText = readFileSync(join(cwd, target), "utf8");
  const parts = [head, fence(target, viewText(targetText, args.task, cfg.limits.viewLines))];
  const imps = importLines(targetText);
  if (imps.length) parts.push(`Imports already in ${target}:\n${imps.join("\n")}`);
  const users = importers(cwd, target);
  if (users.length) parts.push(`Files that import ${target}:\n${users.join("\n")}`);
  for (const p of extra) parts.push(fence(p, viewText(readFileSync(join(cwd, p), "utf8"), args.task, cfg.limits.viewLines)));
  if (testPath && insideFile(cwd, testPath)) parts.push(fence(testPath, viewText(readFileSync(join(cwd, testPath), "utf8"), args.task, cfg.limits.viewLines)));
  const testLine = testPath
    ? `Write the new code in ${target} and a test for it in ${testPath}${insideFile(cwd, testPath) ? " (it exists; add to it)" : " (a new file)"}.`
    : `Write the new code in ${target} and a test for it in a test file.`;

  takeSnapshot(cwd, env); // before the first write; /fix --undo restores this (the ladder keeps it: keepUndo)
  pg.step("write");
  const reply = await call("edit", [
    { role: "system", content: ADD_RULES },
    { role: "user", content: `${parts.join("\n\n")}\n\nTask:\n${args.task}\n${testLine}\n\nReply with edit blocks only.` },
  ]);
  const applied = await applyReply(reply, { cwd, protected: [], maxWholeFileLines: 400 });
  for (const f of applied.applied) pg.touch(f);
  const wroteTarget = applied.applied.includes(target);
  const wroteTest = applied.applied.find((p) => isTestPath(p) && p !== target) ?? null;
  const changed = () => changedSinceSnapshot(cwd, env);
  say(`applied: ${JSON.stringify(applied.applied)}${applied.failed.length ? `; not applied: ${JSON.stringify(applied.failed)}` : ""}`);
  const testToRun = wroteTest ?? (testPath && insideFile(cwd, testPath) ? testPath : undefined);
  if (wroteTarget && !wroteTest) say("note: the reply held no test for the new code");

  const handOver = async (why: string): Promise<AddResult> => {
    say(`${why}: handing over to /fix's ladder${testToRun ? ` on ${testToRun}` : ""}`);
    const fp = pg.nest("fix");
    const fix = await runFix(
      {
        test: testToRun,
        undo: false,
        task: `${args.task}\n\n(/add put new code in ${target}${testToRun ? ` with the test ${testToRun}` : ""}; make it work and make the test pass.)`,
      },
      { cwd, config: cfg, chat: deps.chat, pi: deps.pi, report: say, env, runTests: deps.runTests, lint: deps.lint, keepUndo: true, progress: fp },
    ).finally(() => fp.end());
    const ok = fix.solvedBy !== "none";
    return res(ok, target, testToRun ?? null, changed(), fix);
  };

  if (!applied.applied.length) return handOver("no edit could be applied");

  pg.step("test");
  const t = await tests({ cwd, test: testToRun, config: cfg.test });
  say(`test ${testToRun ?? "(suite)"}: ${t.ok ? "pass" : "fail"}`);
  if (!t.ok) return handOver("the test fails");

  pg.step("lint");
  await lintPass(
    { cwd, files: changed(), env },
    { report: say, lint: deps.lint, verify: async () => (await tests({ cwd, test: testToRun, config: cfg.test })).ok },
  );
  const files = changed();
  say(`added: ${files.join(", ")}`);
  say(`calls: ${calls}`);
  return res(true, target, testToRun ?? null, files);
}
