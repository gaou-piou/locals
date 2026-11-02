import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyExceptions } from "../src/background/exceptions.ts";
import { applyLearned, excludeLearned, learnedRules, LEARNED_ID_BASE, parseLearnedIndex, type LearnedEntry } from "../src/background/learned.ts";
import { installFakeChrome } from "./fake-chrome.ts";

const H = "a".repeat(64);
const entry = (over = {}) => ({ url: "https://cdn.example.net/lib@1.2.3/x.min.js", file: `${H}.js`, sha256: H, type: "script", ...over });

describe("parseLearnedIndex", () => {
  it("keeps well-formed entries and drops anything else", () => {
    const good = entry();
    const out = parseLearnedIndex({
      schema: 1,
      entries: [good, entry({ file: "../evil.js" }), entry({ url: "ftp://x/y.js" }), entry({ type: "image" }), entry({ sha256: "zz" }), null, "x"],
    });
    expect(out).toEqual([good]);
  });
  it("returns nothing for a malformed index", () => {
    expect(parseLearnedIndex(null)).toEqual([]);
    expect(parseLearnedIndex({ schema: 2, entries: [entry()] })).toEqual([]);
    expect(parseLearnedIndex({ schema: 1 })).toEqual([]);
  });
});

describe("learnedRules", () => {
  it("redirects the exact URL to the learned file with the matching resource type", () => {
    const [r] = learnedRules([entry() as never]);
    expect(r.id).toBe(LEARNED_ID_BASE);
    expect(r.action).toEqual({ type: "redirect", redirect: { extensionPath: `/libs/learned/${H}.js` } });
    expect(r.condition).toMatchObject({ urlFilter: "||cdn.example.net/lib@1.2.3/x.min.js^", resourceTypes: ["script"] });
  });
  it("ranks below the site-exception rules so a disabled site is left alone", () => {
    const [r] = learnedRules([entry() as never]);
    expect(r.priority).toBeLessThan(100);
  });
});

describe("applyLearned", () => {
  beforeEach(() => {
    installFakeChrome();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ schema: 1, entries: [entry()] })));
  });

  it("installs the rules and reports how many", async () => {
    expect(await applyLearned()).toBe(1);
    expect((await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id)).toEqual([LEARNED_ID_BASE]);
  });

  it("is idempotent and replaces rules of entries that disappeared", async () => {
    await applyLearned();
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ schema: 1, entries: [] })));
    expect(await applyLearned()).toBe(0);
    expect(await chrome.declarativeNetRequest.getDynamicRules()).toEqual([]);
  });

  it("treats a missing index as no learned libraries", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 404 }));
    expect(await applyLearned()).toBe(0);
  });

  it("and site exceptions do not remove each other's rules", async () => {
    await applyLearned();
    await applyExceptions({ disabledSites: ["a.com"], allowedSites: [] });
    const ids = (await chrome.declarativeNetRequest.getDynamicRules()).map((r) => r.id).sort((a, b) => a - b);
    expect(ids).toEqual([100_000, LEARNED_ID_BASE]);
    await applyLearned();
    expect((await chrome.declarativeNetRequest.getDynamicRules()).length).toBe(2);
  });
});

describe("excludeLearned", () => {
  const cand = (url: string) => ({ url, sites: 2, hits: 3, last: 1 });
  it("drops candidates whose URL is already learned and keeps the rest", () => {
    const learned = [entry()] as LearnedEntry[];
    const a = cand(learned[0].url);
    const b = cand("https://cdn.example.net/other@1.0.0/y.js");
    expect(excludeLearned([a, b], learned)).toEqual([b]);
  });
  it("returns everything when nothing is learned", () => {
    const a = cand("https://cdn.example.net/z@1.0.0/z.js");
    expect(excludeLearned([a], [])).toEqual([a]);
  });
});
