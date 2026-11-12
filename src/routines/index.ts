// File-type routines (rule 8). A routine knows how to load a file as editable text, save edited text back, and check
// the result. The registry picks one by extension; unknown types get the plain-text routine (check = none).
import { extname } from "node:path";
import type { Routine } from "./base.ts";
import { codeRoutine } from "./code.ts";
import { plainRoutine } from "./plain.ts";
import { pyRoutine } from "./py.ts";
import { scptRoutine } from "./scpt.ts";

export * from "./base.ts";
const ROUTINES: Routine[] = [pyRoutine, scptRoutine];

/** The routine for a path, by extension; the plain-text routine when none matches. JS/TS files get the code routine only with "ts" in `langs` (config languages). */
export function routineFor(path: string, langs: readonly string[] = ["py"]): Routine {
  const ext = extname(path).toLowerCase();
  if (langs.includes("ts") && codeRoutine.exts.includes(ext)) return codeRoutine;
  return ROUTINES.find((r) => r.exts.includes(ext)) ?? plainRoutine;
}

/** Every extension a specific routine handles, for /edit's argument parsing (the code routine's are left out, so it parses as before). */
export const KNOWN_EXTS: string[] = ROUTINES.flatMap((r) => r.exts);
export { codeRoutine, plainRoutine, pyRoutine, scptRoutine };
