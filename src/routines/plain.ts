import { readFile } from "node:fs/promises";
import type { Routine } from "./base.ts";
import { normalizeEolText, atomicWrite } from "./util.ts";

/** Any file type without its own routine: the file is the text, and there is nothing to check. */
export const plainRoutine: Routine = {
  name: "plain",
  exts: [],
  available: () => ({ ok: true }),
  async load(path) {
    return { text: normalizeEolText(await readFile(path, "utf8")), viewPath: path };
  },
  async save(path, text) {
    await atomicWrite(path, text);
  },
  async check() {
    return { ok: true, out: "no check for this file type" };
  },
};
