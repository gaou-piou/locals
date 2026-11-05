import { LEARNED_ID_BASE } from "./learned.ts";

export type StatsRange = "day" | "week" | "month" | "year";
export type StatsResult = { total: number; byLibrary: Record<string, number> };

const STATS_KEY = "stats";
const TAB_KEY = "tabCounts";
const RANGE_DAYS: Record<StatsRange, number> = { day: 1, week: 7, month: 30, year: 365 };
const KEEP_DAYS = 366;

type Buckets = Record<string, Record<string, number>>; // day → ruleId → count

export const dayKey = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const keyDaysBefore = (now: Date, n: number): string => dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - n, 12));

export function createStats(deps: {
  now?: () => Date;
  loadIndex: () => Promise<Record<number, string>>;
  flushDelayMs?: number;
}) {
  const now = deps.now ?? (() => new Date());
  const delay = deps.flushDelayMs ?? 5_000;

  let pending: Buckets = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let queue: Promise<void> = Promise.resolve();
  const tabs = new Map<number, number>();
  const hydrated = chrome.storage.session.get(TAB_KEY).then((s) => {
    for (const [k, v] of Object.entries((s[TAB_KEY] ?? {}) as Record<string, number>)) tabs.set(Number(k), (tabs.get(Number(k)) ?? 0) + v);
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
    recordMatch(ruleId: number, day: string, tabId?: number): void {
      add(pending, day, ruleId);
      if (tabId !== undefined && tabId >= 0) tabs.set(tabId, (tabs.get(tabId) ?? 0) + 1);
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
          const lib = idx[Number(id)] ?? (Number(id) >= LEARNED_ID_BASE ? "learned" : "unknown");
          out.byLibrary[lib] = (out.byLibrary[lib] ?? 0) + n;
        }
      }
      return out;
    },

    async getTabCount(tabId: number): Promise<number> {
      await hydrated;
      return tabs.get(tabId) ?? 0;
    },

    resetTab(tabId: number): void {
      tabs.delete(tabId);
      void hydrated.then(() => tabs.delete(tabId)); // a late hydration must not resurrect the old count
    },
  };
}

export type Stats = ReturnType<typeof createStats>;

/** Static redirect rulesets and learned redirects (dynamic, ids from LEARNED_ID_BASE) serve a library; site-exception rules do not. */
export const isLibraryMatch = (rule: { rulesetId: string; ruleId?: number }): boolean =>
  rule.rulesetId === "exact" || rule.rulesetId === "substitute" || (rule.rulesetId === "_dynamic" && (rule.ruleId ?? 0) >= LEARNED_ID_BASE);
