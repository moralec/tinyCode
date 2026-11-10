import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { autoFix, detectConfigured, execShell, findTool, lintPass, type ExecFn } from "../../src/lint.ts";

const repo = (files: Record<string, string>) => {
  const d = tmpDir("tinycode-lint-");
  for (const [f, t] of Object.entries(files)) {
    mkdirSync(join(d, f, ".."), { recursive: true });
    writeFileSync(join(d, f), t);
  }
  return d;
};

test("detectConfigured: from config files only", () => {
  assert.deepEqual(detectConfigured(repo({ "a.py": "" })), []);
  assert.deepEqual(detectConfigured(repo({ "pyproject.toml": "[tool.ruff]\nline-length=100\n[tool.black]\n" })), ["ruff", "black"]);
  assert.deepEqual(detectConfigured(repo({ "ruff.toml": "", ".prettierrc": "{}", "eslint.config.js": "" })), ["ruff", "prettier", "eslint"]);
  assert.deepEqual(detectConfigured(repo({ "package.json": '{"prettier":{"semi":false}}' })), ["prettier"]);
  assert.deepEqual(detectConfigured(repo({ "pyproject.toml": "[project]\nname='x'\n" })), []);
});

test("findTool: node_modules/.bin first, else null when absent from PATH", () => {
  const d = repo({ "node_modules/.bin/prettier": "x" });
  assert.equal(findTool("prettier", d, { PATH: "" }), join(d, "node_modules", ".bin", "prettier"));
  assert.equal(findTool("ruff", d, { PATH: "" }), null);
});

test("autoFix: runs configured+installed tools on the given files only, reports, reverts", async () => {
  const d = repo({ "pyproject.toml": "[tool.black]\n", "a.py": "x=1\n", "b.py": "y=2\n", "c.js": "z\n" });
  const cmds: string[] = [];
  const exec: ExecFn = async (command, cwd) => {
    cmds.push(command);
    writeFileSync(join(cwd, "a.py"), "x = 1\n"); // the fake black reformats a.py
    return { code: 0, out: "" };
  };
  const r = await autoFix({ cwd: d, files: ["a.py", "c.js"], exec, find: (t) => (t === "black" ? "/bin/black" : null) });
  assert.equal(cmds.length, 1);
  assert.match(cmds[0]!, /^\/bin\/black --quiet a\.py$/); // b.py and c.js never passed
  assert.deepEqual(r.changed, ["a.py"]);
  assert.match(r.lines.join("\n"), /lint: black .* 1 file\(s\): rewrote a\.py/);
  r.revert();
  assert.equal(readFileSync(join(d, "a.py"), "utf8"), "x=1\n");
});

test("autoFix: configured but not installed is skipped and reported; nothing configured runs nothing", async () => {
  const d = repo({ "ruff.toml": "", "a.py": "x=1\n" });
  const exec: ExecFn = async () => assert.fail("must not run");
  const r = await autoFix({ cwd: d, files: ["a.py"], exec, find: () => null });
  assert.deepEqual(r.missing, ["ruff"]);
  assert.match(r.lines[0]!, /ruff is configured but not installed, skipped/);
  const none = await autoFix({ cwd: repo({ "a.py": "x" }), files: ["a.py"], exec, find: () => "/bin/ruff" });
  assert.deepEqual(none.steps, []);
  assert.deepEqual(none.lines, []);
});

test("autoFix: ruff gets check --fix then format (format only when black is not configured); prettier/eslint by extension", async () => {
  const d = repo({ "ruff.toml": "", ".prettierrc": "{}", "eslint.config.js": "", "a.py": "", "b.ts": "", "c.md": "" });
  const cmds: string[] = [];
  await autoFix({ cwd: d, files: ["a.py", "b.ts", "c.md"], exec: async (c) => (cmds.push(c), { code: 0, out: "" }), find: (t) => `/x/${t}`, trustRepo: true });
  assert.deepEqual(cmds, ["/x/ruff check --fix --quiet a.py", "/x/ruff format --quiet a.py", "/x/prettier --write --log-level warn b.ts c.md", "/x/eslint --fix b.ts"]);
});

test("lintPass: a rewrite that breaks the check is undone", async () => {
  const d = repo({ ".prettierrc": "{}", "a.ts": "let a=1\n" });
  const exec: ExecFn = async (_c, cwd) => (writeFileSync(join(cwd, "a.ts"), "broken"), { code: 0, out: "" });
  const said: string[] = [];
  await lintPass({ cwd: d, files: ["a.ts"], trustRepo: true }, { report: (l) => said.push(l), verify: async () => false, lint: { exec, find: () => "/p" } });
  assert.equal(readFileSync(join(d, "a.ts"), "utf8"), "let a=1\n");
  assert.match(said.join("\n"), /put back/);
});

test("autoFix untrusted (security audit 2026-11-09): no project binaries, no Node tools; ruff/black from PATH only", async () => {
  const d = repo({ "ruff.toml": "", ".prettierrc": "{}", "eslint.config.js": "", "node_modules/.bin/ruff": "x", "a.py": "", "b.ts": "" });
  assert.equal(findTool("ruff", d, { PATH: "" }, false), null, "node_modules/.bin is not searched");
  const seen: { tool: string; local: boolean }[] = [];
  const cmds: string[] = [];
  const r = await autoFix({ cwd: d, files: ["a.py", "b.ts"], exec: async (c) => (cmds.push(c), { code: 0, out: "" }), find: (t, _c, _e, local) => (seen.push({ tool: t, local: local ?? true }), `/usr/bin/${t}`) });
  assert.deepEqual(cmds, ["/usr/bin/ruff check --fix --quiet a.py", "/usr/bin/ruff format --quiet a.py"]);
  assert.ok(seen.every((s) => s.local === false));
  assert.match(r.lines.join("\n"), /prettier skipped: it can load code from the project/);
  assert.match(r.lines.join("\n"), /eslint skipped/);
});

test("autoFix: file names reach the tool as argv words, never shell text; a leading '-' becomes ./ (security audit 2026-11-09)", async () => {
  const names = ["a;touch PWNED;.py", "b$(touch PWNED2).py", "-rf.py"];
  const d = repo({ "ruff.toml": "", ...Object.fromEntries(names.map((n) => [n, "x = 1\n"])) });
  const argvs: string[][] = [];
  await autoFix({ cwd: d, files: names, exec: async (_c, _cwd, argv) => (argvs.push(argv), { code: 0, out: "" }), find: () => "/usr/bin/ruff" });
  assert.deepEqual(argvs[0], ["/usr/bin/ruff", "check", "--fix", "--quiet", ...names.slice(0, 2), "./-rf.py"]);
});

test("execShell runs the argv with no shell: metacharacters in a file name are not executed", { skip: process.platform === "win32" }, async () => {
  const d = repo({});
  const r = await execShell("echo", d, ["/bin/sh", "-c", 'printf "%s" "$0"', "x;touch PWNED"]);
  assert.equal(r.out, "x;touch PWNED");
  assert.equal(existsSync(join(d, "PWNED")), false);
});
