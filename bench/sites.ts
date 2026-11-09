/**
 * Builds bench/sites.txt: a reproducible sample of the Tranco list (https://tranco-list.eu).
 * The head of the list is mostly big sites that self-host everything; CDN libraries live in the long tail,
 * so the sample is the top 250 plus 750 seeded-random domains from ranks 1,001–200,000.
 *
 *   pnpm tsx bench/sites.ts [listId]
 */
import { mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { take, uniq } from "ramda";
import { CACHE, LIST_ID, SITES_FILE } from "./config.ts";

const listId = process.argv[2] ?? LIST_ID;
const csv = `${CACHE}/tranco-${listId}.csv`;
await mkdir(CACHE, { recursive: true });
execFileSync("curl", ["-sfL", "-o", csv, `https://tranco-list.eu/download/${listId}/200000`]);
const domains = (await import("node:fs")).readFileSync(csv, "utf8").trim().split(/\r?\n/).map((l) => l.split(",")[1]);

/** mulberry32: a tiny seeded PRNG, so the same list id always yields the same sample. */
const rng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const next = rng(42);
const tail = domains.slice(1000);
const picked = new Set<string>();
while (picked.size < 750) picked.add(tail[Math.floor(next() * tail.length)]);

const sites = uniq([...take(250, domains), ...picked]);
await writeFile(SITES_FILE, `# Tranco list ${listId}: top 250 + 750 random from ranks 1001-200000 (seed 42)\n${sites.join("\n")}\n`);
console.log(`${sites.length} sites → ${SITES_FILE}`);
