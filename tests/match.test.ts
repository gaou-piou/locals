import { beforeEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { applyLearned } from "../src/background/learned.ts";
import { buildIndex, createMatcher, looksLikeLibrary, MATCH_ID_BASE, matchRules } from "../src/background/match.ts";
import type { LibraryEntry } from "../src/shared/manifest-schema.ts";
import { installFakeChrome } from "./fake-chrome.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const JQ = "/*jquery 3.7.1*/";
const libs: LibraryEntry[] = [
  {
    name: "jquery",
    npm: "jquery",
    license: "MIT",
    versions: [{ version: "3.7.1", files: [{ path: "dist/jquery.min.js", type: "script", sha256: sha(JQ) }] }],
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

  it("expires a match so a changed file is noticed, then re-verifies it on the next load", async () => {
    const url = "https://shop.example/js/jquery.min.js";
    bodies[url] = JQ;
    const m = make({ ttlMs: 1000 });
    await m.consider({ url, type: "script" });
    now += 2000;
    await m.prune();
    expect(env.state.dynamic).toEqual([]);
    bodies[url] = "changed";
    await m.consider({ url, type: "script" });
    expect(env.state.dynamic).toEqual([]);
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
