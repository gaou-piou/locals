export type ObservedType = "script" | "stylesheet" | "font";
export type Candidate = { url: string; type: ObservedType; sites: number; hits: number; lastSeen: number };
export type Observation = { url: string; initiator?: string; type: string };

type Entry = { type: ObservedType; hits: number; last: number; sites: string[] };
type State = { salt: string; entries: Record<string, Entry> };

const KEY = "observed";
const TYPES = new Set<string>(["script", "stylesheet", "font"]);
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
    const stored = (await chrome.storage.local.get(KEY))[KEY] as State | undefined;
    state = stored ?? { salt: crypto.randomUUID(), entries: {} };
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

  const apply = async (o: Observation): Promise<void> => {
    if (!TYPES.has(o.type) || !o.initiator) return;
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
    const e = (s.entries[url] ??= { type: o.type as ObservedType, hits: 0, last: 0, sites: [] });
    const frag = fnv1a(s.salt + registrable(initiatorHost));
    e.hits++;
    e.last = now().getTime();
    if (!e.sites.includes(frag) && e.sites.length < MAX_SITES) e.sites.push(frag);
    const urls = Object.keys(s.entries);
    if (urls.length > maxEntries) {
      urls.sort((a, b) => s.entries[a].last - s.entries[b].last);
      for (const u of urls.slice(0, urls.length - maxEntries)) delete s.entries[u];
    }
    dirty = true;
    schedule();
  };

  const record = (o: Observation): void => {
    chain = chain.then(() => apply(o)).catch(() => {});
  };

  async function flush(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    await chain;
    await save();
  }

  async function getCandidates(opts: { minSites?: number } = {}): Promise<Candidate[]> {
    await chain;
    const min = opts.minSites ?? 2;
    const s = await load();
    return Object.entries(s.entries)
      .filter(([url, e]) => e.sites.length >= min && isImmutableUrl(url))
      .map(([url, e]) => ({ url, type: e.type, sites: e.sites.length, hits: e.hits, lastSeen: e.last }))
      .sort((a, b) => b.sites - a.sites || b.hits - a.hits || a.url.localeCompare(b.url));
  }

  async function clear(): Promise<void> {
    await chain;
    state = { salt: crypto.randomUUID(), entries: {} };
    dirty = true;
    await save();
  }

  return { record, flush, getCandidates, clear };
}
