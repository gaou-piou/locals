import { uniq } from "ramda";
import { applyExceptions } from "./exceptions.ts";

export type Settings = {
  schema: 1;
  enabled: boolean;
  substitute: boolean;
  disabledSites: string[];
  allowedSites: string[];
};

export const SETTINGS_KEY = "settings";
export const DEFAULT_SETTINGS: Settings = { schema: 1, enabled: true, substitute: false, disabledSites: [], allowedSites: [] };

const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** "https://Foo.org:8080/x?y" → "foo.org"; undefined when it is not a hostname. */
export function normalizeHost(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  let s = input.trim().toLowerCase();
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
  return HOST_RE.test(s) ? s : undefined;
}

export const normalizeSites = (input: unknown): string[] =>
  Array.isArray(input) ? uniq(input.map(normalizeHost).filter((h): h is string => !!h)) : [];

/** Turns whatever is stored (or imported) into current-schema Settings; never throws. */
export function migrate(raw: unknown): Settings {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ...DEFAULT_SETTINGS };
  const r = raw as Record<string, unknown>;
  return {
    schema: 1,
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_SETTINGS.enabled,
    substitute: typeof r.substitute === "boolean" ? r.substitute : DEFAULT_SETTINGS.substitute,
    disabledSites: normalizeSites(r.disabledSites),
    allowedSites: normalizeSites(r.allowedSites),
  };
}

export async function getSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return migrate(stored[SETTINGS_KEY]);
}

export async function applyRulesets(s: Settings): Promise<void> {
  const on = (cond: boolean, id: string): [string[], string[]] => (cond ? [[id], []] : [[], [id]]);
  const [e1, d1] = on(s.enabled, "exact");
  const [e2, d2] = on(s.enabled && s.substitute, "substitute");
  await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds: [...e1, ...e2], disableRulesetIds: [...d1, ...d2] });
}

// Settings writes and the install-time restore are serialized: each is read-modify-write plus
// two DNR updates, and an interleaving would apply stale lists over fresh ones.
let queue: Promise<unknown> = Promise.resolve();
const serialize = <T>(task: () => Promise<T>): Promise<T> => {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
};

async function apply(next: Settings): Promise<void> {
  await applyRulesets(next);
  await applyExceptions(next);
}

/** Persists the migrated shape and re-applies stored settings (rulesets reset to manifest defaults on update). */
export const restoreSettings = (): Promise<void> =>
  serialize(async () => {
    const settings = await getSettings();
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    await apply(settings);
  });

export const setSettings = (patch: Partial<Omit<Settings, "schema">>): Promise<void> =>
  serialize(async () => {
    const next = migrate({ ...(await getSettings()), ...patch });
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
    await apply(next);
  });
