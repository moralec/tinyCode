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
}

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
  /** `undoFrom`: auto-undo from the Nth time the same break is seen (1 = at once; 2 lets a first break be fixed forward) */
  constructor(stuckRuns = 0, maxContinues = 0, autoUndo = false, undoFrom = 1) {
    this.stuckRuns = stuckRuns;
    this.maxContinues = maxContinues;
    this.autoUndo = autoUndo;
    this.undoFrom = Math.max(1, undoFrom);
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
  }

  /** Is there a tree to go back to? */
  get has(): boolean {
    return this.best !== null;
  }

  /** The hand-over's tree is the starting best (counts of the kept ladder tree, else of the original). `snapshot` copies the tree. */
  seed(counts: TestCounts | null | undefined, snapshot: () => void): void {
    if (!counts || counts.passed <= 0) return;
    this.best = counts;
    this.bestRun = 0;
    this.sinceBest = 0;
    this.breaks.clear();
    this.undoOff = false;
    snapshot();
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
    if (!counts) return null;
    this.last = counts;
    if (this.best === null) {
      if (counts.passed <= 0) return null;
    } else if (!better(counts, this.best)) {
      const worse = worseThan(this.best, counts);
      this.verdict = worse ? "worse" : "same";
      if (counts.failed <= 0) return null;
      this.sinceBest++;
      if (restore && this.stuckRuns > 0 && this.sinceBest >= this.stuckRuns && !this.stuckSaid) {
        this.stuckSaid = true;
        if (!worse) return `No progress ${this.sinceBest} test runs (${fmt(counts)}). Stop: report what still fails.`;
        restore();
        this.last = this.best;
        return `No progress ${this.sinceBest} test runs. Best restored (${fmt(this.best)}). Stop: report what still fails.`;
      }
      if (!worse) return null;
      const undone = this.undoLine(counts, opts);
      if (undone) return undone;
      return `Worse than best (${fmt(this.best)}${this.bestRun ? ` at test run ${this.bestRun}` : ", the hand-over"}). Restore: call ${RESTORE_TOOL}.`;
    }
    this.best = counts;
    this.bestRun = this.runs;
    this.sinceBest = 0;
    this.verdict = "best";
    this.breaks.clear();
    this.undoOff = false;
    snapshot();
    return null;
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
    if (!this.best || !this.last || !better(this.best, this.last)) return null;
    if (restore() === null) return null;
    this.last = this.best;
    return `Ended below best: restored best tree (${fmt(this.best)}).`;
  }

  /** `restore_best`: put the tree back with `restore`; the text the model reads. */
  restoreText(restore: () => unknown | null): string {
    if (!this.best) return "No best tree yet.";
    return restore() === null ? "No snapshot found." : `Restored best tree (${fmt(this.best)}).`;
  }
}

/** One line for the result of a `write` that replaces a file when tests already pass in this request; null otherwise (never a block). */
export function rewriteNudge(toolName: string, fileExisted: boolean, bestExists: boolean): string | null {
  return toolName === "write" && fileExisted && bestExists ? "Whole-file rewrite. Prefer edit." : null;
}
