// .scpt (compiled AppleScript), macOS only. load = osadecompile to text; save = osacompile to a temp .scpt beside the
// original, then an atomic rename over it, after copying the original to `<file>.scpt.bak`. A compile failure throws
// and leaves the original untouched. Gated by process.platform: the one place we shell out to platform tools.
import { copyFile, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { onPath, run, RoutineError, type Routine } from "./base.ts";
import { normalizeEolText } from "./util.ts";

export const scptRoutine: Routine = {
  name: "scpt",
  exts: [".scpt"],
  viewExt: ".applescript",
  available() {
    if (process.platform !== "darwin" || !onPath("osadecompile") || !onPath("osacompile")) {
      return { ok: false, why: "AppleScript routine needs macOS" };
    }
    return { ok: true };
  },
  async load(path) {
    const r = await run("osadecompile", [path]);
    if (r.code !== 0) throw new RoutineError(`osadecompile failed:\n${r.out}`);
    const dir = await mkdtemp(join(tmpdir(), "tinycode-scpt-"));
    const viewPath = join(dir, basename(path).replace(/\.scpt$/i, "") + ".applescript");
    // osadecompile output is the script text; its own trailing newline is part of it
    const text = normalizeEolText(r.out) + "\n";
    await writeFile(viewPath, text);
    return { text, viewPath };
  },
  async save(path, text, opts) {
    const dir = await mkdtemp(join(dirname(path), ".tinycode-"));
    const src = join(dir, "edit.applescript");
    const out = join(dir, "edit.scpt");
    try {
      await writeFile(src, text);
      const r = await run("osacompile", ["-o", out, src]);
      if (r.code !== 0) throw new RoutineError(`osacompile failed:\n${r.out}`);
      if (opts?.backup !== false) await copyFile(path, path + ".bak");
      await rename(out, path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
  async check(path) {
    const r = await run("osadecompile", [path]);
    return { ok: r.code === 0, out: r.code === 0 ? "compiled script loads" : `osadecompile failed:\n${r.out}` };
  },
};
