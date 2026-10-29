import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, basename, join } from "node:path";

export const normalizeEolText = (s: string) => s.replace(/\r\n/g, "\n");

/** Write next to the target, then rename over it. Keeps CRLF when the file had it. */
export async function atomicWrite(path: string, data: string | Buffer): Promise<void> {
  let body = data;
  if (typeof data === "string") {
    let crlf = false;
    try {
      const old = await readFile(path, "utf8");
      const c = (old.match(/\r\n/g) ?? []).length;
      crlf = c > 0 && c >= (old.match(/\n/g) ?? []).length - c;
    } catch {
      // new file
    }
    body = crlf ? data.replace(/\n/g, "\r\n") : data;
  }
  const tmp = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(tmp, body);
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}
