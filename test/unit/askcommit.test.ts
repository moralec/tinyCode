import assert from "node:assert/strict";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { mergeConfig, type Config } from "../../src/config.ts";
import type { ChatResult, Message } from "../../src/llm.ts";
import { actionable, buildIndex, heuristic, route } from "../../src/router.ts";
import { runAdd } from "../../src/workflows/add.ts";
import { parseAskArgs, runAsk } from "../../src/workflows/ask.ts";
import { COMMIT_RULES, diffForModel, parseCommitArgs, runCommit, validateMessage } from "../../src/workflows/commit.ts";
import { undoFix } from "../../src/workflows/fix.ts";

const ROOT = resolve(import.meta.dirname, "../..");
const PY = (process.env.TINYCODE_TEST_PYTHON ?? "python3");
const cfg = (): Config => mergeConfig({ test: { python: PY }, ladder: { skipSolePick: false } }); // the scripted replies include the pick

function scripted(replies: string[]) {
  const calls: { step: string; messages: Message[] }[] = [];
  let i = 0;
  const chat = async (step: string, messages: Message[]): Promise<ChatResult> => {
    calls.push({ step, messages: structuredClone(messages) });
    assert.ok(i < replies.length, `unexpected extra call #${i + 1} (${step})`);
    return { text: replies[i++]!, usage: { prompt_tokens: 10, cached_tokens: 0, completion_tokens: 5 }, ms: 1, lane: "small", model: "qwen3.5-4b", fellBack: false };
  };
  return { chat, calls };
}
const block = (path: string, search: string, replace: string) => `${path}\n<<<<<<< SEARCH\n${search}\n=======\n${replace}\n>>>>>>> REPLACE\n`;

// ---------------------------------------------------------------- /ask

test("/ask: one call on the 'ask' step with no tools and no repo context; the small lane by default", async () => {
  assert.equal(cfg().steps.ask.lane, "small");
  assert.equal(cfg().steps.commit.lane, "small");
  const s = scripted(["A mutex lets one thread at a time into a critical section."]);
  const lines: string[] = [];
  const r = await runAsk(parseAskArgs("  what is a mutex?  "), { config: cfg(), chat: s.chat, report: (l) => lines.push(l) });
  assert.equal(r.ok, true);
  assert.equal(r.calls, 1);
  assert.deepEqual(s.calls.map((c) => c.step), ["ask"]);
  assert.equal(s.calls[0]!.messages.length, 2);
  assert.equal(s.calls[0]!.messages[1]!.content, "what is a mutex?");
  assert.deepEqual(lines, ["A mutex lets one thread at a time into a critical section.", "calls: 1"]);
  const none = await runAsk({ question: "" }, { config: cfg(), chat: s.chat, report: (l) => lines.push(l) });
  assert.equal(none.calls, 0);
});

// ---------------------------------------------------------------- routing

test("router: general questions go to ask; research phrasing goes to research; repo questions do not", async () => {
  const names = new Map([["textutil.py", "textutil.py"], ["slugify", "textutil.py"]]);
  for (const q of ["what is a mutex?", "what's the difference between a list and a tuple?", "how do I undo the last git commit?", "how to center a div", "should I use tabs or spaces?"]) {
    const r = heuristic(q, names);
    assert.deepEqual([r.workflow, r.confident, actionable(r)], ["ask", true, "ask"], q);
  }
  for (const q of ["find a library for parsing toml in python", "is there a package that renders tables in the terminal?", "any prior art for incremental backups", "research how others do rate limiting", "search github for a markdown linter"]) {
    const r = heuristic(q, names);
    assert.deepEqual([r.workflow, actionable(r)], ["research", "research"], q);
  }
  // not general: names a file, points at "this code", or is a repo-specific why/how-long question (the frozen rows)
  for (const q of ["what does textutil.py do?", "what is wrong with this function?", "why do waiters get sorted by class before arrival?", "how long would a csv export take to build, roughly?", "what does it return?"]) {
    assert.notEqual(heuristic(q, names).workflow, "ask", q);
  }
  assert.equal(heuristic("what does textutil.py do?", names).workflow, "explain");
  assert.equal(heuristic("fix the library import", names).workflow, "fix");
  assert.equal(heuristic("find the bug in this package", names).workflow, "fix");
  // an ask route is decided by code: no model call
  const r = await route("what is a mutex?", { files: [], names: new Map() }, async () => assert.fail("code decides"));
  assert.equal(r.workflow, "ask");
  assert.equal(r.source, "code");
});

// ---------------------------------------------------------------- /commit

const good = "feat(parser): accept trailing commas\n\nThe list grammar rejected `[1, 2,]`. Allow one trailing comma and\nkeep the error for double commas.";

test("validateMessage: conventional subject, 72 characters, blank line, body", () => {
  assert.equal(validateMessage(good).ok, true);
  assert.equal(validateMessage("```\n" + good + "\n```").ok, true, "a fence is stripped");
  assert.equal(validateMessage('"' + good.replace(/\n/g, "\n") + '"').ok, true, "wrapping quotes are stripped");
  const bad = (m: string, re: RegExp) => {
    const r = validateMessage(m);
    assert.equal(r.ok, false, m);
    assert.match(r.reason, re, m);
  };
  bad("", /empty/);
  bad("Update the parser\n\nbody", /<type>/);
  bad("feat: " + "x".repeat(70) + "\n\nbody", /73|limit is 72/);
  bad("feat: ok.\n\nbody", /period/);
  bad("feat: ok", /blank line/);
  bad("feat: ok\nbody right away", /blank line/);
  bad("feat: ok\n\n   \n", /body/);
  assert.equal(validateMessage("feat: " + "x".repeat(66) + "\n\nb").ok, true, "exactly 72 passes");
  assert.deepEqual(parseCommitArgs("--yes tidy up"), { yes: true, hint: "tidy up" });
  assert.deepEqual(parseCommitArgs(""), { yes: false, hint: "" });
});

test("diffForModel: every file shows, each trimmed to its share", () => {
  const f = (n: string) => `diff --git a/${n} b/${n}\n--- a/${n}\n+++ b/${n}\n` + "+line\n".repeat(2000);
  const out = diffForModel(" a | 2000\n b | 2000", f("a") + "\n" + f("b"), 4000);
  assert.ok(out.length < 4200);
  assert.match(out, /diff --git a\/a/);
  assert.match(out, /diff --git a\/b/);
  assert.match(out, /cut/);
});

function repo() {
  const d = tmpDir("tinycode-commit-");
  const git = (...a: string[]) => execFileSync("git", a, { cwd: d, encoding: "utf8" });
  git("init", "-q", ".");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(d, "a.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  return { d, git };
}

test("/commit: staged diff goes in the prompt, message shown, confirmed, committed from a temp file (git log has it)", async () => {
  const { d, git } = repo();
  writeFileSync(join(d, "a.txt"), "one\ntwo\n");
  git("add", "a.txt");
  writeFileSync(join(d, "b.txt"), "unstaged\n");
  const s = scripted([good]);
  const lines: string[] = [];
  const asked: string[] = [];
  const r = await runCommit({ yes: false, hint: "" }, { cwd: d, config: cfg(), chat: s.chat, report: (l) => lines.push(l), confirm: async (q) => (asked.push(q), true) });
  assert.equal(r.outcome, "committed");
  assert.equal(r.calls, 1);
  assert.deepEqual(asked, ["commit with this message?"]);
  assert.equal(s.calls[0]!.messages[0]!.content, COMMIT_RULES);
  assert.match(s.calls[0]!.messages[1]!.content, /diff --git a\/a\.txt[\s\S]*\+two/);
  assert.doesNotMatch(s.calls[0]!.messages[1]!.content, /unstaged/, "only the staged diff is read");
  assert.equal(git("log", "-1", "--format=%B").trim(), good.trim());
  assert.equal(git("status", "--porcelain").trim(), "?? b.txt", "the unstaged file is untouched");
  assert.ok(lines.some((l) => /^committed:/.test(l)));
});

test("/commit: nothing staged: shows changes, -p mode needs --yes, UI asks, decline leaves nothing staged", async () => {
  const { d, git } = repo();
  writeFileSync(join(d, "a.txt"), "one\ntwo\n");
  const s = scripted([good]);
  const lines: string[] = [];
  // no UI, no --yes: nothing happens, no call
  let r = await runCommit({ yes: false, hint: "" }, { cwd: d, config: cfg(), chat: s.chat, report: (l) => lines.push(l) });
  assert.equal(r.outcome, "nothing");
  assert.equal(r.calls, 0);
  assert.ok(lines.some((l) => /M a\.txt/.test(l)) && lines.some((l) => /without --yes/.test(l)));
  assert.equal(git("diff", "--staged").trim(), "");
  // UI says no to staging
  r = await runCommit({ yes: false, hint: "" }, { cwd: d, config: cfg(), chat: s.chat, report: () => {}, confirm: async () => false });
  assert.equal(r.outcome, "declined");
  assert.equal(git("diff", "--staged").trim(), "");
  // UI says yes to staging but no to the message: staging is undone
  let n = 0;
  r = await runCommit({ yes: false, hint: "" }, { cwd: d, config: cfg(), chat: s.chat, report: (l) => lines.push(l), confirm: async () => ++n === 1 });
  assert.equal(r.outcome, "declined");
  assert.equal(git("diff", "--staged").trim(), "", "staging this run did is undone");
  assert.equal(git("log", "--oneline").trim().split("\n").length, 1);
  // --yes without a UI stages all and commits
  const s2 = scripted([good]);
  r = await runCommit({ yes: true, hint: "" }, { cwd: d, config: cfg(), chat: s2.chat, report: () => {} });
  assert.equal(r.outcome, "committed");
  assert.equal(git("log", "--oneline").trim().split("\n").length, 2);
  // clean tree
  const r3 = await runCommit({ yes: true, hint: "" }, { cwd: d, config: cfg(), chat: s2.chat, report: () => {} });
  assert.equal(r3.outcome, "nothing");
});

test("/commit: a bad message gets one retry with the reason appended; still bad: refused, nothing committed", async () => {
  const { d, git } = repo();
  writeFileSync(join(d, "a.txt"), "x\n");
  git("add", "-A");
  const long = "feat: " + "word ".repeat(20) + "\n\nbody";
  const s = scripted([long, good]);
  const lines: string[] = [];
  let r = await runCommit({ yes: true, hint: "" }, { cwd: d, config: cfg(), chat: s.chat, report: (l) => lines.push(l) });
  assert.equal(r.outcome, "committed");
  assert.equal(r.calls, 2);
  assert.equal(s.calls[1]!.messages.length, 4);
  assert.match(s.calls[1]!.messages[3]!.content, /refused: the subject is \d+ characters; the limit is 72/);
  assert.equal(s.calls[1]!.messages[0]!.content, s.calls[0]!.messages[0]!.content, "append-only retry");
  writeFileSync(join(d, "a.txt"), "y\n");
  git("add", "-A");
  const s2 = scripted(["Updated stuff", "still not conventional"]);
  r = await runCommit({ yes: true, hint: "" }, { cwd: d, config: cfg(), chat: s2.chat, report: (l) => lines.push(l) });
  assert.equal(r.outcome, "refused");
  assert.equal(r.calls, 2);
  assert.equal(git("log", "--oneline").trim().split("\n").length, 2);
  assert.equal(git("diff", "--staged", "--name-only").trim(), "a.txt", "what the user staged stays staged");
});

test("/commit: a failing pre-commit hook is reported, never bypassed (no --no-verify), nothing committed", { skip: process.platform === "win32" }, async () => {
  const { d, git } = repo();
  writeFileSync(join(d, ".git", "hooks", "pre-commit"), "#!/bin/sh\necho 'lint says no' >&2\nexit 1\n");
  chmodSync(join(d, ".git", "hooks", "pre-commit"), 0o755);
  writeFileSync(join(d, "a.txt"), "z\n");
  const s = scripted([good]);
  const lines: string[] = [];
  const r = await runCommit({ yes: true, hint: "" }, { cwd: d, config: cfg(), chat: s.chat, report: (l) => lines.push(l) });
  assert.equal(r.outcome, "failed");
  assert.ok(lines.some((l) => /lint says no/.test(l)));
  assert.equal(git("log", "--oneline").trim().split("\n").length, 1);
  assert.equal(git("diff", "--staged").trim(), "", "the staging this run did is undone");
  // the source never passes --no-verify
  assert.doesNotMatch(readFileSync(join(ROOT, "src/workflows/commit.ts"), "utf8").replace(/\/\/.*$/gm, ""), /no-verify|"-n"/);
});

test("/commit: not a git repository", async () => {
  const d = tmpDir("tinycode-nogit-");
  const lines: string[] = [];
  const r = await runCommit({ yes: true, hint: "" }, { cwd: d, config: cfg(), chat: scripted([]).chat, report: (l) => lines.push(l) });
  assert.equal(r.outcome, "failed");
  assert.match(lines[0]!, /not a git repository/);
});

// ---------------------------------------------------------------- the undo fix

test("/fix --undo after /add handed over to the ladder restores the state from before /add (earliest snapshot kept)", async () => {
  const d = tmpDir("tinycode-undo-");
  const cwd = join(d, "repo");
  cpSync(join(ROOT, "test/fixtures/task-repos/t03-slugify"), cwd, { recursive: true, filter: (s) => !s.includes("__pycache__") });
  const env = { TINYCODE_LOG: join(d, "state", "calls.jsonl") };
  const before = readFileSync(join(cwd, "textutil.py"), "utf8");
  const s = scripted([
    block("textutil.py", "def title_case(text):", "def word_count(text):\n    return len(text.split(' '))\n\n\ndef title_case(text):") +
      block("tests/test_textutil.py", "", "from textutil import word_count\n\n\ndef test_word_count():\n    assert word_count('a b  c') == 3\n"),
    JSON.stringify({ files: ["textutil.py"], reason: "word_count splits on one space" }),
    block("textutil.py", "return len(text.split(' '))", "return len(text.split())"),
  ]);
  const r = await runAdd({ file: "textutil.py", task: "add word_count(text)" }, { cwd, config: cfg(), chat: s.chat, report: () => {}, env });
  assert.equal(r.fix?.solvedBy, "rung1", "the ladder took over and solved it");
  assert.deepEqual(r.files, ["tests/test_textutil.py", "textutil.py"], "changes are still counted against /add's snapshot");
  assert.match(readFileSync(join(cwd, "textutil.py"), "utf8"), /def word_count/);
  const msg = undoFix(cwd, env);
  assert.match(msg, /^undone: restored 1 file\(s\), removed 1 created file\(s\)/);
  assert.equal(readFileSync(join(cwd, "textutil.py"), "utf8"), before, "textutil.py is as before /add");
  assert.equal(existsSync(join(cwd, "tests/test_textutil.py")), false, "the test /add created is gone too");
});
