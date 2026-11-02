import { test, expect } from "@playwright/test";
import { startServer, type FixtureServer } from "./server";
import { launchWithExtension } from "./extension";

const EXTENSION = "spike";
let server: FixtureServer;
test.beforeAll(async () => { server = await startServer(); });
test.afterAll(async () => { await server.close(); });

test("jquery loads from the extension when cdnjs is unreachable", async () => {
  const ctx = await launchWithExtension(EXTENSION, { blockedHosts: ["cdnjs.cloudflare.com"] });
  try {
    const page = await ctx.newPage();
    await page.goto(`${server.origin}/jquery.html`);
    const version = await page.evaluate(() => (window as any).jQuery?.fn.jquery);
    expect(version).toBe("3.7.1");
  } finally {
    await ctx.close();
  }
});

const EXT_ID = "jongdncfbmpeeojgbpmhajbclkegnnkg";
const BLOCK = ["cdnjs.cloudflare.com", "code.jquery.com", "fonts.test.invalid"];
const jq = () => (window as any).jQuery?.fn.jquery as string | undefined;

async function withCtx<T>(fn: (ctx: import("@playwright/test").BrowserContext) => Promise<T>) {
  const ctx = await launchWithExtension(EXTENSION, { blockedHosts: BLOCK });
  try { return await fn(ctx); } finally { await ctx.close(); }
}
async function sw(ctx: import("@playwright/test").BrowserContext) {
  return ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
}

test("(a) query string matches via ^ and .map does not", async () => {
  await withCtx(async (ctx) => {
    const worker = await sw(ctx);
    const out = await worker.evaluate(async () => {
      const t = (url: string) =>
        chrome.declarativeNetRequest.testMatchOutcome({ url, type: "script", initiator: "http://localhost" });
      const base = "https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js";
      return { plain: await t(base), query: await t(base + "?v=1"), map: await t(base + ".map"), http: await t(base.replace("https", "http")) };
    });
    console.log("PROBE a", JSON.stringify(out));
    expect(out.plain.matchedRules.length).toBe(1);
    expect(out.query.matchedRules.length).toBe(1);
    expect(out.map.matchedRules.length).toBe(0);
    expect(out.http.matchedRules.length).toBe(1);
    const page = await ctx.newPage();
    await page.goto(`${server.origin}/query.html`);
    expect(await page.evaluate(jq)).toBe("3.7.1");
  });
});

test("(b) SRI: identical bytes pass, wrong hash blocks", async () => {
  await withCtx(async (ctx) => {
    const ok = await ctx.newPage();
    await ok.goto(`${server.origin}/sri-ok.html`);
    const bad = await ctx.newPage();
    await bad.goto(`${server.origin}/sri-bad.html`);
    const r = { ok: await ok.evaluate(jq), bad: await bad.evaluate(jq) };
    console.log("PROBE b", JSON.stringify(r));
    expect(r.ok).toBe("3.7.1");
    expect(r.bad).toBeUndefined();
  });
});

test("(c) regexSubstitution to chrome-extension://<fixed id>", async () => {
  await withCtx(async (ctx) => {
    const page = await ctx.newPage();
    await page.goto(`${server.origin}/regex.html`);
    const v = await page.evaluate(jq);
    console.log("PROBE c", v, "id", EXT_ID);
    expect(v).toBe("3.7.1");
  });
});

test("(d) font redirected to extension resource loads", async () => {
  await withCtx(async (ctx) => {
    const page = await ctx.newPage();
    await page.goto(`${server.origin}/font.html`);
    const st = await page.evaluate(async () => { await document.fonts.load("16px T"); return [...document.fonts].map((f) => f.status); });
    console.log("PROBE d", JSON.stringify(st));
    expect(st).toEqual(["loaded"]);
  });
});

test("(e) protocol-relative URL on http page is redirected", async () => {
  await withCtx(async (ctx) => {
    const page = await ctx.newPage();
    await page.goto(`${server.origin}/protorel.html`);
    expect(await page.evaluate(jq)).toBe("3.7.1");
  });
});

test("(f) restrictive page CSP", async () => {
  await withCtx(async (ctx) => {
    const page = await ctx.newPage();
    await page.goto(`${server.origin}/jquery.html?csp=${encodeURIComponent("script-src https://cdnjs.cloudflare.com")}`);
    const v = await page.evaluate(jq);
    console.log("PROBE f", v);
    expect(["3.7.1", undefined]).toContain(v);
  });
});

test("(g) allowAllRequests with requestDomains exempts site and third-party iframes", async () => {
  await withCtx(async (ctx) => {
    const worker = await sw(ctx);
    const control = await ctx.newPage();
    await control.goto(`${server.origin}/frames.html`);
    expect(await control.evaluate(jq)).toBe("3.7.1");
    await worker.evaluate(() =>
      chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [{ id: 1000, priority: 100, action: { type: "allowAllRequests" as any }, condition: { requestDomains: ["localhost"], resourceTypes: ["main_frame", "sub_frame"] as any } }],
      }),
    );
    const page = await ctx.newPage();
    const frameUrl = `${server.origin.replace("localhost", "127.0.0.1")}/jquery.html`;
    await page.goto(`${server.origin}/frames.html?frame=${encodeURIComponent(frameUrl)}`);
    await page.waitForLoadState("load");
    const main = await page.evaluate(jq);
    const frame = page.frames().find((f) => f.url().startsWith("http://127.0.0.1"));
    const inner = frame ? await frame.evaluate(jq) : "no-frame";
    console.log("PROBE g", JSON.stringify({ main, inner }));
    expect(main).toBeUndefined();
    expect(inner).toBeUndefined();
  });
});

test("(h) limits and (i) onRuleMatchedDebug", async () => {
  await withCtx(async (ctx) => {
    const worker = await sw(ctx);
    await worker.evaluate(() => {
      (globalThis as any).__m = [];
      chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((i) => (globalThis as any).__m.push(i.rule.ruleId));
    });
    const page = await ctx.newPage();
    await page.goto(`${server.origin}/jquery.html`);
    await page.waitForTimeout(300);
    const out = await worker.evaluate(() => {
      const d = chrome.declarativeNetRequest as any;
      return {
        matched: (globalThis as any).__m,
        MAX_NUMBER_OF_STATIC_RULES: d.MAX_NUMBER_OF_STATIC_RULES,
        GUARANTEED_MINIMUM_STATIC_RULES: d.GUARANTEED_MINIMUM_STATIC_RULES,
        MAX_NUMBER_OF_REGEX_RULES: d.MAX_NUMBER_OF_REGEX_RULES,
        MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: d.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS,
        MAX_NUMBER_OF_STATIC_RULESETS: d.MAX_NUMBER_OF_STATIC_RULESETS,
        MAX_NUMBER_OF_DYNAMIC_RULES: d.MAX_NUMBER_OF_DYNAMIC_RULES,
      };
    });
    console.log("PROBE h/i", JSON.stringify(out));
    expect(out.matched).toContain(1);
  });
});

test("(j) modifyHeaders can strip Referer from a request", async () => {
  await withCtx(async (ctx) => {
    const worker = await sw(ctx);
    const page = await ctx.newPage();
    await page.goto(`${server.origin}/jquery.html`);
    const before = await page.evaluate(async (o) => (await fetch(`${o}/echo`)).json(), server.origin);
    await worker.evaluate(() =>
      chrome.declarativeNetRequest.updateDynamicRules({
        addRules: [{ id: 2000, priority: 1, action: { type: "modifyHeaders" as any, requestHeaders: [{ header: "referer", operation: "remove" as any }] }, condition: { urlFilter: "|http://localhost*/echo", resourceTypes: ["xmlhttprequest"] as any } }],
      }),
    );
    const after = await page.evaluate(async (o) => (await fetch(`${o}/echo`)).json(), server.origin);
    console.log("PROBE j", JSON.stringify({ before: before.referer, after: after.referer }));
    expect(before.referer).toBeDefined();
    expect(after.referer).toBeUndefined();
  });
});
