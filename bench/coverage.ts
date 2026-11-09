/**
 * Step 2: coverage. Every captured script/style/font URL is put to the three extensions, with no network involved:
 *  - λocals and Decentraleyes: their real DNR rulesets, asked through declarativeNetRequest.testMatchOutcome in a
 *    Chromium that has the extension loaded (λocals twice: default settings, and with version substitution on);
 *  - LocalCDN: its own resolver in a Node vm (see localcdn.ts).
 *
 *   pnpm tsx bench/coverage.ts       → bench/out/coverage.json and coverage.md
 */
import { chromium, type Worker } from "@playwright/test";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { countBy, identity, sortBy, splitEvery, uniqBy, sum, take, toPairs, descend, sortWith, prop, uniq } from "ramda";
import { DECENTRALEYES, LOCALS_DIR, OUT } from "./config.ts";
import { readJsonl, type CapturedSite } from "./data.ts";
import { loadLocalcdn } from "./localcdn.ts";

type Req = { url: string; type: string; initiator: string };
type Rule = { id: number; action: { type: string; redirect?: { extensionPath?: string; regexSubstitution?: string } }; condition: Record<string, unknown> };
type Hit = { target: string; ruleset: string } | null;

const sites = (await readJsonl<CapturedSite>(`${OUT}/capture.jsonl`)).filter((s) => s.ok);
const origin = (s: CapturedSite) => new URL(s.finalUrl).origin;
/** One entry per (site, url, type): the same file loaded twice by a page counts once, loaded by two sites counts twice. */
const requests: (Req & { site: string })[] = sites.flatMap((s) =>
  uniqBy(
    (r) => `${r.type} ${r.url}`,
    s.requests.filter((r) => URL.canParse(r.url)).map((r) => ({ ...r, initiator: origin(s), site: s.site })),
  ),
);
const host = (url: string) => new URL(url).host;
const siteHost = (s: string) => s.replace(/^www\./, "");

// ---- the rulesets, read from disk, so that a matched rule id can be turned into its redirect target
const readRules = async (file: string): Promise<Rule[]> => JSON.parse(await readFile(file, "utf8"));
async function rulesets(dir: string) {
  const manifest = JSON.parse(await readFile(`${dir}/manifest.json`, "utf8"));
  const map = new Map<string, Map<number, Rule>>();
  for (const r of manifest.declarative_net_request.rule_resources) map.set(r.id, new Map((await readRules(`${dir}/${r.path}`)).map((x) => [x.id, x])));
  return map;
}

/** Hosts any of the extensions treats as a library CDN: the "third-party CDN" side of the comparison. */
function cdnHosts(rs: Map<string, Map<number, Rule>>[], localcdnHosts: string[]) {
  const hosts = new Set(localcdnHosts);
  for (const m of rs)
    for (const [id, rules] of m) {
      if (id === "byname") continue; // byname matches any host by design
      for (const r of rules.values()) {
        const f = String(r.condition.urlFilter ?? r.condition.regexFilter ?? "");
        const h = f.match(/^(?:\|\||\|https?:\/\/|\^https\?:\/\/)([a-z0-9.\\-]+)/i)?.[1]?.replaceAll("\\", "");
        if (h && r.action.type === "redirect") hosts.add(h);
      }
    }
  return hosts;
}

async function withExtension<T>(dir: string, fn: (sw: Worker) => Promise<T>) {
  const ctx = await chromium.launchPersistentContext(await mkdtemp(path.join(os.tmpdir(), "bench-")), {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
  try {
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
    await sw.evaluate(() => new Promise((r) => setTimeout(r, 1000))); // let the worker apply its startup ruleset changes
    return await fn(sw);
  } finally {
    await ctx.close();
  }
}

/** testMatchOutcome for every request; returns, per request, the redirect it would get (or null). */
async function dnrOutcomes(sw: Worker, rs: Map<string, Map<number, Rule>>, reqs: Req[], enable: string[] = []): Promise<Hit[]> {
  if (enable.length) await sw.evaluate((ids) => chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ids }), enable);
  const out: Hit[] = [];
  for (const chunk of splitEvery(400, reqs)) {
    const matched = await sw.evaluate(
      async (chunk) =>
        Promise.all(
          chunk.map(async (r) => {
            try {
              const o = await chrome.declarativeNetRequest.testMatchOutcome({ url: r.url, type: r.type as chrome.declarativeNetRequest.ResourceType, initiator: r.initiator });
              return o.matchedRules.map((m) => [m.rulesetId, m.ruleId] as const);
            } catch {
              return [];
            }
          }),
        ),
      chunk,
    );
    for (const [i, rules] of matched.entries()) {
      const redirect = rules.map(([set, id]) => ({ set, rule: rs.get(set)?.get(id) })).find((x) => x.rule?.action.type === "redirect");
      const target = redirect?.rule?.action.redirect;
      out.push(redirect && target ? { ruleset: redirect.set, target: target.extensionPath ?? substitute(target.regexSubstitution!, chunk[i].url, redirect.rule!) } : null);
    }
  }
  return out;
}
/** regexSubstitution with \1-style groups resolved against the request URL. */
const substitute = (sub: string, url: string, rule: Rule) => {
  const m = url.match(new RegExp(String(rule.condition.regexFilter)));
  return sub.replace(/\\(\d)/g, (_, n) => m?.[Number(n)] ?? "").replace(/^chrome-extension:\/\/[^/]+/, "");
};

// ---- run
const localsRules = await rulesets(LOCALS_DIR);
const decentRules = await rulesets(DECENTRALEYES.dir);
const localcdn = loadLocalcdn();
const localcdnHosts: string[] = (await readFile(`${path.dirname(DECENTRALEYES.dir)}/localcdn/CDN.txt`, "utf8")).split("\n").filter(Boolean);
const CDN = cdnHosts([localsRules, decentRules], localcdnHosts);

const candidates = requests.filter((r) => r.type === "script" || r.type === "stylesheet" || r.type === "font");
console.log(`${sites.length} sites loaded, ${candidates.length} script/style/font requests, ${candidates.filter((r) => CDN.has(host(r.url))).length} to library CDNs`);

const [locals, localsSub] = await withExtension(LOCALS_DIR, async (sw) => [await dnrOutcomes(sw, localsRules, candidates), await dnrOutcomes(sw, localsRules, candidates, ["substitute"])]);
// staging is Decentraleyes' opt-in "enforce staging environment" setting: the newer library releases (jQuery 3 among them)
const [decent, decentStaging] = await withExtension(DECENTRALEYES.dir, async (sw) => [
  await dnrOutcomes(sw, decentRules, candidates),
  await dnrOutcomes(sw, decentRules, candidates, ["redirect/staging"]),
]);
const lcdn: Hit[] = candidates.map((r) => {
  const t = localcdn(r.url, r.initiator);
  return t ? { ruleset: "localcdn", target: t.path } : null;
});

const EXT = { "λocals": locals, "λocals + substitute": localsSub, Decentraleyes: decent, "Decentraleyes + staging": decentStaging, "LocalCDN (Firefox)": lcdn } as const;
type Ext = keyof typeof EXT;

/** "same" when the version in the URL is the version served; otherwise the extension swapped in another release. */
const versionOf = (s: string) => s.match(/(?:^|[/@-])v?(\d+\.\d+\.\d+)(?=[/._-]|$)/)?.[1] ?? s.match(/(?:^|[/@-])v?(\d+\.\d+)(?=[/._-]|$)/)?.[1];
const sameVersion = (url: string, target: string) => {
  const a = versionOf(new URL(url).pathname);
  const b = versionOf(target);
  return !a || !b || a === b;
};

const rows = candidates.map((r, i) => ({
  ...r,
  cdn: CDN.has(host(r.url)),
  hits: Object.fromEntries(Object.entries(EXT).map(([k, v]) => [k, v[i]])) as Record<Ext, Hit>,
}));
await writeFile(`${OUT}/coverage.json`, JSON.stringify({ cdnHosts: [...CDN].sort(), rows }, null, 0));

// ---- summary
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "–");
const cdnRows = rows.filter((r) => r.cdn);
const cdnSites = uniq(cdnRows.map((r) => r.site));
const selfRows = rows.filter((r) => !r.cdn);
const lines: string[] = [];
lines.push(`# Coverage`, "");
lines.push(`${sites.length} sites loaded (of ${(await readJsonl<CapturedSite>(`${OUT}/capture.jsonl`)).length}); ${cdnSites.length} of them request a library CDN; ${cdnRows.length} CDN requests (${uniq(cdnRows.map((r) => r.url)).length} distinct URLs).`, "");
lines.push("## Requests to library CDNs", "");
const servable = cdnRows.filter((r) => Object.values(r.hits).some(Boolean)).length;
lines.push(`${servable} of the CDN requests can be served by at least one extension (the rest are mostly Google Fonts and site-specific bundles).`, "");
lines.push("| Extension | Served locally | of servable | Same version | Other version | Sites fully served | Sites with ≥1 served |", "|---|---:|---:|---:|---:|---:|---:|");
for (const ext of Object.keys(EXT) as Ext[]) {
  const served = cdnRows.filter((r) => r.hits[ext]);
  const same = served.filter((r) => sameVersion(r.url, r.hits[ext]!.target));
  const bySite = (pred: (rs: typeof cdnRows) => boolean) => cdnSites.filter((s) => pred(cdnRows.filter((r) => r.site === s))).length;
  lines.push(
    `| ${ext} | ${served.length} (${pct(served.length, cdnRows.length)}) | ${pct(served.length, servable)} | ${same.length} | ${served.length - same.length} | ${pct(bySite((rs) => rs.every((r) => r.hits[ext])), cdnSites.length)} | ${pct(bySite((rs) => rs.some((r) => r.hits[ext])), cdnSites.length)} |`,
  );
}
lines.push("", "Other version: the URL asks for one release and the extension serves another. On a page with Subresource Integrity that file is blocked; without it the page runs a library version it did not ask for.", "");

lines.push("## Requests per CDN host", "", "| Host | Requests | λocals | λocals + substitute | Decentraleyes | Decentraleyes + staging | LocalCDN |", "|---|---:|---:|---:|---:|---:|---:|");
const hosts = sortWith([descend((x: [string, number]) => x[1])], toPairs(countBy(identity, cdnRows.map((r) => host(r.url)))));
for (const [h, n] of take(25, hosts)) {
  const hr = cdnRows.filter((r) => host(r.url) === h);
  const c = (e: Ext) => pct(hr.filter((r) => r.hits[e]).length, n);
  lines.push(`| ${h} | ${n} | ${(Object.keys(EXT) as Ext[]).map(c).join(" | ")} |`);
}

const missed = (pred: (r: (typeof rows)[number]) => boolean) =>
  take(
    30,
    sortWith([descend(prop(1))], toPairs(countBy((r) => r.url.replace(/[?#].*/, ""), cdnRows.filter(pred)))) as [string, number][],
  );
lines.push("", "## CDN URLs λocals misses and another extension serves", "", "| URL | Sites | λocals + substitute | Decentraleyes | LocalCDN |", "|---|---:|:-:|:-:|:-:|");
for (const [url, n] of missed((r) => !r.hits["λocals"] && !!(r.hits["Decentraleyes + staging"] || r.hits["LocalCDN (Firefox)"]))) {
  const r = cdnRows.find((x) => x.url.replace(/[?#].*/, "") === url)!;
  lines.push(`| ${url} | ${n} | ${r.hits["λocals + substitute"] ? "✓" : ""} | ${r.hits.Decentraleyes ? "✓" : r.hits["Decentraleyes + staging"] ? "staging" : ""} | ${r.hits["LocalCDN (Firefox)"] ? "✓" : ""} |`);
}
lines.push("", "## CDN URLs nobody serves", "", "| URL | Sites |", "|---|---:|");
for (const [url, n] of missed((r) => Object.values(r.hits).every((h) => !h))) lines.push(`| ${url} | ${n} |`);

const byname = selfRows.filter((r) => r.hits["λocals"]?.ruleset === "byname");
lines.push(
  "",
  "## Self-hosted copies (λocals byname)",
  "",
  `${byname.length} requests on ${uniq(byname.map((r) => r.site)).length} sites name a bundled library and version in their path and are served from the bundle by name (then checked by sha256 in the background). The other extensions only look at CDN hosts.`,
  "",
);
for (const r of take(15, sortBy(prop("url"), byname))) lines.push(`- ${r.url} → \`${r.hits["λocals"]!.target}\``);

await writeFile(`${OUT}/coverage.md`, lines.join("\n") + "\n");
console.log(lines.slice(0, 14).join("\n"));
