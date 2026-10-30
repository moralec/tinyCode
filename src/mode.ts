// tinyCode's mode. "auto" (default): tinyCode's own machinery never asks diagnostic questions (no stuck prompt, no hint
// line, no "hand it to /fix?"); the model may still ask in conversation. Exactly one class of confirmation stays:
// irreversible actions the user did not explicitly ask for in that message. "dev": the stuck confirm, the router hint,
// tools-first and step-back events and the per-call token line are shown. `/dev on|off` toggles it for the session.
export type Mode = "auto" | "dev";
export type Irreversible = "commit" | "git-init" | "delete" | "readme-rewrite";

export const modeState: { mode: Mode; lastPrompt: string } = { mode: "auto", lastPrompt: "" };
export const isDev = (): boolean => modeState.mode === "dev";
export function setMode(m: Mode): void {
  modeState.mode = m;
}

/** `/dev on|off` (no argument toggles); null = not understood. */
export function parseDevArgs(raw: string): Mode | null {
  const a = raw.trim().toLowerCase();
  if (a === "on") return "dev";
  if (a === "off") return "auto";
  if (a === "") return isDev() ? "auto" : "dev";
  return null;
}

const ASKED: Record<Irreversible, RegExp> = {
  commit: /\bcommit\b/i,
  "git-init": /\bgit init\b|\binit(?:ialise|ialize)?\b[^.\n]{0,20}\b(?:git|repo(?:sitory)?)\b/i,
  delete: /\b(?:delete|remove|rm|erase|get rid of)\b/i,
  "readme-rewrite": /\b(?:rewrite|regenerate|redo|update|refresh|write|create)\b[^.\n]{0,40}\breadme\b|\breadme\b[^.\n]{0,40}\b(?:rewrite|regenerate|update|refresh)\b/i,
};

/** Did the user's message itself ask for this action? (a slash command is an explicit ask for what it names) */
export const explicitlyAsked = (kind: Irreversible, userText: string): boolean => ASKED[kind].test(userText);

export interface ConfirmCtx {
  hasUI: boolean;
  ui: { confirm(title: string, question: string): Promise<boolean> };
}

/**
 * The confirm function to hand a workflow (undefined = it cannot ask).
 *   dev: asks as before (with a UI).
 *   auto, irreversible `kind`: explicit -> proceeds without asking; called by the model (`fromTool`) and not asked for in
 *     the user's message -> declined at once, no dialog (book-store on 02fd96e: an unasked commit's dialog waited 19 min);
 *     else (a slash command) asks (with a UI; no UI: undefined).
 *   auto, no `kind` (a diagnostic or routine question): never asks, answers `dflt` (true unless `dflt: false`, then undefined).
 */
export function confirmFor(ctx: ConfirmCtx, o: { kind?: Irreversible; explicit?: boolean; dflt?: boolean; fromTool?: boolean } = {}): ((q: string) => Promise<boolean>) | undefined {
  const ask = ctx.hasUI ? (q: string) => ctx.ui.confirm("tinyCode", q) : undefined;
  if (isDev()) return ask;
  if (o.kind) return o.explicit ? async () => true : o.fromTool ? async () => false : ask;
  return o.dflt === false ? undefined : async () => true;
}

/** The stuck confirm: only in dev mode with a UI; auto posts a sentence instead and keeps going. */
export function stuckConfirmFor(ctx: ConfirmCtx): ((calls: number) => Promise<boolean>) | undefined {
  return ctx.hasUI && isDev()
    ? (n) => ctx.ui.confirm("tinyCode", `No new phase and no file change for ${n} calls: it looks stuck. Continue? (No stops this run.)`)
    : undefined;
}
