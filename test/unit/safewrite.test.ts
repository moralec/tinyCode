import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { checkInside, UnsafePathError, writeInside } from "../../src/safewrite.ts";

const setup = () => {
  const root = tmpDir("tc-safewrite-");
  const proj = join(root, "proj");
  mkdirSync(proj);
  writeFileSync(join(root, "victim.txt"), "ORIGINAL");
  return { root, proj };
};

test("writeInside: writes a new file, creating missing directories, and replaces an existing regular file", () => {
  const { proj } = setup();
  assert.equal(writeInside(proj, join("docs", "deep", "a.html"), "one"), join(proj, "docs", "deep", "a.html"));
  assert.equal(readFileSync(join(proj, "docs", "deep", "a.html"), "utf8"), "one");
  writeInside(proj, join("docs", "deep", "a.html"), "two");
  assert.equal(readFileSync(join(proj, "docs", "deep", "a.html"), "utf8"), "two");
});

test("writeInside: a symlinked leaf, a dangling leaf and a symlinked directory are refused; nothing outside changes", () => {
  const { root, proj } = setup();
  symlinkSync(join(root, "victim.txt"), join(proj, "leaf.md"));
  assert.throws(() => writeInside(proj, "leaf.md", "x"), UnsafePathError);
  symlinkSync(join(root, "new.txt"), join(proj, "dangling.md"));
  assert.throws(() => writeInside(proj, "dangling.md", "x"), /symlink/);
  mkdirSync(join(root, "outdir"));
  symlinkSync(join(root, "outdir"), join(proj, "docs"));
  assert.throws(() => writeInside(proj, join("docs", "overview.html"), "x"), /symlink: docs/);
  assert.equal(readFileSync(join(root, "victim.txt"), "utf8"), "ORIGINAL");
  assert.ok(!existsSync(join(root, "new.txt")));
  assert.ok(!existsSync(join(root, "outdir", "overview.html")));
  assert.ok(lstatSync(join(proj, "leaf.md")).isSymbolicLink(), "the link itself is left alone");
});

test("checkInside: escaping and absolute paths are refused; a directory where a file belongs is refused", () => {
  const { proj } = setup();
  for (const p of ["../x", "a/../../x", "/etc/passwd", ""]) assert.throws(() => checkInside(proj, p), UnsafePathError, p);
  mkdirSync(join(proj, "d"));
  assert.throws(() => checkInside(proj, "d"), /regular file/);
  assert.equal(checkInside(proj, "missing/x.txt"), join(proj, "missing", "x.txt"));
});
