import { beforeEach, describe, expect, it } from "vitest";
import { applyExceptions } from "../src/background/exceptions.ts";
import { PRIORITY } from "../src/shared/priorities.ts";
import { installFakeChrome } from "./fake-chrome.ts";

let env: ReturnType<typeof installFakeChrome>;
beforeEach(() => {
  env = installFakeChrome();
});
const FRAMES = ["main_frame", "sub_frame"];

describe("applyExceptions", () => {
  it("adds one allowAllRequests rule per disabled site, above every redirect rule", async () => {
    await applyExceptions({ disabledSites: ["example.com"], allowedSites: [] });
    expect(env.state.dynamic).toHaveLength(1);
    const [r] = env.state.dynamic;
    expect(r.action).toEqual({ type: "allowAllRequests" });
    expect(r.condition).toEqual({ requestDomains: ["example.com"], resourceTypes: FRAMES });
    expect(r.priority).toBe(PRIORITY.deny);
    expect(r.priority).toBeGreaterThan(PRIORITY.exact);
  });

  it("removes stale rules", async () => {
    await applyExceptions({ disabledSites: ["a.com", "b.com"], allowedSites: [] });
    await applyExceptions({ disabledSites: ["b.com"], allowedSites: [] });
    expect(env.state.dynamic.map((r) => r.condition.requestDomains)).toEqual([["b.com"]]);
    await applyExceptions({ disabledSites: [], allowedSites: [] });
    expect(env.state.dynamic).toEqual([]);
  });

  it("allow-list mode: one catch-all exemption that excludes the listed sites", async () => {
    await applyExceptions({ disabledSites: [], allowedSites: ["ok.org", "fine.net"] });
    expect(env.state.dynamic).toHaveLength(1);
    const [r] = env.state.dynamic;
    expect(r.priority).toBe(PRIORITY.catchAll);
    expect(r.action).toEqual({ type: "allowAllRequests" });
    expect(r.condition).toEqual({ excludedRequestDomains: ["ok.org", "fine.net"], resourceTypes: FRAMES });
  });

  it("orders priorities: data: copies < their gate < extension redirects < catch-all < deny", () => {
    expect(PRIORITY.cached).toBeLessThan(PRIORITY.gate);
    expect(PRIORITY.gate).toBeLessThan(PRIORITY.byname);
    expect(PRIORITY.gate).toBeLessThan(PRIORITY.substitute);
    expect(PRIORITY.byname).toBeLessThan(PRIORITY.exact);
    expect(PRIORITY.exact).toBeLessThan(PRIORITY.catchAll);
    expect(PRIORITY.catchAll).toBeLessThan(PRIORITY.deny);
  });

  it("a site in both lists is still exempted (deny wins)", async () => {
    await applyExceptions({ disabledSites: ["x.com"], allowedSites: ["x.com"] });
    const deny = env.state.dynamic.find((r) => r.priority === PRIORITY.deny)!;
    expect(deny.condition.requestDomains).toEqual(["x.com"]);
  });

  it("uses unique positive integer ids that are stable across calls", async () => {
    const lists = { disabledSites: ["a.com", "b.com", "c.com"], allowedSites: ["d.com", "e.com"] };
    await applyExceptions(lists);
    const first = env.state.dynamic.map((r) => r.id);
    await applyExceptions(lists);
    expect(env.state.dynamic.map((r) => r.id)).toEqual(first);
    expect(new Set(first).size).toBe(first.length);
    expect(first.every((id) => Number.isInteger(id) && id > 0)).toBe(true);
  });

  it("with the extension switched off, one deny-priority rule exempts every frame so dynamic redirects stop too", async () => {
    await applyExceptions({ enabled: false, disabledSites: [], allowedSites: [] });
    expect(env.state.dynamic).toHaveLength(1);
    const [r] = env.state.dynamic;
    expect(r.action).toEqual({ type: "allowAllRequests" });
    expect(r.priority).toBe(PRIORITY.deny);
    expect(r.condition).toEqual({ resourceTypes: FRAMES });
  });

  it("switching back on removes the exempt-all rule", async () => {
    await applyExceptions({ enabled: false, disabledSites: [], allowedSites: [] });
    await applyExceptions({ enabled: true, disabledSites: [], allowedSites: [] });
    expect(env.state.dynamic).toEqual([]);
  });
});
