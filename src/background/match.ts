import { PRIORITY } from "../shared/priorities.ts";
import type { LibraryEntry } from "../shared/manifest-schema.ts";
import { normalizeUrl } from "./observe.ts";

type Rule = chrome.declarativeNetRequest.Rule;
type FileType = "script" | "stylesheet" | "font";

/** Dynamic rule ids at or above this belong to matched (hash-verified) files; learned ones sit below. */
export const MATCH_ID_BASE = 300_000;
/** Allow rules that undo a byname redirect whose bytes turned out not to be a bundled file. */
export const REJECT_ID_BASE = 400_000;

export type MatchedEntry = { url: string; library: string; version: string; path: string; sha256: string; type: FileType; at: number };
export type HashIndex = { bySha: Map<string, { library: string; version: string; path: string; type: FileType }>; tokens: string[] };

const KEY = "matched";
const DAY = 24 * 3600 * 1000;
const MAX_ENTRIES = 1000;
const MAX_TRIED = 3000;
const MAX_REJECTED = 2000;
const MAX_QUEUE = 50;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Maps the sha256 of every bundled file to where it lives, and collects the words that make a URL worth checking. */
export function buildIndex(libs: LibraryEntry[]): HashIndex {
  const bySha: HashIndex["bySha"] = new Map();
  const tokens = new Set<string>();
  for (const lib of libs) {
    const name = squash(lib.name);
    if (name.length >= 3) tokens.add(name);
    for (const v of lib.versions)
      for (const f of v.files) {
        if (!bySha.has(f.sha256)) bySha.set(f.sha256, { library: lib.name, version: v.version, path: `libs/${lib.name}/${v.version}/${f.path}`, type: f.type });
        const stem = squash((f.path.split("/").pop() ?? "").replace(/\.(?:min\.)?(?:js|css|woff2?)$/i, ""));
        if (stem.length >= 4) tokens.add(stem);
      }
  }
  return { bySha, tokens: [...tokens] };
}

/** Cheap pre-filter so that only plausible URLs cost a download. The hash decides, this only bounds the work. */
export function looksLikeLibrary(url: string, index: Pick<HashIndex, "tokens">): boolean {
  let path: string;
  try {
    path = squash(new URL(url).pathname);
  } catch {
    return false;
  }
  return index.tokens.some((t) => path.includes(t));
}

const filterFor = (url: string) => `||${url.replace(/^https?:\/\//, "")}^`;

/** `extensionId` keeps the worker's own downloads (verification, re-checks) out of the redirect. */
export function matchRules(entries: MatchedEntry[], extensionId?: string): Rule[] {
  return entries.map((e, i) => ({
    id: MATCH_ID_BASE + i,
    priority: PRIORITY.exact,
    action: { type: "redirect" as chrome.declarativeNetRequest.RuleActionType, redirect: { extensionPath: `/${e.path}` } },
    condition: {
      urlFilter: filterFor(e.url),
      resourceTypes: [e.type as chrome.declarativeNetRequest.ResourceType],
      ...(extensionId ? { excludedInitiatorDomains: [extensionId] } : {}),
    },
  }));
}

/** Allow rules that win over the byname ruleset for URLs whose bytes are not a bundled file. */
export function rejectRules(rejected: RejectedEntry[]): Rule[] {
  return rejected.map((e, i) => ({
    id: REJECT_ID_BASE + i,
    priority: PRIORITY.exact,
    action: { type: "allow" as chrome.declarativeNetRequest.RuleActionType },
    condition: { urlFilter: filterFor(e.url), resourceTypes: [e.type as chrome.declarativeNetRequest.ResourceType] },
  }));
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export type RejectedEntry = { url: string; type: FileType; at: number };
type State = { entries: Record<string, MatchedEntry>; tried: Record<string, number>; rejected: Record<string, RejectedEntry> };
type Mode = "observed" | "verify" | "revalidate";

/**
 * Keeps per-URL redirects for files that are byte-identical to a bundled library but served from a URL the
 * static rules do not know (typically a copy hosted by the site itself).
 *
 * - `consider`: a file that reached the network is downloaded and hashed; identical bytes get a redirect.
 * - `verify`: the byname ruleset already served a file by its name; its real bytes decide afterwards whether the
 *   guess stays (identical), is corrected (another bundled version) or is rolled back with an allow rule.
 * - `prune`: matches older than `ttlMs` keep working while they are downloaded and checked again
 *   (stale-while-revalidate); rejections expire after `rejectTtlMs` so the file gets another chance.
 *
 * The worker's own downloads bypass every redirect (excludedInitiatorDomains), so they see the real file.
 */
export function createMatcher(deps: {
  loadLibraries: () => Promise<LibraryEntry[]>;
  fetchBody: (url: string) => Promise<ArrayBuffer | null>;
  now?: () => number;
  ttlMs?: number;
  retryMs?: number;
  rejectTtlMs?: number;
}) {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? 7 * DAY;
  const retry = deps.retryMs ?? 3 * DAY;
  const rejectTtl = deps.rejectTtlMs ?? 30 * DAY;

  let state: State | undefined;
  let index: Promise<HashIndex> | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let queued = 0;
  const seen = new Set<string>();

  const load = async (): Promise<State> => {
    if (state) return state;
    const stored = (await chrome.storage.local.get(KEY))[KEY] as Partial<State> | undefined;
    return (state = { entries: stored?.entries ?? {}, tried: stored?.tried ?? {}, rejected: stored?.rejected ?? {} });
  };

  const newest = <T>(rec: Record<string, T>, max: number, at: (v: T) => number): Record<string, T> => {
    const all = Object.entries(rec);
    return all.length > max ? Object.fromEntries(all.sort((a, b) => at(b[1]) - at(a[1])).slice(0, max)) : rec;
  };

  async function commit(s: State): Promise<void> {
    s.tried = newest(s.tried, MAX_TRIED, (v) => v);
    s.rejected = newest(s.rejected, MAX_REJECTED, (v) => v.at);
    await chrome.storage.local.set({ [KEY]: s });
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.filter((r) => r.id >= MATCH_ID_BASE).map((r) => r.id),
      addRules: [...matchRules(Object.values(s.entries), chrome.runtime.id), ...rejectRules(Object.values(s.rejected))],
    });
  }

  const getIndex = (): Promise<HashIndex> =>
    // a failed load must not be cached: the next request would never get a chance
    (index ??= deps.loadLibraries().then(buildIndex, (err) => {
      index = undefined;
      throw err;
    }));

  async function check(obs: { url: string; type: string }, mode: Mode): Promise<void> {
    const url = normalizeUrl(obs.url);
    if (!url || /[*|^\s]/.test(url) || (obs.type !== "script" && obs.type !== "stylesheet" && obs.type !== "font")) return;
    const type = obs.type;
    const s = await load();
    const t = now();
    if (mode !== "revalidate") {
      if (s.entries[url] || s.rejected[url] || (s.tried[url] !== undefined && t - s.tried[url] < retry)) return;
    } else if (!s.entries[url]) return;
    const idx = await getIndex();
    if (mode === "observed" && !looksLikeLibrary(url, idx)) return;
    if (mode !== "revalidate" && Object.keys(s.entries).length >= MAX_ENTRIES) return;
    s.tried[url] = t;
    const body = await deps.fetchBody(url).catch(() => null);
    let hit: ReturnType<HashIndex["bySha"]["get"]>;
    let digest = "";
    if (body && body.byteLength <= MAX_BODY_BYTES) {
      digest = hex(await crypto.subtle.digest("SHA-256", body));
      hit = idx.bySha.get(digest);
    }
    console.debug(`locals: ${mode}`, url, { bytes: body?.byteLength ?? null, digest, hit: hit?.library ?? null, type });
    if (hit && hit.type === type) {
      delete s.tried[url];
      s.entries[url] = { url, library: hit.library, version: hit.version, path: hit.path, sha256: digest, type: hit.type, at: t };
    } else if (body && mode !== "observed") {
      // served by name (or matched earlier) but the bytes are not ours: give the file back to the site
      delete s.tried[url];
      delete s.entries[url];
      s.rejected[url] = { url, type, at: t };
    } else if (!body && mode === "revalidate") {
      delete s.tried[url]; // offline or a server error: keep serving, try again on a later prune
      return;
    }
    await commit(s);
  }

  const enqueue = (obs: { url: string; type: string }, mode: Mode): Promise<void> => {
    const key = `${mode} ${obs.type} ${obs.url}`;
    if (seen.has(key) || queued >= MAX_QUEUE) return Promise.resolve();
    seen.add(key);
    queued++;
    const run = chain.then(() => check(obs, mode)).finally(() => {
      queued--;
      seen.delete(key);
    });
    chain = run.catch(() => {});
    return run;
  };

  return {
    /** Checks one request that reached the network; resolves when the check (and any rule update) is done. */
    consider: (obs: { url: string; type: string }): Promise<void> => enqueue(obs, "observed"),

    /** Checks the real bytes behind a request the byname ruleset served from a bundled copy. */
    verify: (obs: { url: string; type: string }): Promise<void> => enqueue(obs, "verify"),

    /** Re-checks matches older than the ttl (they keep working meanwhile) and expires old rejections. */
    async prune(): Promise<void> {
      await chain;
      const s = await load();
      const t = now();
      const expired = Object.keys(s.rejected).filter((u) => s.rejected[u].at < t - rejectTtl);
      if (expired.length) {
        for (const u of expired) delete s.rejected[u];
        await commit(s);
      }
      const stale = Object.values(s.entries).filter((e) => e.at < t - ttl);
      await Promise.all(stale.map((e) => enqueue(e, "revalidate")));
    },

    async getMatched(): Promise<MatchedEntry[]> {
      await chain;
      return Object.values((await load()).entries).sort((a, b) => a.url.localeCompare(b.url));
    },

    async getRejected(): Promise<RejectedEntry[]> {
      await chain;
      return Object.values((await load()).rejected).sort((a, b) => a.url.localeCompare(b.url));
    },
  };
}

export type Matcher = ReturnType<typeof createMatcher>;
