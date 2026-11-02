import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as tar from "tar";

export const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** Builds an npm-style tarball (everything under `package/`) in memory. */
export async function makeTarball(files: Record<string, string>): Promise<Buffer> {
  const dir = mkdtempSync(join(tmpdir(), "cdnm-tar-"));
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, "package", path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  const chunks: Buffer[] = [];
  for await (const c of tar.c({ gzip: true, cwd: dir }, ["package"])) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export const tmp = () => mkdtempSync(join(tmpdir(), "cdnm-out-"));
