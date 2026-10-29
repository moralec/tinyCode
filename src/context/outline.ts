// Repo outline: files + top-level Python names and signatures. Port of tc1.repo_files / tc1.outline, with a
// line-based reader instead of Python's `ast` (see README rule: pure TypeScript, no Python at runtime).
// Parity with tc1.outline() is tested on every bakeoff task repo (test/unit/outline.test.ts).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const SKIP_DIRS = new Set([".git", "__pycache__", ".venv", "venv", "node_modules", ".pytest_cache"]);
export const TEXT_EXT = new Set([
  ".py", ".md", ".txt", ".ini", ".cfg", ".toml", ".json", ".yaml", ".yml", ".js", ".html", ".css", ".sh",
  ".service", ".conf", ".scpt", "",
]);

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** os.path.splitext: the extension of the last component; a leading dot alone is not an extension. */
function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i);
}

/** Text files under cwd, "/"-separated, in tc1 order: a directory's files (sorted), then its sub-directories (sorted). */
export function repoFiles(cwd: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    let entries;
    try {
      entries = readdirSync(join(cwd, rel), { withFileTypes: true });
    } catch {
      return;
    }
    const dirs: string[] = [];
    const files: string[] = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) dirs.push(e.name);
      } else if (e.isFile() || e.isSymbolicLink()) {
        if (TEXT_EXT.has(extOf(e.name)) && !e.name.startsWith(".")) files.push(e.name);
      }
    }
    for (const f of files.sort(cmp)) out.push(rel ? `${rel}/${f}` : f);
    for (const d of dirs.sort(cmp)) walk(rel ? `${rel}/${d}` : d);
  };
  walk("");
  return out;
}

interface Logical {
  indent: number;
  text: string;
}

/**
 * Split Python source into logical lines: continuation lines (open brackets, trailing backslash, triple-quoted
 * strings) are joined, comments dropped, blank lines skipped. `indent` is the first physical line's indentation.
 */
export function logicalLines(src: string): Logical[] {
  const out: Logical[] = [];
  let cur = "";
  let indent = 0;
  let started = false;
  let depth = 0;
  let i = 0;
  const n = src.length;
  const flush = () => {
    if (started && cur.trim()) out.push({ indent, text: cur.trim() });
    cur = "";
    started = false;
  };
  while (i < n) {
    if (!started) {
      // at a physical line start with no logical line open: measure indent
      let j = i;
      let w = 0;
      while (j < n && (src[j] === " " || src[j] === "\t" || src[j] === "\f")) {
        w += src[j] === "\t" ? 8 - (w % 8) : src[j] === "\f" ? 0 : 1;
        j++;
      }
      if (j >= n) break;
      if (src[j] === "\n" || src[j] === "\r" || src[j] === "#") {
        while (j < n && src[j] !== "\n") j++;
        i = j + 1;
        continue;
      }
      indent = w;
      started = true;
      i = j;
      continue;
    }
    const c2 = src[i];
    if (c2 === "#") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c2 === "'" || c2 === '"') {
      const triple = src.startsWith(c2.repeat(3), i);
      const q = triple ? c2.repeat(3) : c2;
      // string prefix letters were already appended as ordinary chars
      let j = i + q.length;
      cur += q;
      while (j < n) {
        if (src[j] === "\\") {
          cur += src.slice(j, j + 2);
          j += 2;
          continue;
        }
        if (src.startsWith(q, j)) {
          cur += q;
          j += q.length;
          break;
        }
        if (!triple && src[j] === "\n") break; // unterminated single-quoted string: stop at EOL
        cur += src[j];
        j++;
      }
      i = j;
      continue;
    }
    if (c2 === "\\" && (src[i + 1] === "\n" || (src[i + 1] === "\r" && src[i + 2] === "\n"))) {
      i += src[i + 1] === "\r" ? 3 : 2;
      cur += " ";
      continue;
    }
    if (c2 === "(" || c2 === "[" || c2 === "{") depth++;
    else if (c2 === ")" || c2 === "]" || c2 === "}") depth = Math.max(0, depth - 1);
    if (c2 === "\n") {
      if (depth === 0) {
        flush();
        i++;
        continue;
      }
      cur += " ";
      i++;
      continue;
    }
    if (c2 !== "\r") cur += c2;
    i++;
  }
  flush();
  return out;
}

const DEF_RE = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/;
const CLASS_RE = /^class\s+([A-Za-z_]\w*)/;
const ASSIGN_RE = /^((?:[A-Za-z_]\w*\s*=\s*)+)(?!=)/;

/** Positional parameter names, like python `[a.arg for a in node.args.args]` (no posonly, *args, kw-only, **kw). */
function positionalArgs(text: string): string[] {
  const open = text.indexOf("(");
  let depth = 0;
  const parts: string[] = [];
  let cur = "";
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break;
      depth--;
    }
    if (c === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else cur += c;
  }
  parts.push(cur);
  const names: string[] = [];
  for (const raw of parts) {
    const p = raw.trim();
    if (!p) continue;
    if (p === "/") {
      names.length = 0;
      continue;
    }
    if (p.startsWith("*")) break;
    const m = p.match(/^[A-Za-z_]\w*/);
    if (m) names.push(m[0]);
  }
  return names;
}

const sig = (name: string, text: string) => `${name}(${positionalArgs(text).join(", ")})`;
const isUpper = (s: string) => /[A-Z]/.test(s) && !/[a-z]/.test(s);

export interface PyOutline {
  /** "def f(a, b); class C: m(self); X, Y" style parts, in source order */
  parts: string[];
  /** top-level function and class names */
  names: string[];
}

export function pyOutline(src: string): PyOutline {
  const lines = logicalLines(src);
  const parts: string[] = [];
  const names: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const { indent, text } = lines[i];
    if (indent !== 0) continue;
    const d = text.match(DEF_RE);
    if (d) {
      parts.push("def " + sig(d[1], text));
      names.push(d[1]);
      continue;
    }
    const c = text.match(CLASS_RE);
    if (c) {
      const meths: string[] = [];
      const bodyIndent = i + 1 < lines.length && lines[i + 1].indent > 0 ? lines[i + 1].indent : -1;
      for (let j = i + 1; j < lines.length && lines[j].indent > 0; j++) {
        if (lines[j].indent !== bodyIndent) continue;
        const m = lines[j].text.match(DEF_RE);
        if (m) meths.push(sig(m[1], lines[j].text));
      }
      parts.push(`class ${c[1]}: ${meths.join(", ")}`);
      names.push(c[1]);
      continue;
    }
    const a = text.match(ASSIGN_RE);
    if (a) {
      const targets = a[1].split("=").map((t) => t.trim()).filter(Boolean);
      if (targets.every(isUpper)) parts.push(targets.join(", "));
    }
  }
  return { parts, names };
}

function lineCount(text: string): number {
  if (text === "") return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

/** The outline text: `path: def f(a); class C: m(self); X` per file, or names only when over `cap` chars. */
export function outline(cwd: string, cap = 8000): string {
  const full: string[] = [];
  const short: string[] = [];
  for (const f of repoFiles(cwd)) {
    let buf: Buffer;
    try {
      buf = readFileSync(join(cwd, f));
    } catch {
      continue;
    }
    if (!f.endsWith(".py")) {
      const line = `${f} (${lineCount(buf.toString("utf8"))} lines)`;
      full.push(line);
      short.push(line);
      continue;
    }
    let src: string;
    try {
      src = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      full.push(f);
      short.push(f);
      continue;
    }
    const { parts, names } = pyOutline(src);
    full.push(`${f}: ${parts.join("; ") || "-"}`);
    short.push(`${f}: ${names.join(", ") || "-"}`);
  }
  let text = full.join("\n");
  if (text.length > cap) text = short.join("\n");
  return text.length <= cap ? text : text.slice(0, cap) + "\n...";
}
