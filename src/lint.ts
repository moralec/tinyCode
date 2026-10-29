// Formatter/linter auto-fix after an editing workflow (README rule 13). Shared by /add, /edit and /fix.
// Detects ruff, black, prettier and eslint from the project's own config files, runs a tool only when it is both
// configured and installed (cwd's node_modules/.bin or .venv, else PATH), never installs anything, and only passes
// the files the workflow changed. Pure Node: no Unix tools, paths through node:path, user tools spawned with
// shell: true. `autoFix` returns what ran and a `revert` so the caller can undo the pass if its check then fails.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, relative, resolve } from "node:path";

export type LintTool = "ruff" | "black" | "prettier" | "eslint";

const PY_EXT = new Set([".py", ".pyi"]);
const JS_EXT = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]);
const PRETTIER_EXT = new Set([...JS_EXT, ".json", ".css", ".scss", ".html", ".md", ".yml", ".yaml", ".vue"]);

const read = (p: string): string | null => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};
const anyExists = (cwd: string, names: string[]) => names.some((n) => existsSync(join(cwd, n)));

/** Tools the project configures (by config files only; installed or not). Order is the run order. */
export function detectConfigured(cwd: string): LintTool[] {
  const out: LintTool[] = [];
  const pyproject = read(join(cwd, "pyproject.toml")) ?? "";
  const pkgText = read(join(cwd, "package.json"));
  let pkg: Record<string, unknown> = {};
  try {
    pkg = pkgText ? (JSON.parse(pkgText) as Record<string, unknown>) : {};
  } catch {
    pkg = {};
  }
  if (anyExists(cwd, ["ruff.toml", ".ruff.toml"]) || /^\s*\[tool\.ruff[\].]/m.test(pyproject)) out.push("ruff");
  if (/^\s*\[tool\.black[\].]/m.test(pyproject)) out.push("black");
  const prettierNames = [".prettierrc", ".prettierrc.json", ".prettierrc.yml", ".prettierrc.yaml", ".prettierrc.json5", ".prettierrc.js", ".prettierrc.cjs", ".prettierrc.mjs", ".prettierrc.toml", "prettier.config.js", "prettier.config.cjs", "prettier.config.mjs", "prettier.config.ts"];
  if (anyExists(cwd, prettierNames) || "prettier" in pkg) out.push("prettier");
  const eslintNames = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts", ".eslintrc", ".eslintrc.js", ".eslintrc.cjs", ".eslintrc.json", ".eslintrc.yml", ".eslintrc.yaml"];
  if (anyExists(cwd, eslintNames) || "eslintConfig" in pkg) out.push("eslint");
  return out;
}

/** The executable for a tool, or null when it is not installed: project-local first, then PATH. */
export function findTool(tool: LintTool, cwd: string, env: Record<string, string | undefined> = process.env): string | null {
  const win = process.platform === "win32";
  const exts = win ? ["", ".exe", ".cmd", ".bat"] : [""];
  const dirs = [join(cwd, "node_modules", ".bin"), join(cwd, ".venv", win ? "Scripts" : "bin"), join(cwd, "venv", win ? "Scripts" : "bin")];
  dirs.push(...(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean));
  for (const d of dirs) {
    for (const e of exts) {
      const p = join(d, tool + e);
      try {
        if (statSync(p).isFile()) return p;
      } catch {
        // next
      }
    }
  }
  return null;
}

export interface ExecResult {
  code: number | null;
  out: string;
}
export type ExecFn = (command: string, cwd: string) => Promise<ExecResult>;

/** Default runner: shell: true, output captured, 120 s limit. */
export const execShell: ExecFn = (command, cwd) =>
  new Promise((done) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const chunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => chunks.push(d));
    let finished = false;
    const finish = (code: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done({ code, out: Buffer.concat(chunks).toString("utf8").replace(/\r\n/g, "\n") });
    };
    const timer = setTimeout(() => finish(null), 120_000);
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });

const quote = (s: string) => (/[\s"&|<>^()]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);

export interface LintStep {
  tool: LintTool;
  command: string;
  files: string[];
  code: number | null;
  /** files whose bytes changed in this step */
  changed: string[];
}

export interface LintReport {
  steps: LintStep[];
  /** configured tools that were not installed (nothing was run for them) */
  missing: LintTool[];
  /** every file a tool rewrote */
  changed: string[];
  /** one human line per step / skip, ready for `say` */
  lines: string[];
  /** put every file back to its bytes from before the pass */
  revert: () => void;
}

export interface LintOptions {
  cwd: string;
  /** the files the workflow changed (relative to cwd or absolute); anything else is never touched */
  files: string[];
  env?: Record<string, string | undefined>;
  exec?: ExecFn;
  find?: typeof findTool;
}

const bytes = (abs: string): Buffer | null => {
  try {
    return readFileSync(abs);
  } catch {
    return null;
  }
};

export async function autoFix(opts: LintOptions): Promise<LintReport> {
  const cwd = resolve(opts.cwd);
  const exec = opts.exec ?? execShell;
  const find = opts.find ?? findTool;
  const rels = [...new Set(opts.files.map((f) => (isAbsolute(f) ? relative(cwd, f) : f).split("\\").join("/")))].filter((f) => {
    if (!f || f.startsWith("..") || isAbsolute(f)) return false;
    try {
      return statSync(join(cwd, f)).isFile();
    } catch {
      return false;
    }
  });
  const report: LintReport = { steps: [], missing: [], changed: [], lines: [], revert: () => {} };
  if (!rels.length) return report;
  const before = new Map(rels.map((f) => [f, bytes(join(cwd, f))] as const));
  report.revert = () => {
    for (const [f, b] of before) if (b) writeFileSync(join(cwd, f), b);
  };
  const configured = detectConfigured(cwd);
  const forExt = (exts: Set<string>) => rels.filter((f) => exts.has(extname(f).toLowerCase()));

  const plan: { tool: LintTool; args: string; files: string[] }[] = [];
  for (const tool of configured) {
    if (tool === "ruff") {
      const files = forExt(PY_EXT);
      if (files.length) plan.push({ tool, args: "check --fix --quiet", files });
      // black owns formatting when both are configured
      if (files.length && !configured.includes("black")) plan.push({ tool, args: "format --quiet", files });
    } else if (tool === "black") {
      const files = forExt(PY_EXT);
      if (files.length) plan.push({ tool, args: "--quiet", files });
    } else if (tool === "prettier") {
      const files = forExt(PRETTIER_EXT);
      if (files.length) plan.push({ tool, args: "--write --log-level warn", files });
    } else {
      const files = forExt(JS_EXT);
      if (files.length) plan.push({ tool, args: "--fix", files });
    }
  }
  const exe = new Map<LintTool, string | null>();
  for (const p of plan) {
    if (!exe.has(p.tool)) exe.set(p.tool, find(p.tool, cwd, opts.env ?? process.env));
    const path = exe.get(p.tool);
    if (!path) {
      if (!report.missing.includes(p.tool)) {
        report.missing.push(p.tool);
        report.lines.push(`lint: ${p.tool} is configured but not installed, skipped`);
      }
      continue;
    }
    const command = `${quote(path)} ${p.args} ${p.files.map(quote).join(" ")}`;
    const snap = new Map(p.files.map((f) => [f, bytes(join(cwd, f))] as const));
    const r = await exec(command, cwd);
    const changed = p.files.filter((f) => {
      const a = snap.get(f);
      const b = bytes(join(cwd, f));
      return !!a && !!b && !a.equals(b);
    });
    for (const f of changed) if (!report.changed.includes(f)) report.changed.push(f);
    report.steps.push({ tool: p.tool, command, files: p.files, code: r.code, changed });
    const note = r.code === 0 ? "" : r.code === null ? ", did not finish" : `, exit ${r.code} (issues it could not fix remain)`;
    report.lines.push(`lint: ${[p.tool, ...p.args.split(" ").filter((a) => !["--quiet", "--log-level", "warn"].includes(a))].join(" ")} on ${p.files.length} file(s): ${changed.length ? `rewrote ${changed.join(", ")}` : "no change"}${note}`);
  }
  return report;
}

export interface LintPass {
  report: (line: string) => void;
  /** re-run the workflow's check after a tool rewrote files; false = the rewrite broke it */
  verify?: () => Promise<boolean>;
  /** test hook: replaces the real runner / finder */
  lint?: Pick<LintOptions, "exec" | "find">;
}

/** Run autoFix for the changed files, report what ran, and undo the pass if it broke the workflow's check. */
export async function lintPass(opts: Pick<LintOptions, "cwd" | "files" | "env">, pass: LintPass): Promise<LintReport> {
  const r = await autoFix({ ...opts, ...pass.lint });
  for (const l of r.lines) pass.report(l);
  if (r.changed.length && pass.verify && !(await pass.verify())) {
    r.revert();
    pass.report("lint: the check failed after the rewrite, so the files were put back as they were before lint");
  }
  return r;
}
