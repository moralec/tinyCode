// /ask <question>: a general programming question answered by ONE call with no tools, no repo context and no file
// access, on the small lane by default (steps.ask). Questions about this repo's own files or symbols belong to
// /explain; coding actions to the other workflows (the router decides, src/router.ts GENERAL). Pure logic with an
// injected chat; nothing is read or written.
import { NOOP_PROGRESS, type Progress } from "../progress.ts";
import type { Config } from "../config.ts";
import type { Message } from "../llm.ts";
import type { ChatFn } from "./fix.ts";

export const ASK_RULES = `Answer a general programming question. No access to their code, files, tools.
General knowledge, plain text, short: answer first, then at most one small example.
Needs their code: say so in one sentence, name what you need. No invented file names or APIs.`;

export interface AskArgs {
  question: string;
}

export function parseAskArgs(raw: string): AskArgs {
  return { question: raw.trim() };
}

/** The phases /ask reports. */
export const ASK_PHASES = ["answer"];

export interface AskDeps {
  progress?: Progress;
  config: Config;
  chat: ChatFn;
  report: (line: string) => void;
  env?: Record<string, string | undefined>;
}

export interface AskResult {
  ok: boolean;
  calls: number;
  answer: string;
}

export async function runAsk(args: AskArgs, deps: AskDeps): Promise<AskResult> {
  if (!args.question) {
    deps.report("usage: /ask <a general programming question>");
    return { ok: false, calls: 0, answer: "" };
  }
  const messages: Message[] = [
    { role: "system", content: ASK_RULES },
    { role: "user", content: args.question },
  ];
  (deps.progress ?? NOOP_PROGRESS).step("answer");
  const r = await deps.chat("ask", messages, { workflow: "ask", config: deps.config, env: deps.env });
  const answer = r.text.trim();
  deps.report(answer || "(the model gave no answer)");
  deps.report("calls: 1");
  return { ok: answer.length > 0, calls: 1, answer };
}
