// Never lose the best tree in Pi's loop (operator 2026-10-29). Evidence: the ladder handed over a tree passing 24/31, the
// model then rewrote the whole file, got 27/31, then 3/31, and kept rewriting from scratch. tinyCode keeps the best test
// result of the current request (the ladder's kept counts are the starting best), snapshots the tree whenever run_tests
// improves on it, says so when a later run is worse, and offers `restore_best`. Only notes and a tool: nothing is blocked.
// Stuck (operator 2026-10-29): `stuckRuns` test runs in a row without beating the best restore it once and tell the
// model to stop and report; the model ends its turn, tinyCode never aborts the run. Only a worse tree is put back: on
// equal counts the tree may hold work the tests do not see yet, and a green run is never stuck (add-1-chunk r2 on
// 3a0462b: three 2/2 runs restored the snapshot and wiped the new function, then 90 todo saves).
// Undo at once (operator 2026-10-30, limits.undoWorse): a run worse than the best (fewer pass or more fail) puts the best
// tree back right away, test files untouched, and says so in one line. dot-dsl 16k r3: the same edit took 11/12 to 9/12
// eleven times, the model edited back each time, 114 calls to the 10-minute cap. The same break (counts and failing
// names) a third time: said once more, then no auto-restore until a new best (the "Worse than best" line and the stuck
// rule as before).
// Pure logic with injected snapshot functions; the fs-backed ones are the fix.ts snapshot helpers (slot LOOP_SLOT).
import type { TestCounts } from "./testrun.ts";
import { better } from "./workflows/fix.ts";

/** The undo-dir slot of the loop's best tree (fix.ts has BEST_SLOT for the ladder's; this one outlives the fix run). */
export const LOOP_SLOT = ".loop";
export const RESTORE_TOOL = "restore_best";

const fmt = (c: TestCounts): string => `${c.passed}/${c.passed + c.failed}`;

/** What the last observed test run was, against the best before it (milestone checkpoints read it, src/checkpoint.ts). */
export type TestVerdict = "best" | "same" | "worse" | null;

/** The same break this many times since the best: auto-restore stops until a new best. */
export const UNDO_REPEATS = 3;

/** Not better than `best` (see `better`) and fewer pass or more fail. */
export const worseThan = (best: TestCounts, c: TestCounts): boolean => !better(c, best) && (c.passed < best.passed || c.failed > best.failed);

export interface ObserveOpts {
  /** puts the best tree back without touching test files (limits.undoWorse); absent = no auto-restore */
  undo?: () => unknown | null;
  /** what makes two breaks the same (the failing names); default the counts */
  sig?: string;
  /** the run timed out (E22: resets the same-failure row, like a crash with no counts) */
  timedOut?: boolean;
  /** E22: the request's `.start` snapshot was taken (the extension's per-request flag); no offer without it */
  startTaken?: boolean;
}

// ---- E22, start over (limits.startOver; docs/designs/loop-guards-2/design.md)

/** The undo-dir slot of the request's original tree (E22), taken lazily before the first change to the tree. */
export const START_SLOT = ".start";
/** The same failure (counts and failing names) this many runs in a row offers the original files (E22). */
export const SAME_FAILURE_RUNS = 3;
/** E22's offer, on its own. */
export const startOfferLine = (c: TestCounts): string =>
  `Same failure ${SAME_FAILURE_RUNS} runs (${fmt(c)}). The design may be wrong: ${RESTORE_TOOL} to=start puts the original files back (tests kept, best tree saved), then rebuild. Or keep fixing.`;
const START_OFFER_TAIL = `Same failure ${SAME_FAILURE_RUNS} runs: the design may be wrong. ${RESTORE_TOOL} to=start puts the original files back (tests kept, best saved); or report what still fails.`;

export class BestTree {
  best: TestCounts | null = null;
  /** the last observe(): "best" = it became the best, "same" = as good as the best, "worse", null = unreadable / nothing passes */
  verdict: TestVerdict = null;
  /** which test run of this request reached `best` (1-based; 0 = the hand-over's tree) */
  private bestRun = 0;
  private runs = 0;
  /** test runs since the best was last beaten (or seeded) */
  private sinceBest = 0;
  private stuckSaid = false;
  private stuckRuns: number;
  /** the last run_tests counts of this request, and how many "still fail, continue" follow-ups were sent */
  private last: TestCounts | null = null;
  private continues = 0;
  private maxContinues: number;
  private autoUndo: boolean;
  private undoFrom: number;
  /** breaks seen since the best (signature -> times), and whether auto-restore is off until a new best */
  private breaks = new Map<string, number>();
  private undoOff = false;
  /** auto-restores made (this request) */
  undos = 0;
  /** false (limits.loopBestTree): counts are still tracked (verdict, continue line, checkpoints), but no snapshot, line, restore or undo */
  private keep: boolean;
  /** E22 (limits.startOver): offer the original files on the same failure SAME_FAILURE_RUNS runs in a row; ignored without `keep` */
  private startOn: boolean;
  /** E22: the same-failure row (its signature and length), whether the offer was made (once per request), and whether
   *  the last observe() met the trigger (also with the key off: the shadow line) */
  private rowSig: string | null = null;
  private row = 0;
  private startOffered = false;
  startTrigger = false;
  /** E22: the fresh-attempt state after `to: "start"`, its own best and its failing runs without a new one */
  private fresh = false;
  private freshBest: TestCounts | null = null;
  private freshRuns = 0;

  /** `undoFrom`: auto-undo from the Nth time the same break is seen (1 = at once; 2 lets a first break be fixed forward) */
  constructor(stuckRuns = 0, maxContinues = 0, autoUndo = false, undoFrom = 1, keep = true, startOver = false) {
    this.stuckRuns = stuckRuns;
    this.maxContinues = maxContinues;
    this.autoUndo = autoUndo;
    this.undoFrom = Math.max(1, undoFrom);
    this.keep = keep;
    this.startOn = startOver && keep;
  }

  /** E22: in the fresh-attempt state (after `restore_best to=start`, until it beats the saved best or uses its budget) */
  get freshAttempt(): boolean {
    return this.fresh;
  }

  /** E22: the fresh attempt's failing-run budget, 2 x stuckTestRuns (6 by default) */
  private get freshBudget(): number {
    return 2 * (this.stuckRuns > 0 ? this.stuckRuns : SAME_FAILURE_RUNS);
  }

  /**
   * The model ended its turn while the last test run still fails (connect on 1c631a3: "Let me look at the canonical
   * data more carefully." and no tool call). The follow-up a user would type, at most `maxContinues` per request and
   * never after the stuck rule told it to stop; null otherwise.
   */
  continueLine(): string | null {
    if (!this.last || this.last.failed <= 0 || this.stuckSaid || this.continues >= this.maxContinues) return null;
    this.continues++;
    return `Tests still fail (${fmt(this.last)}). Continue.`;
  }

  /** The last run_tests counts of this request (null before the first readable run). */
  get lastCounts(): TestCounts | null {
    return this.last;
  }

  /** Which test run of this request reached the best (0 = the hand-over's tree). */
  get bestRunNo(): number {
    return this.bestRun;
  }

  /** A new request: no best, no runs. */
  reset(): void {
    this.best = null;
    this.verdict = null;
    this.bestRun = 0;
    this.runs = 0;
    this.sinceBest = 0;
    this.stuckSaid = false;
    this.last = null;
    this.continues = 0;
    this.breaks.clear();
    this.undoOff = false;
    this.undos = 0;
    this.rowSig = null;
    this.row = 0;
    this.startOffered = false;
    this.startTrigger = false;
    this.fresh = false;
    this.freshBest = null;
    this.freshRuns = 0;
  }

  /** Has a test run (or the hand-over) passed at least one test in this request? */
  get has(): boolean {
    return this.best !== null;
  }

  /** Is there a kept tree to go back to (`restore_best` offered)? */
  get offersRestore(): boolean {
    return this.keep && this.best !== null;
  }

  /** The hand-over's tree is the starting best (counts of the kept ladder tree, else of the original). `snapshot` copies the tree. */
  seed(counts: TestCounts | null | undefined, snapshot: () => void): void {
    if (!counts || counts.passed <= 0) return;
    this.best = counts;
    this.bestRun = 0;
    this.sinceBest = 0;
    this.breaks.clear();
    this.undoOff = false;
    if (this.keep) snapshot();
  }

  /**
   * A run_tests result. Improves on the best (and at least one test passes): snapshot, no line. Worse than the best:
   * the one line to append to the result; with auto-undo (`opts.undo`) the best tree is put back first and the line says
   * so. Same or unreadable counts: nothing. The `stuckRuns`-th failing run in a row that does not beat the best (once per
   * request, with `restore`): the model is told to stop, and the best is put back when this tree is worse. A run with no
   * failure never counts.
   */
  observe(counts: TestCounts | null | undefined, snapshot: () => void, restore?: () => unknown, opts: ObserveOpts = {}): string | null {
    this.runs++;
    this.verdict = null;
    // E22: the same-failure row runs first, so 0-pass runs count too; `offer` only with limits.startOver
    const offer = this.countRow(counts, opts) && counts ? startOfferLine(counts) : null;
    if (!counts) return null;
    this.last = counts;
    if (this.fresh) {
      // E22's fresh-attempt state: only a run better than the saved best ends it (a new best, below)
      if (!this.best || !better(counts, this.best)) return this.freshObserve(counts, restore);
      this.fresh = false;
    }
    if (this.best === null) {
      if (counts.passed <= 0) return offer;
    } else if (!better(counts, this.best)) {
      const worse = worseThan(this.best, counts);
      this.verdict = worse ? "worse" : "same";
      if (counts.failed <= 0) return null;
      this.sinceBest++;
      if (!this.keep) return null;
      if (restore && this.stuckRuns > 0 && this.sinceBest >= this.stuckRuns && !this.stuckSaid) {
        this.stuckSaid = true;
        // with E22's offer the two lines become one, and "Stop:" becomes "or report" so they do not contradict
        if (!worse) return `No progress ${this.sinceBest} test runs (${fmt(counts)}). ${offer ? START_OFFER_TAIL : "Stop: report what still fails."}`;
        restore();
        this.last = this.best;
        return `No progress ${this.sinceBest} test runs. Best restored (${fmt(this.best)}). ${offer ? START_OFFER_TAIL : "Stop: report what still fails."}`;
      }
      if (!worse) return offer;
      const line = this.undoLine(counts, opts) ?? `Worse than best (${fmt(this.best)}${this.bestRun ? ` at test run ${this.bestRun}` : ", the hand-over"}). Restore: call ${RESTORE_TOOL}.`;
      return offer ? `${line}\n${offer}` : line;
    }
    this.best = counts;
    this.bestRun = this.runs;
    this.sinceBest = 0;
    this.verdict = "best";
    this.breaks.clear();
    this.undoOff = false;
    if (this.keep) snapshot();
    return offer;
  }

  /**
   * E22's same-failure row: a run with failing tests and the signature of the run before it adds one; a timeout, a run
   * with no counts or a green run resets it. At SAME_FAILURE_RUNS, once per request, with the `.start` snapshot taken
   * and outside the fresh-attempt state, the trigger is met: `startTrigger` is set (the shadow line, key on or off) and
   * the result is true only with limits.startOver (the offer).
   */
  private countRow(counts: TestCounts | null | undefined, opts: ObserveOpts): boolean {
    this.startTrigger = false;
    if (!counts || opts.timedOut || counts.failed <= 0) {
      this.rowSig = null;
      this.row = 0;
      return false;
    }
    const sig = opts.sig ?? fmt(counts);
    this.row = sig === this.rowSig ? this.row + 1 : 1;
    this.rowSig = sig;
    if (this.row < SAME_FAILURE_RUNS || this.startOffered || !opts.startTaken || this.fresh || !this.keep) return false;
    this.startOffered = true;
    this.startTrigger = true;
    return this.startOn;
  }

  /**
   * A run in E22's fresh-attempt state that does not beat the saved best: compared with the attempt's own best (no
   * "Worse than best", no undo, no stuck rule); `freshBudget` failing runs without a new one put the saved best back once.
   */
  private freshObserve(counts: TestCounts, restore?: () => unknown): string | null {
    const fb = this.freshBest;
    if (counts.passed > 0 && (fb === null || better(counts, fb))) {
      this.freshBest = counts;
      this.freshRuns = 0;
      this.verdict = "best";
      return null;
    }
    if (fb) this.verdict = worseThan(fb, counts) ? "worse" : "same";
    if (counts.failed <= 0) return null;
    this.freshRuns++;
    if (this.freshRuns < this.freshBudget || !this.best) return null;
    this.fresh = false;
    this.stuckSaid = true;
    if (restore) {
      restore();
      this.last = this.best;
    }
    return `Fresh attempt: no progress in ${this.freshRuns} runs (${fmt(counts)}). Best tree back (${fmt(this.best)}). Stop: report what still fails.`;
  }

  /** E22, `restore_best to=start`: the original files are back; enter the fresh-attempt state (the saved best is kept). */
  startOver(): void {
    this.rowSig = null;
    this.row = 0;
    if (!this.best) return; // nothing saved to protect: the normal rules apply
    this.fresh = true;
    this.freshBest = null;
    this.freshRuns = 0;
    this.last = null; // the tree on disk is the original now; endRestore treats "no run yet" as below the best
  }

  /** E22, `restore_best to=start`: `restore` puts the request's `.start` snapshot back (tests left alone); the text the model reads. */
  startOverText(restore: () => unknown | null, taken: boolean): string {
    if (!this.startOn) return "to=start is off (limits.startOver).";
    if (!taken) return "No start snapshot in this request.";
    if (restore() === null) return "No snapshot found.";
    this.startOver();
    return this.best ? `Original files back (tests kept; best tree ${fmt(this.best)} saved). Rebuild, then run_tests.` : "Original files back (tests kept). Rebuild, then run_tests.";
  }

  /** Auto-undo of a worse run (see the header): the line, or null when it is off, used up for this break, or no snapshot. */
  private undoLine(counts: TestCounts, opts: ObserveOpts): string | null {
    const best = this.best;
    if (!best || !this.autoUndo || !opts.undo || this.undoOff) return null;
    const sig = opts.sig ?? fmt(counts);
    const n = (this.breaks.get(sig) ?? 0) + 1;
    this.breaks.set(sig, n);
    if (n < this.undoFrom || opts.undo() === null) return null;
    this.undos++;
    this.last = best;
    const lost = Math.max(best.passed - counts.passed, counts.failed - best.failed, 1);
    if (n >= UNDO_REPEATS) {
      this.undoOff = true;
      return `Same break ${n} times: best tree back (${fmt(best)}). No more auto-restore until new best. Change approach.`;
    }
    return `Edit made ${lost} more fail: best tree back (${fmt(best)}). Try another way.`;
  }

  /**
   * The request is ending: when the last test run is worse than the best, put the best back (once) and return the line
   * that says so; null otherwise. paasio on 956f1da: after the stuck stop the model edited on for 70 calls and ended on
   * a tree that no longer imported, below its best.
   */
  endRestore(restore: () => unknown | null): string | null {
    if (!this.keep || !this.best) return null;
    // E22: in the fresh-attempt state with no run since the start-over, the tree is the original: below the best
    const below = this.last ? better(this.best, this.last) : this.fresh;
    if (!below) return null;
    if (restore() === null) return null;
    this.last = this.best;
    this.fresh = false;
    return `Ended below best: restored best tree (${fmt(this.best)}).`;
  }


  /** `restore_best`: put the tree back with `restore`; the text the model reads. Ends E22's fresh-attempt state. */
  restoreText(restore: () => unknown | null): string {
    if (!this.best) return "No best tree yet.";
    if (restore() === null) return "No snapshot found.";
    this.fresh = false;
    return `Restored best tree (${fmt(this.best)}).`;
  }
}

/** One line for the result of a `write` that replaces a file when tests already pass in this request; null otherwise (never a block). */
export function rewriteNudge(toolName: string, fileExisted: boolean, bestExists: boolean): string | null {
  return toolName === "write" && fileExisted && bestExists ? "Whole-file rewrite. Prefer edit." : null;
}
