// Cache and bytecode paths: never code changes, never staged, never committed. Shared by /build and /test.
export const CACHE_IGNORE = ["__pycache__/", "*.pyc", ".pytest_cache/", "node_modules/"];

/** True for `__pycache__/`, `*.pyc`/`*.pyo`, `.pytest_cache/`, `node_modules/` paths (any depth). */
export function isCachePath(p: string): boolean {
  const n = p.replace(/\\/g, "/");
  return /\.py[co]$/.test(n) || n.split("/").some((s) => s === "__pycache__" || s === ".pytest_cache" || s === "node_modules");
}

/** A `files` entry of a plan task, with an optional read-only marker: `read-only: a.py` or `a.py (read-only)`. */
export function parseTaskFile(entry: string): { path: string; readOnly: boolean } {
  const s = entry.trim();
  const pre = s.match(/^read-?only:\s*(.+)$/i);
  if (pre) return { path: pre[1]!.trim(), readOnly: true };
  const post = s.match(/^(.+?)\s*\(\s*read-?only\s*\)$/i);
  if (post) return { path: post[1]!.trim(), readOnly: true };
  return { path: s, readOnly: false };
}
