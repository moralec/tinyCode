// Temp dirs for tests: created under the OS temp dir like mkdtempSync(join(tmpdir(), prefix)), removed when the test
// process ends. (Tests used to leave them behind; 99 empty "route-*" dirs once sat in /tmp.)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];
process.on("exit", () => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

export function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
}
