import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Extension size budget, recorded in docs/spike-results.md. */
export const BUDGET_BYTES = 25 * 1024 * 1024;

export function dirSize(dir: string): number {
  return readdirSync(dir, { withFileTypes: true }).reduce(
    (sum, e) => sum + (e.isDirectory() ? dirSize(join(dir, e.name)) : statSync(join(dir, e.name)).size),
    0,
  );
}

export function checkSize(bytes: number): { ok: boolean; message: string } {
  const mb = (n: number) => (n / 1024 / 1024).toFixed(2);
  return bytes > BUDGET_BYTES
    ? { ok: false, message: `dist is ${mb(bytes)} MB and exceeds the ${mb(BUDGET_BYTES)} MB budget` }
    : { ok: true, message: `dist is ${mb(bytes)} MB of ${mb(BUDGET_BYTES)} MB` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dist = fileURLToPath(new URL("../dist", import.meta.url));
  const r = checkSize(dirSize(dist));
  console.log(r.message);
  if (!r.ok) process.exit(1);
}
