import { parseManifest, type LibraryEntry } from "../shared/manifest-schema.ts";
import { send, type Candidate, type Settings, type StatsRange, type StatsResult } from "../shared/messages.ts";
import { parseConfig, serializeConfig, toggleSitePatch } from "./config.ts";

export type PopupState = { settings: Settings; tab: { host: string; count: number } };

const hostOf = (url: string | undefined): string => {
  try {
    const u = new URL(url ?? "");
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : "";
  } catch {
    return "";
  }
};

export const getSettings = (): Promise<Settings> => send({ type: "get-settings" });

export async function getState(): Promise<PopupState> {
  const [settings, [tab]] = await Promise.all([getSettings(), chrome.tabs.query({ active: true, currentWindow: true })]);
  const host = hostOf(tab?.url);
  const count = tab?.id !== undefined && host ? await send({ type: "get-tab-count", tabId: tab.id }) : 0;
  return { settings, tab: { host, count } };
}

export async function setGlobal(patch: Partial<Omit<Settings, "schema">>): Promise<void> {
  await send({ type: "set-settings", patch });
}

export async function toggleSite(host: string, enabled: boolean): Promise<void> {
  await setGlobal(toggleSitePatch(await getSettings(), host, enabled));
}

export const getStats = (range: StatsRange): Promise<StatsResult> => send({ type: "get-stats", range });

export const getObserved = (): Promise<Candidate[]> => send({ type: "get-observed" });

export const refreshLearned = (): Promise<number> => send({ type: "refresh-learned" });

export async function clearObserved(): Promise<void> {
  await send({ type: "clear-observed" });
}

export async function exportConfig(): Promise<string> {
  return serializeConfig(await getSettings());
}

/** Validates before touching anything: a rejected file leaves the current settings unchanged. */
export async function importConfig(json: string): Promise<void> {
  const { schema: _schema, ...settings } = parseConfig(json);
  await setGlobal(settings);
}

export async function getLibraries(): Promise<LibraryEntry[]> {
  const res = await fetch(chrome.runtime.getURL("libraries.json"));
  return parseManifest(await res.json());
}

export const openOptions = (): Promise<void> => chrome.runtime.openOptionsPage();
