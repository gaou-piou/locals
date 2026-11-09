/**
 * Step 3a: browses every captured site with a CDN request once, with λocals, in one profile (bench/.cache/trained-profile).
 * live.ts --conditions …,"λocals trained" then starts each load from a copy of it: what auto-cache learned is kept,
 * the browser's HTTP cache is not, so the gain measured is the extension's alone.
 *
 *   pnpm tsx bench/train.ts [--parallel 4]
 */
import { chromium } from "@playwright/test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { splitEvery, uniq } from "ramda";
import { LOCALS_DIR, OUT, TRAINED_PROFILE } from "./config.ts";

const { values } = parseArgs({ options: { parallel: { type: "string", default: "4" } } });
if (existsSync(TRAINED_PROFILE)) throw new Error(`${TRAINED_PROFILE} exists: move it away to train again`);

type Coverage = { rows: { site: string; initiator: string; cdn: boolean }[] };
const coverage: Coverage = JSON.parse(await readFile(`${OUT}/coverage.json`, "utf8"));
const urls = uniq(coverage.rows.filter((r) => r.cdn).map((r) => r.initiator));

const ctx = await chromium.launchPersistentContext(TRAINED_PROFILE, {
  channel: "chromium",
  headless: true,
  ignoreHTTPSErrors: true,
  args: [`--disable-extensions-except=${LOCALS_DIR}`, `--load-extension=${LOCALS_DIR}`],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
const kept = () =>
  sw.evaluate(async () => {
    const entries: Record<string, { bytes: number }> = ((await chrome.storage.local.get("cache")).cache as any)?.entries ?? {};
    return { files: Object.keys(entries).length, bytes: Object.values(entries).reduce((n, e) => n + e.bytes, 0) };
  });

console.log(`training on ${urls.length} sites → ${TRAINED_PROFILE}`);
let visited = 0;
for (const batch of splitEvery(Number(values.parallel), urls)) {
  await Promise.all(
    batch.map(async (url) => {
      const page = await ctx.newPage();
      await page.goto(url, { waitUntil: "load", timeout: 45_000 }).catch(() => {});
      await page.waitForTimeout(2_000);
      await page.close().catch(() => {});
    }),
  );
  visited += batch.length;
  const k = await kept();
  console.log(`[${visited}/${urls.length}] kept ${k.files} files, ${(k.bytes / 1e6).toFixed(1)} MB`);
}

// the last copies are still being fetched: wait until the count stops moving
let last = -1;
for (let i = 0; i < 30; i++) {
  const { files } = await kept();
  if (files === last) break;
  last = files;
  await new Promise((r) => setTimeout(r, 2_000));
}
const k = await kept();
const { rules, hosts } = await sw.evaluate(async () => ({
  rules: (await chrome.declarativeNetRequest.getDynamicRules()).filter((r) => r.id >= 500_100).length,
  hosts: Object.keys(((await chrome.storage.local.get("cache")).cache as any)?.hosts ?? {}).length,
}));
console.log(`done: ${k.files} files (${rules} rules), ${(k.bytes / 1e6).toFixed(1)} MB; ${hosts} hosts with a CSP verdict`);
await ctx.close();
