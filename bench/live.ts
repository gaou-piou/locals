/**
 * Step 3: real page loads. Every selected site is loaded with no extension, with λocals and with Decentraleyes
 * (each with its default settings), in a fresh profile per load (cold cache), then once more in the same profile
 * (warm cache). Conditions are interleaved run by run, so drift of the network or the site hits them alike.
 *
 * Per load: CDN requests served from the extension vs fetched from the network, CDN hosts contacted, bytes over the
 * network, console errors (SRI among them) and page errors, and the page's own timings (FCP, LCP, DOMContentLoaded,
 * load) from the Performance API.
 *
 *   pnpm tsx bench/live.ts [--runs 3] [--sites 40] [--throttle none|4g|3g]
 *
 * Sites: those whose captured CDN requests at least one extension can serve (coverage.json), most CDN requests first.
 */
import { chromium, type BrowserContext } from "@playwright/test";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { countBy, descend, prop, sortWith, take, toPairs, uniq } from "ramda";
import { DECENTRALEYES, LOCALS_DIR, OUT } from "./config.ts";
import { readJsonl } from "./data.ts";

const { values } = parseArgs({
  options: { runs: { type: "string", default: "3" }, sites: { type: "string", default: "40" }, throttle: { type: "string", default: "none" }, out: { type: "string" } },
});
const RUNS = Number(values.runs);
const FILE = values.out ?? `${OUT}/live-${values.throttle}.jsonl`;

/** Chrome DevTools presets: latency is the added round trip, throughput in bytes/s. */
const THROTTLE = {
  none: null,
  "4g": { latency: 150, downloadThroughput: (9 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8 },
  "3g": { latency: 400, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
}[values.throttle as "none" | "4g" | "3g"];

export const CONDITIONS = { none: null, "λocals": LOCALS_DIR, Decentraleyes: DECENTRALEYES.dir } as const;
type Condition = keyof typeof CONDITIONS;

type Coverage = { cdnHosts: string[]; rows: { site: string; initiator: string; cdn: boolean; hits: Record<string, unknown> }[] };
const coverage: Coverage = JSON.parse(await readFile(`${OUT}/coverage.json`, "utf8"));
const CDN = new Set(coverage.cdnHosts);
const servable = coverage.rows.filter((r) => r.cdn && Object.values(r.hits).some(Boolean));
const ranked = sortWith([descend(prop(1))], toPairs(countBy((r) => r.site, servable))) as [string, number][];
const urlOf = Object.fromEntries(coverage.rows.map((r) => [r.site, r.initiator]));
const sites = take(Number(values.sites), ranked).map(([s]) => s);

export type Load = {
  site: string;
  condition: Condition;
  run: number;
  cache: "cold" | "warm";
  throttle: string;
  ok: boolean;
  error?: string;
  cdnLocal: number;
  cdnNetwork: number;
  cdnHosts: string[];
  bytes: number;
  requests: number;
  consoleErrors: number;
  sriErrors: number;
  pageErrors: number;
  /** "Denying load" of a fallback font format (ttf/woff/eot/svg) the extension does not bundle: Chromium checks every
   *  @font-face src against web_accessible_resources, but uses the woff2. Logged, harmless, not counted as an error. */
  fontFallbackDenied: number;
  /** the first error messages, for telling breakage from noise */
  errors: string[];
  fcp?: number;
  lcp?: number;
  dcl?: number;
  load?: number;
};

/** Headless Chromium now and then crashes while starting (SIGSEGV before the first page); one more try is enough. */
async function launch(condition: Condition, tries = 3): Promise<{ ctx: BrowserContext; dir: string }> {
  try {
    return await launchOnce(condition);
  } catch (e) {
    if (tries <= 1) throw e;
    console.warn(`launch ${condition} failed, retrying: ${String(e).split("\n")[0]}`);
    return launch(condition, tries - 1);
  }
}

async function launchOnce(condition: Condition): Promise<{ ctx: BrowserContext; dir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "bench-live-"));
  const ext = CONDITIONS[condition];
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: "chromium",
    headless: true,
    ignoreHTTPSErrors: true,
    args: ext ? [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`] : [],
  });
  if (ext) {
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
    await sw.evaluate(() => new Promise((r) => setTimeout(r, 500))); // startup ruleset changes
  }
  return { ctx, dir };
}

async function load(ctx: BrowserContext, url: string): Promise<Omit<Load, "site" | "condition" | "run" | "cache" | "throttle">> {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: false });
  if (THROTTLE) await cdp.send("Network.emulateNetworkConditions", { offline: false, ...THROTTLE });

  let cdnLocal = 0;
  let requests = 0;
  let bytes = 0;
  const cdnNet = new Map<string, string>(); // requestId → host, until it is redirected or finishes
  const hosts = new Set<string>();
  const http = new Set<string>(); // requestIds that went to the network (an extension redirect reuses the id)
  cdp.on("Network.requestWillBeSent", (e: any) => {
    const u = URL.parse(e.request.url);
    if (!u) return; // pages do request malformed URLs ("fonts.googleapis.co%20m")
    if (u.protocol.startsWith("http")) http.add(e.requestId);
    else http.delete(e.requestId);
    if (e.redirectResponse && CDN.has(URL.parse(e.redirectResponse.url)?.host ?? "")) {
      cdnNet.delete(e.requestId);
      if (u.protocol === "chrome-extension:") cdnLocal++;
    }
    if (u.protocol.startsWith("http")) {
      requests++;
      if (CDN.has(u.host) && ["Script", "Stylesheet", "Font"].includes(e.type)) cdnNet.set(e.requestId, u.host);
    }
  });
  let cdnNetwork = 0;
  cdp.on("Network.loadingFinished", (e: any) => {
    if (http.has(e.requestId)) bytes += e.encodedDataLength;
    const h = cdnNet.get(e.requestId);
    if (h && e.encodedDataLength > 0) {
      cdnNetwork++;
      hosts.add(h);
    }
  });
  let consoleErrors = 0;
  let sriErrors = 0;
  let pageErrors = 0;
  let fontFallbackDenied = 0;
  const errors: string[] = [];
  const note = (s: string) => errors.length < 8 && errors.push(s.slice(0, 220));
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    if (/^Denying load of chrome-extension:\/\/\S+\.(?:ttf|woff|eot|svg|otf)\b/.test(m.text())) {
      fontFallbackDenied++;
      return;
    }
    consoleErrors++;
    note(m.text());
    if (/integrity/i.test(m.text())) sriErrors++;
  });
  page.on("pageerror", (e) => {
    pageErrors++;
    note(`pageerror: ${e.message}`);
  });

  try {
    await page.goto(url, { waitUntil: "load", timeout: 45_000 });
    await page.waitForTimeout(2_500);
    const t = await page.evaluate(
      () =>
        new Promise<{ fcp?: number; lcp?: number; dcl?: number; load?: number }>((resolve) => {
          const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
          const fcp = performance.getEntriesByName("first-contentful-paint")[0]?.startTime;
          let lcp: number | undefined;
          new PerformanceObserver((l) => {
            for (const e of l.getEntries()) lcp = e.startTime;
          }).observe({ type: "largest-contentful-paint", buffered: true });
          setTimeout(() => resolve({ fcp, lcp, dcl: nav?.domContentLoadedEventEnd, load: nav?.loadEventEnd }), 50);
        }),
    );
    return { ok: true, cdnLocal, cdnNetwork, cdnHosts: [...hosts], bytes, requests, consoleErrors, sriErrors, pageErrors, fontFallbackDenied, errors, ...t };
  } catch (err) {
    return { ok: false, error: String(err).split("\n")[0], cdnLocal, cdnNetwork, cdnHosts: [...hosts], bytes, requests, consoleErrors, sriErrors, pageErrors, fontFallbackDenied, errors };
  } finally {
    await page.close().catch(() => {});
  }
}

const done = new Set(existsSync(FILE) ? (await readJsonl<Load>(FILE)).map((l) => `${l.site} ${l.condition} ${l.run}`) : []);
console.log(`${sites.length} sites × ${Object.keys(CONDITIONS).length} conditions × ${RUNS} runs, throttle ${values.throttle} → ${FILE}`);
for (const [i, site] of sites.entries()) {
  for (let run = 0; run < RUNS; run++) {
    // rotate the order, so no condition is always first after a site was just warmed up by another
    const order = Object.keys(CONDITIONS) as Condition[];
    const rotated = [...order.slice(run % order.length), ...order.slice(0, run % order.length)];
    for (const condition of rotated) {
      if (done.has(`${site} ${condition} ${run}`)) continue;
      const { ctx, dir } = await launch(condition);
      const base = { site, condition, run, throttle: values.throttle! };
      try {
        const cold = await load(ctx, urlOf[site]);
        const warm = cold.ok ? await load(ctx, urlOf[site]) : null;
        const lines = [{ ...base, cache: "cold", ...cold }, ...(warm ? [{ ...base, cache: "warm", ...warm }] : [])];
        await appendFile(FILE, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
        console.log(
          `[${i + 1}/${sites.length}] ${site} #${run} ${condition}: ${cold.ok ? `local ${cold.cdnLocal} net ${cold.cdnNetwork} lcp ${Math.round(cold.lcp ?? 0)} load ${Math.round(cold.load ?? 0)}` : cold.error}`,
        );
      } finally {
        await ctx.close().catch(() => {});
        await rm(dir, { recursive: true, force: true });
      }
    }
  }
}
console.log(`sites: ${uniq(sites).length}`);
