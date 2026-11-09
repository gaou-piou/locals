import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { launchWithExtension } from "./extension";

const JS = "window.LIB = (window.LIB ?? 0) + 1;";
const CSS = ".x{color:rgb(1, 2, 3)}";
const SRI = `sha256-${createHash("sha256").update(JS).digest("base64")}`;

/** Sites <name>.test and a CDN cdn.test on one local server; nothing is cacheable by the browser itself. */
async function startSites() {
  const cdnLog: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const port = url.port;
    if (url.hostname === "cdn.test") {
      // only what a page asked for: the worker's own downloads (to compare, to keep a copy) come with Sec-Fetch-Dest: empty
      if (req.headers["sec-fetch-dest"] !== "empty") cdnLog.push(url.pathname);
      const css = url.pathname.endsWith(".css");
      res.writeHead(200, { "content-type": css ? "text/css" : "text/javascript", "cache-control": "no-store", "access-control-allow-origin": "*" });
      res.end(css ? CSS : JS);
      return;
    }
    const csp = url.searchParams.get("csp");
    const meta = url.searchParams.get("meta");
    res.writeHead(200, { "content-type": "text/html", "cache-control": "no-store", ...(csp ? { "content-security-policy": csp } : {}) });
    res.end(
      `<!doctype html>${meta ? `<meta http-equiv="Content-Security-Policy" content="${meta}">` : ""}<title>${url.hostname}</title>` +
        `<link rel="stylesheet" href="http://cdn.test:${port}/lib/1.2.3/lib.min.css">` +
        `<script src="http://cdn.test:${port}/lib/1.2.3/lib.min.js" integrity="${SRI}" crossorigin="anonymous"></script><p class="x">x</p>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { port, cdnLog, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

test("files seen on three sites are served as data: copies where the page's CSP allows it", async () => {
  test.setTimeout(90_000);
  const sites = await startSites();
  const ctx = await launchWithExtension("dist", { hostRules: ["MAP *.test 127.0.0.1"] });
  try {
    const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
    sw.on("console", (m) => (m.type() === "warning" || m.type() === "error") && console.log(`[sw ${m.type()}] ${m.text()}`));
    const ext = await ctx.newPage();
    await ext.goto(`chrome-extension://${new URL(sw.url()).host}/options/index.html`);
    const send = (message: object) => ext.evaluate((m) => chrome.runtime.sendMessage(m), message);
    const page = await ctx.newPage();
    const site = (name: string, query = "") => `http://${name}.test:${sites.port}/${query}`;
    /** Loads a page; returns whether the CDN was asked for the script, and what the page got. */
    const visit = async (url: string) => {
      sites.cdnLog.length = 0;
      await page.goto(url);
      await page.waitForLoadState("load");
      const got = await page.evaluate(() => ({ lib: (window as any).LIB ?? 0, color: getComputedStyle(document.querySelector(".x")!).color }));
      return { network: sites.cdnLog.includes("/lib/1.2.3/lib.min.js"), ...got };
    };

    // the third site to load the files makes them worth a copy (the worker may still be starting: keep browsing)
    await expect
      .poll(
        async () => {
          for (const name of ["a", "b", "c"]) await visit(site(name));
          return ((await send({ type: "get-cached" })) as { url: string }[]).map((f) => f.url);
        },
        { timeout: 30_000, intervals: [500, 1000, 2000] },
      )
      .toEqual([`http://cdn.test:${sites.port}/lib/1.2.3/lib.min.css`, `http://cdn.test:${sites.port}/lib/1.2.3/lib.min.js`]);

    // a known site with no CSP gets the copies: the CDN is not asked, SRI passes, the stylesheet applies
    expect(await visit(site("a"))).toEqual({ network: false, lib: 1, color: "rgb(1, 2, 3)" });

    // a site never seen before gets the copies as soon as its CSP is known (its document arrives before its scripts)
    await visit(site("d"));
    expect(await visit(site("d"))).toEqual({ network: false, lib: 1, color: "rgb(1, 2, 3)" });

    // a CSP without data: keeps the site on the network (and working)
    const strict = `?csp=${encodeURIComponent(`script-src 'self' http://cdn.test:${sites.port}`)}`;
    expect(await visit(site("e", strict))).toEqual({ network: true, lib: 1, color: "rgb(1, 2, 3)" });
    expect(await visit(site("e", strict))).toEqual({ network: true, lib: 1, color: "rgb(1, 2, 3)" });

    // a <meta> CSP is invisible to the worker: the blocked copy flips the host and the tab reloads from the network
    const meta = `?meta=${encodeURIComponent(`script-src 'self' http://cdn.test:${sites.port}`)}`;
    // (the first visit may still go to the network: the worker learns the host's headers while the page loads)
    const verdict = () => sw.evaluate(async () => ((await chrome.storage.local.get("cache")).cache as any).hosts["f.test"]);
    await expect
      .poll(async () => {
        await page.goto(site("f", meta)).catch(() => {}); // the reload may cut the navigation short
        return verdict();
      })
      .toMatchObject({ script: false, stylesheet: false, font: false });
    await expect.poll(() => page.evaluate(() => (window as any).LIB ?? 0).catch(() => 0), { timeout: 10_000 }).toBe(1);
    expect(await visit(site("f", meta))).toMatchObject({ network: true, lib: 1 });

    // the options page shows what is kept
    await ext.reload();
    await expect(ext.getByTestId("cached-count")).toContainText("2 files kept");

    // the setting turns the copies off at once
    await send({ type: "set-settings", patch: { autoCache: false } });
    await expect.poll(async () => (await visit(site("a"))).network).toBe(true);
  } finally {
    await ctx.close();
    await sites.close();
  }
});
