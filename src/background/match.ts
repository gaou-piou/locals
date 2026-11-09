import { descend, fromPairs, prop, sort, sortBy, take, toPairs } from "ramda";
import * as v from "valibot";
import { AssetTypeSchema, Sha256Schema, type LibraryEntry } from "../shared/manifest-schema.ts";
import { PRIORITY } from "../shared/priorities.ts";
import { normalizeUrl } from "./observe.ts";

type Rule = chrome.declarativeNetRequest.Rule;
type FileType = v.InferOutput<typeof AssetTypeSchema>;

/** Dynamic rule ids at or above this belong to matched (hash-verified) files; learned ones sit below. */
export const MATCH_ID_BASE = 300_000;
/** Allow rules that undo a byname redirect whose bytes turned out not to be a bundled file. */
export const REJECT_ID_BASE = 400_000;

const MatchedEntrySchema = v.object({
  url: v.string(),
  library: v.string(),
  version: v.string(),
  path: v.string(),
  sha256: Sha256Schema,
  type: AssetTypeSchema,
  at: v.number(),
});
const RejectedEntrySchema = v.object({ url: v.string(), type: AssetTypeSchema, at: v.number() });
/** What `chrome.storage.local` holds; a missing or malformed part starts empty (fresh objects: the state is mutated). */
const record = <T extends v.GenericSchema>(item: T) => {
  const schema = v.record(v.string(), item);
  const empty = () => ({}) as v.InferOutput<typeof schema>;
  return v.optional(v.fallback(schema, empty), empty);
};
const StateSchema = v.fallback(
  v.object({ entries: record(MatchedEntrySchema), tried: record(v.number()), rejected: record(RejectedEntrySchema) }),
  () => ({ entries: {}, tried: {}, rejected: {} }),
);

export type MatchedEntry = v.InferOutput<typeof MatchedEntrySchema>;
export type RejectedEntry = v.InferOutput<typeof RejectedEntrySchema>;
type State = v.InferOutput<typeof StateSchema>;
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
    for (const ver of lib.versions)
      for (const f of ver.files) {
        if (!bySha.has(f.sha256)) bySha.set(f.sha256, { library: lib.name, version: ver.version, path: `libs/${lib.name}/${ver.version}/${f.path}`, type: f.type });
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
    return (state = v.parse(StateSchema, (await chrome.storage.local.get(KEY))[KEY]));
  };

  const newest = <T>(rec: Record<string, T>, max: number, at: (x: T) => number): Record<string, T> =>
    fromPairs(take(max, sort(descend(([, x]: [string, T]) => at(x)), toPairs(rec))));

  async function commit(s: State): Promise<void> {
    s.tried = newest(s.tried, MAX_TRIED, (at) => at);
    s.rejected = newest(s.rejected, MAX_REJECTED, prop("at"));
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
    const type = obs.type;
    if (!url || /[*|^\s]/.test(url) || !v.is(AssetTypeSchema, type)) return;
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
      return sortBy(prop("url"), Object.values((await load()).entries));
    },

    async getRejected(): Promise<RejectedEntry[]> {
      await chain;
      return sortBy(prop("url"), Object.values((await load()).rejected));
    },
  };
}

export type Matcher = ReturnType<typeof createMatcher>;
