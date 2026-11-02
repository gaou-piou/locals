import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { launchWithExtension } from "./extension";
import { startServer } from "./server";

test("a file written by locals-learn after load is served instead of the CDN, even under CSP", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "locals-learned-"));
  await cp("dist", dir, { recursive: true });
  const body = "window.__learned = 'yes';";
  const sha = createHash("sha256").update(body).digest("hex");
  const server = await startServer();
  const ctx = await launchWithExtension(dir, { blockedHosts: ["cdn.jsdelivr.net"] });
  try {
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
    // written after the extension is already running, as the helper does
    await mkdir(path.join(dir, "libs/learned"), { recursive: true });
    await writeFile(path.join(dir, `libs/learned/${sha}.js`), body);
    await writeFile(
      path.join(dir, "libs/learned/index.json"),
      JSON.stringify({ schema: 1, entries: [{ url: "https://cdn.jsdelivr.net/npm/learnedlib@9.9.9/x.min.js", file: `${sha}.js`, sha256: sha, type: "script" }] }),
    );
    // the worker cannot message itself, so apply through an extension page
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${new URL(sw.url()).host}/options/index.html`);
    expect(await page.evaluate(() => chrome.runtime.sendMessage({ type: "refresh-learned" }))).toBe(1);
    await page.goto(`${server.origin}/learned.html?csp=${encodeURIComponent("script-src https://cdn.jsdelivr.net")}`);
    await expect.poll(() => page.evaluate(() => (window as any).__learned)).toBe("yes");
  } finally {
    await ctx.close();
    await server.close();
  }
});
