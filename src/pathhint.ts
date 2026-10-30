// Wrong-path hint: a small model mistypes the long absolute path of its working directory, gets ENOENT, and goes
// searching the file system (find /tmp ...) instead of using the project. When a read / edit / write fails with
// "no such file" on a path outside the project (or one that does not exist) and a file with the same name exists in
// the project, one line is appended to the error. Pure: index.ts calls it from the tool_result hook.
import { existsSync } from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { repoFiles } from "./context/outline.ts";

const PATH_TOOLS = new Set(["read", "edit", "write"]);

/** `files` = the project's files, "/"-separated relative to `cwd` (default: repoFiles). null = no hint. */
export function wrongPathHint(
  cwd: string,
  toolName: string,
  input: Record<string, unknown>,
  isError: boolean,
  errorText: string,
  files?: string[],
): string | null {
  if (!isError || !PATH_TOOLS.has(toolName) || !/ENOENT|no such file|not found/i.test(errorText)) return null;
  const given = String(input.path ?? input.file_path ?? "").trim();
  if (!given) return null;
  const abs = resolve(cwd, given);
  const rel = relative(resolve(cwd), abs);
  const inside = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  if (inside && existsSync(abs)) return null; // the path is fine; the error is about something else
  const name = basename(given);
  if (!name) return null;
  const same = (files ?? repoFiles(cwd)).filter((f) => basename(f) === name);
  if (!same.length) return null;
  // the shallowest match first (repoFiles lists a directory's own files before its sub-directories)
  const pick = [...same].sort((a, b) => a.split("/").length - b.split("/").length)[0]!;
  if (pick === rel) return null;
  return `No such path. The project is ${resolve(cwd)}; did you mean ${pick}? Use paths relative to the project.`;
}
