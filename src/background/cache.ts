import { isEmpty, keys, omit, pickBy, prop, sortBy, sum, take, values } from "ramda";
import * as v from "valibot";
import { AssetTypeSchema } from "../shared/manifest-schema.ts";
import { PRIORITY } from "../shared/priorities.ts";
import { CACHE_ID_BASE, filterFor } from "./match.ts";
import { isImmutableUrl, normalizeUrl } from "./observe.ts";

type Rule = chrome.declarativeNetRequest.Rule;
export type CacheType = v.InferOutput<typeof AssetTypeSchema>;
const TYPES: CacheType[] = ["script", "stylesheet", "font"];

/** Allow rules, two per type, that keep `data:` copies away from pages whose CSP would block them. */
export const GATE_ID_BASE = CACHE_ID_BASE;
/** One redirect per cached file, at `ENTRY_ID_BASE + slot`. */
export const ENTRY_ID_BASE = CACHE_ID_BASE + 100;

const HostVerdictSchema = v.object({ script: v.boolean(), stylesheet: v.boolean(), font: v.boolean(), at: v.number() });
/** A document host's verdict per type: may its pages load `data:` scripts / stylesheets / fonts? `at`: last seen. */
export type HostVerdict = v.InferOutput<typeof HostVerdictSchema>;

const FALLBACK: Record<CacheType, string[]> = {
  script: ["script-src-elem", "script-src", "default-src"],
  stylesheet: ["style-src-elem", "style-src", "default-src"],
  font: ["font-src", "default-src"],
};

/** Which types a document may load from `data:`, given its enforced CSP headers (report-only ones do not count). */
export function cspAllowsData(headers: string[]): Record<CacheType, boolean> {
  const policies = headers.flatMap((h) => h.split(",")).map((policy) => {
    const directives = new Map<string, string[]>();
    for (const part of policy.split(";")) {
      const [name, ...sources] = part.trim().toLowerCase().split(/\s+/);
      if (name && !directives.has(name)) directives.set(name, sources); // the first occurrence wins
    }
    return directives;
  });
  const allows = (type: CacheType) =>
    policies.every((d) => {
      const name = FALLBACK[type].find((n) => d.has(n));
      if (!name) return true;
      const sources = d.get(name)!;
      return sources.includes("data:") && !(type === "script" && sources.includes("'strict-dynamic'"));
    });
  return { script: allows("script"), stylesheet: allows("stylesheet"), font: allows("font") };
}

// protocol-relative URLs count as relative: `data:` has no host to lend them
const RELATIVE_CSS = [/url\(\s*(?!['"]?\s*(?:data:|https?:|#))/i, /@import\s+(?!url\()(['"])(?!https?:)/i, /@import\s+url\(\s*['"]?(?!https?:)/i];
const SELF_LOCATING_JS = [
  /\bcurrentScript\b/,
  /\bimport\.meta\b/,
  /\bimport\s*\(/,
  /\b(?:from|import)\s*["']\.{1,2}\//,
  /getElementsByTagName\(\s*["']script/i,
  /querySelector(?:All)?\(\s*["']script/i,
];

/**
 * Whether a file still works from a `data:` URL. Relative URLs in a stylesheet would resolve against `data:`,
 * and a script that derives URLs from its own location (chunks, workers, sibling files) would look in the wrong place.
 */
export function servable(type: CacheType, text: string): boolean {
  if (type === "stylesheet") return !RELATIVE_CSS.some((re) => re.test(text));
  if (type === "script") return !SELF_LOCATING_JS.some((re) => re.test(text));
  return true;
}

const FONT_MIME: Record<string, string> = { woff2: "font/woff2", woff: "font/woff", ttf: "font/ttf", otf: "font/otf" };

const base64 = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

/** The redirect target: the bytes as base64, typed so the page accepts them (scripts and stylesheets keep their charset). */
export function dataUrl(type: CacheType, url: string, contentType: string, body: ArrayBuffer): string {
  let mime: string;
  if (type === "font") {
    const ext = /\.([a-z0-9]+)$/i.exec(new URL(url).pathname)?.[1]?.toLowerCase() ?? "";
    mime = FONT_MIME[ext] ?? "application/octet-stream";
  } else {
    const charset = /;\s*charset=([^;\s]+)/i.exec(contentType)?.[1]?.toLowerCase() ?? "utf-8";
    mime = `${type === "script" ? "text/javascript" : "text/css"};charset=${charset}`;
  }
  return `data:${mime};base64,${base64(body)}`;
}

const allow = "allow" as chrome.declarativeNetRequest.RuleActionType;

/**
 * Per type: A blocks `data:` copies for every initiator except the hosts known to allow them (`excludedInitiatorDomains`
 * also covers subdomains), B takes back the known unsafe hosts among those subdomains. Off, or with no safe host yet,
 * A blocks them everywhere.
 */
export function gateRules(hosts: Record<string, HostVerdict>, enabled: boolean): Rule[] {
  return TYPES.flatMap((type, i): Rule[] => {
    const resourceTypes = [type as chrome.declarativeNetRequest.ResourceType];
    const safe = enabled ? keys(hosts).filter((h) => hosts[h][type]) : [];
    const unsafe = keys(hosts).filter((h) => !hosts[h][type]);
    const a: Rule = {
      id: GATE_ID_BASE + 2 * i,
      priority: PRIORITY.gate,
      action: { type: allow },
      condition: { resourceTypes, ...(isEmpty(safe) ? {} : { excludedInitiatorDomains: safe }) },
    };
    if (isEmpty(safe) || isEmpty(unsafe)) return [a];
    return [a, { id: GATE_ID_BASE + 2 * i + 1, priority: PRIORITY.gate, action: { type: allow }, condition: { resourceTypes, initiatorDomains: unsafe } }];
  });
}

const EntrySchema = v.object({ slot: v.number(), type: AssetTypeSchema, bytes: v.number(), at: v.number(), used: v.number() });
const record = <T extends v.GenericSchema>(item: T) => {
  const schema = v.record(v.string(), item);
  const empty = () => ({}) as v.InferOutput<typeof schema>;
  return v.optional(v.fallback(schema, empty), empty);
};
const StateSchema = v.fallback(
  v.object({ entries: record(EntrySchema), tried: record(v.number()), hosts: record(HostVerdictSchema) }),
  () => ({ entries: {}, tried: {}, hosts: {} }),
);
type State = v.InferOutput<typeof StateSchema>;
export type CachedFile = { url: string; type: CacheType; bytes: number; at: number; used: number };

const KEY = "cache";
const DAY = 24 * 3600 * 1000;
const MAX_HOSTS = 3000;
const MAX_TRIED = 3000;
const GATE_IDS = TYPES.flatMap((_, i) => [GATE_ID_BASE + 2 * i, GATE_ID_BASE + 2 * i + 1]);
const SAME_VERDICT = (a: HostVerdict, b: Record<CacheType, boolean>) => TYPES.every((t) => a[t] === b[t]);

/**
 * auto-cache: third-party files with an immutable URL, seen on `minSites` different sites, are downloaded once and
 * from then on served from a `data:` redirect on every site — the more you browse, the more is served locally.
 *
 * - `consider`: a request that reached the network; caches it when it qualifies (the observer counts the sites).
 * - `noteDocument`: a page's CSP decides whether its host may get `data:` copies (`gateRules`).
 * - `noteAborted`: a cached script/stylesheet that aborts was blocked anyway (a `<meta>` CSP): the host turns unsafe.
 * - `touch` / `prune`: least recently used copies make room; copies unused for `unusedTtlMs` expire.
 */
export function createCache(deps: {
  fetchBody: (url: string) => Promise<{ body: ArrayBuffer; contentType: string } | null>;
  sitesOf: (url: string) => Promise<number>;
  /** Bytes of a bundled file are served from the extension (the matcher), never as a copy. */
  isBundled: (body: ArrayBuffer) => Promise<boolean>;
  enabled: () => Promise<boolean>;
  now?: () => number;
  minSites?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxEntries?: number;
  retryMs?: number;
  unusedTtlMs?: number;
  hostTtlMs?: number;
}) {
  const now = deps.now ?? Date.now;
  const minSites = deps.minSites ?? 3;
  const maxFile = deps.maxFileBytes ?? 1024 * 1024;
  const maxTotal = deps.maxTotalBytes ?? 24 * 1024 * 1024;
  const maxEntries = deps.maxEntries ?? 500;
  const retry = deps.retryMs ?? 3 * DAY;
  const unusedTtl = deps.unusedTtlMs ?? 60 * DAY;
  const hostTtl = deps.hostTtlMs ?? 30 * DAY;

  let state: State | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let dirty = false;
  /** Bumped by `clear`: downloads that started before it are dropped. */
  let epoch = 0;
  const serial = <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  };

  const load = async (): Promise<State> => (state ??= v.parse(StateSchema, (await chrome.storage.local.get(KEY))[KEY]));
  const save = async (s: State): Promise<void> => {
    dirty = false;
    await chrome.storage.local.set({ [KEY]: s });
  };

  const commitGates = async (s: State): Promise<void> => {
    const newest = Object.fromEntries(take(MAX_HOSTS, sortBy(([, h]) => -h.at, Object.entries(s.hosts))));
    s.hosts = newest;
    await save(s);
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: GATE_IDS, addRules: gateRules(s.hosts, await deps.enabled()) });
  };

  const remove = async (s: State, urls: string[]): Promise<void> => {
    const ids = urls.map((u) => ENTRY_ID_BASE + s.entries[u].slot);
    for (const u of urls) delete s.entries[u];
    if (ids.length) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: ids });
  };

  /**
   * Whether a request qualifies is decided in the queue, the download happens outside it (up to 15 s: pages must still
   * be noted meanwhile), and the copy is stored in the queue again. Marking the URL as tried keeps a second sighting
   * from downloading it twice; `epoch` drops a download that `clear` overtook.
   */
  async function check(obs: { url: string; type: string }): Promise<void> {
    const url = normalizeUrl(obs.url);
    const type = obs.type;
    if (!url || /[*|^\s]/.test(url) || !v.is(AssetTypeSchema, type) || !isImmutableUrl(url)) return;
    const started = await serial(async () => {
      const s = await load();
      const t = now();
      if (s.entries[url] || (s.tried[url] !== undefined && t - s.tried[url] < retry)) return undefined;
      if (!(await deps.enabled()) || (await deps.sitesOf(url)) < minSites) return undefined;
      s.tried[url] = t;
      s.tried = Object.fromEntries(take(MAX_TRIED, sortBy(([, at]) => -at, Object.entries(s.tried))));
      return { t, epoch };
    });
    if (!started) return;
    const res = await deps.fetchBody(url).catch(() => null);
    const ok =
      res &&
      res.body.byteLength > 0 &&
      res.body.byteLength <= maxFile &&
      servable(type, new TextDecoder().decode(res.body)) &&
      !(await deps.isBundled(res.body));
    await serial(async () => {
      if (ok && res) return store(url, type, res, started);
      if (started.epoch === epoch) await save(await load()); // remember the failed try, so it waits `retryMs`
    });
  }

  async function store(url: string, type: CacheType, res: { body: ArrayBuffer; contentType: string }, started: { t: number; epoch: number }): Promise<void> {
    const s = await load();
    if (started.epoch !== epoch || s.entries[url] || !(await deps.enabled())) return;
    const t = started.t;
    delete s.tried[url];
    const bytes = res.body.byteLength;
    const total = () => sum(values(s.entries).map((e) => e.bytes));
    const lru = sortBy((u: string) => s.entries[u].used, keys(s.entries));
    const evict: string[] = [];
    while (lru.length && (total() - sum(evict.map((u) => s.entries[u].bytes)) + bytes > maxTotal || keys(s.entries).length - evict.length >= maxEntries))
      evict.push(lru.shift()!);
    await remove(s, evict);
    const taken = new Set(values(s.entries).map((e) => e.slot));
    let slot = 0;
    while (taken.has(slot)) slot++;
    s.entries[url] = { slot, type, bytes, at: t, used: t };
    await save(s);
    const id = ENTRY_ID_BASE + slot;
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [id],
      addRules: [
        {
          id,
          priority: PRIORITY.cached,
          action: { type: "redirect" as chrome.declarativeNetRequest.RuleActionType, redirect: { url: dataUrl(type, url, res.contentType, res.body) } },
          condition: { urlFilter: filterFor(url), resourceTypes: [type as chrome.declarativeNetRequest.ResourceType], excludedInitiatorDomains: [chrome.runtime.id] },
        },
      ],
    });
  }

  const hostOf = (url: string | undefined): string | undefined => {
    try {
      const u = new URL(url ?? "");
      return u.protocol === "https:" || u.protocol === "http:" ? u.hostname : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    consider: check,

    /** A document (frame) arrived with these CSP headers; unsafe verdicts stick while the host keeps being visited. */
    noteDocument: (doc: { url: string; headers: string[] }): Promise<void> =>
      serial(async () => {
        const host = hostOf(doc.url);
        if (!host) return;
        const s = await load();
        const seen = cspAllowsData(doc.headers);
        const prev = s.hosts[host];
        const next = prev ? { script: prev.script && seen.script, stylesheet: prev.stylesheet && seen.stylesheet, font: prev.font && seen.font } : seen;
        const t = now();
        s.hosts[host] = { ...next, at: t };
        if (!prev || !SAME_VERDICT(prev, next)) await commitGates(s);
        else if (t - prev.at > DAY) await save(s);
      }),

    /** True when a cached copy was blocked on a host thought safe: the host is now unsafe and the page should reload. */
    noteAborted: (req: { url: string; type: string; initiator?: string }): Promise<boolean> =>
      serial(async () => {
        if (req.type !== "script" && req.type !== "stylesheet") return false; // fonts abort even when they load
        const url = normalizeUrl(req.url);
        const host = hostOf(req.initiator);
        const s = await load();
        if (!url || !host || !s.entries[url] || s.entries[url].type !== req.type || !s.hosts[host]?.[req.type]) return false;
        s.hosts[host] = { script: false, stylesheet: false, font: false, at: now() };
        await commitGates(s);
        return true;
      }),

    /** A page asked for this URL (it may be served from a copy): keeps the copy from being the least recently used. */
    touch(raw: string): void {
      const url = normalizeUrl(raw);
      if (!url) return;
      void serial(async () => {
        const e = (await load()).entries[url];
        if (e) (e.used = now()), (dirty = true);
      });
    },

    flush: (): Promise<void> => serial(async () => (dirty && state ? save(state) : undefined)),

    /** Re-applies the gate (after the setting changed). */
    refreshGates: (): Promise<void> => serial(async () => commitGates(await load())),

    prune: (): Promise<void> =>
      serial(async () => {
        const s = await load();
        const t = now();
        await remove(s, keys(s.entries).filter((u) => s.entries[u].used < t - unusedTtl));
        const slots = new Set(values(s.entries).map((e) => ENTRY_ID_BASE + e.slot));
        const rules = await chrome.declarativeNetRequest.getDynamicRules();
        const orphans = rules.filter((r) => r.id >= ENTRY_ID_BASE && !slots.has(r.id)).map((r) => r.id);
        const have = new Set(rules.map((r) => r.id));
        for (const u of keys(s.entries)) if (!have.has(ENTRY_ID_BASE + s.entries[u].slot)) delete s.entries[u];
        if (orphans.length) await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: orphans });
        for (const u of keys(s.tried)) if (s.tried[u] < t - retry) delete s.tried[u];
        s.hosts = pickBy((h: HostVerdict) => h.at >= t - hostTtl, s.hosts);
        await commitGates(s);
      }),

    list: (): Promise<CachedFile[]> =>
      serial(async () => {
        const s = await load();
        return sortBy(prop("url"), Object.entries(s.entries).map(([url, e]): CachedFile => ({ url, ...omit(["slot"], e) })));
      }),

    clear: (): Promise<void> =>
      serial(async () => {
        const s = await load();
        await remove(s, keys(s.entries));
        s.tried = {};
        epoch++;
        await save(s);
      }),
  };
}

export type Cache = ReturnType<typeof createCache>;
