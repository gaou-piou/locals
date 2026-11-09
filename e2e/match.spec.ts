import { expect, test } from "@playwright/test";
import { launchWithExtension } from "./extension";
import { startServer } from "./server";

test("a site's own byte-identical copy of jQuery is detected and then served from the extension", async () => {
  const server = await startServer();
  const ctx = await launchWithExtension("dist");
  try {
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
    sw.on("console", (m) => console.log(`[sw ${m.type()}] ${m.text()}`));
    const page = await ctx.newPage();
    const ext = `chrome-extension://${new URL(sw.url()).host}/options/index.html`;
    const matched = async () => {
      const p = await ctx.newPage();
      await p.goto(ext);
      const out = await p.evaluate(() => chrome.runtime.sendMessage({ type: "get-matched" }));
      await p.close();
      return out as { url: string; library: string }[];
    };

    try {
      // The worker may still be evaluating its module when the first page loads on a slow runner (the webRequest
      // listener is not registered yet, so that load is never observed). Load again until a load is seen.
      await expect
        .poll(
          async () => {
            await page.goto(`${server.origin}/selfhosted.html`);
            return (await matched()).map((m) => m.library);
          },
          { timeout: 20_000, intervals: [500, 1000, 2000] },
        )
        .toEqual(["jquery"]);
    } catch (err) {
      // the CI runner does not show the worker console; put the evidence in the failure itself
      const state = await sw
        .evaluate(async () => ({
          storage: await chrome.storage.local.get("matched"),
          dynamic: (await chrome.declarativeNetRequest.getDynamicRules()).length,
        }))
        .catch((e) => String(e));
      throw new Error(`${err}\nserver.requests=${JSON.stringify(server.requests)}\nstate=${JSON.stringify(state)}\nsw=${sw.url()} workers=${ctx.serviceWorkers().length}`);
    }

    server.requests.length = 0;
    await page.goto(`${server.origin}/selfhosted.html`);
    expect(await page.evaluate(() => (window as any).jQuery?.fn.jquery)).toBe("3.7.1");
    expect(server.requests).not.toContain("/vendor/jquery.min.js");

    // the badge and the popup count it as served from a detected copy, apart from the saved copies
    const counts = await ctx.newPage();
    await counts.goto(ext);
    const tabState = () =>
      counts.evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ url });
        return {
          badge: await chrome.action.getBadgeText({ tabId: tab!.id! }),
          count: await chrome.runtime.sendMessage({ type: "get-tab-count", tabId: tab!.id! }),
        };
      }, `${server.origin}/selfhosted.html`);
    await expect.poll(tabState).toEqual({ badge: "0·1", count: { saved: 0, detected: 1 } });
    await counts.close();

    // the global switch also stops the dynamic redirects
    const settings = await page.context().newPage();
    await settings.goto(ext);
    await settings.evaluate(() => chrome.runtime.sendMessage({ type: "set-settings", patch: { enabled: false } }));
    await settings.close();
    await expect
      .poll(async () => {
        server.requests.length = 0;
        await page.goto(`${server.origin}/selfhosted.html`);
        return server.requests.includes("/vendor/jquery.min.js");
      })
      .toBe(true);
  } finally {
    await ctx.close();
    await server.close();
  }
});
