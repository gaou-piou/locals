import { beforeEach, describe, expect, it } from "vitest";
import { applyRulesets, DEFAULT_SETTINGS, getSettings, migrate, restoreSettings, setSettings } from "../src/background/settings.ts";
import { installFakeChrome } from "./fake-chrome.ts";

let env: ReturnType<typeof installFakeChrome>;
beforeEach(() => {
  env = installFakeChrome();
});

describe("migrate", () => {
  it("upgrades an unversioned stored object and normalises sites", () => {
    expect(migrate({ enabled: false, disabledSites: ["Example.com ", "https://foo.org/x?y", "example.com", "bad host!"] })).toEqual({
      schema: 1,
      enabled: false,
      substitute: false,
      byname: true,
      autoCache: true,
      disabledSites: ["example.com", "foo.org"],
      allowedSites: [],
    });
  });

  it.each([["garbage"], [null], [42], [[]], [undefined]])("returns defaults for %j", (raw) => {
    expect(migrate(raw)).toEqual(DEFAULT_SETTINGS);
  });

  it("falls back per key on wrongly typed values", () => {
    expect(migrate({ enabled: "yes", substitute: true, disabledSites: "a.com", allowedSites: [1, "b.com"] })).toEqual({
      schema: 1,
      enabled: true,
      substitute: true,
      byname: true,
      autoCache: true,
      disabledSites: [],
      allowedSites: ["b.com"],
    });
  });

  it("is idempotent on current-schema data", () => {
    const s = { schema: 1 as const, enabled: true, substitute: true, byname: false, autoCache: false, disabledSites: ["a.com"], allowedSites: ["b.com"] };
    expect(migrate(s)).toEqual(s);
  });

  it("keeps known keys from a newer schema instead of dropping the user's lists", () => {
    expect(migrate({ schema: 99, disabledSites: ["a.com"], extra: 1 }).disabledSites).toEqual(["a.com"]);
  });
});

describe("applyRulesets", () => {
  const s = (enabled: boolean, substitute: boolean) => ({ ...DEFAULT_SETTINGS, enabled, substitute, byname: false });
  it.each([
    [true, false, ["exact"]],
    [true, true, ["exact", "substitute"]],
    [false, true, []],
    [false, false, []],
  ])("enabled=%s substitute=%s → %j", async (enabled, substitute, expected) => {
    env.state.enabled = new Set(["exact", "substitute"]);
    await applyRulesets(s(enabled, substitute));
    expect([...env.state.enabled].sort()).toEqual([...expected].sort());
  });
});

describe("byname", () => {
  it("is on by default and survives migration", () => {
    expect(DEFAULT_SETTINGS.byname).toBe(true);
    expect(migrate({ byname: false }).byname).toBe(false);
    expect(migrate({ byname: "no" }).byname).toBe(true);
  });

  it.each([
    [true, true, ["exact", "byname"]],
    [true, false, ["exact"]],
    [false, true, []],
  ])("enabled=%s byname=%s → %j", async (enabled, byname, expected) => {
    env.state.enabled = new Set(["exact", "byname"]);
    await applyRulesets({ ...DEFAULT_SETTINGS, enabled, byname });
    expect([...env.state.enabled].sort()).toEqual([...expected].sort());
  });
});

describe("autoCache", () => {
  it("is on by default and survives migration", () => {
    expect(DEFAULT_SETTINGS.autoCache).toBe(true);
    expect(migrate({ autoCache: false }).autoCache).toBe(false);
    expect(migrate({ autoCache: 0 }).autoCache).toBe(true);
  });
});

describe("getSettings / setSettings", () => {
  it("returns defaults when storage is empty", async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("migrates what is stored", async () => {
    env.local.settings = { enabled: false };
    expect((await getSettings()).enabled).toBe(false);
  });

  it("persists, normalises and applies rulesets and exceptions", async () => {
    await setSettings({ substitute: true, disabledSites: ["Example.com", "example.com"], allowedSites: ["ok.org"] });
    expect(env.local.settings).toEqual({
      schema: 1,
      enabled: true,
      substitute: true,
      byname: true,
      autoCache: true,
      disabledSites: ["example.com"],
      allowedSites: ["ok.org"],
    });
    expect([...env.state.enabled].sort()).toEqual(["byname", "exact", "substitute"]);
    expect(env.state.dynamic.length).toBeGreaterThan(0);
  });

  it("a later patch keeps earlier values", async () => {
    await setSettings({ disabledSites: ["a.com"] });
    await setSettings({ enabled: false });
    expect(await getSettings()).toMatchObject({ enabled: false, disabledSites: ["a.com"] });
  });
});

describe("restoreSettings", () => {
  it("does not clobber a set-settings that races with it (install-time init vs. first message)", async () => {
    const env = installFakeChrome();
    await Promise.all([restoreSettings(), setSettings({ disabledSites: ["a.com"] })]);
    expect((await getSettings()).disabledSites).toEqual(["a.com"]);
    expect(env.state.dynamic.map((r) => r.condition.requestDomains)).toEqual([["a.com"]]);
  });
});
