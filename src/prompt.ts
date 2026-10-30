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

/**
 * Pi's prompt trimmed, plus the terse line, the tools-first text for the declared workflow tools (config `intercept`;
 * default all, none = no line) and the working method (same text every run, so the cache holds).
 */
export function composePrompt(piPrompt: string, scriptLines: number, tools: readonly string[] = WORKFLOW_TOOLS): string {
  const first = toolsFirstPrompt(tools);
  return `${trimPiDocs(piPrompt)}\n\n${tersePrompt(scriptLines)}\n${first ? `${first}\n` : ""}${MEMORY_PROMPT}`;
}
