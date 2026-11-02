import { expect, test, type BrowserContext, type Worker } from "@playwright/test";
import { launchWithExtension } from "./extension";
import { startServer, type FixtureServer } from "./server";

const DIST = "dist";
const BLOCK = ["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "unpkg.com"];

let server: FixtureServer;
test.beforeAll(async () => {
  server = await startServer();
});
test.afterAll(async () => {
  await server.close();
});

async function withCtx<T>(fn: (ctx: BrowserContext, sw: Worker) => Promise<T>) {
  const ctx = await launchWithExtension(DIST, { blockedHosts: BLOCK });
  try {
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
    return await fn(ctx, sw);
  } finally {
    await ctx.close();
  }
}

/** Returns, per URL, the redirect target of the first matching rule ("" when nothing matches). */
async function outcomes(sw: Worker, urls: string[], type = "script") {
  return sw.evaluate(
    async ({ urls, type }) => {
      const ruleset = async (id: string) => (await (await fetch(chrome.runtime.getURL(`rules/${id}.json`))).json()) as any[];
      const rules = [...(await ruleset("exact")), ...(await ruleset("substitute"))];
      const result: Record<string, string> = {};
      for (const url of urls) {
        const { matchedRules } = await chrome.declarativeNetRequest.testMatchOutcome({ url, type: type as any, initiator: "http://localhost" });
        const rule = rules.find((r) => r.id === matchedRules[0]?.ruleId);
        result[url] = rule ? (rule.action.redirect.extensionPath ?? rule.action.redirect.regexSubstitution) : "";
      }
      return result;
    },
    { urls, type },
  );
}

const JQ = "/libs/jquery/3.7.1/dist/jquery.min.js";

test("jquery 3.7.1 redirects from cdnjs, jsDelivr and unpkg to one bundled file", async () => {
  await withCtx(async (_ctx, sw) => {
    const urls = [
      "https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js",
      "https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js",
      "https://unpkg.com/jquery@3.7.1/dist/jquery.min.js",
    ];
    const out = await outcomes(sw, urls);
    expect(Object.values(out)).toEqual([JQ, JQ, JQ]);
  });
});

test("query strings redirect, the source map and unknown versions do not", async () => {
  await withCtx(async (_ctx, sw) => {
    const base = "https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js";
    const out = await outcomes(sw, [
      base + "?v=1",
      base + ".map",
      "https://cdnjs.cloudflare.com/ajax/libs/jquery/9.9.9/jquery.min.js",
      "https://cdnjs.cloudflare.com/ajax/libs/jquery/3.5.1/jquery.min.js",
    ]);
    expect(out[base + "?v=1"]).toBe(JQ);
    expect(out[base + ".map"]).toBe("");
    expect(out["https://cdnjs.cloudflare.com/ajax/libs/jquery/9.9.9/jquery.min.js"]).toBe("");
    expect(out["https://cdnjs.cloudflare.com/ajax/libs/jquery/3.5.1/jquery.min.js"]).toBe("");
  });
});

test("http:// URLs redirect too", async () => {
  await withCtx(async (_ctx, sw) => {
    const url = "http://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js";
    expect((await outcomes(sw, [url]))[url]).toBe(JQ);
  });
});

test("a cdn pattern with different bytes (vue on cdnjs) is not redirected", async () => {
  await withCtx(async (_ctx, sw) => {
    const cdnjs = "https://cdnjs.cloudflare.com/ajax/libs/vue/3.5.13/vue.global.prod.min.js";
    const jsd = "https://cdn.jsdelivr.net/npm/vue@3.5.13/dist/vue.global.prod.js";
    const out = await outcomes(sw, [cdnjs, jsd]);
    expect(out[cdnjs]).toBe("");
    expect(out[jsd]).toBe("/libs/vue/3.5.13/dist/vue.global.prod.js");
  });
});

test("the substitute ruleset is off by default and, once enabled, maps same-major versions only", async () => {
  await withCtx(async (_ctx, sw) => {
    const same = "https://cdnjs.cloudflare.com/ajax/libs/jquery/3.5.1/jquery.min.js";
    const other = "https://cdnjs.cloudflare.com/ajax/libs/jquery/4.0.0/jquery.min.js";
    expect((await outcomes(sw, [same]))[same]).toBe("");
    await sw.evaluate(() => chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: ["substitute"] }));
    const out = await outcomes(sw, [same, other]);
    expect(out[same]).toMatch(/^chrome-extension:\/\/[a-p]{32}\/libs\/jquery\/3\.7\.1\/dist\/jquery\.min\.js$/);
    expect(out[other]).toBe("");
  });
});

test("the generated ruleset serves jquery when cdnjs is unreachable (https and protocol-relative)", async () => {
  await withCtx(async (ctx) => {
    for (const fixture of ["jquery.html", "protorel.html"]) {
      const page = await ctx.newPage();
      await page.goto(`${server.origin}/${fixture}`);
      expect(await page.evaluate(() => (window as any).jQuery?.fn.jquery)).toBe("3.7.1");
    }
  });
});
