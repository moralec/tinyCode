// The system prompt tinyCode hands to Pi for a request: Pi's own prompt without its documentation block (a coding
// request never needs Pi's README/docs/examples paths), then the fixed tinyCode texts. Pure TypeScript, no Pi import.
import { MEMORY_PROMPT } from "./limits.ts";
import { toolsFirstPrompt, tersePrompt, WORKFLOW_TOOLS } from "./tools.ts";

/**
 * Pi's prompt without the `<docs>` block that starts with "Pi documentation". Matched by its markers; when they are
 * not found (another Pi version, a custom prompt) the prompt is returned unchanged.
 */
export function trimPiDocs(prompt: string): string {
  const out = prompt
    .replace(/\n*<docs>\nPi documentation[\s\S]*?<\/docs>\n*/, "\n\n")
    // two lines that tell a small model nothing: tools are all listed, PI_* env is never needed for a coding task
    .replace(/\n*In addition to the tools above, you may have access to other custom tools depending on the project\.\n/, "\n")
    .replace(/- You can inspect PI_\* environment variables for current model and session details\.\n/, "");
  return out === prompt ? prompt : out.replace(/^\n+/, "");
}

/** E4 (limits.terseSystem): Pi's edit rules in one line; its tool list goes (the tool schemas already describe each tool) */
export const TERSE_RULES = "read, not cat/sed. edit: one call per file; edits[].oldText exact, unique, small, each matched against the original file, none overlapping.";
const TERSE_WRITE = " write: new files or whole rewrites only.";

/**
 * E4: Pi's `<tools>` and `<rules>` blocks become one `<rules>` line (TERSE_RULES). Markers not found (another Pi
 * version, a custom prompt): unchanged.
 */
export function terseRules(prompt: string): string {
  return prompt.replace(/<tools>\n[\s\S]*?<\/tools>\n*<rules>\n[\s\S]*?<\/rules>/, `<rules>\n${TERSE_RULES}${TERSE_WRITE}\n</rules>`);
}

/**
 * Pi's prompt trimmed, plus the terse line, the tools-first text for the declared workflow tools (config `intercept`;
 * default all, none = no line) and the working method (same text every run, so the cache holds). `terse`: E4 (limits.terseSystem).
 */
export function composePrompt(piPrompt: string, scriptLines: number, tools: readonly string[] = WORKFLOW_TOOLS, o: { terse?: boolean } = {}): string {
  const first = toolsFirstPrompt(tools);
  const pi = o.terse ? terseRules(trimPiDocs(piPrompt)) : trimPiDocs(piPrompt);
  return `${pi}\n\n${tersePrompt(scriptLines)}\n${first ? `${first}\n` : ""}${MEMORY_PROMPT}`;
}
