// Forgiving edits (limits.forgiveEdits). Pi's `edit` needs every edits[].oldText to match the file exactly (Pi itself
// forgives trailing spaces, CRLF and Unicode quotes/dashes only). Nemotron-Nano-9B-v2 at 16k (runs-radar 2026-10-30,
// 94 failed edit calls in 5 runs, both arms) mostly sent the right lines with the wrong indentation: the block dedented as a whole
// (`def f():\n    pass` for `    def f():\n        pass`), every line shifted by the same amount. It retried the same
// oldText until the cap (dot-dsl: 36 of 36 edits). The rest were stale or invented text, never safe to guess.
//
// When Pi says "Could not find", the call is retried here with whole lines compared after their indentation, the
// indentation off by the SAME prefix on every non-blank line, for an oldText of 2+ non-blank lines (one line is only
// located). Exactly one such place per edit, or nothing is applied;
// all edits[] of the call apply together or none (Pi's all-or-nothing). The replacement is re-indented by that prefix.
// When Pi says "Found N occurrences", the result names each occurrence's lines with the nearest line above and below,
// so the next try can be exact. Anything else: Pi's message stays. Pure text functions; index.ts does the file I/O.
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export interface EditPair {
  oldText: string;
  newText: string;
}

/** The edits of an `edit` call, in the shapes Pi accepts (edits[] array or JSON string, one edit object, legacy oldText/newText). */
export function editsOf(input: Record<string, unknown>): EditPair[] | null {
  let edits: unknown = input.edits;
  if (typeof edits === "string") {
    try {
      edits = JSON.parse(edits);
    } catch {
      return null;
    }
  }
  const one = (v: unknown): v is EditPair => !!v && typeof v === "object" && typeof (v as EditPair).oldText === "string" && typeof (v as EditPair).newText === "string";
  let list: unknown[] = Array.isArray(edits) ? [...edits] : one(edits) ? [edits] : [];
  if (typeof input.oldText === "string" && typeof input.newText === "string") list = [...list, { oldText: input.oldText, newText: input.newText }];
  if (!list.length || !list.every(one)) return null;
  return (list as EditPair[]).map((e) => ({ oldText: lf(e.oldText), newText: lf(e.newText) }));
}

export interface PiEditError {
  kind: "notfound" | "dup";
  /** the edits[] index Pi named; 0 for a single-edit call */
  index: number;
}

/** Pi's two match errors (edit-diff.js getNotFoundError / getDuplicateError); null for any other text. */
export function parsePiEditError(text: string): PiEditError | null {
  const nf = /^Could not find (?:the exact text|edits\[(\d+)\]) in /.exec(text);
  if (nf) return { kind: "notfound", index: Number(nf[1] ?? 0) };
  const dup = /^Found \d+ occurrences of (?:the text|edits\[(\d+)\]) in /.exec(text);
  if (dup) return { kind: "dup", index: Number(dup[1] ?? 0) };
  return null;
}

/** the tolerant match needs at least 2 non-blank lines of oldText */
const multiLine = (old: string): boolean => old.split("\n").filter((l) => l.trim() !== "").length >= 2;
const lf = (t: string): string => t.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
const indentOf = (l: string): string => /^[ \t]*/.exec(l)![0];
const blank = (l: string): boolean => l.trim() === "";

/** old text as lines; a final newline is a flag, not an empty last line */
function oldLines(old: string): { lines: string[]; nl: boolean } {
  const nl = old.endsWith("\n");
  return { lines: (nl ? old.slice(0, -1) : old).split("\n"), nl };
}

/** One place where oldText matches whole file lines with a uniform indentation shift. 0-based lines, end exclusive. */
export interface Window {
  line0: number;
  line1: number;
  /** what the file has more (+1) or less (-1) on every non-blank line; "" = indentation equal (trailing spaces differ) */
  prefix: string;
  sign: 1 | -1;
}

/** The shift that turns `oldIndent` into `fileIndent`, or null when one is not a prefix-extension of the other. */
function shiftOf(fileIndent: string, oldIndent: string): { prefix: string; sign: 1 | -1 } | null {
  if (fileIndent.length >= oldIndent.length && fileIndent.endsWith(oldIndent)) return { prefix: fileIndent.slice(0, fileIndent.length - oldIndent.length), sign: 1 };
  if (oldIndent.endsWith(fileIndent)) return { prefix: oldIndent.slice(0, oldIndent.length - fileIndent.length), sign: -1 };
  return null;
}

/** Every window of `file` (LF) that matches `old` line by line: same text after the indentation (trailing spaces ignored),
 *  blank lines against blank lines, and one indentation shift for all non-blank lines. */
export function tolerantWindows(file: string, old: string): Window[] {
  const { lines: ol } = oldLines(old);
  if (ol.every(blank)) return [];
  const fl = file.split("\n");
  const out: Window[] = [];
  for (let i = 0; i + ol.length <= fl.length; i++) {
    let shift: { prefix: string; sign: 1 | -1 } | null = null;
    let ok = true;
    for (let j = 0; j < ol.length && ok; j++) {
      const o = ol[j]!;
      const f = fl[i + j]!;
      if (blank(o) || blank(f)) {
        ok = blank(o) && blank(f);
        continue;
      }
      const oi = indentOf(o);
      const fi = indentOf(f);
      if (f.slice(fi.length).trimEnd() !== o.slice(oi.length).trimEnd()) {
        ok = false;
        continue;
      }
      const s = shiftOf(fi, oi);
      // an equal indent reads as sign +1 with prefix ""; any non-empty shift must be the same on every line
      if (!s || (shift && (s.prefix !== shift.prefix || (s.prefix !== "" && s.sign !== shift.sign)))) ok = false;
      else shift ??= s;
    }
    if (ok && shift) out.push({ line0: i, line1: i + ol.length, ...shift });
  }
  return out;
}

/** newText shifted like the matched window; null when a line has less indentation than the shift takes away. */
export function reindent(text: string, prefix: string, sign: 1 | -1): string | null {
  if (!prefix) return text;
  const out: string[] = [];
  for (const l of text.split("\n")) {
    if (blank(l)) out.push(l);
    else if (sign === 1) out.push(prefix + l);
    else if (l.startsWith(prefix)) out.push(l.slice(prefix.length));
    else return null;
  }
  return out.join("\n");
}

/** character offset of the start of each line, plus the text length at the end */
function lineStarts(text: string): number[] {
  const s = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") s.push(i + 1);
  return s;
}

interface Span {
  start: number;
  end: number;
  text: string;
  tolerant: boolean;
}

function exactCount(file: string, old: string): { count: number; at: number } {
  let count = 0;
  let at = -1;
  for (let i = file.indexOf(old); i !== -1; i = file.indexOf(old, i + old.length)) {
    if (at < 0) at = i;
    count++;
  }
  return { count, at };
}

export interface Applied {
  content: string;
  /** 1-based line ranges of the replaced blocks in the new file, in file order */
  lines: [number, number][];
  /** edits matched by the whitespace-tolerant rule (the others matched exactly) */
  tolerant: number;
}

/**
 * All edits against the same original text (LF, no BOM), as Pi does: each one unique (exact, else exactly one
 * tolerant window), none overlapping, the result different from the original. Otherwise null and nothing applies.
 */
export function forgiveApply(file: string, edits: EditPair[]): Applied | null {
  if (!edits.length) return null;
  const starts = lineStarts(file);
  const spans: Span[] = [];
  for (const e of edits) {
    if (!e.oldText) return null;
    const ex = exactCount(file, e.oldText);
    if (ex.count > 1) return null;
    if (ex.count === 1) {
      spans.push({ start: ex.at, end: ex.at + e.oldText.length, text: e.newText, tolerant: false });
      continue;
    }
    // one line is too little to place by its text alone (a same-text line at another nesting level): located, not applied
    if (!multiLine(e.oldText)) return null;
    const w = tolerantWindows(file, e.oldText);
    if (w.length !== 1) return null;
    const { prefix, sign, line0, line1 } = w[0]!;
    const text = reindent(e.newText, prefix, sign);
    if (text === null) return null;
    const { nl } = oldLines(e.oldText);
    const start = starts[line0]!;
    // the window ends at the end of its last line; a final newline in oldText takes the line break too
    const lastEnd = (starts[line1] ?? file.length + 1) - 1;
    const end = nl ? Math.min(file.length, lastEnd + 1) : lastEnd;
    spans.push({ start, end, text, tolerant: true });
  }
  spans.sort((a, b) => a.start - b.start);
  for (let i = 1; i < spans.length; i++) if (spans[i - 1]!.end > spans[i]!.start) return null;
  let content = "";
  let pos = 0;
  const lines: [number, number][] = [];
  for (const s of spans) {
    content += file.slice(pos, s.start);
    const first = content.split("\n").length;
    content += s.text;
    const body = s.text.endsWith("\n") ? s.text.slice(0, -1) : s.text;
    lines.push([first, first + body.split("\n").length - 1]);
    pos = s.end;
  }
  content += file.slice(pos);
  if (content === file) return null;
  return { content, lines, tolerant: spans.filter((s) => s.tolerant).length };
}

const MAX_LISTED = 4;
const ctxLine = (fl: string[], i: number, step: 1 | -1): string | null => {
  for (let k = i; k >= 0 && k < fl.length; k += step) if (!blank(fl[k]!)) return `${k + 1}| ${fl[k]!.trim().slice(0, 70)}`;
  return null;
};
const range = (a: number, b: number): string => (a === b ? String(a) : `${a}-${b}`);

/** "a-b: above N| text, below M| text" for each window (0-based, end exclusive), at most MAX_LISTED */
function listWindows(file: string, ws: { line0: number; line1: number }[]): string[] {
  const fl = file.split("\n");
  const out = ws.slice(0, MAX_LISTED).map((w) => {
    const up = ctxLine(fl, w.line0 - 1, -1);
    const down = ctxLine(fl, w.line1, 1);
    return `${range(w.line0 + 1, w.line1)}: ${[up ? `above ${up}` : "", down ? `below ${down}` : ""].filter(Boolean).join(", ") || "no other lines"}`;
  });
  if (ws.length > MAX_LISTED) out.push(`+${ws.length - MAX_LISTED} more`);
  return out;
}

/** Where Pi's duplicate oldText occurs (Pi counts with trailing spaces ignored, so the same is done here), 0-based windows. */
export function occurrences(file: string, old: string): { line0: number; line1: number }[] {
  const strip = (t: string) => t.split("\n").map((l) => l.trimEnd()).join("\n");
  const f = strip(file);
  const o = strip(old);
  if (!o) return [];
  const n = (o.endsWith("\n") ? o.slice(0, -1) : o).split("\n").length;
  const out: { line0: number; line1: number }[] = [];
  for (let i = f.indexOf(o); i !== -1; i = f.indexOf(o, i + o.length)) {
    const line0 = f.slice(0, i).split("\n").length - 1;
    out.push({ line0, line1: line0 + n });
  }
  return out;
}

export type Forgiven =
  | { kind: "applied"; content: string; text: string; lines: [number, number][]; tolerant: number }
  | { kind: "clarified"; text: string; lines: [number, number][] };

/**
 * What tinyCode makes of Pi's failed edit. `file` is the file text as on disk; `errText` Pi's error. applied: the new
 * file text (BOM and line endings kept as Pi keeps them) and the success line; clarified: the error to show instead.
 */
export function forgive(file: string, edits: EditPair[], errText: string): Forgiven | null {
  const err = parsePiEditError(errText);
  if (!err || !edits.length) return null;
  const bom = file.startsWith("\uFEFF") ? "\uFEFF" : "";
  const raw = bom ? file.slice(1) : file;
  const crlf = raw.indexOf("\r\n");
  const lfAt = raw.indexOf("\n");
  const eol = lfAt !== -1 && crlf !== -1 && crlf < lfAt ? "\r\n" : "\n";
  const text = lf(raw);
  const named = edits[err.index] ?? edits[0]!;
  const label = edits.length > 1 ? `edits[${err.index}] oldText` : "oldText";
  if (err.kind === "notfound") {
    const a = forgiveApply(text, edits);
    if (a) {
      const content = bom + (eol === "\r\n" ? a.content.replace(/\n/g, "\r\n") : a.content);
      const where = a.lines.map(([x, y]) => range(x, y)).join(", ");
      const n = edits.length > 1 ? ` ${edits.length} blocks` : "";
      return { kind: "applied", content, text: `Applied${n} (whitespace-tolerant match, lines ${where}).`, lines: a.lines, tolerant: a.tolerant };
    }
    // the named edit fits several places once indentation is ignored: say where, so the next try can be exact
    if (exactCount(text, named.oldText).count === 0) {
      const ws = tolerantWindows(text, named.oldText);
      if (ws.length > 1 || (ws.length === 1 && !multiLine(named.oldText)))
        return {
          kind: "clarified",
          text: [`${label} not exact. Same lines, other indent, at lines ${ws.map((w) => range(w.line0 + 1, w.line1)).join(", ")}. Copy indent from file${ws.length > 1 ? "; add a nearby line to make it unique" : ""}.`, ...listWindows(text, ws)].join("\n"),
          lines: ws.map((w) => [w.line0 + 1, w.line1]),
        };
    }
    return null;
  }
  const occ = occurrences(text, named.oldText);
  if (occ.length < 2) return null;
  return {
    kind: "clarified",
    text: [`${label} at lines ${occ.map((w) => range(w.line0 + 1, w.line1)).join(", ")}. Add a nearby line to make it unique.`, ...listWindows(text, occ)].join("\n"),
    lines: occ.map((w) => [w.line0 + 1, w.line1]),
  };
}

export interface ForgiveCall {
  /** the project-relative path */
  path: string;
  result: Forgiven;
}

/**
 * The tool_result side: Pi's failed `edit` call re-tried on the file on disk. Applied edits are written here. Never a
 * test file (src/workflows/fix.ts isTestPath, the same rule the auto-undo uses), never a path outside cwd.
 */
export function forgiveEditCall(cwd: string, input: Record<string, unknown>, errText: string, isTest: (rel: string) => boolean): ForgiveCall | null {
  if (!parsePiEditError(errText)) return null;
  const given = String(input.path ?? input.file_path ?? "").trim();
  const edits = editsOf(input);
  if (!given || !edits) return null;
  const abs = resolve(cwd, given.replace(/^@/, ""));
  const rel = relative(resolve(cwd), abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  const relPosix = rel.split("\\").join("/");
  let file: string;
  try {
    file = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  const result = forgive(file, edits, errText);
  if (!result) return null;
  if (result.kind === "applied") {
    if (isTest(relPosix)) return null;
    try {
      writeFileSync(abs, result.content, "utf8");
    } catch {
      return null;
    }
  }
  return { path: relPosix, result };
}
