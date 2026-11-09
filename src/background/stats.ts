import * as v from "valibot";
import { ENTRY_ID_BASE } from "./cache.ts";
import { LEARNED_ID_BASE } from "./learned.ts";
import { MATCH_ID_BASE, REJECT_ID_BASE } from "./match.ts";

export type StatsRange = "day" | "week" | "month" | "year";
export type StatsResult = { total: number; byLibrary: Record<string, number> };
/** Where a served request came from: a copy bundled or learned ahead of time, or a self-hosted copy detected by hash. */
export type MatchSource = "saved" | "detected";
export type TabCount = Record<MatchSource, number>;

const STATS_KEY = "stats";
const TAB_KEY = "tabCounts";
const RANGE_DAYS: Record<StatsRange, number> = { day: 1, week: 7, month: 30, year: 365 };
const KEEP_DAYS = 366;

const count = v.fallback(v.number(), 0);
/** Stored per-tab counts; a bare number predates the split, when every served request came from a saved copy. */
const StoredTabCountsSchema = v.fallback(
  v.record(
    v.string(),
    v.fallback(
      v.union([
        v.pipe(v.number(), v.transform((saved): TabCount => ({ saved, detected: 0 }))),
        v.object({ saved: v.optional(count, 0), detected: v.optional(count, 0) }),
      ]),
      () => ({ saved: 0, detected: 0 }),
    ),
  ),
  () => ({}),
);

type Buckets = Record<string, Record<string, number>>; // day → ruleId → count

export const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const keyDaysBefore = (now: Date, n: number): string => dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, 12));

export function createStats(deps: {
  now?: () => Date;
  loadIndex: () => Promise<Record<number, string>>;
  flushDelayMs?: number;
  /** Called on every change of a tab's counts (the badge). */
  onTabCount?: (tabId: number, count: TabCount) => void;
}) {
  const now = deps.now ?? (() => new Date());
  const delay = deps.flushDelayMs ?? 5_000;

  let pending: Buckets = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<void> = Promise.resolve();
  const tabs = new Map<number, TabCount>();
  const zero = (): TabCount => ({ saved: 0, detected: 0 });
  const hydrated = chrome.storage.session.get(TAB_KEY).then((s) => {
    for (const [k, stored] of Object.entries(v.parse(StoredTabCountsSchema, s[TAB_KEY]))) {
      const t = tabs.get(Number(k)) ?? zero();
      tabs.set(Number(k), { saved: t.saved + stored.saved, detected: t.detected + stored.detected });
    }
  });
  let index: Promise<Record<number, string>> | undefined;

  const add = (into: Buckets, day: string, ruleId: number | string, n = 1) => {
    const d = (into[day] ??= {});
    d[ruleId] = (d[ruleId] ?? 0) + n;
  };

  async function doFlush(): Promise<void> {
    await hydrated;
    await chrome.storage.session.set({ [TAB_KEY]: Object.fromEntries(tabs) });
    const batch = pending;
    pending = {};
    if (!Object.keys(batch).length) return;
    try {
      const stored = ((await chrome.storage.local.get(STATS_KEY))[STATS_KEY] ?? {}) as Buckets;
      for (const [day, rules] of Object.entries(batch)) for (const [id, n] of Object.entries(rules)) add(stored, day, id, n);
      const cutoff = keyDaysBefore(now(), KEEP_DAYS);
      for (const day of Object.keys(stored)) if (day < cutoff) delete stored[day];
      await chrome.storage.local.set({ [STATS_KEY]: stored });
    } catch (err) {
      for (const [day, rules] of Object.entries(batch)) for (const [id, n] of Object.entries(rules)) add(pending, day, id, n);
      throw err;
    }
  }

  const flush = (): Promise<void> => {
    clearTimeout(timer);
    timer = undefined;
    const run = queue.then(doFlush);
    queue = run.catch(() => {});
    return run;
  };

  return {
    recordMatch(ruleId: number, day: string, tabId?: number, source: MatchSource = "saved"): void {
      add(pending, day, ruleId);
      if (tabId !== undefined && tabId >= 0) {
        const t = { ...(tabs.get(tabId) ?? zero()) };
        t[source]++;
        tabs.set(tabId, t);
        deps.onTabCount?.(tabId, { ...t });
      }
      timer ??= setTimeout(() => void flush().catch(() => {}), delay);
    },

    flush,

    async getStats(range: StatsRange): Promise<StatsResult> {
      const stored = ((await chrome.storage.local.get(STATS_KEY))[STATS_KEY] ?? {}) as Buckets;
      const merged: Buckets = {};
      for (const src of [stored, pending]) {
        for (const [day, rules] of Object.entries(src)) for (const [id, n] of Object.entries(rules)) add(merged, day, id, n);
      }
      const from = keyDaysBefore(now(), RANGE_DAYS[range] - 1);
      const to = dayKey(now());
      index ??= deps.loadIndex();
      const idx = await index;
      const out: StatsResult = { total: 0, byLibrary: {} };
      for (const [day, rules] of Object.entries(merged)) {
        if (day < from || day > to) continue;
        for (const [id, n] of Object.entries(rules)) {
          out.total += n;
          const rule = Number(id);
          const lib = idx[rule] ?? (rule >= ENTRY_ID_BASE ? "cached" : rule >= MATCH_ID_BASE ? "detected" : rule >= LEARNED_ID_BASE ? "learned" : "unknown");
          out.byLibrary[lib] = (out.byLibrary[lib] ?? 0) + n;
        }
      }
      return out;
    },

    async getTabCount(tabId: number): Promise<TabCount> {
      await hydrated;
      return { ...(tabs.get(tabId) ?? zero()) };
    },

    resetTab(tabId: number): void {
      tabs.delete(tabId);
      deps.onTabCount?.(tabId, zero());
      void hydrated.then(() => tabs.delete(tabId)); // a late hydration must not resurrect the old count
    },
  };
}

export type Stats = ReturnType<typeof createStats>;

/**
 * Static redirect rulesets, learned/matched redirects (dynamic, ids from LEARNED_ID_BASE) and auto-cache copies (from
 * ENTRY_ID_BASE) serve a library; site-exception rules, rejected byname guesses (allow rules from REJECT_ID_BASE) and
 * the auto-cache gate do not.
 */
export const isLibraryMatch = (rule: { rulesetId: string; ruleId?: number }): boolean => {
  if (rule.rulesetId !== "_dynamic") return rule.rulesetId === "exact" || rule.rulesetId === "substitute" || rule.rulesetId === "byname";
  const id = rule.ruleId ?? 0;
  return (id >= LEARNED_ID_BASE && id < REJECT_ID_BASE) || id >= ENTRY_ID_BASE;
};

/** Static rulesets and learned redirects serve saved copies; matched redirects serve hash-detected self-hosted copies. */
export const matchSource = (rule: { rulesetId: string; ruleId?: number }): MatchSource =>
  rule.rulesetId === "_dynamic" && (rule.ruleId ?? 0) >= MATCH_ID_BASE && (rule.ruleId ?? 0) < REJECT_ID_BASE ? "detected" : "saved";
