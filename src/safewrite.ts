// Writes that stay inside a chosen directory (security audit 2026-11-09, BACKLOG "Release", group 1).
// A repository can commit a symlink at any path tinyCode writes to (docs/overview.html, .tinycode/, a README), and
// writeFileSync follows it to a file outside the project. writeInside refuses a symlink (or anything but a directory)
// at every component below the base and anything but a regular file at the leaf, creates missing directories one level
// at a time, and writes a temp file that is renamed over the target, so no link is ever followed. A refusal throws
// UnsafePathError; the caller's error path reports it. The base itself is the operator's (cwd, or an --out they chose).
import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";

export class UnsafePathError extends Error {}

function parts(rel: string): string[] {
  const n = normalize(rel);
  if (!n || n === "." || isAbsolute(n) || n === ".." || n.startsWith(".." + sep)) throw new UnsafePathError(`not inside the project: ${rel}`);
  return n.split(sep).filter((p) => p && p !== ".");
}

/** base/rel when no existing component below base is a symlink, a directory component is a directory and the leaf (if it exists) a regular file; else throws. */
export function checkInside(base: string, rel: string): string {
  const ps = parts(rel);
  let cur = base;
  for (let i = 0; i < ps.length; i++) {
    cur = join(cur, ps[i]!);
    let st;
    try {
      st = lstatSync(cur);
    } catch {
      break; // missing from here on
    }
    const shown = ps.slice(0, i + 1).join("/");
    if (st.isSymbolicLink()) throw new UnsafePathError(`refusing to follow a symlink: ${shown}`);
    if (i < ps.length - 1 ? !st.isDirectory() : !st.isFile()) throw new UnsafePathError(`not a ${i < ps.length - 1 ? "directory" : "regular file"}: ${shown}`);
  }
  return join(base, ...ps);
}

/** Write base/rel without following links: checks every component, makes missing directories, temp file + rename. */
export function writeInside(base: string, rel: string, data: string | Buffer): string {
  const target = checkInside(base, rel);
  const ps = parts(rel);
  let cur = base;
  for (const p of ps.slice(0, -1)) {
    cur = join(cur, p);
    try {
      mkdirSync(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    if (!lstatSync(cur).isDirectory()) throw new UnsafePathError(`not a directory: ${cur}`);
  }
  const tmp = join(dirname(target), `.${basename(target)}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, data, { flag: "wx" });
    renameSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
  return target;
}
