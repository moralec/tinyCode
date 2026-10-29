import assert from "node:assert/strict";
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { mergeConfig, type Config } from "../../src/config.ts";
import type { ChatResult, Message } from "../../src/llm.ts";
import { run, scptRoutine } from "../../src/routines/index.ts";
import { parseEditArgs, runEdit, viewText } from "../../src/workflows/edit.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const PY = (process.env.TINYCODE_TEST_PYTHON ?? "python3");
const cfg = (): Config => mergeConfig({ test: { python: PY } });
const mac = scptRoutine.available().ok;

function scripted(replies: string[]) {
  const calls: { step: string; messages: Message[] }[] = [];
  let i = 0;
  const chat = async (step: string, messages: Message[]): Promise<ChatResult> => {
    calls.push({ step, messages: structuredClone(messages) });
    assert.ok(i < replies.length, `unexpected extra call #${i + 1}`);
    return { text: replies[i++]!, usage: { prompt_tokens: 10, cached_tokens: 0, completion_tokens: 5 }, ms: 1, lane: "trunk", model: "gemma-4-12b", fellBack: false };
  };
  return { chat, calls };
}

function slugRepo() {
  const d = mkdtempSync(join(tmpdir(), "tinycode-edit-"));
  const cwd = join(d, "repo");
  cpSync(join(ROOT, "test/fixtures/task-repos/t03-slugify"), cwd, { recursive: true, filter: (s) => !s.includes("__pycache__") });
  return cwd;
}

const block = (path: string, search: string, replace: string) => `${path}\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n`;

test("parseEditArgs: path first, --test optional, unknown first word is part of the instruction", () => {
  const cwd = slugRepo();
  assert.deepEqual(parseEditArgs("textutil.py add a parameter", cwd), { test: undefined, path: "textutil.py", instruction: "add a parameter" });
  assert.deepEqual(parseEditArgs("--test tests/test_x.py textutil.py do it", cwd), { test: "tests/test_x.py", path: "textutil.py", instruction: "do it" });
  assert.deepEqual(parseEditArgs("x.scpt change the greeting", cwd), { test: undefined, path: "x.scpt", instruction: "change the greeting" });
  assert.deepEqual(parseEditArgs("make it faster", cwd), { test: undefined, instruction: "make it faster" });
});

test("viewText: short file whole; long file windows around named symbols, verbatim, with omitted markers", () => {
  const short = "a\nb\n";
  assert.equal(viewText(short, "x", 100), short);
  const lines = Array.from({ length: 1000 }, (_, i) => (i === 700 ? "def target_func(x):" : `line ${i}`));
  const v = viewText(lines.join("\n") + "\n", "change target_func to accept y", 100);
  assert.match(v, /def target_func\(x\):/);
  assert.match(v, /\.\.\. \[lines 1-\d+ omitted\]/);
  assert.match(v, /\.\.\. \[lines \d+-1000 omitted\]/);
  assert.ok(v.split("\n").length < 140);
  const none = viewText(lines.join("\n") + "\n", "zzzzzz", 100);
  assert.match(none, /^line 0\n/);
  assert.match(none, /omitted/);
});

test("py edit: one call, py_compile passes, outline + file in the prompt", async () => {
  const cwd = slugRepo();
  const src = readFileSync(join(cwd, "textutil.py"), "utf8");
  const def = src.match(/def slugify\([^)]*\):/)![0];
  const { chat, calls } = scripted([block("textutil.py", def, def.replace("):", ", sep=\"-\"):"))]);
  const out: string[] = [];
  const r = await runEdit({ path: "textutil.py", instruction: "add a parameter sep to slugify" }, { cwd, config: cfg(), chat, report: (l) => out.push(l) });
  assert.equal(r.ok, true);
  assert.equal(r.calls, 1);
  assert.match(readFileSync(join(cwd, "textutil.py"), "utf8"), /def slugify\([^)]*sep="-"\):/);
  assert.equal(calls[0]!.step, "edit");
  assert.match(calls[0]!.messages[1]!.content, /Repository outline:/);
  assert.match(calls[0]!.messages[1]!.content, /textutil\.py\n```\n/);
  assert.equal(existsSync(join(cwd, "__pycache__")), false);
  assert.ok(out.includes("calls: 1"));
});

test("py edit: failing check retries once with the output appended, then passes", async () => {
  const cwd = slugRepo();
  const src = readFileSync(join(cwd, "textutil.py"), "utf8");
  const def = src.match(/def slugify\([^)]*\):/)![0];
  const { chat, calls } = scripted([
    block("textutil.py", def, def.replace("):", ", sep=\"-\""))  /* missing ): syntax error */,
    block("textutil.py", def.replace("):", ", sep=\"-\""), def.replace("):", ", sep=\"-\"):")),
  ]);
  const r = await runEdit({ path: "textutil.py", instruction: "add a parameter sep" }, { cwd, config: cfg(), chat, report: () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.calls, 2);
  const retry = calls[1]!.messages;
  assert.equal(retry.length, 4);
  assert.match(retry[3]!.content, /Check failed:\npy_compile failed/);
  assert.match(readFileSync(join(cwd, "textutil.py"), "utf8"), /sep="-"\):/);
});

test("py edit: two failures restore the original bytes and offer rung 3", async () => {
  const cwd = slugRepo();
  const before = readFileSync(join(cwd, "textutil.py"));
  const src = before.toString("utf8");
  const def = src.match(/def slugify\([^)]*\):/)![0];
  const bad = def.replace("):", ", sep=");
  const { chat } = scripted([block("textutil.py", def, bad), block("textutil.py", bad, bad + " +")]);
  const out: string[] = [];
  const r = await runEdit({ path: "textutil.py", instruction: "add a parameter" }, { cwd, config: cfg(), chat, report: (l) => out.push(l) });
  assert.equal(r.ok, false);
  assert.equal(r.offerFix, true);
  assert.equal(r.calls, 2);
  assert.ok(readFileSync(join(cwd, "textutil.py")).equals(before));
  assert.ok(out.some((l) => /restored to the original/.test(l)));
});

test("py edit: a block that does not match is reported and retried; edits to other files are ignored", async () => {
  const cwd = slugRepo();
  const before = readFileSync(join(cwd, "textutil.py"), "utf8");
  const def = before.match(/def slugify\([^)]*\):/)![0];
  const { chat, calls } = scripted([
    block("textutil.py", "this text is not in the file", "x") + block("other.py", "", "print(1)"),
    block("textutil.py", def, def.replace("):", ", sep=\"-\"):")),
  ]);
  const out: string[] = [];
  const r = await runEdit({ path: "textutil.py", instruction: "add sep" }, { cwd, config: cfg(), chat, report: (l) => out.push(l) });
  assert.equal(r.ok, true);
  assert.equal(r.calls, 2);
  assert.match(calls[1]!.messages[3]!.content, /not applied: textutil\.py \(not found\)/);
  assert.equal(existsSync(join(cwd, "other.py")), false, "other files are never created");
});

test("py edit with a test: the configured test decides the check", async () => {
  const cwd = slugRepo();
  const src = readFileSync(join(cwd, "textutil.py"), "utf8");
  const def = src.match(/def slugify\([^)]*\):/)![0];
  const { chat } = scripted([block("textutil.py", def, def), block("textutil.py", def, def)]);
  // the repo's slugify bug is unfixed, so the whole-suite test fails: both attempts fail, the file is restored
  const r = await runEdit({ path: "textutil.py", instruction: "no-op", test: "tests" }, { cwd, config: cfg(), chat, report: () => {} });
  assert.equal(r.ok, false);
  assert.equal(r.offerFix, true);
});

test("/edit x.scpt returns the routine's why when it is unavailable", { skip: mac ? "needs a machine without the AppleScript tools" : false }, async () => {
  const d = mkdtempSync(join(tmpdir(), "tinycode-edit-"));
  const out: string[] = [];
  const { chat } = scripted([]);
  const r = await runEdit({ path: "x.scpt", instruction: "change the greeting" }, { cwd: d, config: cfg(), chat, report: (l) => out.push(l) });
  assert.equal(r.ok, false);
  assert.equal(r.calls, 0);
  assert.equal(r.unavailable, "AppleScript routine needs macOS");
  assert.deepEqual(out, ["AppleScript routine needs macOS"]);
});

test("scpt edit on macOS: scripted edit shows after osadecompile; a bad edit leaves the original intact", { skip: mac ? false : "skipped: needs macOS" }, async () => {
  const d = mkdtempSync(join(tmpdir(), "tinycode-edit-"));
  copyFileSync(join(ROOT, "test/fixtures/scpt/hello.applescript"), join(d, "hello.applescript"));
  assert.equal((await run("osacompile", ["-o", join(d, "hello.scpt"), join(d, "hello.applescript")])).code, 0);
  const f = join(d, "hello.scpt");
  const orig = readFileSync(f);

  const good = scripted([block("hello.applescript", 'return "Hello, " & who', 'return "Howdy, " & who')]);
  const r = await runEdit({ path: "hello.scpt", instruction: "greet with Howdy" }, { cwd: d, config: cfg(), chat: good.chat, report: () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.calls, 1);
  assert.match(good.calls[0]!.messages[1]!.content, /hello\.applescript\n```\n/);
  const dec = await run("osadecompile", [f]);
  assert.match(dec.out, /Howdy, /);
  assert.ok(readFileSync(f + ".bak").equals(orig));

  copyFileSync(f + ".bak", f);
  const before = readFileSync(f);
  const badEdit = block("hello.applescript", 'return "Hello, " & who', 'return "Hello, " &');
  const bad = scripted([badEdit, badEdit]);
  const r2 = await runEdit({ path: "hello.scpt", instruction: "break it" }, { cwd: d, config: cfg(), chat: bad.chat, report: () => {} });
  assert.equal(r2.ok, false);
  assert.equal(r2.offerFix, true);
  assert.ok(readFileSync(f).equals(before), "original intact");
  assert.match((await run("osadecompile", [f])).out, /Hello, /);
});
