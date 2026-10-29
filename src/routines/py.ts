import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type Routine } from "./base.ts";
import { atomicWrite, normalizeEolText } from "./util.ts";
import { runTests } from "../testrun.ts";

/** .py: the file is the text; check = `<python> -m py_compile`, then the configured test when one is given. */
export const pyRoutine: Routine = {
  name: "py",
  exts: [".py"],
  available: () => ({ ok: true }),
  async load(path) {
    return { text: normalizeEolText(await readFile(path, "utf8")), viewPath: path };
  },
  async save(path, text) {
    await atomicWrite(path, text);
  },
  async check(path, o) {
    // py_compile writes a .pyc; send it to the temp dir so the project tree stays clean
    const r = await run(o.python, ["-m", "py_compile", path], {
      cwd: o.cwd,
      env: { PYTHONPYCACHEPREFIX: join(tmpdir(), "tinycode-pyc") },
    });
    if (r.code !== 0) return { ok: false, out: `py_compile failed:\n${r.out}`.slice(0, 3200) };
    if (o.test && (o.test.path || o.test.command)) {
      const t = await runTests({
        cwd: o.cwd,
        test: o.test.path,
        config: { python: o.python, command: o.test.command },
      });
      return { ok: t.ok, out: t.text };
    }
    return { ok: true, out: "py_compile ok" };
  },
};
