import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type BrowserContext } from "@playwright/test";
import { EXTENSION_KEY } from "../src/manifest";
import { extensionIdFromKey } from "../scripts/rules";
import { launchWithExtension } from "./extension";
import { startServer, type FixtureServer } from "./server";

const DIST = "dist";
const EXT_ID = extensionIdFromKey(EXTENSION_KEY);
const BLOCK = ["cdnjs.cloudflare.com"];
const jq = () => (window as any).jQuery?.fn.jquery as string | undefined;

let server: FixtureServer;
test.beforeAll(async () => {
  server = await startServer();
});
test.afterAll(async () => {
  await server.close();
});

async function open(userDataDir?: string) {
  const ctx = await launchWithExtension(DIST, { blockedHosts: BLOCK, userDataDir });
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  // Chrome loads rulesets asynchronously after startup; don't probe before they are in force.
  await expect.poll(() => sw.evaluate(() => chrome.declarativeNetRequest.getEnabledRulesets())).toContain("exact");
  return ctx;
}

async function send<T>(ctx: BrowserContext, message: unknown): Promise<T> {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${EXT_ID}/options/index.html`);
  const res = await page.evaluate((m) => chrome.runtime.sendMessage(m), message);
  await page.close();
  return res as T;
}

/** Loads frames.html on `localhost` with a third-party (127.0.0.1) iframe and reports jQuery in both. */
async function probe(ctx: BrowserContext) {
  const page = await ctx.newPage();
  const frameUrl = `${server.origin.replace("localhost", "127.0.0.1")}/jquery.html`;
  await page.goto(`${server.origin}/frames.html?frame=${encodeURIComponent(frameUrl)}`);
  await page.waitForLoadState("load");
  const frame = page.frames().find((f) => f.url().startsWith("http://127.0.0.1"));
  await expect.poll(() => page.frames().length).toBe(2);
  const out = { main: await page.evaluate(jq), inner: frame ? await frame.evaluate(jq) : "no-frame" };
  await page.close();
  return out;
}

async function jqAt(ctx: BrowserContext, url: string) {
  const page = await ctx.newPage();
  await page.goto(url);
  const v = await page.evaluate(jq);
  await page.close();
  return v;
}

async function stopWorker(ctx: BrowserContext) {
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await page.close();
}

test("redirects work by default (control)", async () => {
  const ctx = await open();
  try {
    await expect.poll(() => probe(ctx), { timeout: 8000 }).toEqual({ main: "3.7.1", inner: "3.7.1" });
  } finally {
    await ctx.close();
  }
});

test("a disabled site is left alone, including a third-party iframe; survives worker stop and relaunch", async () => {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "cdn-mirror-exc-"));
  let ctx = await open(userDataDir);
  try {
    await send(ctx, { type: "set-settings", patch: { disabledSites: ["localhost"] } });
    await expect.poll(() => probe(ctx), { timeout: 8000 }).toEqual({ main: undefined, inner: undefined });

    await stopWorker(ctx);
    await expect.poll(() => probe(ctx), { timeout: 8000 }).toEqual({ main: undefined, inner: undefined });

    await ctx.close();
    ctx = await open(userDataDir);
    const sw = ctx.serviceWorkers()[0];
    await expect.poll(() => sw.evaluate(async () => (await chrome.declarativeNetRequest.getDynamicRules()).length)).toBe(1);
    await expect.poll(() => probe(ctx), { timeout: 8000 }).toEqual({ main: undefined, inner: undefined });
    expect(await send<{ disabledSites: string[] }>(ctx, { type: "get-settings" })).toMatchObject({ disabledSites: ["localhost"] });

    // and it can be switched back on
    await send(ctx, { type: "set-settings", patch: { disabledSites: [] } });
    await expect.poll(() => probe(ctx), { timeout: 8000 }).toEqual({ main: "3.7.1", inner: "3.7.1" });
  } finally {
    await ctx.close();
  }
});

test("allow-list mode: redirects only on listed sites", async () => {
  const ctx = await open();
  try {
    await send(ctx, { type: "set-settings", patch: { allowedSites: ["localhost"] } });
    await expect.poll(() => jqAt(ctx, `${server.origin}/jquery.html`), { timeout: 8000 }).toBe("3.7.1");
    await expect.poll(() => jqAt(ctx, `${server.origin.replace("localhost", "127.0.0.1")}/jquery.html`), { timeout: 8000 }).toBeUndefined();
  } finally {
    await ctx.close();
  }
});

test("disabling the extension turns redirects off", async () => {
  const ctx = await open();
  try {
    await send(ctx, { type: "set-settings", patch: { enabled: false } });
    await expect.poll(() => jqAt(ctx, `${server.origin}/jquery.html`), { timeout: 8000 }).toBeUndefined();
  } finally {
    await ctx.close();
  }
});

test("matches are counted per tab and in the stats", async () => {
  const ctx = await open();
  try {
    const page = await ctx.newPage();
    await page.goto(`${server.origin}/jquery.html`);
    let last: unknown;
    await expect
      .poll(async () => {
        last = await send<{ total: number; byLibrary: Record<string, number> }>(ctx, { type: "get-stats", range: "day" });
        return (last as any).byLibrary?.jquery;
      })
      .toBeGreaterThanOrEqual(1);
  } finally {
    await ctx.close();
  }
});
