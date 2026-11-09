import { beforeEach, describe, expect, it } from "vitest";
import { createCache, cspAllowsData, dataUrl, ENTRY_ID_BASE, gateRules, GATE_ID_BASE, servable } from "../src/background/cache.ts";
import { installFakeChrome } from "./fake-chrome.ts";
import { PRIORITY } from "../src/shared/priorities.ts";

describe("cspAllowsData", () => {
  it("allows every type without a policy, or with only unrelated directives", () => {
    expect(cspAllowsData([])).toEqual({ script: true, stylesheet: true, font: true });
    expect(cspAllowsData(["frame-ancestors 'self'; upgrade-insecure-requests"])).toEqual({ script: true, stylesheet: true, font: true });
  });

  it("falls back from the element directive to the type directive to default-src", () => {
    expect(cspAllowsData(["default-src 'self'"])).toEqual({ script: false, stylesheet: false, font: false });
    expect(cspAllowsData(["default-src 'self'; script-src * data:; font-src data:"])).toEqual({ script: true, stylesheet: false, font: true });
    expect(cspAllowsData(["script-src data:; script-src-elem 'self'; style-src-elem DATA: 'self'"])).toEqual({ script: false, stylesheet: true, font: true });
  });

  it("does not count * as data:, and 'strict-dynamic' ignores data: for scripts", () => {
    expect(cspAllowsData(["script-src *; style-src *"])).toMatchObject({ script: false, stylesheet: false });
    expect(cspAllowsData(["script-src 'nonce-x' 'strict-dynamic' data:"]).script).toBe(false);
  });

  it("needs every policy (headers, or comma-joined ones) to allow it", () => {
    expect(cspAllowsData(["font-src data:", "default-src 'self'"]).font).toBe(false);
    expect(cspAllowsData(["font-src data:, font-src 'self'"]).font).toBe(false);
    expect(cspAllowsData(["font-src data:, style-src 'self'"]).font).toBe(true);
  });
});

describe("servable", () => {
  it("serves fonts and self-contained stylesheets", () => {
    expect(servable("font", "wOF2...")).toBe(true);
    expect(servable("stylesheet", `.a{background:url("data:image/png;base64,AA")}.b{background:url(https://x.org/a.png)}`)).toBe(true);
  });

  it("skips stylesheets with relative urls or imports (they would resolve against data:)", () => {
    expect(servable("stylesheet", ".a{background:url(../img/a.png)}")).toBe(false);
    expect(servable("stylesheet", ".a{background:url( '/img/a.png' )}")).toBe(false);
    expect(servable("stylesheet", `@import "theme.css";`)).toBe(false);
    expect(servable("stylesheet", `@import url(theme.css);`)).toBe(false);
    expect(servable("stylesheet", ".c{background:url(//x.org/b.png)}")).toBe(false); // no host to borrow from data:
    expect(servable("stylesheet", `@import "//x.org/t.css";`)).toBe(false);
  });

  it("skips scripts that find their own URL or load relative modules", () => {
    expect(servable("script", "window.x=1;")).toBe(true);
    for (const js of [
      "var s=document.currentScript.src",
      "new URL('./w.js', import.meta.url)",
      `import{a}from"./chunk.js"`,
      `import "../side.js"`,
      `import("./lazy.js")`,
      `var s=document.getElementsByTagName("script")`,
      `document.querySelectorAll('script[src]')`,
    ])
      expect(servable("script", js), js).toBe(false);
  });
});

describe("dataUrl", () => {
  const body = new TextEncoder().encode("é;").buffer;
  it("encodes the bytes as base64 with a type the page accepts", () => {
    expect(dataUrl("script", "https://c.org/a.js", "application/javascript; charset=utf-8", body)).toBe("data:text/javascript;charset=utf-8;base64,w6k7");
    expect(dataUrl("stylesheet", "https://c.org/a.css", "text/css", body)).toBe("data:text/css;charset=utf-8;base64,w6k7");
    expect(dataUrl("script", "https://c.org/a.js", "text/javascript;charset=iso-8859-1", body)).toBe("data:text/javascript;charset=iso-8859-1;base64,w6k7");
  });
  it("types fonts by their extension", () => {
    expect(dataUrl("font", "https://fonts.gstatic.com/s/x/v1/a.woff2", "", body)).toBe("data:font/woff2;base64,w6k7");
    expect(dataUrl("font", "https://c.org/a.ttf", "application/octet-stream", body)).toBe("data:font/ttf;base64,w6k7");
  });
});

describe("gateRules", () => {
  const hosts = { "a.org": { script: true, stylesheet: true, font: true, at: 1 }, "x.a.org": { script: false, stylesheet: true, font: true, at: 1 } };
  const byId = (rules: chrome.declarativeNetRequest.Rule[]) => Object.fromEntries(rules.map((r) => [r.id - GATE_ID_BASE, r]));

  it("blocks data: copies everywhere except known safe hosts, and takes unsafe subdomains back", () => {
    const r = byId(gateRules(hosts, true));
    expect(r[0]).toEqual({
      id: GATE_ID_BASE,
      priority: PRIORITY.gate,
      action: { type: "allow" },
      condition: { resourceTypes: ["script"], excludedInitiatorDomains: ["a.org"] },
    });
    expect(r[1].condition).toEqual({ resourceTypes: ["script"], initiatorDomains: ["x.a.org"] });
    expect(r[2].condition).toEqual({ resourceTypes: ["stylesheet"], excludedInitiatorDomains: ["a.org", "x.a.org"] });
    expect(r[3]).toBeUndefined(); // no unsafe host for stylesheets: a rule with an empty list would match everything
    expect(Object.keys(r)).toEqual(["0", "1", "2", "4"]);
  });

  it("blocks every data: copy when auto-cache is off or nothing is known yet", () => {
    for (const rules of [gateRules(hosts, false), gateRules({}, true)])
      expect(rules.map((g) => g.condition)).toEqual([{ resourceTypes: ["script"] }, { resourceTypes: ["stylesheet"] }, { resourceTypes: ["font"] }]);
  });
});

describe("createCache", () => {
  const JS = "https://cdn.example/lib/1.2.3/lib.min.js";
  const CSS = "https://cdn.example/lib/1.2.3/lib.min.css";
  const DAY = 24 * 3600 * 1000;
  let env: ReturnType<typeof installFakeChrome>;
  let now: number;
  let fetched: string[];
  let bodies: Record<string, string>;
  let sites: Record<string, number>;
  let enabled: boolean;
  let bundled: Set<string>;
  const make = (over: Partial<Parameters<typeof createCache>[0]> = {}) =>
    createCache({
      fetchBody: async (url) => {
        fetched.push(url);
        return url in bodies ? { body: new TextEncoder().encode(bodies[url]).buffer, contentType: "text/plain" } : null;
      },
      sitesOf: async (url) => sites[url] ?? 0,
      isBundled: async (body) => bundled.has(new TextDecoder().decode(body)),
      enabled: async () => enabled,
      now: () => now,
      ...over,
    });
  const entryRules = () => env.state.dynamic.filter((r) => r.id >= ENTRY_ID_BASE);
  const gates = () => env.state.dynamic.filter((r) => r.id < ENTRY_ID_BASE);

  beforeEach(() => {
    env = installFakeChrome();
    now = 100 * DAY;
    fetched = [];
    bodies = { [JS]: "window.lib=1;", [CSS]: ".lib{color:red}" };
    sites = { [JS]: 3, [CSS]: 3 };
    enabled = true;
    bundled = new Set();
  });

  it("serves an immutable file seen on 3 sites from a data: copy, and only once fetched", async () => {
    const c = make();
    await c.consider({ url: JS + "?v=1", type: "script" });
    await c.consider({ url: JS, type: "script" });
    expect(fetched).toEqual([JS]);
    expect(entryRules()).toEqual([
      {
        id: ENTRY_ID_BASE,
        priority: PRIORITY.cached,
        action: { type: "redirect", redirect: { url: `data:text/javascript;charset=utf-8;base64,${btoa("window.lib=1;")}` } },
        condition: { urlFilter: "||cdn.example/lib/1.2.3/lib.min.js^", resourceTypes: ["script"], excludedInitiatorDomains: ["fakeextensionid"] },
      },
    ]);
    expect(await c.list()).toEqual([{ url: JS, type: "script", bytes: 13, at: now, used: now }]);
  });

  it("waits for the third site, and never caches mutable urls or when it is off", async () => {
    sites[JS] = 2;
    await make().consider({ url: JS, type: "script" });
    const latest = "https://cdn.example/lib/latest/lib.min.js";
    bodies[latest] = "x";
    sites[latest] = 8;
    await make().consider({ url: latest, type: "script" });
    enabled = false;
    sites[JS] = 3;
    await make().consider({ url: JS, type: "script" });
    expect(fetched).toEqual([]);
  });

  it("skips files that are too big, would break as data:, or are bundled; and does not retry them soon", async () => {
    const big = "https://cdn.example/big/1.0.0/big.js";
    const chunky = "https://cdn.example/app/1.0.0/app.js";
    const known = "https://cdn.example/jquery/3.7.1/jquery.min.js";
    bodies[big] = "x".repeat(101);
    bodies[chunky] = "import('./chunk.js')";
    bodies[known] = "/*jquery*/";
    bundled.add("/*jquery*/");
    Object.assign(sites, { [big]: 3, [chunky]: 3, [known]: 3 });
    const c = make({ maxFileBytes: 100 });
    for (const url of [big, chunky, known]) await c.consider({ url, type: "script" });
    for (const url of [big, chunky, known]) await c.consider({ url, type: "script" });
    expect(fetched).toEqual([big, chunky, known]);
    expect(entryRules()).toEqual([]);
    now += 4 * DAY;
    await c.consider({ url: big, type: "script" });
    expect(fetched).toHaveLength(4);
  });

  it("makes room by dropping the least recently used copies", async () => {
    const c = make({ maxTotalBytes: 30 }); // JS 13 + CSS 15 fit, a third does not
    await c.consider({ url: JS, type: "script" });
    now += 1000;
    await c.consider({ url: CSS, type: "stylesheet" });
    now += 1000;
    c.touch(JS + "?cb=2");
    const font = "https://fonts.gstatic.com/s/roboto/v30/abc.woff2";
    bodies[font] = "wOF2wOF2";
    sites[font] = 5;
    await c.consider({ url: font, type: "font" });
    expect((await c.list()).map((e) => e.url)).toEqual([JS, font]); // CSS was the least recently used
    expect(entryRules().map((r) => r.id).sort()).toEqual([ENTRY_ID_BASE, ENTRY_ID_BASE + 1]);
  });

  it("downloads outside its queue: pages are noted while a file is on its way, and Forget wins over a late download", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const c = make({
      fetchBody: async (url) => {
        fetched.push(url);
        await gate;
        return { body: new TextEncoder().encode(bodies[url]).buffer, contentType: "text/plain" };
      },
    });
    const pending = c.consider({ url: JS, type: "script" });
    const second = c.consider({ url: JS, type: "script" });
    const noted = await Promise.race([c.noteDocument({ url: "https://news.example/", headers: [] }).then(() => true), gate.then(() => false)]);
    expect(noted).toBe(true);
    expect(gates()[0].condition).toEqual({ resourceTypes: ["script"], excludedInitiatorDomains: ["news.example"] });
    await c.clear();
    release();
    await Promise.all([pending, second]);
    expect(fetched).toEqual([JS]);
    expect(await c.list()).toEqual([]);
    expect(entryRules()).toEqual([]);
    // the next sighting fetches it again (Forget also forgets what was tried)
    await c.consider({ url: JS, type: "script" });
    expect(await c.list()).toHaveLength(1);
  });

  it("keeps its copies across worker restarts", async () => {
    await make().consider({ url: JS, type: "script" });
    const again = make();
    await again.consider({ url: JS, type: "script" });
    expect(fetched).toEqual([JS]);
    expect(await again.list()).toHaveLength(1);
  });

  it("opens the gate for document hosts whose CSP allows data:, and keeps unsafe verdicts", async () => {
    const c = make();
    await c.noteDocument({ url: "https://news.example/a", headers: [] });
    await c.noteDocument({ url: "https://bank.example/", headers: ["default-src 'self'"] });
    expect(gates()[0].condition).toEqual({ resourceTypes: ["script"], excludedInitiatorDomains: ["news.example"] });
    await c.noteDocument({ url: "https://news.example/admin", headers: ["script-src 'self'"] });
    await c.noteDocument({ url: "https://news.example/b", headers: [] });
    expect(gates()[0].condition).toEqual({ resourceTypes: ["script"] });
    expect(gates().find((g) => g.condition.resourceTypes?.[0] === "font")?.condition).toEqual({ resourceTypes: ["font"], excludedInitiatorDomains: ["news.example"] });
  });

  it("closes the gate everywhere when turned off", async () => {
    const c = make();
    await c.noteDocument({ url: "https://news.example/a", headers: [] });
    enabled = false;
    await c.refreshGates();
    expect(gates().map((g) => g.condition)).toEqual([{ resourceTypes: ["script"] }, { resourceTypes: ["stylesheet"] }, { resourceTypes: ["font"] }]);
  });

  it("marks a host unsafe when a cached script or stylesheet aborts there (a meta CSP), so the page can reload", async () => {
    const c = make();
    await c.consider({ url: JS, type: "script" });
    await c.noteDocument({ url: "https://news.example/a", headers: [] });
    expect(await c.noteAborted({ url: "https://other.example/x.js", type: "script", initiator: "https://news.example" })).toBe(false);
    expect(await c.noteAborted({ url: JS, type: "font", initiator: "https://news.example" })).toBe(false); // fonts abort on success too
    expect(await c.noteAborted({ url: JS, type: "script", initiator: "https://news.example" })).toBe(true);
    expect(gates().map((g) => g.condition)).toEqual([{ resourceTypes: ["script"] }, { resourceTypes: ["stylesheet"] }, { resourceTypes: ["font"] }]);
    expect(await c.noteAborted({ url: JS, type: "script", initiator: "https://news.example" })).toBe(false); // already known: no reload loop
  });

  it("prune expires copies unused for 60 days, hosts not seen for 30, and rules without an entry", async () => {
    const c = make();
    await c.consider({ url: JS, type: "script" });
    await c.noteDocument({ url: "https://news.example/a", headers: [] });
    env.state.dynamic.push({ id: ENTRY_ID_BASE + 9, priority: 1, action: { type: "allow" as chrome.declarativeNetRequest.RuleActionType }, condition: {} });
    now += 31 * DAY;
    await c.prune();
    expect(gates()[0].condition).toEqual({ resourceTypes: ["script"] });
    expect(entryRules().map((r) => r.id)).toEqual([ENTRY_ID_BASE]);
    now += 30 * DAY;
    await c.prune();
    expect(entryRules()).toEqual([]);
    expect(await c.list()).toEqual([]);
  });
});
