// File-type routines (rule 8). A routine knows how to load a file as editable text, save edited text back, and check
// the result. The registry picks one by extension; unknown types get the plain-text routine (check = none).
import { extname } from "node:path";
import type { Routine } from "./base.ts";
import { plainRoutine } from "./plain.ts";
import { pyRoutine } from "./py.ts";
import { scptRoutine } from "./scpt.ts";

export * from "./base.ts";
const ROUTINES: Routine[] = [pyRoutine, scptRoutine];

/** The routine for a path, by extension; the plain-text routine when none matches. */
export function routineFor(path: string): Routine {
  const ext = extname(path).toLowerCase();
  return ROUTINES.find((r) => r.exts.includes(ext)) ?? plainRoutine;
}

/** Every extension a specific routine handles. */
export const KNOWN_EXTS: string[] = ROUTINES.flatMap((r) => r.exts);
export { plainRoutine, pyRoutine, scptRoutine };
