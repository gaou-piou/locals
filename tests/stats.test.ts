import { beforeEach, describe, expect, it } from "vitest";
import { createStats, dayKey, isLibraryMatch } from "../src/background/stats.ts";
import { installFakeChrome } from "./fake-chrome.ts";

const index = { 1: "jquery", 2: "jquery", 3: "react" };
const NOW = new Date(2026, 10, 2, 12); // 2026-11-02 local
let env: ReturnType<typeof installFakeChrome>;
let now = NOW;
const make = () => createStats({ now: () => now, loadIndex: async () => index, flushDelayMs: 0 });
beforeEach(() => {
  env = installFakeChrome();
  now = NOW;
});
const daysAgo = (n: number) => dayKey(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - n, 12));

describe("stats", () => {
  it("dayKey is YYYY-MM-DD in local time", () => {
    expect(dayKey(NOW)).toBe("2026-11-02");
  });

  it("getStats('day') counts only today and maps rule ids to libraries", async () => {
    const s = make();
    s.recordMatch(1, daysAgo(0));
    s.recordMatch(2, daysAgo(0));
    s.recordMatch(3, daysAgo(0));
    s.recordMatch(1, daysAgo(1));
    await s.flush();
    expect(await s.getStats("day")).toEqual({ total: 3, byLibrary: { jquery: 2, react: 1 } });
  });

  it("includes counts that have not been flushed yet", async () => {
    const s = make();
    s.recordMatch(1, daysAgo(0));
    expect((await s.getStats("day")).total).toBe(1);
  });

  it("week = last 7 days, month = 30, year = 365 (inclusive of today)", async () => {
    const s = make();
    for (const n of [0, 6, 7, 29, 30, 364, 365]) s.recordMatch(1, daysAgo(n));
    await s.flush();
    expect((await s.getStats("day")).total).toBe(1);
    expect((await s.getStats("week")).total).toBe(2);
    expect((await s.getStats("month")).total).toBe(4);
    expect((await s.getStats("year")).total).toBe(6);
  });

  it("buckets per day and prunes days older than 366 days on flush", async () => {
    const s = make();
    s.recordMatch(1, daysAgo(400));
    s.recordMatch(1, daysAgo(366));
    s.recordMatch(1, daysAgo(0));
    await s.flush();
    expect(Object.keys(env.local.stats as object).sort()).toEqual([daysAgo(366), daysAgo(0)].sort());
  });

  it("loses no counts across two batches", async () => {
    const s = make();
    s.recordMatch(1, daysAgo(0));
    await s.flush();
    s.recordMatch(1, daysAgo(0));
    s.recordMatch(1, daysAgo(0));
    await s.flush();
    expect((await s.getStats("day")).total).toBe(3);
  });

  it("loses no counts when a record arrives during a flush", async () => {
    const s = make();
    s.recordMatch(1, daysAgo(0));
    const flushing = s.flush();
    s.recordMatch(1, daysAgo(0));
    await flushing;
    await s.flush();
    expect((await s.getStats("day")).total).toBe(2);
  });

  it("two instances (a restarted worker) accumulate into the same storage", async () => {
    const a = make();
    a.recordMatch(1, daysAgo(0));
    await a.flush();
    const b = make();
    b.recordMatch(3, daysAgo(0));
    await b.flush();
    expect(await b.getStats("day")).toEqual({ total: 2, byLibrary: { jquery: 1, react: 1 } });
  });

  it("tracks per-tab counts", async () => {
    const s = make();
    s.recordMatch(1, daysAgo(0), 7);
    s.recordMatch(1, daysAgo(0), 7);
    s.recordMatch(1, daysAgo(0), 8);
    expect(await s.getTabCount(7)).toBe(2);
    s.resetTab(7);
    expect(await s.getTabCount(7)).toBe(0);
    expect(await s.getTabCount(8)).toBe(1);
  });

  it("only matches of the static redirect rulesets count; site-exception rules do not", () => {
    expect(isLibraryMatch({ rulesetId: "exact" })).toBe(true);
    expect(isLibraryMatch({ rulesetId: "substitute" })).toBe(true);
    expect(isLibraryMatch({ rulesetId: "_dynamic" })).toBe(false);
    expect(isLibraryMatch({ rulesetId: "_session" })).toBe(false);
  });
});
