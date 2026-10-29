// Plain-language sentences for the chat heartbeat and the end summary. Templates only: no model call.
// Every workflow phase label maps to a present-tense phrase ("summarising the project's files") and a future one
// ("summarise the folders"); labels that carry data (`check "How It Works"`, `task 3/5: add check`) are parsed.

export interface PhaseView {
  label: string;
  i?: number;
  n?: number;
}

interface Phrase {
  now: string;
  will: string;
  /** collapse key: consecutive upcoming phases with the same key read as one group */
  key?: string;
}

const TABLE: Record<string, [string, string]> = {
  scan: ["scanning the project", "scan the project"],
  "summarising files": ["summarising the project's files", "summarise the files"],
  "summarising folders": ["summarising the folders", "summarise the folders"],
  "writing sections": ["writing the README sections", "write the README sections"],
  "self-check": ["running a self-check against the code", "do a quick self-check"],
  render: ["rendering the result", "render the result"],
  "find target": ["finding what to work on", "find what to work on"],
  "read diff": ["reading the diff", "read the diff"],
  "write message": ["writing the commit message", "write the commit message"],
  commit: ["committing", "commit"],
  "pick file": ["choosing which file to change", "choose the file to change"],
  "pick files": ["choosing which files to change", "choose the files to change"],
  write: ["writing the change", "write the change"],
  test: ["running the tests", "run the tests"],
  lint: ["linting the result", "lint the result"],
  research: ["researching the code", "research the code"],
  plan: ["drafting the plan", "draft the plan"],
  save: ["saving the result", "save the result"],
  "document symbols": ["documenting the symbols", "document the symbols"],
  check: ["checking the result", "check the result"],
  "review hunks": ["reviewing the changes", "review the changes"],
  review: ["reviewing the change", "review the change"],
  merge: ["merging the review notes", "merge the review notes"],
  edit: ["editing the file", "edit the file"],
  "second edit": ["making a second attempt at the edit", "make a second attempt"],
  baseline: ["running a baseline test", "run a baseline test"],
  "write tests": ["writing the tests", "write the tests"],
  "run tests": ["running the new tests", "run the new tests"],
  retry: ["retrying after a failure", "retry"],
  answer: ["writing the answer", "write the answer"],
  "check citations": ["checking the citations", "check the citations"],
  loop: ["working through the fix step by step", "work through the fix"],
};

const CHECK = /^check "(.*)"$/;
const TASK = /^task (\d+)\/(\d+):\s*(.*)$/;

const lower = (s: string): string => (s ? s[0]!.toLowerCase() + s.slice(1) : s);
export const cap = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? "" : "s"}`;

export function phrase(label: string): Phrase {
  const ck = CHECK.exec(label);
  if (ck) return { now: `checking the '${ck[1]}' section against the code`, will: `check the '${ck[1]}' section`, key: "check" };
  const tk = TASK.exec(label);
  if (tk) return { now: `working on task ${tk[1]} of ${tk[2]} of your plan, ${lower(tk[3] ?? "")}`.replace(/, $/, ""), will: `do task ${tk[1]}`, key: "task" };
  const t = TABLE[label];
  if (t) return { now: t[0], will: t[1] };
  return { now: lower(label), will: lower(label) };
}

/** "(i of n)" for a phase that counts its own items; for a `check` phase, its place among the declared checks. */
function position(p: PhaseView, declared: string[]): string {
  if (p.n) return ` (${p.i ?? 0} of ${p.n})`;
  if (CHECK.test(p.label)) {
    const all = declared.filter((l) => CHECK.test(l));
    const k = all.indexOf(p.label);
    if (k >= 0 && all.length > 1) return ` (${k + 1} of ${all.length})`;
  }
  return "";
}

/** What comes after the current declared phase: up to two groups, consecutive checks/tasks collapsed. */
export function nextClause(declared: string[], cur: number): string {
  const rest = cur >= 0 ? declared.slice(cur + 1) : [];
  const onCheck = cur >= 0 && CHECK.test(declared[cur] ?? "");
  const onTask = cur >= 0 && TASK.test(declared[cur] ?? "");
  const groups: string[] = [];
  for (let k = 0; k < rest.length; ) {
    const ph = phrase(rest[k]!);
    let m = 1;
    if (ph.key) while (k + m < rest.length && phrase(rest[k + m]!).key === ph.key) m++;
    if (ph.key === "check") groups.push(m === 1 ? ph.will : `check ${onCheck ? `the remaining ${plural(m, "section")}` : `the README's ${m} sections`} one by one`);
    else if (ph.key === "task") groups.push(m === 1 ? "move on to the next task" : `work through ${onTask ? "the remaining" : "the next"} ${plural(m, "task")}`);
    else groups.push(ph.will);
    k += m;
  }
  if (!groups.length) return "After this I'll sum up what changed.";
  return `Next I'll ${groups.slice(0, 2).join(", then ")}.`;
}

export interface BeatView {
  /** frames, outermost first */
  frames: { name: string; phase: PhaseView | null }[];
  declared: string[];
  cur: number;
  todo: { text: string; done: boolean }[];
  calls: number;
  elapsedMs: number;
  tokens: string;
}

const mins = (ms: number): string => plural(Math.max(1, Math.round(ms / 60_000)), "minute");

/** Auto mode, stuck detection fired: one plain sentence, no question. */
export function stuckSentence(calls: number): string {
  return `This has gone ${calls} calls without visible progress; I'll keep going, and step back to plain Pi if it doesn't move.`;
}

export function waitingSentence(idleMs: number): string {
  return `Still waiting on the model; no reply for ${mins(idleMs)}. Nothing is stuck on my side.`;
}

export function beatSentence(v: BeatView): string {
  const root = v.frames[0]!;
  const el = v.elapsedMs < 60_000 ? `${Math.round(v.elapsedMs / 1000)}s` : `${Math.floor(v.elapsedMs / 60_000)}m`;
  const tail = ` (${el} in, ${plural(v.calls, "call")}, ${v.tokens} tok)`;
  const done = v.todo.filter((s) => s.done).length;
  if (root.name === "chat" && !v.declared.length) {
    const cur = v.todo.find((s) => !s.done);
    const bits = [`${plural(v.calls, "step")} so far`];
    if (v.todo.length) bits.push(`${done} of ${v.todo.length} todo items done`);
    return `Still working on your request — ${bits.join(", ")}.${cur ? ` Current step: ${cur.text}.` : ""}${tail}`;
  }
  const leafFrame = v.frames[v.frames.length - 1]!;
  const rootPhase = root.phase;
  let now: string;
  if (v.frames.length > 1 && leafFrame.phase) {
    const outer = rootPhase ? `${phrase(rootPhase.label).now}${position(rootPhase, v.declared)}` : `running ${root.name}`;
    now = `I'm ${outer} — now in the ${leafFrame.name} step, ${phrase(leafFrame.phase.label).now}${position(leafFrame.phase, [])}.`;
  } else if (rootPhase) {
    now = `${cap(phrase(rootPhase.label).now)}${position(rootPhase, v.declared)}.`;
    if (!/^(Working|Checking)/.test(now)) now = `I'm ${lower(now)}`;
  } else {
    now = `I'm working on ${root.name}.`;
  }
  const next = nextClause(v.declared, v.cur);
  return `${now} ${next}${tail}`;
}

/** The opening sentence of the end summary. */
export function endSentence(outcome: "done" | "blocked" | "failed", text: string, reason: string | undefined): string {
  const t = (reason ?? text ?? "").trim().replace(/[.\s]+$/, "");
  if (outcome === "done") return t ? `Done — ${t}.` : "Done.";
  if (outcome === "blocked") return `I had to stop — ${t || "something needs your decision"}.`;
  return `That didn't work — ${t || "it failed"}.`;
}
