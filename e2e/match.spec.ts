import { expect, test } from "@playwright/test";
import { launchWithExtension } from "./extension";
import { startServer } from "./server";

test("a site's own byte-identical copy of jQuery is detected and then served from the extension", async () => {
  const server = await startServer();
  const ctx = await launchWithExtension("dist");
  try {
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
    const page = await ctx.newPage();
    const ext = `chrome-extension://${new URL(sw.url()).host}/options/index.html`;
    const matched = async () => {
      const p = await ctx.newPage();
      await p.goto(ext);
      const out = await p.evaluate(() => chrome.runtime.sendMessage({ type: "get-matched" }));
      await p.close();
      return out as { url: string; library: string }[];
    };

    await page.goto(`${server.origin}/selfhosted.html`);
    await expect.poll(async () => (await matched()).map((m) => m.library)).toEqual(["jquery"]);

    server.requests.length = 0;
    await page.goto(`${server.origin}/selfhosted.html`);
    expect(await page.evaluate(() => (window as any).jQuery?.fn.jquery)).toBe("3.7.1");
    expect(server.requests).not.toContain("/vendor/jquery.min.js");
  } finally {
    await ctx.close();
    await server.close();
  }
});
