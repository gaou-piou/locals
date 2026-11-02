import { uniq, without } from "ramda";
import { z } from "zod";
import { migrate, normalizeHost, type Settings } from "../background/settings.ts";
import type { LibraryEntry } from "../shared/manifest-schema.ts";

/** Accepts the current export and the unversioned (schema 0) one; unknown keys are an error. */
const ConfigSchema = z.strictObject({
  schema: z.union([z.literal(0), z.literal(1)]).optional(),
  enabled: z.boolean().optional(),
  substitute: z.boolean().optional(),
  disabledSites: z.array(z.string()).optional(),
  allowedSites: z.array(z.string()).optional(),
});

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
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "));
  for (const host of [...(parsed.data.disabledSites ?? []), ...(parsed.data.allowedSites ?? [])]) {
    if (!normalizeHost(host)) throw new ConfigError(`"${host}" is not a hostname`);
  }
  return migrate(parsed.data);
}

export const siteEnabled = (s: Settings, host: string): boolean =>
  !s.disabledSites.includes(host) && (s.allowedSites.length === 0 || s.allowedSites.includes(host));

/** The settings patch that turns `host` on or off, honouring allow-list mode. */
export function toggleSitePatch(s: Settings, host: string, enabled: boolean): Pick<Settings, "disabledSites" | "allowedSites"> {
  if (!enabled) return { disabledSites: uniq([...s.disabledSites, host]), allowedSites: s.allowedSites };
  return {
    disabledSites: without([host], s.disabledSites),
    allowedSites: s.allowedSites.length ? uniq([...s.allowedSites, host]) : s.allowedSites,
  };
}

export const filterLibraries = (libs: LibraryEntry[], query: string): LibraryEntry[] => {
  const q = query.trim().toLowerCase();
  return q ? libs.filter((l) => l.name.toLowerCase().includes(q) || l.npm.toLowerCase().includes(q)) : libs;
};
