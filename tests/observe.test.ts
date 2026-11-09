import { beforeEach, describe, expect, it } from "vitest";
import { createObserver, isImmutableUrl, normalizeUrl, sameSite } from "../src/background/observe.ts";
import { installFakeChrome } from "./fake-chrome.ts";

let now = new Date(2026, 10, 2, 12);
beforeEach(() => {
  installFakeChrome();
  now = new Date(2026, 10, 2, 12);
});
const make = () => createObserver({ now: () => now, flushDelayMs: 0 });
const URL1 = "https://cdn.example.net/lib/swiper@11.1.4/swiper.min.js";

describe("normalizeUrl", () => {
  it("drops query and fragment, keeps scheme/host/path", () => {
    expect(normalizeUrl("https://a.com/x/y.js?v=1#z")).toBe("https://a.com/x/y.js");
  });
  it("rejects non-http(s) and garbage", () => {
    expect(normalizeUrl("chrome-extension://abc/x.js")).toBeUndefined();
    expect(normalizeUrl("data:text/javascript,1")).toBeUndefined();
    expect(normalizeUrl("nope")).toBeUndefined();
  });
});

describe("sameSite", () => {
  it("treats subdomains and the registrable domain as the same site", () => {
    expect(sameSite("www.example.com", "static.example.com")).toBe(true);
    expect(sameSite("example.com", "cdn.other.com")).toBe(false);
  });
  it("understands two-level public suffixes", () => {
    expect(sameSite("a.example.co.uk", "b.example.co.uk")).toBe(true);
    expect(sameSite("a.example.co.uk", "b.other.co.uk")).toBe(false);
  });
});

describe("isImmutableUrl", () => {
  it.each([
    "https://x.com/npm/swiper@11.1.4/swiper.min.js",
    "https://x.com/ajax/libs/slick/1.8.1/slick.min.js",
    "https://x.com/lib-2.3.1.min.js",
    "https://x.com/assets/app.3f9a1c7e2b.js",
    "https://fonts.gstatic.com/s/roboto/v30/KFOmCnqEu92Fr1Mu4mxK.woff2",
    "https://c0.wp.com/c/6.8.2/wp-includes/js/jquery/jquery.min.js",
  ])("accepts %s", (u) => expect(isImmutableUrl(u)).toBe(true));
  it.each([
    "https://x.com/analytics.js",
    "https://x.com/npm/swiper@latest/swiper.min.js",
    "https://x.com/npm/swiper@11/swiper.min.js",
    "https://x.com/v1/widget.js",
    "https://fonts.gstatic.com/l/font?kit=abc",
    "https://evil.example/s/roboto/v30/KFOmCnqEu92Fr1Mu4mxK.woff2",
  ])("rejects %s", (u) => expect(isImmutableUrl(u)).toBe(false));
});

describe("observer", () => {
  it("ignores first-party, non-asset and non-http requests", async () => {
    const o = make();
    o.record({ url: "https://www.site.com/app.js", initiator: "https://site.com", type: "script" });
    o.record({ url: URL1, initiator: "https://a.com", type: "image" });
    o.record({ url: "chrome-extension://abc/x.js", initiator: "https://a.com", type: "script" });
    await o.flush();
    expect(await o.getCandidates({ minSites: 1 })).toEqual([]);
  });

  it("counts distinct sites, not repeated hits from one site", async () => {
    const o = make();
    o.record({ url: URL1 + "?v=1", initiator: "https://a.com", type: "script" });
    o.record({ url: URL1, initiator: "https://www.a.com", type: "script" });
    await o.flush();
    const [c] = await o.getCandidates({ minSites: 1 });
    expect(c).toMatchObject({ url: URL1, type: "script", sites: 1, hits: 2 });
  });

  it("offers a candidate only after it was seen on enough different sites and is immutable", async () => {
    const o = make();
    o.record({ url: URL1, initiator: "https://a.com", type: "script" });
    await o.flush();
    expect(await o.getCandidates()).toEqual([]);
    o.record({ url: URL1, initiator: "https://b.org", type: "script" });
    o.record({ url: "https://cdn.example.net/analytics.js", initiator: "https://a.com", type: "script" });
    o.record({ url: "https://cdn.example.net/analytics.js", initiator: "https://b.org", type: "script" });
    await o.flush();
    const out = await o.getCandidates();
    expect(out.map((c) => c.url)).toEqual([URL1]);
    expect(out[0].sites).toBe(2);
  });

  it("sitesOf counts the distinct sites that loaded a url (query ignored), 0 when never seen", async () => {
    const o = make();
    o.record({ url: URL1, initiator: "https://a.com", type: "script" });
    o.record({ url: URL1, initiator: "https://www.a.com", type: "script" });
    o.record({ url: URL1, initiator: "https://b.org", type: "script" });
    expect(await o.sitesOf(URL1 + "?v=2")).toBe(2);
    expect(await o.sitesOf("https://never.example/x.js")).toBe(0);
  });

  it("does not store which sites were visited", async () => {
    const o = make();
    o.record({ url: URL1, initiator: "https://secret-site.example", type: "script" });
    await o.flush();
    const raw = JSON.stringify((await chrome.storage.local.get("observed")).observed);
    expect(raw).not.toContain("secret-site");
  });

  it("survives a restart (state lives in storage) and clear() empties it", async () => {
    const a = make();
    a.record({ url: URL1, initiator: "https://a.com", type: "script" });
    await a.flush();
    const b = make();
    b.record({ url: URL1, initiator: "https://b.org", type: "script" });
    await b.flush();
    expect((await b.getCandidates())[0].sites).toBe(2);
    await b.clear();
    expect(await make().getCandidates({ minSites: 1 })).toEqual([]);
  });

  it("keeps at most `maxEntries` urls, dropping the least recently seen", async () => {
    const o = createObserver({ now: () => now, flushDelayMs: 0, maxEntries: 2 });
    for (const n of [1, 2, 3]) {
      now = new Date(2026, 10, n, 12);
      o.record({ url: `https://c.net/l@1.0.${n}/a.js`, initiator: "https://a.com", type: "script" });
    }
    await o.flush();
    const urls = (await o.getCandidates({ minSites: 1 })).map((c) => c.url).sort();
    expect(urls).toEqual(["https://c.net/l@1.0.2/a.js", "https://c.net/l@1.0.3/a.js"]);
  });

  it("lists versioned urls seen on only one site as pending, never the ready or unversioned ones", async () => {
    const o = make();
    const ready = "https://c.net/a@1.0.0/a.js";
    const waiting = "https://c.net/b@2.0.0/b.js";
    o.record({ url: ready, initiator: "https://a.com", type: "script" });
    o.record({ url: ready, initiator: "https://b.org", type: "script" });
    o.record({ url: waiting, initiator: "https://a.com", type: "script" });
    o.record({ url: "https://c.net/analytics.js", initiator: "https://a.com", type: "script" });
    await o.flush();
    const pending = await o.getPending();
    expect(pending.map((c) => c.url)).toEqual([waiting]);
    expect(pending[0]).toMatchObject({ sites: 1, hits: 1, type: "script" });
  });

  it("lists the most recently seen pending url first", async () => {
    const o = make();
    for (const [n, u] of [[1, "https://c.net/a@1.0.0/a.js"], [2, "https://c.net/b@1.0.0/b.js"]] as const) {
      now = new Date(2026, 10, n, 12);
      o.record({ url: u, initiator: "https://a.com", type: "script" });
    }
    await o.flush();
    expect((await o.getPending()).map((c) => c.url)).toEqual(["https://c.net/b@1.0.0/b.js", "https://c.net/a@1.0.0/a.js"]);
  });
});
