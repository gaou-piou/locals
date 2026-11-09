/**
 * Step 1: loads every site of sites.txt in a plain Chromium (no extension) and records the scripts, styles and fonts
 * it requests. The result is the URL corpus that the coverage step feeds to all three extensions.
 *
 *   pnpm tsx bench/capture.ts [--concurrency 8] [--limit N]
 *
 * Resumable: sites already in bench/out/capture.jsonl are skipped.
 */
import { chromium, type Browser } from "@playwright/test";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import { splitEvery } from "ramda";
import { OUT, SITES_FILE, TYPES } from "./config.ts";
import { readJsonl, type CapturedSite } from "./data.ts";

const { values } = parseArgs({ options: { concurrency: { type: "string", default: "8" }, limit: { type: "string" } } });
const FILE = `${OUT}/capture.jsonl`;
await mkdir(OUT, { recursive: true });

const all = (await readFile(SITES_FILE, "utf8")).split("\n").filter((l) => l && !l.startsWith("#"));
const done = new Set(existsSync(FILE) ? (await readJsonl<CapturedSite>(FILE)).map((s) => s.site) : []);
const todo = all.filter((s) => !done.has(s)).slice(0, values.limit ? Number(values.limit) : undefined);
console.log(`${todo.length} to capture (${done.size} done)`);

const UA_TYPES = new Set<string>(TYPES);

async function capture(browser: Browser, site: string): Promise<CapturedSite> {
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const requests: CapturedSite["requests"] = [];
  ctx.on("request", (r) => {
    if (UA_TYPES.has(r.resourceType()) && /^https?:/.test(r.url())) requests.push({ url: r.url(), type: r.resourceType() });
  });
  try {
    const page = await ctx.newPage();
    const res = await page.goto(`https://${site}/`, { waitUntil: "load", timeout: 25_000 });
    await page.waitForTimeout(3_000); // late, script-inserted libraries
    return { site, ok: true, status: res?.status() ?? 0, finalUrl: page.url(), requests };
  } catch (err) {
    return { site, ok: false, status: 0, finalUrl: "", error: String(err).split("\n")[0], requests };
  } finally {
    await ctx.close().catch(() => {});
  }
}

const browser = await chromium.launch({ channel: "chromium", headless: true });
let n = done.size;
for (const batch of splitEvery(Number(values.concurrency), todo)) {
  const results = await Promise.all(batch.map((s) => capture(browser, s)));
  await appendFile(FILE, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
  n += results.length;
  console.log(`${n}/${all.length}  ${results.map((r) => `${r.site}:${r.ok ? r.requests.length : "✗"}`).join(" ")}`);
}
await browser.close();
