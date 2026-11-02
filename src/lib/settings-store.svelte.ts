import { getSettings } from "./api.ts";
import type { Settings } from "../shared/messages.ts";

/**
 * Reactive view of the stored settings; follows changes made by other extension pages.
 * Construct it during component initialisation (it registers an effect).
 */
export class SettingsStore {
  current = $state<Settings>();

  constructor() {
    void this.refresh();
    $effect(() => {
      const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
        if (area === "local" && changes.settings) void this.refresh();
      };
      chrome.storage.onChanged.addListener(onChanged);
      return () => chrome.storage.onChanged.removeListener(onChanged);
    });
  }

  async refresh(): Promise<void> {
    this.current = await getSettings();
  }
}
