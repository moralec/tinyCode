// The slice of the check runner (src/acceptance.ts, first built for E17) that /build calls to run a task's own check
// (E21b, stages.buildChecks; design plan-build-fit). Minimal structural types, so build.ts compiles and its tests run
// without the module; index.ts wires the real function through `loadAcceptanceModule`.

/** One step of a check: an argv run with no shell (`{python}` becomes test.python), plus what its output must show. */
export interface AcceptStep {
  argv: string[];
  exit?: number;
  stdoutHas?: string[];
  [k: string]: unknown;
}
export interface AcceptCheck {
  name: string;
  steps: AcceptStep[];
  [k: string]: unknown;
}
/** A set of checks: only `checks` is read by the runner. */
export interface AcceptSet {
  checks: AcceptCheck[];
  [k: string]: unknown;
}
/** The runner's result. `unavailable` (no interpreter) means not run, never failed. */
export interface AcceptRun {
  ok: boolean;
  total: number;
  passed: number;
  failed: { name: string; command: string; why: string }[];
  ms: number;
  unavailable?: string;
}
export interface AcceptRunOpts {
  cwd: string;
  python: string;
  stepSeconds: number;
}
/** BuildDeps.acceptance: the runner's runAcceptance. */
export interface AcceptanceApi {
  run(set: AcceptSet, opts: AcceptRunOpts): Promise<AcceptRun>;
}

/** The runner module's runAcceptance as this file's type, or null when it does not load. */
export async function loadAcceptanceModule(): Promise<AcceptanceApi | null> {
  const spec = "../acceptance.ts";
  try {
    const { runAcceptance } = (await import(spec)) as Record<string, unknown>;
    if (typeof runAcceptance !== "function") return null;
    return { run: runAcceptance as AcceptanceApi["run"] };
  } catch {
    return null;
  }
}
