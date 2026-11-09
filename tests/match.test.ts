import { beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { applyLearned } from "../src/background/learned.ts";
import { buildIndex, createMatcher, looksLikeLibrary, MATCH_ID_BASE, matchRules, REJECT_ID_BASE } from "../src/background/match.ts";
import { PRIORITY } from "../src/shared/priorities.ts";
import type { LibraryEntry } from "../src/shared/manifest-schema.ts";
import { installFakeChrome } from "./fake-chrome.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const JQ = "/*jquery 3.7.1*/";
const JQ364 = "/*jquery 3.6.4*/";
const libs: LibraryEntry[] = [
  {
    name: "jquery",
    npm: "jquery",
    license: "MIT",
    versions: [
      { version: "3.6.4", files: [{ path: "dist/jquery.min.js", type: "script", sha256: sha(JQ364) }] },
      { version: "3.7.1", files: [{ path: "dist/jquery.min.js", type: "script", sha256: sha(JQ) }] },
    ],
    patterns: [],
  },
  {
    name: "font-awesome-5",
    npm: "x",
    license: "MIT",
    versions: [{ version: "5.0.0", files: [{ path: "css/all.min.css", type: "stylesheet", sha256: sha("fa") }] }],
    patterns: [],
  },
];

let env: ReturnType<typeof installFakeChrome>;
let now = 1_000_000;
let fetched: string[];
let bodies: Record<string, string | null>;
const make = (over = {}) =>
  createMatcher({
    loadLibraries: async () => libs,
    fetchBody: async (url) => {
      fetched.push(url);
      const b = bodies[url];
      return b == null ? null : new TextEncoder().encode(b).buffer;
    },
    now: () => now,
    ...over,
  });
beforeEach(() => {
  env = installFakeChrome();
  now = 1_000_000;
  fetched = [];
  bodies = {};
});

describe("looksLikeLibrary", () => {
  const idx = buildIndex(libs);
  it("needs a library name or file stem somewhere in the path", () => {
    expect(looksLikeLibrary("https://a.example/wp-content/js/jquery-3.7.1.min.js", idx)).toBe(true);
    expect(looksLikeLibrary("https://a.example/vendor/jquery/dist/x.js", idx)).toBe(true);
    expect(looksLikeLibrary("https://a.example/assets/fontawesome/css/all.min.css", idx)).toBe(false); // names are font-awesome-5
    expect(looksLikeLibrary("https://a.example/assets/font-awesome-5/css/x.css", idx)).toBe(true);
    expect(looksLikeLibrary("https://a.example/assets/app.bundle.js", idx)).toBe(false);
  });
});

describe("matcher", () => {
  it("redirects a self-hosted file to the bundled copy when the bytes are identical", async () => {
    const url = "https://shop.example/wp-content/js/jquery.min.js";
    bodies[url] = JQ;
    const m = make();
    await m.consider({ url, type: "script" });
    const [r] = env.state.dynamic;
    expect(r.id).toBeGreaterThanOrEqual(MATCH_ID_BASE);
    expect(r.action).toEqual({ type: "redirect", redirect: { extensionPath: "/libs/jquery/3.7.1/dist/jquery.min.js" } });
    expect(r.condition).toMatchObject({ urlFilter: "||shop.example/wp-content/js/jquery.min.js^", resourceTypes: ["script"] });
    expect(r.priority).toBeLessThan(100);
    expect(await m.getMatched()).toMatchObject([{ url, library: "jquery", version: "3.7.1", type: "script" }]);
  });

  it("does nothing when the bytes differ, and does not ask again soon", async () => {
    const url = "https://shop.example/js/jquery.min.js";
    bodies[url] = "patched";
    const m = make();
    await m.consider({ url, type: "script" });
    await m.consider({ url, type: "script" });
    expect(env.state.dynamic).toEqual([]);
    expect(fetched).toEqual([url]);
  });

  it("retries a mismatch after the retry delay", async () => {
    const url = "https://shop.example/js/jquery.min.js";
    bodies[url] = "patched";
    const m = make();
    await m.consider({ url, type: "script" });
    now += 4 * 24 * 3600 * 1000;
    await m.consider({ url, type: "script" });
    expect(fetched).toHaveLength(2);
  });

  it("never fetches URLs that do not look like a library", async () => {
    await make().consider({ url: "https://shop.example/assets/app.js", type: "script" });
    expect(fetched).toEqual([]);
  });

  it("ignores a match whose resource type differs from the bundled file", async () => {
    const url = "https://shop.example/js/jquery.min.js";
    bodies[url] = JQ;
    await make().consider({ url, type: "stylesheet" });
    expect(env.state.dynamic).toEqual([]);
  });

  it("refuses urls that would be unsafe or ambiguous as a urlFilter", async () => {
    bodies["https://s.example/jquery*.js"] = JQ;
    await make().consider({ url: "https://s.example/jquery*.js", type: "script" });
    expect(fetched).toEqual([]);
  });

  it("keeps serving a stale match while it re-checks the file in the background", async () => {
    const url = "https://shop.example/js/jquery.min.js";
    bodies[url] = JQ;
    const m = make({ ttlMs: 1000 });
    await m.consider({ url, type: "script" });
    now += 2000;
    await m.prune();
    expect(fetched).toEqual([url, url]);
    expect(env.state.dynamic).toHaveLength(1);
    expect((await m.getMatched())[0].at).toBe(now);
  });

  it("hands a matched file back to the site once its bytes change", async () => {
    const url = "https://shop.example/js/jquery.min.js";
    bodies[url] = JQ;
    const m = make({ ttlMs: 1000 });
    await m.consider({ url, type: "script" });
    now += 2000;
    bodies[url] = "patched";
    await m.prune();
    expect(await m.getMatched()).toEqual([]);
    expect(env.state.dynamic.map((r) => r.action.type)).toEqual(["allow"]);
  });

  it("keeps a stale match when the re-check cannot download the file", async () => {
    const url = "https://shop.example/js/jquery.min.js";
    bodies[url] = JQ;
    const m = make({ ttlMs: 1000 });
    await m.consider({ url, type: "script" });
    now += 2000;
    bodies[url] = null;
    await m.prune();
    expect(await m.getMatched()).toHaveLength(1);
  });

  it("keeps matches across worker restarts", async () => {
    const url = "https://shop.example/js/jquery.min.js";
    bodies[url] = JQ;
    await make().consider({ url, type: "script" });
    expect(await make().getMatched()).toHaveLength(1);
  });

  it("matchRules gives every entry its own id", () => {
    const e = { library: "jquery", version: "3.7.1", path: "libs/jquery/3.7.1/dist/jquery.min.js", sha256: "", type: "script" as const, at: 0 };
    const rules = matchRules([{ ...e, url: "https://a.example/jquery.js" }, { ...e, url: "https://b.example/jquery.js" }]);
    expect(new Set(rules.map((r) => r.id)).size).toBe(2);
  });

  it("learned rules and matched rules do not remove each other", async () => {
    const url = "https://shop.example/js/jquery.min.js";
    bodies[url] = JQ;
    await make().consider({ url, type: "script" });
    await applyLearned();
    expect(env.state.dynamic).toHaveLength(1);
  });
});

describe("verify (after a byname redirect)", () => {
  const url = "https://shop.example/js/jquery-3.7.1.min.js";

  it("confirms a copy whose bytes are the bundled file", async () => {
    bodies[url] = JQ;
    const m = make();
    await m.verify({ url: `${url}?x=1`, type: "script" });
    expect(fetched).toEqual([url]);
    expect(await m.getMatched()).toMatchObject([{ url, version: "3.7.1" }]);
  });

  it("corrects a copy that is really another bundled version", async () => {
    bodies[url] = JQ364;
    const m = make();
    await m.verify({ url, type: "script" });
    const [r] = env.state.dynamic;
    expect(r.action).toEqual({ type: "redirect", redirect: { extensionPath: "/libs/jquery/3.6.4/dist/jquery.min.js" } });
    expect(r.priority).toBeGreaterThan(PRIORITY.byname);
  });

  it("rolls back a guess whose bytes are not a bundled file", async () => {
    bodies[url] = "jquery 3.7.1 with a site patch";
    const m = make();
    await m.verify({ url, type: "script" });
    const [r] = env.state.dynamic;
    expect(r.id).toBeGreaterThanOrEqual(REJECT_ID_BASE);
    expect(r.action).toEqual({ type: "allow" });
    expect(r.priority).toBeGreaterThan(PRIORITY.byname);
    expect(r.priority).toBeLessThan(PRIORITY.catchAll);
    expect(r.condition).toMatchObject({ urlFilter: "||shop.example/js/jquery-3.7.1.min.js^", resourceTypes: ["script"] });
    expect(await m.getRejected()).toMatchObject([{ url, type: "script" }]);
  });

  it("does not download a rejected file again, also when the page loads it from the network", async () => {
    bodies[url] = "patched";
    const m = make();
    await m.verify({ url, type: "script" });
    await m.verify({ url, type: "script" });
    await m.consider({ url, type: "script" });
    expect(fetched).toEqual([url]);
  });

  it("gives a rejected url another chance after a month", async () => {
    bodies[url] = "patched";
    const m = make();
    await m.verify({ url, type: "script" });
    now += 31 * 24 * 3600 * 1000;
    await m.prune();
    expect(env.state.dynamic).toEqual([]);
    expect(await m.getRejected()).toEqual([]);
  });

  it("keeps the guess when the file cannot be downloaded, and does not retry at once", async () => {
    const m = make();
    await m.verify({ url, type: "script" });
    await m.verify({ url, type: "script" });
    expect(fetched).toEqual([url]);
    expect(env.state.dynamic).toEqual([]);
  });

  it("lets the worker's own downloads past matched redirects", async () => {
    bodies[url] = JQ;
    await make().verify({ url, type: "script" });
    expect(env.state.dynamic[0].condition.excludedInitiatorDomains).toEqual(["fakeextensionid"]);
  });
});
