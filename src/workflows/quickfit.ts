// Window-sized quick tries (issue #10): a rung-1 or second-try prompt must leave `ladder.replyReserve` tokens for the
// reply inside the lane's contextWindow. Evidence: 8k window (P4000, gemma-4-12b, bowling) rung 1 sent 7.1k tokens
// (instructions + the whole 31-test file + outline); the reply hit the window at 1110 tokens and nothing applied.
// A prompt that does not fit is shrunk, in this order: the outline is left out, the test file shows only the failing
// tests, the test output keeps its count line, the task text is cut in the middle with a marker. The source files being
// edited are never cut: when they alone do not fit, the quick tries are skipped and the task goes to Pi's loop.
import type { Message } from "../llm.ts";

/** chat-template tokens per message (role markers, separators) on top of the text */
const MSG_TOKENS = 8;

/** Prompt size estimate: characters / `charsPerToken` (ladder.charsPerToken) plus a few tokens per message. */
export function estTokens(msgs: Message[], charsPerToken: number): number {
  return msgs.reduce((n, m) => n + MSG_TOKENS + Math.ceil(m.content.length / charsPerToken), 0);
}

/** The parts of the rung-1 first user message, each one the shrink can cut. */
export interface QuickHead {
  /** the repository outline (without its heading); null = none */
  outline: string | null;
  /** the given test file, shown whole unless cut to its failing tests */
  test: { path: string; text: string } | null;
  /** test names failing on the original tree (the `name` part of path::Class::name) */
  failing: string[];
  /** "Test output now" text; null when there is no test file to show */
  testOut: string | null;
  task: string;
}

export const STEP1 = '\n\nStep 1: JSON {"files": [max 5 outline paths to read or change], "reason": "..."}. Include files to create if folder exists.';

export const fence = (path: string, text: string): string => `${path}\n\`\`\`\n${text}\`\`\``;

/** The first user message of rung 1 from its parts: unchanged parts give the text the ladder always sent. */
export function headText(h: QuickHead): string {
  const head: string[] = [];
  if (h.outline !== null) head.push("Repository outline:\n" + h.outline);
  if (h.test) head.push(fence(h.test.path, h.test.text), "Test output now:\n" + (h.testOut ?? ""));
  return (head.length ? head.join("\n\n") + "\n\n" : "") + "Task:\n" + h.task + STEP1;
}

const testName = (n: string): string => (n.split("::").pop() ?? n).replace(/\[.*$/, "").trim();

/**
 * A Python test file with the bodies of passing tests left out (top-level `def test_*` and methods alike; helpers,
 * imports, classes and setUp stay), and one marker line saying how many were left out. null when nothing would be
 * left out (every test fails, or the file is not Python), or when a failing name is not a test of the file (a name cut
 * off in a capped test output: then which tests pass is not known, and none is left out).
 */
export function failingTestsOnly(path: string, text: string, failing: string[]): string | null {
  if (!/\.py$/.test(path) || !failing.length) return null;
  const want = new Set(failing.map(testName));
  const lines = text.split("\n");
  const out: string[] = [];
  let dropped = 0;
  let found = 0;
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; ) {
    const m = lines[i]!.match(/^(\s*)(?:async\s+)?def\s+(test\w*)\s*\(/);
    if (!m) {
      out.push(lines[i]!);
      i++;
      continue;
    }
    const indent = m[1]!.length;
    let end = i + 1;
    while (end < lines.length && (!lines[end]!.trim() || lines[end]!.search(/\S/) > indent)) end++;
    // trailing blank lines belong to the gap before the next block
    let last = end;
    while (last > i + 1 && !lines[last - 1]!.trim()) last--;
    if (want.has(m[2]!)) {
      if (!seen.has(m[2]!)) found++;
      seen.add(m[2]!);
      out.push(...lines.slice(i, end));
    } else {
      // decorators directly above belong to the dropped test
      while (out.length && /^\s*@/.test(out[out.length - 1]!) && out[out.length - 1]!.search(/\S/) === indent) out.pop();
      dropped++;
      out.push(...lines.slice(last, end));
    }
    i = end;
  }
  if (found < want.size || !dropped) return null;
  return `${out.join("\n").replace(/\n{3,}/g, "\n\n")}${text.endsWith("\n") ? "" : "\n"}# [${dropped} passing tests not shown]\n`;
}

/**
 * The code of the tests named (helpers, imports and classes kept, see failingTestsOnly); the whole file when they are
 * all its tests; null when a name is not a test of the file or the file is not Python.
 */
export function failingTestsCode(path: string, text: string, names: string[]): string | null {
  const only = failingTestsOnly(path, text, names);
  if (only !== null || !/\.py$/.test(path) || !names.length) return only;
  return names.every((n) => new RegExp(`def\\s+${testName(n).replace(/\W/g, "")}\\s*\\(`).test(text)) ? text : null;
}

/** The test output's first line (the counts) and a marker. */
const testOutCut = (t: string): string => `${t.split("\n")[0]}\n[test output cut for room; failing tests shown above]`;

/** The task text cut to at most `max` characters: its head and its last lines (the ask), with a marker between. */
export function cutMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const MARK = "\n[task text cut here for room]\n";
  const tail = Math.min(400, Math.floor((max - MARK.length) / 3));
  const head = Math.max(0, max - MARK.length - tail);
  const h = text.slice(0, head);
  const nl = h.lastIndexOf("\n");
  const t = text.slice(text.length - tail);
  const tl = t.indexOf("\n");
  return (nl > 0 ? h.slice(0, nl) : h) + MARK + (tl >= 0 && tl < t.length - 1 ? t.slice(tl + 1) : t);
}

/** Least task text a cut keeps (characters); a prompt that needs a deeper cut is not sent. */
export const MIN_TASK_CHARS = 400;

export interface FitOpts {
  /** the lane's context window, tokens */
  window: number;
  /** tokens kept for the reply */
  reserve: number;
  /** the step's own reply cap (limits.maxTokens[step]); max_tokens never goes above it */
  stepMax: number;
  charsPerToken: number;
  /** the pick call needs the outline to pick from: never left out */
  keepOutline?: boolean;
}

export interface Fit {
  msgs: Message[];
  /** estimated prompt tokens */
  tokens: number;
  /** max_tokens for the call: the room left, at most stepMax */
  maxTokens: number;
  /** what was cut, in order ("" none) */
  cuts: string[];
}

/** max_tokens for a prompt of `tokens`: the room left in the window, at most the step's cap. */
export const roomLeft = (tokens: number, o: FitOpts): number => Math.max(0, Math.min(o.stepMax, o.window - tokens));

/** A fixed prompt (no parts to cut) when it fits, else null. */
export function fitFixed(msgs: Message[], o: FitOpts): Fit | null {
  const tokens = estTokens(msgs, o.charsPerToken);
  return tokens + o.reserve <= o.window ? { msgs, tokens, maxTokens: roomLeft(tokens, o), cuts: [] } : null;
}

/**
 * The first prompt `build(headText)` that fits, shrinking the head step by step; null when even the deepest cut leaves
 * too little room (the rest of the prompt, the source files, is never cut).
 */
export function fitHead(h: QuickHead, build: (head: string) => Message[], o: FitOpts): Fit | null {
  const tryOne = (x: QuickHead, cuts: string[]): Fit | null => {
    const f = fitFixed(build(headText(x)), o);
    return f ? { ...f, cuts } : null;
  };
  let cur = h;
  const cuts: string[] = [];
  const first = tryOne(cur, []);
  if (first) return first;
  if (!o.keepOutline && cur.outline !== null) {
    cur = { ...cur, outline: null };
    cuts.push("outline");
    const f = tryOne(cur, [...cuts]);
    if (f) return f;
  }
  if (cur.test) {
    const only = failingTestsOnly(cur.test.path, cur.test.text, cur.failing);
    if (only !== null) {
      cur = { ...cur, test: { ...cur.test, text: only } };
      cuts.push("passing tests");
      const f = tryOne(cur, [...cuts]);
      if (f) return f;
    }
    if (cur.testOut !== null && cur.testOut.includes("\n")) {
      cur = { ...cur, testOut: testOutCut(cur.testOut) };
      cuts.push("test output");
      const f = tryOne(cur, [...cuts]);
      if (f) return f;
    }
  }
  // the task: cut to the characters the room allows
  const over = estTokens(build(headText(cur)), o.charsPerToken) + o.reserve - o.window;
  const keep = cur.task.length - Math.ceil(over * o.charsPerToken) - 40;
  if (keep < MIN_TASK_CHARS) return null;
  cuts.push("task text");
  return tryOne({ ...cur, task: cutMiddle(cur.task, keep) }, cuts);
}
