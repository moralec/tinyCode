// Parsing of model replies: SEARCH/REPLACE blocks (ported from our benchmark BLOCK) and the whole-file fallback.
// Pure: no file system. Line endings: a reply is normalised to LF before parsing, so CRLF replies parse the same.

export interface EditBlock {
  /** path as cleaned by cleanPath (not yet checked) */
  path: string;
  search: string;
  replace: string;
}

export interface FileBlock {
  path: string;
  content: string;
}

// tc0.BLOCK, re.S -> [\s\S]. Group 1 = path line, optionally followed by a ``` fence line.
// A doubled `<<<<<<< SEARCH` or `>>>>>>> REPLACE` line (the model repeats the marker) counts once: otherwise the second
// SEARCH line became the text to find and nothing was written (fix-6's reproduction test, runs-fix 2026-11-11).
const BLOCK_SOURCE =
  "([^\\n`]+?)\\s*\\n(?:```[^\\n]*\\n)?<<<<<<< SEARCH\\n(?:<<<<<<< SEARCH\\n)*([\\s\\S]*?)\\n?=======\\n([\\s\\S]*?)\\n?>>>>>>> REPLACE(?:\\n>>>>>>> REPLACE)*";

export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** tc0: path.strip().strip("`*# ").replace("\\", "/"); also a leading "File:" / "Path:" (a model echoing the prompt's "File: x.py" line, doc-2-todo) */
export function cleanPath(raw: string): string {
  return raw
    .trim()
    .replace(/^[`*# ]+|[`*# ]+$/g, "")
    .replace(/^(?:file|path)\s*:\s*/i, "")
    .replace(/^[`*# ]+/, "")
    .replace(/\\/g, "/");
}

/**
 * A doubled divider: the model closes REPLACE with a second `=======` before `>>>>>>> REPLACE`. The lazy match leaves
 * that line at the end of REPLACE, so a new file ended in "=======" (a syntax error). Every /build task-1 try recorded
 * by 2026-11-11 (7 replies on build-1/build-3), one matrix reply and two October goldens (gemma-4-12b, qwen3.5-4b) did
 * this; no recorded reply needs the line kept.
 */
const DOUBLED_DIVIDER = /(?:^|\n)=======$/;

export function parseBlocks(reply: string): EditBlock[] {
  return [...normalizeEol(reply).matchAll(new RegExp(BLOCK_SOURCE, "g"))].map((m) => ({
    path: cleanPath(m[1]!),
    search: m[2]!,
    replace: m[3]!.replace(DOUBLED_DIVIDER, ""),
  }));
}

function looksLikePath(p: string): boolean {
  return p.length > 0 && p.length < 200 && !/\s/.test(p) && /[./]/.test(p);
}

/**
 * Whole-file fallback format: `path` on its own line, then the complete file in a code fence. Only fences
 * directly under a path-looking line count; prose and bare snippets are ignored.
 */
export function parseWholeFiles(reply: string): FileBlock[] {
  const lines = normalizeEol(reply).replace(new RegExp(BLOCK_SOURCE, "g"), "\n\n").split("\n");
  const isFence = (l: string) => l.trimStart().startsWith("```");
  const out: FileBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isFence(lines[i]!)) {
      // a fence without a path line above it: skip to its close
      while (++i < lines.length && !isFence(lines[i]!)) {
        /* skip */
      }
      continue;
    }
    if (i + 1 < lines.length && isFence(lines[i + 1]!)) {
      const path = cleanPath(lines[i]!.replace(/:\s*$/, ""));
      let j = i + 2;
      while (j < lines.length && !isFence(lines[j]!)) j++;
      if (looksLikePath(path) && j < lines.length) out.push({ path, content: lines.slice(i + 2, j).join("\n") });
      i = j;
    }
  }
  return out;
}
