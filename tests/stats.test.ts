import { beforeEach, describe, expect, it } from "vitest";
import { createStats, dayKey, isLibraryMatch, matchSource } from "../src/background/stats.ts";
import { installFakeChrome } from "./fake-chrome.ts";
import { ENTRY_ID_BASE, GATE_ID_BASE } from "../src/background/cache.ts";

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
    expect(await s.getTabCount(7)).toEqual({ saved: 2, detected: 0 });
    s.resetTab(7);
    expect(await s.getTabCount(7)).toEqual({ saved: 0, detected: 0 });
    expect(await s.getTabCount(8)).toEqual({ saved: 1, detected: 0 });
  });

  it("splits per-tab counts into saved copies and detected self-hosted copies", async () => {
    const s = make();
    s.recordMatch(1, daysAgo(0), 7, "saved");
    s.recordMatch(300_001, daysAgo(0), 7, "detected");
    s.recordMatch(300_002, daysAgo(0), 7, "detected");
    expect(await s.getTabCount(7)).toEqual({ saved: 1, detected: 2 });
  });

  it("per-tab counts survive a restarted worker", async () => {
    const a = make();
    a.recordMatch(1, daysAgo(0), 7, "saved");
    a.recordMatch(300_001, daysAgo(0), 7, "detected");
    await a.flush();
    const b = make();
    b.recordMatch(1, daysAgo(0), 7, "saved");
    expect(await b.getTabCount(7)).toEqual({ saved: 2, detected: 1 });
  });

  it("reports every change of a tab's counts, including a reset", async () => {
    const seen: Array<[number, { saved: number; detected: number }]> = [];
    const s = createStats({ now: () => now, loadIndex: async () => index, flushDelayMs: 0, onTabCount: (tab, c) => seen.push([tab, c]) });
    s.recordMatch(1, daysAgo(0), 7, "saved");
    s.recordMatch(300_001, daysAgo(0), 7, "detected");
    s.recordMatch(1, daysAgo(0)); // no tab: nothing to report
    s.resetTab(7);
    await s.flush();
    expect(seen).toEqual([
      [7, { saved: 1, detected: 0 }],
      [7, { saved: 1, detected: 1 }],
      [7, { saved: 0, detected: 0 }],
    ]);
  });

  it("matchSource: hash-detected redirects are \"detected\", every other redirect is a saved copy", () => {
    expect(matchSource({ rulesetId: "exact", ruleId: 300_001 })).toBe("saved"); // static ids are hashes: the ruleset decides
    expect(matchSource({ rulesetId: "byname", ruleId: 1 })).toBe("saved");
    expect(matchSource({ rulesetId: "_dynamic", ruleId: 200_003 })).toBe("saved"); // learned
    expect(matchSource({ rulesetId: "_dynamic", ruleId: 300_001 })).toBe("detected");
  });

  it("only matches of the static redirect rulesets count; site-exception rules do not", () => {
    expect(isLibraryMatch({ rulesetId: "exact" })).toBe(true);
    expect(isLibraryMatch({ rulesetId: "substitute" })).toBe(true);
    expect(isLibraryMatch({ rulesetId: "byname" })).toBe(true);
    expect(isLibraryMatch({ rulesetId: "_dynamic", ruleId: 300_001 })).toBe(true); // matched redirect
    expect(isLibraryMatch({ rulesetId: "_dynamic", ruleId: 400_001 })).toBe(false); // rejected byname guess: an allow rule
    expect(isLibraryMatch({ rulesetId: "_dynamic", ruleId: 5 })).toBe(false);
    expect(isLibraryMatch({ rulesetId: "_session" })).toBe(false);
  });

  it("learned redirects (dynamic rules from LEARNED_ID_BASE) count too, listed as \"learned\"", async () => {
    expect(isLibraryMatch({ rulesetId: "_dynamic", ruleId: 200_000 })).toBe(true);
    const s = createStats({ loadIndex: async () => ({}), flushDelayMs: 1 });
    s.recordMatch(200_003, dayKey(new Date()), 4);
    expect((await s.getStats("day")).byLibrary).toEqual({ learned: 1 });
    expect(await s.getTabCount(4)).toEqual({ saved: 1, detected: 0 });
  });

  it("auto-cache data: copies count as saved and are listed as \"cached\"; their gate rules do not count", async () => {
    expect(isLibraryMatch({ rulesetId: "_dynamic", ruleId: ENTRY_ID_BASE + 4 })).toBe(true);
    expect(isLibraryMatch({ rulesetId: "_dynamic", ruleId: GATE_ID_BASE + 1 })).toBe(false);
    expect(matchSource({ rulesetId: "_dynamic", ruleId: ENTRY_ID_BASE + 4 })).toBe("saved");
    const s = createStats({ loadIndex: async () => ({}), flushDelayMs: 1 });
    s.recordMatch(ENTRY_ID_BASE + 4, dayKey(new Date()), 4);
    expect((await s.getStats("day")).byLibrary).toEqual({ cached: 1 });
  });

  it("matches of hash-detected self-hosted copies are listed as \"detected\"", async () => {
    expect(isLibraryMatch({ rulesetId: "_dynamic", ruleId: 300_000 })).toBe(true);
    const s = createStats({ loadIndex: async () => ({}), flushDelayMs: 1 });
    s.recordMatch(300_001, dayKey(new Date()));
    expect((await s.getStats("day")).byLibrary).toEqual({ detected: 1 });
  });
});
