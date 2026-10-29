// Comment and docstring scanner for /doc (S17). Pure functions, no file system.
//   scan(lang, src)   -> token spans: comments, docstrings (Python) and the string-like literals that must stay put
//   stripped(lang, src) -> the code with every comment and docstring removed, normalised for comparison: blank lines
//                        outside string literals are dropped and lines that lost a comment lose their trailing space.
//   sameCode(lang, a, b) -> true when a and b differ only in comments, docstrings and blank lines between code.
//   listSymbols(lang, src) -> functions, classes and methods with their line range and whether a doc is present.
// Languages: Python ("py") and JavaScript/TypeScript ("js", for .js .mjs .cjs .ts .mts .cts). JSX/TSX are refused
// (JSX text can hold quotes and slashes that are not code, so no tokenizer here can tell). Any other file type: not
// supported, the caller refuses.
// Known limits, all on the safe side except the first: a JS regex literal the heuristic takes for a division can hide
// a change inside it from the comparison (the compile check is the second net); Python f-strings that reuse their own
// quote inside the braces (3.12) end the string early, which can only make the comparison stricter or fail the check.
import { extname } from "node:path";

export type Lang = "py" | "js";

// Comments that act on tools, not on readers: kept as code, so a model can neither drop nor edit them.
const JS_DIRECTIVE = /^\/\/\s*(?:@ts-|eslint-|prettier-ignore|#|\/\s*<)|^\/\*\s*(?:eslint|istanbul|c8|global|jshint|webpackChunkName|@vite)|^#!/;

/** The language of a path, or null when /doc cannot guarantee "comments only" for it. */
export function langOf(path: string): Lang | null {
  const e = extname(path).toLowerCase();
  if (e === ".py") return "py";
  if ([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"].includes(e)) return "js";
  return null;
}

export interface Span {
  kind: "comment" | "docstring" | "string";
  start: number;
  /** exclusive */
  end: number;
}

interface PyTok {
  type: "str" | "name" | "op" | "num" | "nl";
  text: string;
  start: number;
  end: number;
}

const isIdStart = (c: string) => /[A-Za-z_]/.test(c) || c > "\x7f";
const isId = (c: string) => /[A-Za-z0-9_]/.test(c) || c > "\x7f";

/** End (exclusive) of the string literal that opens at `i` (the quote char), Python rules. */
function pyStringEnd(src: string, i: number): number {
  const q = src[i]!;
  const triple = src.startsWith(q + q + q, i);
  let j = i + (triple ? 3 : 1);
  while (j < src.length) {
    const c = src[j]!;
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (triple) {
      if (src.startsWith(q + q + q, j)) return j + 3;
    } else {
      if (c === q) return j + 1;
      if (c === "\n") return j; // unterminated: stop at the line end
    }
    j++;
  }
  return src.length;
}

interface PyScan {
  spans: Span[];
  toks: PyTok[];
  /** logical lines as ranges of toks (newline tokens excluded) */
  lines: { first: number; last: number; indent: number; line: number }[];
}

function pyScan(src: string): PyScan {
  const spans: Span[] = [];
  const toks: PyTok[] = [];
  let depth = 0;
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "#") {
      let j = src.indexOf("\n", i);
      if (j < 0) j = src.length;
      const text = src.slice(i, j);
      const line = src.slice(0, i).split("\n").length;
      const protectedLine = (i === 0 && text.startsWith("#!")) || (line <= 2 && /coding[:=]/.test(text)) || /^#\s*(?:type:|noqa|pragma|pylint:|fmt:|isort:|mypy:|ruff:|pyright:|flake8:)/.test(text);
      spans.push({ kind: protectedLine ? "string" : "comment", start: i, end: j });
      i = j;
    } else if (c === "\n") {
      if (depth === 0) toks.push({ type: "nl", text: "\n", start: i, end: i + 1 });
      i++;
    } else if (c === "\\" && src[i + 1] === "\n") {
      i += 2;
    } else if (c === " " || c === "\t" || c === "\r" || c === "\f") {
      i++;
    } else if (c === '"' || c === "'") {
      const e = pyStringEnd(src, i);
      toks.push({ type: "str", text: src.slice(i, e), start: i, end: e });
      i = e;
    } else if (isIdStart(c)) {
      let j = i + 1;
      while (j < src.length && isId(src[j]!)) j++;
      const word = src.slice(i, j);
      if (/^[rRbBfFuU]{1,3}$/.test(word) && (src[j] === '"' || src[j] === "'")) {
        const e = pyStringEnd(src, j);
        toks.push({ type: "str", text: src.slice(i, e), start: i, end: e });
        i = e;
      } else {
        toks.push({ type: "name", text: word, start: i, end: j });
        i = j;
      }
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[0-9A-Za-z_.]/.test(src[j]!)) j++;
      toks.push({ type: "num", text: src.slice(i, j), start: i, end: j });
      i = j;
    } else {
      if ("([{".includes(c)) depth++;
      else if (")]}".includes(c)) depth = Math.max(0, depth - 1);
      toks.push({ type: "op", text: c, start: i, end: i + 1 });
      i++;
    }
  }
  // logical lines
  const lines: PyScan["lines"] = [];
  let first = -1;
  const lineStarts: number[] = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === "\n") lineStarts.push(k + 1);
  const lineNo = (pos: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  for (let k = 0; k <= toks.length; k++) {
    const t = toks[k];
    if (!t || t.type === "nl") {
      if (first >= 0) {
        const ls = lineStarts[lineNo(toks[first]!.start) - 1]!;
        lines.push({ first, last: k - 1, indent: toks[first]!.start - ls, line: lineNo(toks[first]!.start) });
        first = -1;
      }
    } else if (first < 0) first = k;
  }
  // docstrings and the other strings
  const doc = new Set<number>();
  lines.forEach((ln, idx) => {
    const only = toks.slice(ln.first, ln.last + 1).every((t) => t.type === "str");
    if (!only) return;
    const prev = lines[idx - 1];
    const header = prev && toks[prev.last]!.text === ":" && ["def", "class", "async"].includes(toks[prev.first]!.text);
    if (idx === 0 || header) for (let k = ln.first; k <= ln.last; k++) doc.add(k);
  });
  toks.forEach((t, k) => {
    if (t.type === "str") spans.push({ kind: doc.has(k) ? "docstring" : "string", start: t.start, end: t.end });
  });
  spans.sort((a, b) => a.start - b.start);
  return { spans, toks, lines };
}

const KW_BEFORE_REGEX = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

/** End (exclusive) of a template literal that opens at `i` (the backtick); `${ ... }` is skipped with nesting. */
function jsTemplateEnd(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length) {
    const c = src[j]!;
    if (c === "\\") j += 2;
    else if (c === "`") return j + 1;
    else if (c === "$" && src[j + 1] === "{") {
      let d = 1;
      j += 2;
      while (j < src.length && d > 0) {
        const x = src[j]!;
        if (x === "{") d++;
        else if (x === "}") d--;
        else if (x === "`") {
          j = jsTemplateEnd(src, j);
          continue;
        } else if (x === '"' || x === "'") {
          j = jsQuoteEnd(src, j);
          continue;
        }
        j++;
      }
    } else j++;
  }
  return src.length;
}

function jsQuoteEnd(src: string, i: number): number {
  const q = src[i]!;
  let j = i + 1;
  while (j < src.length) {
    const c = src[j]!;
    if (c === "\\") j += 2;
    else if (c === q) return j + 1;
    else if (c === "\n") return j;
    else j++;
  }
  return src.length;
}

function jsRegexEnd(src: string, i: number): number {
  let j = i + 1;
  let cls = false;
  while (j < src.length) {
    const c = src[j]!;
    if (c === "\\") j += 2;
    else if (c === "\n") return -1;
    else if (c === "[") {
      cls = true;
      j++;
    } else if (c === "]") {
      cls = false;
      j++;
    } else if (c === "/" && !cls) {
      j++;
      while (j < src.length && /[A-Za-z]/.test(src[j]!)) j++;
      return j;
    } else j++;
  }
  return -1;
}

function jsScan(src: string): Span[] {
  const spans: Span[] = [];
  let prev = ""; // last significant token: a punctuation char, "num", or a word
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === "/" && src[i + 1] === "/") {
      let j = src.indexOf("\n", i);
      if (j < 0) j = src.length;
      spans.push({ kind: JS_DIRECTIVE.test(src.slice(i, j)) ? "string" : "comment", start: i, end: j });
      i = j;
    } else if (c === "/" && src[i + 1] === "*") {
      const e = src.indexOf("*/", i + 2);
      const j = e < 0 ? src.length : e + 2;
      spans.push({ kind: JS_DIRECTIVE.test(src.slice(i, j)) ? "string" : "comment", start: i, end: j });
      i = j;
    } else if (c === "#" && i === 0 && src[1] === "!") {
      let j = src.indexOf("\n");
      if (j < 0) j = src.length;
      spans.push({ kind: "string", start: 0, end: j });
      i = j;
    } else if (c === '"' || c === "'") {
      const e = jsQuoteEnd(src, i);
      spans.push({ kind: "string", start: i, end: e });
      i = e;
      prev = "str";
    } else if (c === "`") {
      const e = jsTemplateEnd(src, i);
      spans.push({ kind: "string", start: i, end: e });
      i = e;
      prev = "str";
    } else if (c === "/") {
      const regexOk = prev === "" || (prev.length === 1 && "(,=:[!&|?{};+-*%<>~^".includes(prev)) || KW_BEFORE_REGEX.has(prev);
      const e = regexOk ? jsRegexEnd(src, i) : -1;
      if (e > 0) {
        spans.push({ kind: "string", start: i, end: e });
        i = e;
        prev = "str";
      } else {
        prev = "/";
        i++;
      }
    } else if (isIdStart(c) || c === "$") {
      let j = i + 1;
      while (j < src.length && (isId(src[j]!) || src[j] === "$")) j++;
      prev = src.slice(i, j);
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < src.length && /[0-9A-Za-z_.]/.test(src[j]!)) j++;
      prev = "num";
      i = j;
    } else if (/\s/.test(c)) {
      i++;
    } else {
      prev = c;
      i++;
    }
  }
  return spans;
}

export function scan(lang: Lang, src: string): Span[] {
  return lang === "py" ? pyScan(src).spans : jsScan(src);
}

/** The code with comments and docstrings removed, normalised (see the header) so two texts can be compared. */
export function stripped(lang: Lang, src: string, spans: Span[] = scan(lang, src)): string {
  const remove = spans.filter((s) => s.kind !== "string");
  const keep = spans.filter((s) => s.kind === "string");
  const inString = (p: number) => keep.some((s) => s.start <= p && p < s.end);
  const out: string[] = [];
  let off = 0;
  for (const raw of src.split("\n")) {
    const ls = off;
    const le = off + raw.length;
    off = le + 1;
    const startsInString = ls > 0 && inString(ls - 1);
    const endsInString = le < src.length && inString(le);
    // the characters of this line that are not in a removed span
    let text = "";
    let p = ls;
    for (const s of remove) {
      if (s.end <= ls || s.start >= le) continue;
      text += src.slice(p, Math.max(p, s.start));
      p = Math.min(le, s.end);
    }
    text += src.slice(p, le);
    if (startsInString || endsInString) {
      out.push(text);
      continue;
    }
    const t = text.replace(/[ \t\r\f]+$/, "");
    if (t.trim() !== "") out.push(t);
  }
  return out.join("\n");
}

export function sameCode(lang: Lang, a: string, b: string): boolean {
  return stripped(lang, a) === stripped(lang, b);
}

// ---------------------------------------------------------------- symbols

export interface Sym {
  /** stable across edits that only add docs: kind + qualified name + ordinal among equals */
  key: string;
  kind: "module" | "function" | "class" | "method" | "type";
  name: string;
  /** 1-based first line (the decorator-less header) */
  line: number;
  /** 1-based last line of the body (capped) */
  end: number;
  hasDoc: boolean;
}

const BODY_CAP = 80;

function pySymbols(src: string): Sym[] {
  const { toks, lines, spans } = pyScan(src);
  const docLines = new Set<number>();
  lines.forEach((ln, idx) => {
    if (toks.slice(ln.first, ln.last + 1).every((t) => t.type === "str") && spans.some((s) => s.kind === "docstring" && s.start === toks[ln.first]!.start)) docLines.add(idx);
  });
  const out: Sym[] = [];
  const stack: { indent: number; name: string; cls: boolean }[] = [];
  const seen = new Map<string, number>();
  const total = src.split("\n").length;
  const add = (kind: Sym["kind"], qual: string, line: number, end: number, hasDoc: boolean) => {
    const base = `${kind}:${qual}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ key: `${base}#${n}`, kind, name: qual, line, end, hasDoc });
  };
  const first = lines[0];
  // a module docstring is wanted once the module has code
  if (first) add("module", "(module)", 1, Math.min(total, 20), docLines.has(0));
  lines.forEach((ln, idx) => {
    const head = toks[ln.first]!;
    let k = ln.first;
    if (head.text === "async" && toks[k + 1]?.text === "def") k++;
    const kw = toks[k]!.text;
    if (toks[k]!.type !== "name" || (kw !== "def" && kw !== "class") || toks[k + 1]?.type !== "name") return;
    while (stack.length && stack[stack.length - 1]!.indent >= ln.indent) stack.pop();
    const name = toks[k + 1]!.text;
    const qual = [...stack.map((s) => s.name), name].join(".");
    let endIdx = idx;
    for (let j = idx + 1; j < lines.length && lines[j]!.indent > ln.indent; j++) endIdx = j;
    const lastTok = toks[lines[endIdx]!.last]!;
    const endLine = endIdx === idx ? ln.line : src.slice(0, lastTok.end).split("\n").length;
    const inClass = stack.length > 0 && stack[stack.length - 1]!.cls;
    add(kw === "class" ? "class" : inClass ? "method" : "function", qual, ln.line, Math.min(endLine, ln.line + BODY_CAP), docLines.has(idx + 1));
    stack.push({ indent: ln.indent, name, cls: kw === "class" });
  });
  return out;
}

const NOT_METHODS = new Set(["if", "for", "while", "switch", "catch", "function", "return", "with", "else", "do", "try", "typeof", "new", "super", "constructor_"]);

/** src with comments, strings and regexes blanked (newlines and length kept), for structure matching. */
function mask(src: string, spans: Span[]): string {
  const chars = src.split("");
  for (const s of spans) for (let k = s.start; k < s.end; k++) if (chars[k] !== "\n") chars[k] = " ";
  return chars.join("");
}

function matchBrace(m: string, from: number): number {
  const open = m.indexOf("{", from);
  if (open < 0) return -1;
  let d = 0;
  for (let k = open; k < m.length; k++) {
    if (m[k] === "{") d++;
    else if (m[k] === "}" && --d === 0) return k;
  }
  return -1;
}

function jsSymbols(src: string): Sym[] {
  const spans = jsScan(src);
  const m = mask(src, spans);
  const lines = src.split("\n");
  const mlines = m.split("\n");
  const starts: number[] = [];
  let o = 0;
  for (const l of lines) {
    starts.push(o);
    o += l.length + 1;
  }
  const lineOf = (pos: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const docBefore = (li: number): boolean => {
    let k = li - 1;
    while (k >= 0 && lines[k]!.trim().startsWith("@")) k--;
    if (k < 0) return false;
    const endPos = starts[k]! + lines[k]!.replace(/\s+$/, "").length;
    const sp = spans.find((s) => s.kind === "comment" && s.end === endPos);
    if (!sp) return false;
    return src.startsWith("/**", sp.start) || src.startsWith("//", sp.start);
  };
  const classes: { name: string; from: number; to: number }[] = [];
  const out: Sym[] = [];
  const seen = new Map<string, number>();
  const add = (kind: Sym["kind"], qual: string, li: number, endLi: number) => {
    const base = `${kind}:${qual}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ key: `${base}#${n}`, kind, name: qual, line: li + 1, end: Math.min(endLi, li + BODY_CAP) + 1, hasDoc: docBefore(li) });
  };
  const endLine = (li: number, braces: boolean): number => {
    if (!braces) return li;
    const e = matchBrace(m, starts[li]!);
    return e < 0 ? Math.min(lines.length - 1, li + 40) : lineOf(e);
  };
  for (let li = 0; li < mlines.length; li++) {
    const l = mlines[li]!;
    const cls = l.match(/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/);
    if (cls) {
      const e = endLine(li, true);
      classes.push({ name: cls[1]!, from: li, to: e });
      add("class", cls[1]!, li, e);
      continue;
    }
    const fn = l.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/);
    if (fn) {
      add("function", fn[1]!, li, endLine(li, true));
      continue;
    }
    const arrow = l.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::\s*[^=]+?)?=>/);
    if (arrow) {
      add("function", arrow[1]!, li, endLine(li, /=>\s*\{/.test(l)));
      continue;
    }
    const ty = l.match(/^\s*(?:export\s+)?(?:declare\s+)?(?:interface|enum)\s+([A-Za-z_$][\w$]*)|^\s*export\s+type\s+([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*=/);
    if (ty) {
      add("type", (ty[1] ?? ty[2])!, li, endLine(li, /\{/.test(l)));
      continue;
    }
    const inCls = classes.find((c) => li > c.from && li <= c.to);
    if (inCls) {
      const me = l.match(/^\s+(?:(?:public|private|protected|static|async|override|abstract|readonly|get|set)\s+)*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::\s*[^{;=]+)?\{\s*$/);
      if (me && !NOT_METHODS.has(me[1]!)) add("method", `${inCls.name}.${me[1]!}`, li, endLine(li, true));
    }
  }
  return out;
}

export function listSymbols(lang: Lang, src: string): Sym[] {
  return lang === "py" ? pySymbols(src) : jsSymbols(src);
}
