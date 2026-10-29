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
import { runTests } from "./testrun.ts";

export const BRANCH_SYSTEM =
  "Answer a question about a code repository from the evidence given: a file outline and grep hits (path:line: text). " +
  "Be short (one or two sentences). Cite the most relevant path:line. If the evidence does not answer it, say so and " +
  "name the files most likely to.";

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

export function registerBranchTools(pi: ExtensionAPI, cfg: Config): void {
  pi.registerTool(
    defineTool({
      name: "find",
      label: "Find",
      description: "Ask where or how something is done in this repo; short answer with path:line.",
      promptSnippet: "find: ask where/how something is in the repo; returns a short answer with path:line citations",
      promptGuidelines: ["Use find to locate code instead of reading many files; then read only the cited files."],
      parameters: Type.Object({ question: Type.String({ description: "The question about the code" }) }),
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
      description: "Run the project's tests: PASS, or the failing tests and the first error.",
      promptSnippet: "run_tests: run the tests; returns pass/fail, failing tests and the first error",
      promptGuidelines: ["Use run_tests after each edit to check your work."],
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        const cwd = (ctx as { cwd?: string } | undefined)?.cwd ?? process.cwd();
        const r = await runTests({ cwd, config: cfg.test });
        return { content: [{ type: "text", text: r.text }], details: {} };
      },
    }),
  );
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
        `Only while you work with read/edit/bash: keep your steps (text, done) and notes (facts to keep); send the whole list. Max ${MAX_TODO_ITEMS} each, ${MAX_TODO_CHARS} chars.`,
      promptSnippet: "todo: your running steps and notes, shown to you again every turn; send the whole list each time",
      promptGuidelines: ["When you work with raw tools (read, edit, bash), keep your steps in todo and update it after each step. Never call todo before a tinyCode tool that fits the request."],
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
