import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tmpDir } from "./tmpdir.ts";
import { wrongPathHint } from "../../src/pathhint.ts";

function project(): string {
  const d = tmpDir("tinycode-hint-");
  mkdirSync(join(d, "pkg/sub"), { recursive: true });
  writeFileSync(join(d, "main.py"), "x = 1\n");
  writeFileSync(join(d, "pkg/sub/deep.py"), "y = 1\n");
  writeFileSync(join(d, "pkg/main.py"), "z = 1\n");
  return d;
}
const ENOENT = (p: string) => `ENOENT: no such file or directory, access '${p}'`;

test("wrong absolute path with the right file name: one hint line naming the project and the relative path", () => {
  const cwd = project();
  const typo = cwd.replace("tinycode-hint-", "tinycode_hint-") + "/main.py";
  assert.equal(
    wrongPathHint(cwd, "read", { path: typo }, true, ENOENT(typo)),
    `No such path. The project is ${cwd}; did you mean main.py? Use paths relative to the project.`,
  );
  assert.match(wrongPathHint(cwd, "edit", { path: "/elsewhere/deep.py" }, true, "File not found")!, /did you mean pkg\/sub\/deep\.py\?/);
  assert.match(wrongPathHint(cwd, "write", { file_path: "/x/y/main.py" }, true, ENOENT("/x/y/main.py"))!, /did you mean main\.py\?/, "shallowest match wins");
});

test("no hint: success, other tools, other errors, existing path, name not in the project", () => {
  const cwd = project();
  const typo = "/nope/main.py";
  assert.equal(wrongPathHint(cwd, "read", { path: typo }, false, ENOENT(typo)), null);
  assert.equal(wrongPathHint(cwd, "bash", { path: typo }, true, ENOENT(typo)), null);
  assert.equal(wrongPathHint(cwd, "read", { path: typo }, true, "permission denied"), null);
  assert.equal(wrongPathHint(cwd, "read", { path: join(cwd, "main.py") }, true, ENOENT("x")), null);
  assert.equal(wrongPathHint(cwd, "read", { path: "/nope/other.py" }, true, ENOENT("/nope/other.py")), null);
  assert.equal(wrongPathHint(cwd, "read", {}, true, ENOENT("")), null);
});

test("a relative path that is missing in the project gets the right relative one; an explicit file list is used as given", () => {
  const cwd = project();
  assert.match(wrongPathHint(cwd, "read", { path: "src/deep.py" }, true, ENOENT("src/deep.py"))!, /did you mean pkg\/sub\/deep\.py\?/);
  assert.match(wrongPathHint("/proj", "read", { path: "/x/a.py" }, true, ENOENT("/x/a.py"), ["lib/a.py"])!, /^No such path\. The project is \/proj; did you mean lib\/a\.py\?/);
});
