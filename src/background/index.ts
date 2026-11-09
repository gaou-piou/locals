import type { Message } from "../shared/messages.ts";
import { applyLearned, excludeLearned, loadLearned } from "./learned.ts";
import { createMatcher, MAX_BODY_BYTES } from "./match.ts";
import { createObserver } from "./observe.ts";
import { getSettings, restoreSettings, setSettings } from "./settings.ts";
import { createStats, dayKey, isLibraryMatch } from "./stats.ts";

const stats = createStats({
  loadIndex: async () => (await fetch(chrome.runtime.getURL("rules/index.json"))).json(),
});

const observer = createObserver();

const matcher = createMatcher({
  loadLibraries: async () => (await fetch(chrome.runtime.getURL("libraries.json"))).json(),
  // the same request the page just made, without cookies; oversized bodies are never bundled libraries
  fetchBody: async (url) => {
    const res = await fetch(url, { credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(15_000) });
    const length = Number(res.headers.get("content-length") ?? 0);
    return res.ok && length <= MAX_BODY_BYTES ? res.arrayBuffer() : null;
  },
});
let lastPrune = 0;
const maybePrune = () => {
  if (Date.now() - lastPrune > 3_600_000) {
    lastPrune = Date.now();
    void matcher.prune().catch(() => {});
  }
};
const considerMatch = (d: { url: string; type: string }) => {
  maybePrune();
  void matcher.consider(d).catch((err) => console.warn("locals: match check failed", err));
};

/** Re-applies stored settings; rulesets reset to the manifest defaults when the extension updates. */
async function init(): Promise<void> {
  await restoreSettings();
  await applyLearned();
  await chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: true });
}

// Listeners are registered synchronously at top level: MV3 wakes the worker for them.
chrome.runtime.onInstalled.addListener(() => void init());
chrome.runtime.onStartup.addListener(() => {
  void chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: true });
  void applyLearned();
});
chrome.runtime.onSuspend.addListener(() => void Promise.all([stats.flush(), observer.flush()]));

// Only fires for unpacked extensions (declarativeNetRequestFeedback); this is the source of the stats.
// It is also what checks a byname redirect: the file was served by its name, its real bytes decide afterwards.
chrome.declarativeNetRequest.onRuleMatchedDebug?.addListener((info) => {
  if (!isLibraryMatch(info.rule)) return;
  stats.recordMatch(info.rule.ruleId, dayKey(new Date()), info.request.tabId);
  maybePrune();
  if (info.rule.rulesetId === "byname")
    void matcher.verify({ url: info.request.url, type: info.request.type }).catch((err) => console.warn("locals: verify failed", err));
});
// Observation only: nothing is fetched or redirected. Records third-party scripts/styles/fonts to learn from.
chrome.webRequest.onCompleted.addListener(
  (d) => {
    if (d.statusCode !== 200 || d.initiator?.startsWith(`chrome-extension://${chrome.runtime.id}`)) return; // not our own fetches
    observer.record({ url: d.url, initiator: d.initiator, type: d.type });
    console.debug("locals: completed", d.type, d.url);
    considerMatch(d);
  },
  {
    urls: ["http://*/*", "https://*/*"],
    types: ["script", "stylesheet", "font"],
  },
);
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
        return excludeLearned(await observer.getCandidates(), await loadLearned());
      case "get-pending":
        return excludeLearned(await observer.getPending(), await loadLearned());
      case "get-matched":
        return matcher.getMatched();
      case "get-rejected":
        return matcher.getRejected();
      case "get-learned":
        return loadLearned();
      case "refresh-learned":
        return applyLearned();
      case "clear-observed":
        await observer.clear();
        return null;
    }
  };
  respond().then(sendResponse, (err) => sendResponse({ error: String(err) }));
  return true; // async response
});
