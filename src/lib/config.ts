import { uniq } from "ramda";
import * as v from "valibot";
import { migrate, normalizeHost, type Settings } from "../background/settings.ts";
import { describeIssues, type LibraryEntry } from "../shared/manifest-schema.ts";

/** Accepts the current export and the unversioned (schema 0) one; unknown keys are an error. */
const ConfigSchema = v.pipe(
  v.unknown(),
  v.check((raw) => !Array.isArray(raw), "Invalid type: Expected Object but received Array"),
  v.strictObject({
    schema: v.optional(v.picklist([0, 1])),
    enabled: v.optional(v.boolean()),
    substitute: v.optional(v.boolean()),
    byname: v.optional(v.boolean()),
    autoCache: v.optional(v.boolean()),
    disabledSites: v.optional(v.array(v.string())),
    allowedSites: v.optional(v.array(v.string())),
  }),
);

export class ConfigError extends Error {
  constructor(detail: string) {
    super(`Invalid configuration: ${detail}`);
  }
}

export const serializeConfig = (s: Settings): string => JSON.stringify(s, null, 2);

export function parseConfig(json: string): Settings {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new ConfigError("not valid JSON");
  }
  const parsed = v.safeParse(ConfigSchema, raw);
  if (!parsed.success) throw new ConfigError(describeIssues(parsed.issues));
  const bad = [...(parsed.output.disabledSites ?? []), ...(parsed.output.allowedSites ?? [])].find((host) => !normalizeHost(host));
  if (bad !== undefined) throw new ConfigError(`"${bad}" is not a hostname`);
  return migrate(parsed.output);
}

/** Chrome's `requestDomains` semantics: the entry itself or any subdomain of it. */
const covers = (entry: string, host: string): boolean => host === entry || host.endsWith(`.${entry}`);

export const siteEnabled = (s: Settings, host: string): boolean =>
  !s.disabledSites.some((d) => covers(d, host)) && (s.allowedSites.length === 0 || s.allowedSites.some((a) => covers(a, host)));

/** The settings patch that turns `host` on or off, honouring allow-list mode and parent domains. */
export function toggleSitePatch(s: Settings, host: string, enabled: boolean): Pick<Settings, "disabledSites" | "allowedSites"> {
  if (!enabled) {
    const already = s.disabledSites.some((d) => covers(d, host));
    return { disabledSites: already ? s.disabledSites : uniq([...s.disabledSites, host]), allowedSites: s.allowedSites };
  }
  const covered = s.allowedSites.some((a) => covers(a, host));
  return {
    // A denied parent domain is what disables the subdomain, so enabling the subdomain lifts that entry.
    disabledSites: s.disabledSites.filter((d) => !covers(d, host)),
    allowedSites: s.allowedSites.length && !covered ? uniq([...s.allowedSites, host]) : s.allowedSites,
  };
}

export const filterLibraries = (libs: LibraryEntry[], query: string): LibraryEntry[] => {
  const q = query.trim().toLowerCase();
  return q ? libs.filter((l) => l.name.toLowerCase().includes(q) || l.npm.toLowerCase().includes(q)) : libs;
};
