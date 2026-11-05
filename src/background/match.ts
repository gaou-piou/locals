import { PRIORITY } from "../shared/priorities.ts";
import type { LibraryEntry } from "../shared/manifest-schema.ts";
import { normalizeUrl } from "./observe.ts";

type Rule = chrome.declarativeNetRequest.Rule;
type FileType = "script" | "stylesheet" | "font";

/** Dynamic rule ids at or above this belong to matched (hash-verified) files; learned ones sit below. */
export const MATCH_ID_BASE = 300_000;

export type MatchedEntry = { url: string; library: string; version: string; path: string; sha256: string; type: FileType; at: number };
export type HashIndex = { bySha: Map<string, { library: string; version: string; path: string; type: FileType }>; tokens: string[] };

const KEY = "matched";
const DAY = 24 * 3600 * 1000;
const MAX_ENTRIES = 1000;
const MAX_TRIED = 3000;
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

export function matchRules(entries: MatchedEntry[]): Rule[] {
  return entries.map((e, i) => ({
    id: MATCH_ID_BASE + i,
    priority: PRIORITY.exact,
    action: { type: "redirect" as chrome.declarativeNetRequest.RuleActionType, redirect: { extensionPath: `/${e.path}` } },
    condition: { urlFilter: `||${e.url.replace(/^https?:\/\//, "")}^`, resourceTypes: [e.type as chrome.declarativeNetRequest.ResourceType] },
  }));
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

type State = { entries: Record<string, MatchedEntry>; tried: Record<string, number> };

/**
 * Finds files that are byte-identical to a bundled library even though they are served from an unknown URL
 * (typically a copy hosted by the site itself) and redirects exactly that URL to the bundled copy. Redirected
 * requests never reach the network, so a match expires after `ttlMs`; the next load is fetched and checked again.
 */
export function createMatcher(deps: {
  loadLibraries: () => Promise<LibraryEntry[]>;
  fetchBody: (url: string) => Promise<ArrayBuffer | null>;
  now?: () => number;
  ttlMs?: number;
  retryMs?: number;
}) {
  const now = deps.now ?? Date.now;
  const ttl = deps.ttlMs ?? 7 * DAY;
  const retry = deps.retryMs ?? 3 * DAY;

  let state: State | undefined;
  let index: Promise<HashIndex> | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let queued = 0;
  const seen = new Set<string>();

  const load = async (): Promise<State> => {
    if (state) return state;
    const stored = (await chrome.storage.local.get(KEY))[KEY] as State | undefined;
    return (state = stored ?? { entries: {}, tried: {} });
  };

  async function commit(s: State): Promise<void> {
    const tried = Object.entries(s.tried);
    if (tried.length > MAX_TRIED) s.tried = Object.fromEntries(tried.sort((a, b) => b[1] - a[1]).slice(0, MAX_TRIED));
    await chrome.storage.local.set({ [KEY]: s });
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.filter((r) => r.id >= MATCH_ID_BASE).map((r) => r.id),
      addRules: matchRules(Object.values(s.entries)),
    });
  }

  async function check(obs: { url: string; type: string }): Promise<void> {
    const url = normalizeUrl(obs.url);
    if (!url || /[*|^\s]/.test(url) || (obs.type !== "script" && obs.type !== "stylesheet" && obs.type !== "font")) return;
    const s = await load();
    const t = now();
    if (s.entries[url] || (s.tried[url] !== undefined && t - s.tried[url] < retry)) return;
    index ??= deps.loadLibraries().then(buildIndex);
    const idx = await index;
    if (!looksLikeLibrary(url, idx)) return;
    if (Object.keys(s.entries).length >= MAX_ENTRIES) return;
    s.tried[url] = t;
    const body = await deps.fetchBody(url).catch(() => null);
    let hit: ReturnType<HashIndex["bySha"]["get"]>;
    let digest = "";
    if (body && body.byteLength <= MAX_BODY_BYTES) {
      digest = hex(await crypto.subtle.digest("SHA-256", body));
      hit = idx.bySha.get(digest);
    }
    if (hit && hit.type === obs.type) {
      delete s.tried[url];
      s.entries[url] = { url, library: hit.library, version: hit.version, path: hit.path, sha256: digest, type: hit.type, at: t };
    }
    await commit(s);
  }

  return {
    /** Checks one observed request; resolves when the check (and any rule update) is done. */
    consider(obs: { url: string; type: string }): Promise<void> {
      const key = `${obs.type} ${obs.url}`;
      if (seen.has(key) || queued >= MAX_QUEUE) return Promise.resolve();
      seen.add(key);
      queued++;
      const run = chain.then(() => check(obs)).catch(() => {});
      chain = run.finally(() => {
        queued--;
        seen.delete(key);
      });
      return run;
    },

    /** Drops matches older than the ttl and removes their rules. */
    async prune(): Promise<void> {
      await chain;
      const s = await load();
      const cutoff = now() - ttl;
      const stale = Object.keys(s.entries).filter((u) => s.entries[u].at < cutoff);
      if (!stale.length) return;
      for (const u of stale) delete s.entries[u];
      await commit(s);
    },

    async getMatched(): Promise<MatchedEntry[]> {
      await chain;
      return Object.values((await load()).entries).sort((a, b) => a.url.localeCompare(b.url));
    },
  };
}

export type Matcher = ReturnType<typeof createMatcher>;
