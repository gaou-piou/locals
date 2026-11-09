import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXTENSION_KEY } from "../src/manifest.ts";
import {
  extensionIdFromKey,
  generateRules,
  generateWar,
  RULE_LIMITS,
  urlFilterFor,
} from "../scripts/rules.ts";
import { parseManifest, type LibraryEntry } from "../src/shared/manifest-schema.ts";
import { PRIORITY } from "../src/shared/priorities.ts";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const H3 = "3".repeat(64);

const jq = (over: Partial<LibraryEntry> = {}): LibraryEntry => ({
  name: "jquery",
  npm: "jquery",
  license: "MIT",
  versions: [
    { version: "3.6.4", files: [{ path: "dist/jquery.min.js", type: "script", sha256: H1 }] },
    { version: "3.7.1", files: [{ path: "dist/jquery.min.js", type: "script", sha256: H2 }] },
  ],
  patterns: [
    {
      url: "https://cdnjs.cloudflare.com/ajax/libs/jquery/{version}/jquery.min.js",
      file: "dist/jquery.min.js",
      cdnSha256: { "3.6.4": H1, "3.7.1": H2 },
    },
  ],
  ...over,
});

describe("urlFilterFor", () => {
  it("uses the ||host/path^ form", () => {
    expect(urlFilterFor("https://cdnjs.cloudflare.com/ajax/libs/jquery/{version}/jquery.min.js", "3.7.1")).toBe(
      "||cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js^",
    );
  });
});

describe("generateRules exact", () => {
  it("emits one redirect per pinned version of a pattern", () => {
    const { rules, index } = generateRules([jq()], "exact");
    expect(rules).toHaveLength(2);
    const r = rules.find((x) => x.condition.urlFilter?.includes("/3.7.1/"))!;
    expect(r.action).toEqual({ type: "redirect", redirect: { extensionPath: "/libs/jquery/3.7.1/dist/jquery.min.js" } });
    expect(r.condition.resourceTypes).toEqual(["script"]);
    expect(index[r.id]).toBe("jquery");
  });

  it("emits no rule when cdnSha256 is missing for the version", () => {
    const e = jq();
    delete e.patterns[0].cdnSha256;
    expect(generateRules([e], "exact").rules).toEqual([]);
  });

  it("emits no rule for a version whose cdnSha256 differs from the bundled bytes", () => {
    const e = jq();
    e.patterns[0].cdnSha256 = { "3.6.4": H3, "3.7.1": H2 };
    const { rules } = generateRules([e], "exact");
    expect(rules).toHaveLength(1);
    expect(rules[0].condition.urlFilter).toContain("/3.7.1/");
  });

  it("maps font and stylesheet files to their resource types", () => {
    const e = jq({
      name: "fa",
      versions: [
        {
          version: "6.5.2",
          files: [
            { path: "css/all.min.css", type: "stylesheet", sha256: H1 },
            { path: "webfonts/a.woff2", type: "font", sha256: H2 },
          ],
        },
      ],
      patterns: [
        { url: "https://cdn.example/fa/{version}/css/all.min.css", file: "css/all.min.css", cdnSha256: { "6.5.2": H1 } },
        { url: "https://cdn.example/fa/{version}/webfonts/a.woff2", file: "webfonts/a.woff2", cdnSha256: { "6.5.2": H2 } },
      ],
    });
    const types = generateRules([e], "exact").rules.map((r) => r.condition.resourceTypes);
    expect(types).toEqual([["stylesheet"], ["font"]]);
  });

  it("serves one bundled file for many CDN patterns", () => {
    const e = jq();
    e.patterns.push({
      url: "https://cdn.jsdelivr.net/npm/jquery@{version}/dist/jquery.min.js",
      file: "dist/jquery.min.js",
      cdnSha256: { "3.6.4": H1, "3.7.1": H2 },
    });
    const { rules } = generateRules([e], "exact");
    expect(rules).toHaveLength(4);
    const targets = new Set(rules.filter((r) => r.condition.urlFilter!.includes("3.7.1")).map((r) => (r.action.redirect as { extensionPath: string }).extensionPath));
    expect([...targets]).toEqual(["/libs/jquery/3.7.1/dist/jquery.min.js"]);
  });

  it("uses unique, positive 31-bit, stable ids", () => {
    const a = generateRules([jq()], "exact").rules.map((r) => r.id);
    const b = generateRules([jq()], "exact").rules.map((r) => r.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
    for (const id of a) {
      expect(Number.isInteger(id)).toBe(true);
      expect(id).toBeGreaterThan(0);
      expect(id).toBeLessThan(2 ** 31);
    }
  });

  it("throws on an id collision", () => {
    expect(() => generateRules([jq()], "exact", { hash: () => 7 })).toThrow(/collision/i);
  });

  it("stays below the static rule limit", () => {
    expect(generateRules([jq()], "exact").rules.length).toBeLessThan(RULE_LIMITS.staticRules);
  });
});

describe("generateRules substitute", () => {
  const id = extensionIdFromKey(EXTENSION_KEY);

  it("builds one same-major regex per (library, CDN, major) targeting the highest pinned version", () => {
    const { rules } = generateRules([jq()], "substitute");
    expect(rules).toHaveLength(1);
    const r = rules[0];
    expect(r.action.redirect?.regexSubstitution).toBe(`chrome-extension://${id}/libs/jquery/3.7.1/dist/jquery.min.js`);
    expect(r.condition.regexFilter).toBe(
      "^https?://cdnjs\\.cloudflare\\.com/ajax/libs/jquery/3\\.\\d+\\.\\d+/jquery\\.min\\.js(?:[?#].*)?$",
    );
  });

  it("matches other versions of the same major only", () => {
    const re = new RegExp(generateRules([jq()], "substitute").rules[0].condition.regexFilter!);
    const u = (v: string) => `https://cdnjs.cloudflare.com/ajax/libs/jquery/${v}/jquery.min.js`;
    expect(re.test(u("3.5.1"))).toBe(true);
    expect(re.test(u("3.7.1") + "?v=2")).toBe(true);
    expect(re.test(u("4.0.0"))).toBe(false);
    expect(re.test(u("2.2.4"))).toBe(false);
    expect(re.test(u("3.7.1") + ".map")).toBe(false);
  });

  it("makes one rule per major", () => {
    const e = jq();
    e.versions.push({ version: "2.2.4", files: [{ path: "dist/jquery.min.js", type: "script", sha256: H3 }] });
    e.patterns[0].cdnSha256 = { "3.6.4": H1, "3.7.1": H2, "2.2.4": H3 };
    const rules = generateRules([e], "substitute").rules;
    expect(rules.map((r) => r.action.redirect?.regexSubstitution).sort()).toEqual([
      `chrome-extension://${id}/libs/jquery/2.2.4/dist/jquery.min.js`,
      `chrome-extension://${id}/libs/jquery/3.7.1/dist/jquery.min.js`,
    ]);
  });

  it("skips patterns whose CDN bytes never match the bundled file", () => {
    const e = jq();
    e.patterns[0].cdnSha256 = { "3.6.4": H3, "3.7.1": H3 };
    expect(generateRules([e], "substitute").rules).toEqual([]);
  });

  it("has a lower priority than the exact ruleset and stays below the regex limit", () => {
    const sub = generateRules([jq()], "substitute").rules;
    const exact = generateRules([jq()], "exact").rules;
    expect(sub[0].priority!).toBeLessThan(exact[0].priority!);
    expect(sub.length).toBeLessThan(RULE_LIMITS.regexRules);
  });
});

describe("generateWar", () => {
  it("exposes every bundled file (scripts, stylesheets, fonts) and not LICENSE files", () => {
    const e = jq({
      versions: [
        {
          version: "1.0.0",
          files: [
            { path: "a.js", type: "script", sha256: H1 },
            { path: "a.css", type: "stylesheet", sha256: H1 },
            { path: "webfonts/a.woff2", type: "font", sha256: H1 },
          ],
        },
      ],
      patterns: [],
    });
    const [w] = generateWar([e]);
    expect(w.matches).toEqual(["*://*/*"]);
    expect(w.resources).toEqual(["libs/jquery/1.0.0/a.js", "libs/jquery/1.0.0/a.css", "libs/jquery/1.0.0/webfonts/a.woff2"]);
  });
});

describe("seed libraries.json", () => {
  const entries = parseManifest(JSON.parse(readFileSync(new URL("../libraries.json", import.meta.url), "utf8")));
  it("fits the rule limits", () => {
    expect(generateRules(entries, "exact").rules.length).toBeLessThan(RULE_LIMITS.staticRules);
    expect(generateRules(entries, "substitute").rules.length).toBeLessThan(RULE_LIMITS.regexRules);
  });
  it("does not redirect the vue cdnjs pattern (different bytes)", () => {
    const { rules } = generateRules(entries, "exact");
    expect(rules.some((r) => r.condition.urlFilter?.includes("vue.global.prod.min.js"))).toBe(false);
    expect(rules.some((r) => r.condition.urlFilter?.includes("jsdelivr.net/npm/vue@"))).toBe(true);
  });
});

describe("generateRules byname", () => {
  const withJsdelivr = () =>
    jq({
      patterns: [
        ...jq().patterns,
        { url: "https://cdn.jsdelivr.net/npm/jquery@{version}/dist/jquery.min.js", file: "dist/jquery.min.js", cdnSha256: { "3.7.1": H2 } },
        { url: "https://code.jquery.com/jquery-{version}.min.js", file: "dist/jquery.min.js", cdnSha256: { "3.7.1": H2 } },
      ],
    });
  const filters = (rules: chrome.declarativeNetRequest.Rule[]) => rules.map((r) => r.condition.urlFilter).sort();

  it("matches the CDN path shape on any other host, by name and version", () => {
    const { rules } = generateRules([withJsdelivr()], "byname");
    expect(filters(rules)).toEqual(
      expect.arrayContaining(["/jquery/3.7.1/jquery.min.js^", "/jquery@3.7.1/dist/jquery.min.js^", "/jquery-3.7.1.min.js^"]),
    );
    const r = rules.find((x) => x.condition.urlFilter === "/jquery@3.7.1/dist/jquery.min.js^")!;
    expect(r.action).toEqual({ type: "redirect", redirect: { extensionPath: "/libs/jquery/3.7.1/dist/jquery.min.js" } });
    expect(r.condition.resourceTypes).toEqual(["script"]);
  });

  it("matches WordPress-style ?ver= copies", () => {
    expect(filters(generateRules([jq()], "byname").rules)).toEqual(expect.arrayContaining(["/jquery.min.js?ver=3.7.1^"]));
  });

  it("leaves CDN hosts to the exact ruleset and lets the worker's own verification fetch through", () => {
    const { rules } = generateRules([withJsdelivr()], "byname");
    for (const r of rules) {
      expect(r.condition.excludedRequestDomains).toEqual(
        expect.arrayContaining(["cdnjs.cloudflare.com", "cdn.jsdelivr.net", "code.jquery.com"]),
      );
      expect(r.condition.excludedInitiatorDomains).toEqual([extensionIdFromKey(EXTENSION_KEY)]);
    }
  });

  it("emits one rule per distinct url filter", () => {
    const e = withJsdelivr();
    e.patterns.push({ url: "https://unpkg.com/jquery@{version}/dist/jquery.min.js", file: "dist/jquery.min.js", cdnSha256: { "3.7.1": H2 } });
    const { rules } = generateRules([e], "byname");
    expect(new Set(filters(rules)).size).toBe(rules.length);
  });

  it("skips path shapes whose CDN bytes differ from ours, and generic file names", () => {
    const e = jq({
      name: "font-awesome",
      versions: [{ version: "6.5.1", files: [{ path: "css/all.min.css", type: "stylesheet", sha256: H3 }] }],
      patterns: [{ url: "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/{version}/css/all.min.css", file: "css/all.min.css", cdnSha256: { "6.5.1": H1 } }],
    });
    expect(generateRules([e], "byname").rules).toEqual([]);
  });

  it("ranks below the exact ruleset", () => {
    for (const r of generateRules([withJsdelivr()], "byname").rules) expect(r.priority).toBeLessThan(PRIORITY.exact);
  });

  it("fits the static rule limit together with the other rulesets for the seed libraries", () => {
    const entries = parseManifest(JSON.parse(readFileSync(new URL("../libraries.json", import.meta.url), "utf8")));
    const total = (["exact", "substitute", "byname"] as const).reduce((n, m) => n + generateRules(entries, m).rules.length, 0);
    expect(total).toBeLessThan(RULE_LIMITS.staticRules);
  });
});
