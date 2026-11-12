import { readFile } from "node:fs/promises";
import { run, runAskedTests, type Routine } from "./base.ts";
import { atomicWrite, normalizeEolText } from "./util.ts";

const PLAIN_JS = /\.(?:js|mjs|cjs)$/i;

/**
 * .ts .mts .cts .js .mjs .cjs, with "ts" in config languages (design languages-and-oracles §1.6): the file is the text;
 * check = `node --check` for plain JS (the Node running tinyCode, so it is always there; .ts gets no type check), then
 * the test /edit asked for, run with the project's own check. .tsx and .jsx stay on the plain routine.
 */
export const codeRoutine: Routine = {
  name: "code",
  exts: [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"],
  available: () => ({ ok: true }),
  async load(path) {
    return { text: normalizeEolText(await readFile(path, "utf8")), viewPath: path };
  },
  async save(path, text) {
    await atomicWrite(path, text);
  },
  async check(path, o) {
    if (PLAIN_JS.test(path)) {
      const r = await run(process.execPath, ["--check", path], { cwd: o.cwd });
      if (r.code !== 0) return { ok: false, out: `node --check failed:\n${r.out}`.slice(0, 3200) };
    }
    return (await runAskedTests(o)) ?? { ok: true, out: PLAIN_JS.test(path) ? "syntax ok" : "no check for .ts (type checks are not run)" };
  },
};
