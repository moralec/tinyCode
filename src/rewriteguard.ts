// Rewrite guard (feature E1, limits.rewriteGuard, docs/designs/rewrite_guard.md). A whole-file `write` once tests pass
// gets C21's line; with the guard, code compares the new file with its copy in the loop's best tree and says what the
// rewrite threw away: cut to under half, top-level names dropped, or (Python) no longer parses, plus the way back.
// Never a block, no model call. Evidence (f15 records, 2026-11-04): a rewrite fell below the best 19 times in 60, an
// edit 20 in 116; 5 rewrites failed every test (bowling: a 30-char file over a 28/31 tree), against 1 edit.
import { spawnSync } from "node:child_process";
import { extname } from "node:path";
import type { TestCounts } from "./testrun.ts";
import { RESTORE_TOOL } from "./besttree.ts";

/** Names listed in one line at most. */
const MAX_NAMES = 5;

const PY = new Set([".py", ".pyi"]);
const JS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]);

/** Top-level def/class names (Python) or function/class/const names (JS/TS), in order; [] for other languages. */
export function topNames(text: string, ext: string): string[] {
  const re = PY.has(ext)
    ? /^(?:async[ \t]+def|def|class)[ \t]+([A-Za-z_]\w*)/gm
    : JS.has(ext)
      ? /^(?:export[ \t]+)?(?:default[ \t]+)?(?:async[ \t]+)?(?:function\*?[ \t]*|class[ \t]+|const[ \t]+)([A-Za-z_$][\w$]*)/gm
      : null;
  if (!re) return [];
  const out = new Set<string>();
  for (const m of text.matchAll(re)) out.add(m[1]!);
  return [...out];
}

/** What the rewrite lost against the best copy (pure); [] = nothing found. `rel` is the path the model used. */
export function rewriteFindings(rel: string, bestText: string, newText: string): string[] {
  const out: string[] = [];
  if (newText.length * 2 < bestText.length) out.push(`cut ${rel} from ${bestText.length} to ${newText.length} chars`);
  const ext = extname(rel).toLowerCase();
  const kept = new Set(topNames(newText, ext));
  const lost = topNames(bestText, ext).filter((n) => !kept.has(n));
  if (lost.length) out.push(`dropped ${lost.slice(0, MAX_NAMES).join(", ")}${lost.length > MAX_NAMES ? ` (+${lost.length - MAX_NAMES})` : ""}`);
  return out;
}

/** `<python> -c ast.parse` on a .py file: "does not parse: SyntaxError line N" or null (parses, not Python, or no interpreter). */
export function pyParseError(python: string, file: string, timeoutMs = 5000): string | null {
  if (!PY.has(extname(file).toLowerCase())) return null;
  const code = "import ast,sys\ntry:\n ast.parse(open(sys.argv[1],encoding='utf-8').read())\nexcept SyntaxError as e:\n print(type(e).__name__, e.lineno or 0); sys.exit(3)";
  // -I: the cwd (the project) is not on sys.path, so a repository ast.py is never imported
  const r = spawnSync(python, ["-I", "-c", code, file], { encoding: "utf8", timeout: timeoutMs });
  if (r.status !== 3) return null;
  const [kind, line] = r.stdout.trim().split(" ");
  return `does not parse: ${kind} line ${line}`;
}

/** The line that replaces C21's when there are findings; null = keep C21's line. `restore`: restore_best is offered. */
export function guardLine(findings: string[], best: TestCounts | null, restore: boolean): string | null {
  if (!findings.length) return null;
  const back = best ? ` Best tree ${best.passed}/${best.passed + best.failed} pass${restore ? `: ${RESTORE_TOOL} puts it back` : ""}.` : "";
  return `Whole-file rewrite: ${findings.join("; ")}.${back}`;
}
