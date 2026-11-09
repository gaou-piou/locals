import { ascend, descend, dropLast, prop, sortBy, sortWith } from "ramda";
import * as v from "valibot";
import { AssetTypeSchema } from "../shared/manifest-schema.ts";

export type ObservedType = v.InferOutput<typeof AssetTypeSchema>;
export type Candidate = { url: string; type: ObservedType; sites: number; hits: number; lastSeen: number };
export type Observation = { url: string; initiator?: string; type: string };

const EntrySchema = v.object({ type: AssetTypeSchema, hits: v.number(), last: v.number(), sites: v.array(v.string()) });
const StateSchema = v.object({ salt: v.string(), entries: v.record(v.string(), EntrySchema) });
type State = v.InferOutput<typeof StateSchema>;

const KEY = "observed";
const MAX_SITES = 8;
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);

export function normalizeUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") return undefined;
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return undefined;
  }
}

const registrable = (host: string): string => {
  const parts = host.toLowerCase().split(".");
  const take = parts.length >= 3 && parts.at(-1)!.length === 2 && SECOND_LEVEL.has(parts.at(-2)!) ? 3 : 2;
  return parts.slice(-take).join(".");
};

export const sameSite = (a: string, b: string): boolean => registrable(a) === registrable(b);

/** URL whose content can be assumed fixed: an explicit full version or a content hash. */
export function isImmutableUrl(url: string): boolean {
  let host = "";
  let path = url;
  try {
    const u = new URL(url);
    host = u.hostname;
    path = u.pathname;
  } catch {
    // keep the raw string
  }
  // Google Fonts files are content-addressed: /s/<family>/v<N>/<file> never changes once published
  if (host === "fonts.gstatic.com" && /^\/s\/[^/]+\/v\d+\/[^/]+\.woff2?$/.test(path)) return true;
  if (/(?<![\d.])\d+\.\d+\.\d+(?!\d)/.test(path)) return true;
  const hashed = /[.-]([0-9a-f]{8,})\.(?:js|css|woff2?)$/.exec(path);
  return !!hashed && /\d/.test(hashed[1]);
}

const fnv1a = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
};

export function createObserver(deps: { now?: () => Date; flushDelayMs?: number; maxEntries?: number } = {}) {
  const now = deps.now ?? (() => new Date());
  const delay = deps.flushDelayMs ?? 5_000;
  const maxEntries = deps.maxEntries ?? 2000;

  let state: State | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;

  const load = async (): Promise<State> => {
    if (state) return state;
    const stored = (await chrome.storage.local.get(KEY))[KEY];
    state = v.is(StateSchema, stored) ? stored : { salt: crypto.randomUUID(), entries: {} };
    return state;
  };

  const save = async (): Promise<void> => {
    if (!state || !dirty) return;
    dirty = false;
    await chrome.storage.local.set({ [KEY]: state });
  };

  const schedule = () => {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush().catch(() => {});
    }, delay);
  };

  const apply = async (o: Observation, at: number): Promise<void> => {
    const type = o.type;
    if (!v.is(AssetTypeSchema, type) || !o.initiator) return;
    const url = normalizeUrl(o.url);
    if (!url) return;
    let initiatorHost: string;
    try {
      initiatorHost = new URL(o.initiator).hostname;
    } catch {
      return;
    }
    if (!initiatorHost || sameSite(initiatorHost, new URL(url).hostname)) return;
    const s = await load();
    const e = (s.entries[url] ??= { type, hits: 0, last: 0, sites: [] });
    const frag = fnv1a(s.salt + registrable(initiatorHost));
    e.hits++;
    e.last = at;
    if (!e.sites.includes(frag) && e.sites.length < MAX_SITES) e.sites.push(frag);
    const urls = Object.keys(s.entries);
    if (urls.length > maxEntries) {
      const oldestFirst = sortBy((u: string) => s.entries[u].last, urls);
      for (const u of dropLast(maxEntries, oldestFirst)) delete s.entries[u];
    }
    dirty = true;
    schedule();
  };

  const record = (o: Observation): void => {
    const at = now().getTime();
    chain = chain.then(() => apply(o, at)).catch(() => {});
  };

  async function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    await chain;
    await save();
  }

  const candidates = async (keep: (sites: number) => boolean): Promise<Candidate[]> => {
    await chain;
    const s = await load();
    return Object.entries(s.entries)
      .filter(([url, e]) => keep(e.sites.length) && isImmutableUrl(url))
      .map(([url, e]) => ({ url, type: e.type, sites: e.sites.length, hits: e.hits, lastSeen: e.last }));
  };

  async function getCandidates(opts: { minSites?: number } = {}): Promise<Candidate[]> {
    const min = opts.minSites ?? 2;
    return sortWith([descend(prop("sites")), descend(prop("hits")), ascend(prop("url"))], await candidates((n) => n >= min));
  }

  /** Versioned URLs seen on fewer sites than needed: they are saved as soon as another site loads them. */
  async function getPending(opts: { minSites?: number } = {}): Promise<Candidate[]> {
    const min = opts.minSites ?? 2;
    return sortWith([descend(prop("lastSeen")), ascend(prop("url"))], await candidates((n) => n < min));
  }

  /** How many different sites loaded `url` (query ignored); 0 when it was never seen from another site. */
  async function sitesOf(raw: string): Promise<number> {
    await chain;
    const url = normalizeUrl(raw);
    return url ? ((await load()).entries[url]?.sites.length ?? 0) : 0;
  }

  async function clear(): Promise<void> {
    await chain;
    state = { salt: crypto.randomUUID(), entries: {} };
    dirty = true;
    await save();
  }

  return { record, flush, getCandidates, getPending, sitesOf, clear };
}
