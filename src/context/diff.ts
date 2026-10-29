// `git diff` → hunks. Pure parsing plus one git call (execFile, no shell).
import { execFileSync } from "node:child_process";

export interface Hunk {
  file: string;
  /** the full `@@ -a,b +c,d @@ context` line */
  header: string;
  oldStart: number;
  newStart: number;
  /** body lines, each with its leading ` `, `+`, `-` (or `\` marker) */
  lines: string[];
}

function unquote(p: string): string {
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      return JSON.parse(p) as string;
    } catch {
      return p.slice(1, -1);
    }
  }
  return p;
}

export function parseDiff(text: string): Hunk[] {
  const hunks: Hunk[] = [];
  let oldFile = "";
  let newFile = "";
  let cur: Hunk | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line.startsWith("diff --git ")) {
      cur = null;
      oldFile = newFile = "";
      const m = line.match(/^diff --git (a\/.+?|"a\/.*?") (b\/.+|"b\/.*")$/);
      if (m) {
        oldFile = unquote(m[1]).slice(2);
        newFile = unquote(m[2]).slice(2);
      }
      continue;
    }
    if (!cur && line.startsWith("--- ")) {
      const p = unquote(line.slice(4).split("\t")[0]);
      if (p !== "/dev/null" && p.startsWith("a/")) oldFile = p.slice(2);
      continue;
    }
    if (!cur && line.startsWith("+++ ")) {
      const p = unquote(line.slice(4).split("\t")[0]);
      if (p !== "/dev/null" && p.startsWith("b/")) newFile = p.slice(2);
      else if (p === "/dev/null") newFile = "";
      continue;
    }
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) {
      cur = { file: newFile || oldFile, header: line, oldStart: Number(h[1]), newStart: Number(h[2]), lines: [] };
      hunks.push(cur);
      continue;
    }
    if (cur && line !== "" && " +-\\".includes(line[0])) cur.lines.push(line);
  }
  return hunks;
}

/** Hunks of the working-tree diff (`git diff`, or `git diff <args>`); empty when git fails or there is none. */
export function gitHunks(cwd: string, args: string[] = []): Hunk[] {
  try {
    const out = execFileSync("git", ["diff", "--no-color", "--no-ext-diff", "--src-prefix=a/", "--dst-prefix=b/", ...args], {
      cwd,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseDiff(out);
  } catch {
    return [];
  }
}
