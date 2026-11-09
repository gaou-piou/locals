import { createHash } from "node:crypto";
import { chain, groupBy, identity, map, sortBy, uniq, values } from "ramda";
import { EXTENSION_KEY } from "../src/manifest.ts";
import { PRIORITY } from "../src/shared/priorities.ts";
import type { LibraryEntry, LibraryFile } from "../src/shared/manifest-schema.ts";

/** Limits observed in Chromium 156 (docs/spike-results.md). */
export const RULE_LIMITS = { staticRules: 30_000, regexRules: 1_000 } as const;


type Rule = chrome.declarativeNetRequest.Rule;
export type RuleMode = "exact" | "substitute" | "byname";
export type GeneratedRules = { rules: Rule[]; index: Record<number, string> };

const RESOURCE_TYPE: Record<LibraryFile["type"], chrome.declarativeNetRequest.ResourceType> = {
  script: "script" as chrome.declarativeNetRequest.ResourceType,
  stylesheet: "stylesheet" as chrome.declarativeNetRequest.ResourceType,
  font: "font" as chrome.declarativeNetRequest.ResourceType,
};

export function extensionIdFromKey(key: string): string {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
  return [...digest].map((b) => String.fromCharCode(97 + (b >> 4)) + String.fromCharCode(97 + (b & 15))).join("");
}

export const urlFilterFor = (url: string, version: string): string =>
  `||${url.replace(/^https?:\/\//, "").replaceAll("{version}", version)}^`;

const defaultHash = (key: string): number => {
  const n = createHash("sha256").update(key).digest().readUInt32BE(0) & 0x7fffffff;
  return n === 0 ? 1 : n;
};

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const parseVersion = (v: string): number[] => v.split(/[-+]/)[0].split(".").map(Number);
const compareVersions = (a: string, b: string): number => {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};
const major = (v: string) => v.split(".")[0];
const isStable = (v: string) => !/[-+]/.test(v);

/** True when the CDN serves, for this version, exactly the bytes we bundle. */
const identical = (cdn: Record<string, string> | undefined, version: string, file: LibraryFile | undefined) =>
  !!file && cdn?.[version] === file.sha256;

type Candidate = { entry: LibraryEntry; version: string; url: string; file: LibraryFile };

function exactCandidates(entries: LibraryEntry[]): Candidate[] {
  return chain(
    (entry) =>
      chain(
        (v) =>
          chain((p) => {
            const file = v.files.find((f) => f.path === p.file);
            return file && identical(p.cdnSha256, v.version, file) ? [{ entry, version: v.version, url: p.url, file }] : [];
          }, entry.patterns),
        entry.versions,
      ),
    entries,
  );
}

function assignIds(drafts: { key: string; rule: Omit<Rule, "id">; library: string }[], hash: (k: string) => number): GeneratedRules {
  const index: Record<number, string> = {};
  const rules: Rule[] = [];
  for (const d of drafts) {
    const id = hash(d.key);
    if (id in index) throw new Error(`rule id collision: ${d.key} (id ${id})`);
    index[id] = d.library;
    rules.push({ id, ...d.rule });
  }
  return { rules, index };
}

export function generateRules(
  entries: LibraryEntry[],
  mode: RuleMode,
  opts: { hash?: (key: string) => number } = {},
): GeneratedRules {
  const hash = opts.hash ?? defaultHash;

  if (mode === "exact") {
    const drafts = map(
      (c) => ({
        key: `exact|${c.entry.name}@${c.version}|${c.url}`,
        library: c.entry.name,
        rule: {
          priority: PRIORITY.exact,
          action: {
            type: "redirect" as chrome.declarativeNetRequest.RuleActionType,
            redirect: { extensionPath: `/libs/${c.entry.name}/${c.version}/${c.file.path}` },
          },
          condition: { urlFilter: urlFilterFor(c.url, c.version), resourceTypes: [RESOURCE_TYPE[c.file.type]] },
        },
      }),
      exactCandidates(entries),
    );
    return assignIds(drafts, hash);
  }

  if (mode === "byname") return assignIds(bynameDrafts(entries), hash);

  // substitute: one regex per (library, CDN pattern, major), aimed at the highest stable pinned
  // version of that major that has the pattern's file and whose CDN bytes match ours.
  const id = extensionIdFromKey(EXTENSION_KEY);
  const groups = values(
    groupBy((c) => `${c.entry.name}|${c.url}|${major(c.version)}`, exactCandidates(entries).filter((c) => isStable(c.version))),
  ) as Candidate[][];
  const drafts = groups.map((group) => {
    const best = group.reduce((a, b) => (compareVersions(a.version, b.version) >= 0 ? a : b));
    const m = major(best.version);
    const [before, after = ""] = best.url.replace(/^https?:\/\//, "").split("{version}");
    const regexFilter = `^https?://${escapeRegExp(before)}${escapeRegExp(m)}\\.\\d+\\.\\d+${escapeRegExp(after)}(?:[?#].*)?$`;
    return {
      key: `substitute|${best.entry.name}|${best.url}|${m}`,
      library: best.entry.name,
      rule: {
        priority: PRIORITY.substitute,
        action: {
          type: "redirect" as chrome.declarativeNetRequest.RuleActionType,
          redirect: { regexSubstitution: `chrome-extension://${id}/libs/${best.entry.name}/${best.version}/${best.file.path}` },
        },
        condition: { regexFilter, resourceTypes: [RESOURCE_TYPE[best.file.type]] },
      },
    };
  });
  return assignIds(drafts, hash);
}

/** File stems too common to say which library a file is. */
const GENERIC_STEMS = new Set(["all", "index", "main", "style", "styles", "app", "bundle", "script", "scripts", "vendor", "common", "core", "theme", "default"]);
const stemOf = (basename: string) => basename.replace(/\.(?:min\.)?(?:js|css|woff2?|ttf|otf|eot)$/i, "").toLowerCase();

/** "https://cdn.x/npm/jquery@{version}/dist/a.js" → "/jquery@3.7.1/dist/a.js^": the part that names the library and version. */
export function pathShape(url: string, version: string): string | undefined {
  const segs = url.replace(/^https?:\/\/[^/]+/, "").split("/");
  const i = segs.findIndex((s) => s.includes("{version}"));
  const start = segs[i] === "{version}" ? i - 1 : i;
  if (i < 0 || start < 1) return undefined;
  return `/${segs.slice(start).join("/").replaceAll("{version}", version)}^`;
}

const hostOf = (url: string) => url.replace(/^https?:\/\//, "").split("/")[0].toLowerCase();

/**
 * byname: copies of a library hosted anywhere else, recognised by name and version in the path (the CDN path
 * shapes, and WordPress-style `?ver=`). Served before the bytes are known; the worker verifies every match
 * afterwards and corrects or rolls it back for the next load. CDN hosts stay with the exact ruleset.
 */
function bynameDrafts(entries: LibraryEntry[]) {
  const cdnHosts = sortBy(identity, uniq(chain((e) => e.patterns.map((p) => hostOf(p.url)), entries)));
  const extensionId = extensionIdFromKey(EXTENSION_KEY);
  const seen = new Set<string>();
  const drafts: { key: string; rule: Omit<Rule, "id">; library: string }[] = [];
  const add = (filter: string, entry: LibraryEntry, version: string, file: LibraryFile) => {
    const key = `byname|${filter}|${file.type}`;
    if (seen.has(key)) return;
    seen.add(key);
    drafts.push({
      key,
      library: entry.name,
      rule: {
        priority: PRIORITY.byname,
        action: {
          type: "redirect" as chrome.declarativeNetRequest.RuleActionType,
          redirect: { extensionPath: `/libs/${entry.name}/${version}/${file.path}` },
        },
        condition: {
          urlFilter: filter,
          resourceTypes: [RESOURCE_TYPE[file.type]],
          excludedRequestDomains: cdnHosts,
          excludedInitiatorDomains: [extensionId],
        },
      },
    });
  };
  for (const c of exactCandidates(entries)) {
    const shape = pathShape(c.url, c.version);
    if (shape) add(shape, c.entry, c.version, c.file);
  }
  for (const entry of entries)
    for (const v of entry.versions)
      for (const f of v.files) {
        const base = f.path.split("/").pop() ?? "";
        if (!GENERIC_STEMS.has(stemOf(base)) && /^[\w.-]+$/.test(base)) add(`/${base}?ver=${v.version}^`, entry, v.version, f);
      }
  return drafts;
}

export function generateWar(entries: LibraryEntry[]): { resources: string[]; matches: string[] }[] {
  const resources = chain((e) => chain((v) => map((f) => `libs/${e.name}/${v.version}/${f.path}`, v.files), e.versions), entries);
  return [{ resources, matches: ["*://*/*"] }];
}
