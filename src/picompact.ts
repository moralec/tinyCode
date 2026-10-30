// Pi's own auto-compaction, sized for a small window (F7).
//
// Pi compacts when the context passes `window - reserveTokens` (default reserve 16384) and then keeps
// `keepRecentTokens` (default 20000) unsummarised. On a 32k window 20000 > 16384, so the context after a
// compaction is still over the trigger: Pi summarised every 2-3 calls and every summary broke the cache.
//
// Pi only asks this hook when its own prepareCompaction (Pi's settings: keepRecentTokens default 20000) finds something to
// cut. With a window under ~20k tokens it never does, so the hook never runs (16k bench, 2026-10-30: no pi_compact line
// in any of the 5 runs); tinyCode's checkpoints (src/checkpoint.ts) are the backstop there. Settings cannot be changed
// from an extension; `compaction.keepRecentTokens` in Pi's settings.json can.
//
// Rule (limits.piCompactReserve / limits.piKeepRecent, shares of the window):
//   - a threshold compaction while the context is still under `1 - piCompactReserve` of the window is cancelled
//     (tinyCode's own pressure masking, limits.pressureAt, handles the context until then);
//   - over that line, or on overflow / manual, Pi's cut is redone with window-sized settings
//     (reserve = window x piCompactReserve, keep = window x piKeepRecent) and Pi's own `compact()` summarises it;
//   - anything missing or failing hands back to Pi (its own compaction), never breaking the run.
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface PiCompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
}

export type PiCompactDecision =
  | { action: "cancel" }
  | { action: "resize"; settings: PiCompactionSettings }
  | { action: "pass"; why: string };

export interface DecideInput {
  windowTokens: number;
  reason: "manual" | "threshold" | "overflow";
  tokensBefore: number;
  reserveShare: number;
  keepShare: number;
  /** a threshold compaction is cancelled only under min((1 - reserveShare) x window, this); absent = the share alone (limits.ts usableTokens) */
  ceilingTokens?: number;
  /**
   * tinyCode's checkpoints keep what is sent under the usable line (src/checkpoint.ts): every threshold compaction is
   * cancelled, and a resize that fails is cancelled too instead of handing over to Pi. paasio 16k live (2026-10-30):
   * the resize's summary call carried the raw history (12.7k tokens, max_tokens 1) and failed; Pi's own compaction
   * then kept keepRecentTokens 20000, i.e. the whole raw history, the checkpoint was lost and the next request got HTTP 400.
   */
  selfManaged?: boolean;
}

/** Pure: what to do with one `session_before_compact` event. */
export function decidePiCompact(i: DecideInput): PiCompactDecision {
  if (!(Number.isFinite(i.windowTokens) && i.windowTokens > 0)) return { action: "pass", why: "no context window known" };
  const line = Math.min(i.windowTokens * (1 - i.reserveShare), i.ceilingTokens && i.ceilingTokens > 0 ? i.ceilingTokens : Infinity);
  if (i.reason === "threshold" && (i.selfManaged || i.tokensBefore <= line)) return { action: "cancel" };
  return {
    action: "resize",
    settings: {
      enabled: true,
      reserveTokens: Math.round(i.windowTokens * i.reserveShare),
      keepRecentTokens: Math.round(i.windowTokens * i.keepShare),
    },
  };
}

/** Minimal shapes of what Pi hands over; the real types are structurally compatible. */
interface Preparation {
  tokensBefore: number;
  firstKeptEntryId: string;
}
interface CompactionResultLike {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  usage?: { output?: number } | undefined;
}
export interface PiCompactDeps {
  /** Pi's prepareCompaction (not in the package's public exports: see loadPrepareCompaction) */
  prepare: (entries: never[], settings: PiCompactionSettings) => Preparation | undefined;
  /** Pi's compact(), with the model, auth and signal already bound */
  compact: (preparation: Preparation) => Promise<CompactionResultLike>;
}

export interface PiCompactOutcome {
  /** what the event handler returns */
  result: { cancel: true } | { compaction: CompactionResultLike } | undefined;
  status: "cancelled" | "resized" | "passed";
  /** context tokens before (Pi's own estimate) */
  tokensBefore: number;
  /** summary output tokens when a summary was made */
  summaryTokens: number;
  /** why it was passed on to Pi, if it was */
  why?: string;
}

/** Decide, and when the decision is to resize, redo the cut and summarise. Never throws. */
export async function runPiCompact(input: DecideInput & { branchEntries: unknown[]; deps: () => Promise<PiCompactDeps> }): Promise<PiCompactOutcome> {
  const d = decidePiCompact(input);
  const base = { tokensBefore: input.tokensBefore, summaryTokens: 0 };
  const failed = (why: string): PiCompactOutcome =>
    input.selfManaged ? { ...base, result: { cancel: true }, status: "cancelled", why } : { ...base, result: undefined, status: "passed", why };
  if (d.action === "cancel") return { ...base, result: { cancel: true }, status: "cancelled" };
  if (d.action === "pass") return { ...base, result: undefined, status: "passed", why: d.why };
  try {
    const deps = await input.deps();
    const prep = deps.prepare(input.branchEntries as never[], d.settings);
    if (!prep) return failed("nothing to cut at the window-sized settings");
    const result = await deps.compact(prep);
    if (!result?.summary?.trim() || !result.firstKeptEntryId) return failed("empty summary");
    return { tokensBefore: result.tokensBefore ?? prep.tokensBefore, summaryTokens: result.usage?.output ?? 0, result: { compaction: result }, status: "resized" };
  } catch (e) {
    return failed((e as Error).message || String(e));
  }
}

/**
 * Pi's `prepareCompaction` is not in the package's public exports (`compact` is), so load it from the same dist
 * folder the package's entry point lives in. Throws when it cannot be found: the caller then lets Pi compact.
 */
export async function loadPrepareCompaction(): Promise<PiCompactDeps["prepare"]> {
  const dists: string[] = [];
  try {
    dists.push(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
  } catch {
    // a loader without import.meta.resolve: fall back to the running CLI's own dist folder
  }
  if (process.argv[1]) dists.push(dirname(dirname(process.argv[1]))); // <dist>/cli.js or <dist>/bundle/cli.js
  dists.push(...dists.map((d) => dirname(d)));
  let last = "the Pi package's dist folder was not found";
  for (const d of dists) {
    try {
      const mod = (await import(pathToFileURL(join(d, "core", "compaction", "compaction.js")).href)) as { prepareCompaction?: PiCompactDeps["prepare"] };
      if (typeof mod.prepareCompaction === "function") return mod.prepareCompaction;
    } catch (e) {
      last = (e as Error).message;
    }
  }
  throw new Error(`prepareCompaction not loadable: ${last}`);
}
