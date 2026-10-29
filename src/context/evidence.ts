// Search evidence for the branch/review calls: keywords from a question, a file/def outline and scored line hits.
// Port of pi-branch `keywords/evidence` (same caps) in pure Node: `git ls-files` through execFile (no shell),
// and a directory walk when the folder is not a git repo (the Python prototypes returned nothing there).
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoFiles } from "./outline.ts";

export const HITS_CHARS = 5200;
export const OUTLINE_CHARS = 2800;

const STOP = new Set(
  ("the a an and or of to in is are was be it this that where what which how why when who does do " +
    "set sets used use uses file files code function functions find for on with by from at as into there here " +
    "defined define called call value values").split(" "),
);

export function trackedFiles(cwd: string): string[] {
  try {
    const out = execFileSync("git", ["ls-files"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const files = out.split("\n").filter(Boolean);
    if (files.length) return files;
  } catch {
    // not a git repo, or git missing
  }
  return repoFiles(cwd);
}

function readText(path: string): string | null {
  try {
    if (statSync(path).size > 400_000) return null;
    const buf = readFileSync(path);
    if (buf.includes(0)) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

export function keywords(question: string): string[] {
  const words = question.match(/[A-Za-z_][A-Za-z0-9_.]{2,}/g) ?? [];
  const out = new Set<string>();
  for (const w of words) {
    const lw = w.toLowerCase().replace(/\.$/, "");
    if (STOP.has(lw)) continue;
    out.add(lw);
    for (const part of lw.split(/[_.]/)) if (part.length >= 4 && !STOP.has(part)) out.add(part);
  }
  return [...out].slice(0, 12);
}

export interface Evidence {
  outline: string;
  hits: string;
}

export function evidence(
  cwd: string,
  question: string,
  caps: { hitsCap?: number; outlineCap?: number } = {},
): Evidence {
  const hitsCap = caps.hitsCap ?? HITS_CHARS;
  const outlineCap = caps.outlineCap ?? OUTLINE_CHARS;
  const kws = keywords(question);
  const outlineLines: string[] = [];
  const scored: { score: number; line: string }[] = [];
  for (const f of trackedFiles(cwd)) {
    const text = readText(join(cwd, f));
    if (text === null) continue;
    const lines = text.split("\n");
    if (/\.(py|js|ts)$/.test(f)) {
      const defs: string[] = [];
      for (const l of lines) {
        const m = l.match(/^(?:def|class|function|async def)\s+([A-Za-z_]\w*)/);
        if (m) defs.push(m[1]);
      }
      outlineLines.push(`${f}: ${defs.join(", ") || "-"}`);
    } else {
      outlineLines.push(`${f} (${lines.length} lines)`);
    }
    const lf = f.toLowerCase();
    lines.forEach((l, i) => {
      const ll = l.toLowerCase();
      let score = 0;
      for (const k of kws) if (ll.includes(k)) score += 2;
      for (const k of kws) if (lf.includes(k)) score += 1;
      if (score >= 2) scored.push({ score, line: `${f}:${i + 1}: ${l.trim().slice(0, 160)}` });
    });
  }
  // stable sort: ties keep file/line order, like python's sort
  scored.sort((a, b) => b.score - a.score);
  let hits = "";
  for (const s of scored) {
    if (hits.length + s.line.length > hitsCap) break;
    hits += s.line + "\n";
  }
  let outline = outlineLines.join("\n");
  if (outline.length > outlineCap) outline = outline.slice(0, outlineCap) + "\n...";
  return { outline, hits: hits || "(no matching lines)" };
}
