import { describe, expect, it } from "vitest";
import { filterLibraries, parseConfig, serializeConfig, siteEnabled, toggleSitePatch } from "../src/lib/config.ts";
import { DEFAULT_SETTINGS, type Settings } from "../src/background/settings.ts";

const S = (over: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...over });

describe("parseConfig", () => {
  it("round-trips an export", () => {
    const s = S({ enabled: false, substitute: true, autoCache: false, disabledSites: ["a.com"], allowedSites: ["b.org"] });
    expect(parseConfig(serializeConfig(s))).toEqual(s);
  });

  it("migrates a schema-0 (unversioned) export and normalises its sites", () => {
    expect(parseConfig('{"enabled":false,"disabledSites":["HTTPS://Foo.org/x","foo.org"]}')).toEqual(
      S({ enabled: false, disabledSites: ["foo.org"] }),
    );
    expect(parseConfig('{"schema":0,"substitute":true}')).toEqual(S({ substitute: true }));
  });

  it.each([["not json"], ["[]"], ["null"], ['"str"'], ["42"], [""]])("rejects malformed input %j", (raw) => {
    expect(() => parseConfig(raw)).toThrow(/invalid/i);
  });

  it("rejects unknown keys, wrong types and future schemas", () => {
    expect(() => parseConfig('{"evil":1}')).toThrow(/invalid/i);
    expect(() => parseConfig('{"enabled":"yes"}')).toThrow(/invalid/i);
    expect(() => parseConfig('{"disabledSites":[1]}')).toThrow(/invalid/i);
    expect(() => parseConfig('{"schema":2}')).toThrow(/invalid/i);
  });

  it("rejects a host entry that is not a hostname instead of silently dropping it", () => {
    expect(() => parseConfig('{"disabledSites":["bad host!"]}')).toThrow(/invalid/i);
  });
});

describe("site toggling", () => {
  it("a site is enabled unless disabled", () => {
    expect(siteEnabled(S(), "a.com")).toBe(true);
    expect(siteEnabled(S({ disabledSites: ["a.com"] }), "a.com")).toBe(false);
  });

  it("in allow-list mode only listed sites are enabled, and deny still wins", () => {
    const s = S({ allowedSites: ["ok.org"] });
    expect(siteEnabled(s, "ok.org")).toBe(true);
    expect(siteEnabled(s, "other.org")).toBe(false);
    expect(siteEnabled({ ...s, disabledSites: ["ok.org"] }, "ok.org")).toBe(false);
  });

  it("disabling adds to the deny list and leaves the allow list", () => {
    expect(toggleSitePatch(S({ allowedSites: ["a.com"] }), "a.com", false)).toEqual({ disabledSites: ["a.com"], allowedSites: ["a.com"] });
  });

  it("enabling removes from deny and, in allow-list mode, adds to the allow list", () => {
    expect(toggleSitePatch(S({ disabledSites: ["a.com"] }), "a.com", true)).toEqual({ disabledSites: [], allowedSites: [] });
    expect(toggleSitePatch(S({ disabledSites: ["a.com"], allowedSites: ["z.com"] }), "a.com", true)).toEqual({
      disabledSites: [],
      allowedSites: ["z.com", "a.com"],
    });
  });

  it("is idempotent", () => {
    const once = toggleSitePatch(S(), "a.com", false);
    expect(toggleSitePatch(S(once), "a.com", false)).toEqual(once);
  });
});

describe("filterLibraries", () => {
  const libs = [
    { name: "jquery", npm: "jquery", license: "MIT", versions: [], patterns: [] },
    { name: "bootstrap", npm: "bootstrap", license: "MIT", versions: [], patterns: [] },
  ];
  it("matches name case-insensitively and keeps order; empty query keeps all", () => {
    expect(filterLibraries(libs, " JQ ").map((l) => l.name)).toEqual(["jquery"]);
    expect(filterLibraries(libs, "").length).toBe(2);
    expect(filterLibraries(libs, "zzz")).toEqual([]);
  });
});

describe("site toggling follows Chrome's domain matching (subdomains included)", () => {
  it("a denied parent domain disables its subdomains", () => {
    expect(siteEnabled(S({ disabledSites: ["example.com"] }), "www.example.com")).toBe(false);
    expect(siteEnabled(S({ disabledSites: ["example.com"] }), "notexample.com")).toBe(true);
  });

  it("an allowed parent domain enables its subdomains", () => {
    const s = S({ allowedSites: ["example.com"] });
    expect(siteEnabled(s, "www.example.com")).toBe(true);
    expect(siteEnabled(s, "badexample.com")).toBe(false);
  });

  it("enabling a subdomain removes the denied parent entry that disabled it", () => {
    const s = S({ disabledSites: ["example.com", "other.org"] });
    const patch = toggleSitePatch(s, "www.example.com", true);
    expect(patch.disabledSites).toEqual(["other.org"]);
    expect(siteEnabled(S(patch), "www.example.com")).toBe(true);
  });

  it("disabling a site already disabled through its parent changes nothing", () => {
    const s = S({ disabledSites: ["example.com"] });
    expect(toggleSitePatch(s, "www.example.com", false)).toEqual({ disabledSites: ["example.com"], allowedSites: [] });
  });

  it("enabling in allow-list mode does not duplicate a subdomain of an allowed entry", () => {
    const s = S({ allowedSites: ["example.com"] });
    expect(toggleSitePatch(s, "www.example.com", true).allowedSites).toEqual(["example.com"]);
  });
});

