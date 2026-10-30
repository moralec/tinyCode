// Branch tools for Pi's loop: `find` (code gathers evidence, one small-model call answers) and `run_tests` (code only; renamed from `test` in S19: `test` is the write-tests workflow).
// Port of our benchmark The side question runs in its own call on the `branch` step's lane (default
// the 4B); only the short answer comes back to the trunk. This file and extensions/tinycode/index.ts are the only
// ones that import Pi at runtime; the helpers below are pure so tests need no Pi.
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Config } from "./config.ts";
import { evidence, type Evidence } from "./context/evidence.ts";
import { chat as realChat, type ChatOptions, type ChatResult, type Message } from "./llm.ts";
import { MAX_TODO_CHARS, MAX_TODO_ITEMS, type Todo } from "./limits.ts";
import { RESTORE_TOOL, type BestTree } from "./besttree.ts";
import { failingNames, parseCounts, runTests } from "./testrun.ts";

export const BRANCH_SYSTEM =
  "Answer a repo question from the evidence: file outline, grep hits (path:line: text). 1-2 sentences. Cite best path:line. " +
  "Evidence lacks answer: say so, name likely files.";

export const ANSWER_SCHEMA = {
  type: "object",
  properties: { answer: { type: "string" }, citations: { type: "array", items: { type: "string" }, maxItems: 4 } },
  required: ["answer", "citations"],
};

export function branchMessages(question: string, ev: Evidence): Message[] {
  return [
    { role: "system", content: BRANCH_SYSTEM },
    { role: "user", content: `Outline:\n${ev.outline}\n\nGrep hits:\n${ev.hits}\nQuestion: ${question}` },
  ];
}

/** `{answer, citations}` JSON to `answer` + `- path:line` lines; anything else is returned trimmed. */
export function formatAnswer(text: string): string {
  try {
    const j = JSON.parse(text) as { answer?: unknown; citations?: unknown };
    const cites = Array.isArray(j.citations) ? j.citations.map((c) => `- ${String(c)}`).join("\n") : "";
    return `${String(j.answer ?? "")}\n${cites}`.trim();
  } catch {
    return text.slice(0, 600) || "(branch returned nothing)";
  }
}

export type ChatFn = (step: string, messages: Message[], opts?: ChatOptions) => Promise<ChatResult>;

/** The whole `find` pipeline with an injectable chat function. */
export async function findAnswer(
  cwd: string,
  question: string,
  opts: { config: Config; chat?: ChatFn; workflow?: string | null },
): Promise<string> {
  const ev = evidence(cwd, question);
  const call = opts.chat ?? realChat;
  const r = await call("branch", branchMessages(question, ev), {
    schema: ANSWER_SCHEMA,
    schemaName: "answer",
    config: opts.config,
    workflow: opts.workflow ?? "pi",
  });
  return formatAnswer(r.text);
}

/** What the loop tools need to keep the best tree (src/besttree.ts): the state, the fs-backed snapshot and restore, and a signal that a best now exists (the tool set changes). */
export interface BestHooks {
  tree: BestTree;
  snapshot(cwd: string): void;
  restore(cwd: string): unknown;
  /** the best tree back without touching test files (limits.undoWorse); null = no snapshot; absent = no auto-undo */
  undo?(cwd: string): unknown;
  onFirstBest(): void;
}

export function registerBranchTools(pi: ExtensionAPI, cfg: Config, best?: BestHooks): void {
  pi.registerTool(
    defineTool({
      name: "find",
      label: "Find",
      description: "Where/how is X in this repo: short answer with path:line.",
      promptSnippet: "where/how is X in repo; path:line answer",
      parameters: Type.Object({ question: Type.String() }),
      async execute(_id, params, _signal, _onUpdate, ctx) {
        const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
        let text: string;
        try {
          text = await findAnswer(cwd, params.question, { config: cfg });
        } catch (e) {
          text = `find failed: ${(e as Error).message}`;
        }
        return { content: [{ type: "text", text }], details: {} };
      },
    }),
  );
  pi.registerTool(
    defineTool({
      name: "run_tests",
      label: "Run tests",
      description: "Run project tests: PASS, or failing tests and first error.",
      promptSnippet: "run tests; PASS or failures",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
        const r = await runTests({ cwd, config: cfg.test });
        let text = r.text;
        if (best) {
          const had = best.tree.has;
          const fails = failingNames(r.text, 1000);
          const counts = r.counts ?? parseCounts(r.text);
          const undo = best.undo;
          const note = best.tree.observe(counts, () => best.snapshot(cwd), () => best.restore(cwd), {
            undo: undo ? () => undo(cwd) : undefined,
            sig: counts ? `${counts.passed}/${counts.failed}|${fails.names.join("|")}` : undefined,
          });
          if (note) text += `\n${note}`;
          if (!had && best.tree.has) best.onFirstBest();
        }
        return { content: [{ type: "text", text }], details: {} };
      },
    }),
  );
  if (best) {
    pi.registerTool(
      defineTool({
        name: RESTORE_TOOL,
        label: "Restore best",
        description: "Put files back to the best tree seen (most tests passing).",
        parameters: Type.Object({}),
        async execute(_id, _params, _signal, _onUpdate, ctx) {
          const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
          return { content: [{ type: "text", text: best.tree.restoreText(() => best.restore(cwd)) }], details: {} };
        },
      }),
    );
  }
}

/**
 * The `todo` tool (S4b): the model's running steps and notes. Replace-whole: every call sends the full list. The
 * extension shows it again at the tail of each request (src/limits.ts `withTail`), so it is never lost to masking.
 */
export function registerTodoTool(pi: ExtensionAPI, todo: Todo): void {
  pi.registerTool(
    defineTool({
      name: "todo",
      label: "Todo",
      description:
        `Raw-tool work only: steps (text, done) and notes (facts to keep). Send whole list. Max ${MAX_TODO_ITEMS} each, ${MAX_TODO_CHARS} chars.`,
      promptSnippet: "steps and notes, shown every turn; send whole list",
      parameters: Type.Object({
        steps: Type.Array(Type.Object({ text: Type.String(), done: Type.Optional(Type.Boolean()) })),
        notes: Type.Optional(Type.Array(Type.String())),
      }),
      async execute(_id, params) {
        const r = todo.set(params);
        return { content: [{ type: "text", text: r.text }], details: {} };
      },
    }),
  );
}
