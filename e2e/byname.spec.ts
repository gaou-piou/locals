import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { launchWithExtension } from "./extension";
import { startServer, type FixtureServer } from "./server";

// A site hosting its own file named jquery-3.7.1.min.js: served from the bundled copy at once, then its real
// bytes decide: identical → kept, another bundled version → corrected, anything else → given back to the site.
let server: FixtureServer;
let ctx: BrowserContext;
let page: Page;
let ext: string;

test.beforeEach(async () => {
  server = await startServer();
  ctx = await launchWithExtension("dist");
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  ext = `chrome-extension://${new URL(sw.url()).host}/options/index.html`;
  page = await ctx.newPage();
});
test.afterEach(async () => {
  await ctx.close();
  await server.close();
});

const ask = async <T>(type: string): Promise<T> => {
  const p = await ctx.newPage();
  await p.goto(ext);
  const out = await p.evaluate((t) => chrome.runtime.sendMessage({ type: t }), type);
  await p.close();
  return out as T;
};
const jquery = () => page.evaluate(() => ({ version: (window as any).jQuery?.fn.jquery, patched: (window as any).PATCHED ?? false }));
const lib = (variant: string) => `${server.origin}/byname/${variant}/jquery-3.7.1.min.js`;

/** Loads the page until the worker has checked the file (the first load can beat the worker's start-up). */
async function loadUntil<T>(variant: string, read: () => Promise<T>, expected: T) {
  await expect
    .poll(
      async () => {
        await page.goto(`${server.origin}/byname/${variant}.html`);
        return read();
      },
      { timeout: 20_000, intervals: [500, 1000, 2000] },
    )
    .toEqual(expected);
}

test("an identical self-hosted copy is served by name and confirmed by its bytes", async () => {
  await page.goto(`${server.origin}/byname/same.html`);
  expect(await jquery()).toEqual({ version: "3.7.1", patched: false });
  expect(server.log).not.toContain("/byname/same/jquery-3.7.1.min.js script");

  await loadUntil("same", async () => (await ask<{ url: string; version: string }[]>("get-matched")).map((m) => [m.url, m.version]), [
    [lib("same"), "3.7.1"],
  ]);
  // the check downloaded the real file (the worker's fetch bypasses the redirect), the page never did
  expect(server.log).toContain("/byname/same/jquery-3.7.1.min.js empty");
  expect(server.log).not.toContain("/byname/same/jquery-3.7.1.min.js script");
});

test("a copy that is really another version is corrected for the next load", async () => {
  await page.goto(`${server.origin}/byname/older.html`);
  expect((await jquery()).version).toBe("3.7.1"); // the name was trusted first
  await loadUntil("older", async () => (await jquery()).version, "3.6.4");
  expect(server.log).not.toContain("/byname/older/jquery-3.7.1.min.js script");
});

test("a modified copy is given back to the site after the first load", async () => {
  await page.goto(`${server.origin}/byname/patched.html`);
  expect(await jquery()).toEqual({ version: "3.7.1", patched: false }); // the accepted risk: first load is ours
  await loadUntil("patched", jquery, { version: "3.7.1", patched: true });
  expect(await ask<{ url: string }[]>("get-rejected")).toMatchObject([{ url: lib("patched") }]);
  expect(await ask<unknown[]>("get-matched")).toEqual([]);
});

test("the byname switch turns it off", async () => {
  const p = await ctx.newPage();
  await p.goto(ext);
  await p.evaluate(() => chrome.runtime.sendMessage({ type: "set-settings", patch: { byname: false } }));
  await p.close();
  await page.goto(`${server.origin}/byname/patched.html`);
  expect((await jquery()).patched).toBe(true);
});
