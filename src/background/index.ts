import type { Message } from "../shared/messages.ts";
import { createObserver } from "./observe.ts";
import { getSettings, restoreSettings, setSettings } from "./settings.ts";
import { createStats, dayKey, isLibraryMatch } from "./stats.ts";

const stats = createStats({
  loadIndex: async () => (await fetch(chrome.runtime.getURL("rules/index.json"))).json(),
});

const observer = createObserver();

/** Re-applies stored settings; rulesets reset to the manifest defaults when the extension updates. */
async function init(): Promise<void> {
  await restoreSettings();
  await chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: true });
}

// Listeners are registered synchronously at top level: MV3 wakes the worker for them.
chrome.runtime.onInstalled.addListener(() => void init());
chrome.runtime.onStartup.addListener(() => void chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: true }));
chrome.runtime.onSuspend.addListener(() => void Promise.all([stats.flush(), observer.flush()]));

// Only fires for unpacked extensions (declarativeNetRequestFeedback); this is the source of the stats.
chrome.declarativeNetRequest.onRuleMatchedDebug?.addListener((info) => {
  if (!isLibraryMatch(info.rule)) return;
  stats.recordMatch(info.rule.ruleId, dayKey(new Date()), info.request.tabId);
});
// Observation only: nothing is fetched or redirected. Records third-party scripts/styles/fonts to learn from.
chrome.webRequest.onCompleted.addListener((d) => d.statusCode === 200 && observer.record({ url: d.url, initiator: d.initiator, type: d.type }), {
  urls: ["http://*/*", "https://*/*"],
  types: ["script", "stylesheet", "font"],
});
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "loading") stats.resetTab(tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => stats.resetTab(tabId));

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  const respond = async () => {
    switch (message.type) {
      case "get-settings":
        return getSettings();
      case "set-settings":
        await setSettings(message.patch);
        return null;
      case "get-stats":
        return stats.getStats(message.range);
      case "get-tab-count":
        return stats.getTabCount(message.tabId);
      case "get-observed":
        return observer.getCandidates();
      case "clear-observed":
        await observer.clear();
        return null;
    }
  };
  respond().then(sendResponse, (err) => sendResponse({ error: String(err) }));
  return true; // async response
});
