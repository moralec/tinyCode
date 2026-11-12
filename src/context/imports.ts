// In-repo import edges, line-based like outline.ts (design plan-build-fit, E21). `localImports` gives the files one
// file imports (forward edges, one level); `reverseImports` inverts it over the repo's files (the importers). One
// scanner for both directions, Python always and TS/JS with "ts" in `langs`. Only edges that resolve to a file in
// `files` count; paths are `/`-separated throughout (repoFiles returns them that way), so Windows needs no special case.
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";

const PY = /\.py$/;
const JS = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/;
const JS_EXT = [".ts", ".tsx", ".js", ".mjs", ".cjs"];

/** A dotted module path as a file in `files`: `a/b.py`, else `a/b/__init__.py`. */
function pyModule(path: string, files: ReadonlySet<string>): string | null {
  if (!path) return null;
  for (const c of [`${path}.py`, `${path}/__init__.py`]) if (files.has(c)) return c;
  return null;
}

/** Python statements one per entry: a parenthesised `from x import (a,\n b)` is joined onto one line; comments dropped. */
function pyStatements(text: string): string[] {
  const out: string[] = [];
  let open: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "");
    if (open !== null) {
      open += " " + line.trim();
      if (line.includes(")")) {
        out.push(open);
        open = null;
      }
      continue;
    }
    if (/^\s*from\s+\S+\s+import\s*\(/.test(line) && !line.includes(")")) open = line.trim();
    else out.push(line);
  }
  if (open !== null) out.push(open);
  return out;
}

function pyImports(file: string, text: string, files: ReadonlySet<string>): string[] {
  const found: string[] = [];
  const add = (p: string | null) => {
    if (p && p !== file && !found.includes(p)) found.push(p);
  };
  const pkgDir = posix.dirname(file) === "." ? "" : posix.dirname(file);
  for (const st of pyStatements(text)) {
    const imp = st.match(/^\s*import\s+(.+)$/);
    if (imp) {
      for (const part of imp[1]!.split(",")) {
        const mod = part.trim().split(/\s+/)[0] ?? "";
        if (/^[\w.]+$/.test(mod)) add(pyModule(mod.replace(/\./g, "/"), files));
      }
      continue;
    }
    const from = st.match(/^\s*from\s+(\.*)([\w.]*)\s+import\s+(.+)$/);
    if (!from) continue;
    const dots = from[1]!.length;
    const mod = from[2]!;
    let base: string;
    if (dots === 0) base = mod.replace(/\./g, "/");
    else {
      // relative: one dot is the file's own package, each further dot one level up
      let dir = pkgDir;
      for (let i = 1; i < dots; i++) dir = dir.includes("/") ? posix.dirname(dir) : "";
      base = [dir, mod.replace(/\./g, "/")].filter(Boolean).join("/");
    }
    if (dots === 0 && !base) continue;
    add(base ? pyModule(base, files) : files.has("__init__.py") ? "__init__.py" : null);
    const names = from[3]!.replace(/[()]/g, " ").split(",").map((n) => n.trim().split(/\s+/)[0] ?? "").filter((n) => /^\w+$/.test(n));
    for (const n of names) add(pyModule(base ? `${base}/${n}` : n, files));
  }
  return found;
}

/** A relative specifier from `file`'s folder: as written, then with each JS/TS extension, then `<x>/index.*`; `./x.js` also tries `x.ts`. */
function jsResolve(file: string, spec: string, files: ReadonlySet<string>): string | null {
  const p = posix.normalize(posix.join(posix.dirname(file), spec));
  if (p.startsWith("..")) return null;
  const cands = [p, ...JS_EXT.map((e) => p + e), ...JS_EXT.map((e) => `${p}/index${e}`)];
  const js = p.match(/^(.*)\.(?:js|mjs|cjs|jsx)$/);
  if (js) cands.push(`${js[1]}.ts`, `${js[1]}.tsx`, `${js[1]}.mts`, `${js[1]}.cts`);
  return cands.find((c) => files.has(c)) ?? null;
}

const JS_SPECS = [
  /\b(?:import|export)\b[^"';]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function jsImports(file: string, text: string, files: ReadonlySet<string>): string[] {
  const hits: { at: number; path: string }[] = [];
  for (const re of JS_SPECS) {
    for (const m of text.matchAll(re)) {
      const spec = m[1]!;
      if (!spec.startsWith("./") && !spec.startsWith("../")) continue; // a package or an alias: not a repo edge
      const r = jsResolve(file, spec, files);
      if (r && r !== file) hits.push({ at: m.index ?? 0, path: r });
    }
  }
  return [...new Set(hits.sort((a, b) => a.at - b.at).map((h) => h.path))];
}

/** The in-repo files `file` imports (one level), in the order they appear; only files in `files` count. */
export function localImports(file: string, text: string, files: readonly string[] | ReadonlySet<string>, langs: readonly string[] = ["py"]): string[] {
  const set = files instanceof Set ? (files as ReadonlySet<string>) : new Set(files as readonly string[]);
  if (PY.test(file)) return pyImports(file, text, set);
  if (langs.includes("ts") && JS.test(file)) return jsImports(file, text, set);
  return [];
}

/** target -> the files that import it (one level), built once over `files` by inverting `localImports`. */
export function reverseImports(cwd: string, targets: readonly string[], files: readonly string[], langs: readonly string[] = ["py"]): Map<string, string[]> {
  const want = new Set(targets);
  const set = new Set(files);
  const out = new Map<string, string[]>(targets.map((t) => [t, []]));
  for (const f of files) {
    if (!PY.test(f) && !(langs.includes("ts") && JS.test(f))) continue;
    let text: string;
    try {
      text = readFileSync(join(cwd, f), "utf8");
    } catch {
      continue;
    }
    for (const t of localImports(f, text, set, langs)) if (want.has(t)) out.get(t)!.push(f);
  }
  return out;
}
