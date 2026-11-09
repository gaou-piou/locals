/**
 * Step 4: turns bench/out/live-<throttle>.jsonl into bench/out/live-<throttle>.md.
 *
 * Timings are noisy on live sites, so every comparison is paired: per site, the median over runs of an extension is
 * compared with the median over runs of the same site without an extension, and the report gives the median of those
 * per-site differences and how many sites got faster. Breakage is counted the same way: a site is "worse" when its
 * median number of console or page errors is higher than without an extension.
 *
 *   pnpm tsx bench/report.ts [--throttle none]
 */
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { groupBy, median, sum, uniq } from "ramda";
import { OUT } from "./config.ts";
import { readJsonl } from "./data.ts";
import type { Load } from "./live.ts";

const { values } = parseArgs({ options: { throttle: { type: "string", default: "none" }, in: { type: "string" } } });
const loads = (await readJsonl<Load>(values.in ?? `${OUT}/live-${values.throttle}.jsonl`)).filter((l) => l.ok);
const conditions = uniq(loads.map((l) => l.condition));
const ext = conditions.filter((c) => c !== "none");
const fmt = (n: number | undefined, unit = " ms") => (n === undefined || Number.isNaN(n) ? "–" : `${n > 0 ? "+" : ""}${Math.round(n)}${unit}`);
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "–");

const lines = [`# Live loads (throttle: ${values.throttle})`, ""];
for (const cache of ["cold", "warm"] as const) {
  const set = loads.filter((l) => l.cache === cache);
  const per = groupBy((l: Load) => `${l.site}\u0000${l.condition}`, set);
  const med = (site: string, c: string, k: keyof Load) => {
    const xs = (per[`${site}\u0000${c}`] ?? []).map((l) => l[k]).filter((x): x is number => typeof x === "number");
    return xs.length ? median(xs) : undefined;
  };
  const sites = uniq(set.map((l) => l.site)).filter((s) => conditions.every((c) => per[`${s}\u0000${c}`]?.length));
  lines.push(`## ${cache === "cold" ? "First visit (cold cache)" : "Second visit (warm cache)"}`, "", `${sites.length} sites with results for every condition.`, "");

  lines.push("| Condition | CDN requests served locally | from the network | CDN hosts contacted (median/site) | Bytes over the network (median/site) |", "|---|---:|---:|---:|---:|");
  for (const c of conditions) {
    const local = sum(sites.map((s) => med(s, c, "cdnLocal") ?? 0));
    const net = sum(sites.map((s) => med(s, c, "cdnNetwork") ?? 0));
    const hosts = median(sites.map((s) => median((per[`${s}\u0000${c}`] ?? []).map((l) => l.cdnHosts.length))));
    const bytes = median(sites.map((s) => med(s, c, "bytes") ?? 0));
    lines.push(`| ${c} | ${local} | ${net} | ${hosts} | ${(bytes / 1024).toFixed(0)} KiB |`);
  }
  lines.push("");

  lines.push(
    "| Extension vs none | Δ FCP | Δ LCP | Δ DOMContentLoaded | Δ load | Sites with faster LCP | Δ LCP on sites it served ≥1 CDN file | Sites with more errors | SRI errors | Font-fallback denials¹ |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  for (const c of ext) {
    const delta = (k: keyof Load, only = sites) =>
      median(only.map((s) => (med(s, c, k) ?? NaN) - (med(s, "none", k) ?? NaN)).filter((x) => !Number.isNaN(x)));
    const lcpFaster = sites.filter((s) => (med(s, c, "lcp") ?? Infinity) < (med(s, "none", "lcp") ?? -Infinity)).length;
    const served = sites.filter((s) => (med(s, c, "cdnLocal") ?? 0) > 0);
    const errors = (s: string, k: string) => (med(s, k, "consoleErrors") ?? 0) + (med(s, k, "pageErrors") ?? 0);
    const worse = sites.filter((s) => errors(s, c) > errors(s, "none"));
    const sri = sum(set.filter((l) => l.condition === c).map((l) => l.sriErrors));
    const denied = sum(set.filter((l) => l.condition === c).map((l) => l.fontFallbackDenied ?? 0));
    lines.push(
      `| ${c} | ${fmt(delta("fcp"))} | ${fmt(delta("lcp"))} | ${fmt(delta("dcl"))} | ${fmt(delta("load"))} | ${lcpFaster}/${sites.length} (${pct(lcpFaster, sites.length)}) | ${served.length ? `${fmt(delta("lcp", served))} (${served.length} sites)` : "–"} | ${worse.length} ${worse.length ? `(${worse.join(", ")})` : ""} | ${sri} | ${denied} |`,
    );
  }
  lines.push("");
}
lines.push(
  "Δ = median over sites of (median with the extension − median without). Negative is faster. Live sites change between loads (ads, A/B tests), so",
  "differences of a few tens of ms are within noise; the count of sites that got faster says more than the median alone.",
  "",
  "¹ `Denying load of chrome-extension://….ttf/.woff`: Chromium checks every format in an @font-face `src` list against",
  "web_accessible_resources and logs the ones the extension does not bundle; the bundled woff2 is used. Not counted as errors.",
);
const out = `${OUT}/live-${values.throttle}.md`;
await writeFile(out, lines.join("\n") + "\n");
console.log(lines.join("\n"));
