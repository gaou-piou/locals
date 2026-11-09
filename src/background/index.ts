import type { Message } from "../shared/messages.ts";
import { createCache } from "./cache.ts";
import { applyLearned, excludeLearned, loadLearned } from "./learned.ts";
import { createMatcher, MAX_BODY_BYTES } from "./match.ts";
import { createObserver } from "./observe.ts";
import { getSettings, restoreSettings, setSettings } from "./settings.ts";
import { badgeText, badgeTitle } from "./badge.ts";
import { createStats, dayKey, isLibraryMatch, matchSource, type TabCount } from "./stats.ts";

/** Per-tab badge: requests served from saved copies, and from detected self-hosted copies. A closed tab just rejects. */
const showTabCount = (tabId: number, count: TabCount) => {
  void chrome.action.setBadgeText({ tabId, text: badgeText(count) }).catch(() => {});
  void chrome.action.setTitle({ tabId, title: count.saved + count.detected ? badgeTitle(count) : "λocals" }).catch(() => {});
};
/** The badge is ours: the built-in action count cannot tell saved from detected copies. */
const setupBadge = async () => {
  await chrome.declarativeNetRequest.setExtensionActionOptions({ displayActionCountAsBadgeText: false });
  await chrome.action.setBadgeBackgroundColor({ color: "#059669" });
  await chrome.action.setBadgeTextColor?.({ color: "#ffffff" });
};

const stats = createStats({
  loadIndex: async () => (await fetch(chrome.runtime.getURL("rules/index.json"))).json(),
  onTabCount: showTabCount,
});

const observer = createObserver();

/** The same request the page just made, without cookies; oversized bodies are never bundled libraries nor cached. */
const fetchFile = async (url: string): Promise<{ body: ArrayBuffer; contentType: string } | null> => {
  const res = await fetch(url, { credentials: "omit", cache: "no-store", signal: AbortSignal.timeout(15_000) });
  const length = Number(res.headers.get("content-length") ?? 0);
  return res.ok && length <= MAX_BODY_BYTES ? { body: await res.arrayBuffer(), contentType: res.headers.get("content-type") ?? "" } : null;
};

const matcher = createMatcher({
  loadLibraries: async () => (await fetch(chrome.runtime.getURL("libraries.json"))).json(),
  fetchBody: async (url) => (await fetchFile(url))?.body ?? null,
});

const cache = createCache({
  fetchBody: fetchFile,
  sitesOf: observer.sitesOf,
  isBundled: matcher.isBundled,
  enabled: async () => {
    const s = await getSettings();
    return s.enabled && s.autoCache;
  },
});
const refreshGates = () => void cache.refreshGates().catch((err) => console.warn("locals: cache gate failed", err));
let lastPrune = 0;
const maybePrune = () => {
  if (Date.now() - lastPrune > 3_600_000) {
    lastPrune = Date.now();
    void matcher.prune().catch(() => {});
    void cache.prune().catch(() => {});
  }
};
const considerMatch = (d: { url: string; type: string }) => {
  maybePrune();
  void matcher.consider(d).catch((err) => console.warn("locals: match check failed", err));
  void cache.consider(d).catch((err) => console.warn("locals: cache check failed", err));
};

/** Re-applies stored settings; rulesets reset to the manifest defaults when the extension updates. */
async function init(): Promise<void> {
  await restoreSettings();
  await applyLearned();
  await setupBadge();
  refreshGates();
}

// Listeners are registered synchronously at top level: MV3 wakes the worker for them.
chrome.runtime.onInstalled.addListener(() => void init());
chrome.runtime.onStartup.addListener(() => {
  void setupBadge();
  void applyLearned();
  refreshGates();
});
chrome.runtime.onSuspend.addListener(() => void Promise.all([stats.flush(), observer.flush(), cache.flush()]));

// Only fires for unpacked extensions (declarativeNetRequestFeedback); this is the source of the stats.
// It is also what checks a byname redirect: the file was served by its name, its real bytes decide afterwards.
chrome.declarativeNetRequest.onRuleMatchedDebug?.addListener((info) => {
  if (!isLibraryMatch(info.rule)) return;
  stats.recordMatch(info.rule.ruleId, dayKey(new Date()), info.request.tabId, matchSource(info.rule));
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
// A new page in the tab starts its count at zero. The page's own request is the signal: it reaches the worker before
// any request of that page, while tabs.onUpdated("loading") can arrive after the first redirects and wipe them.
// frameId 0 is the tab's visible page (not a prerender); same-document navigations make no request and keep the count.
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.frameId === 0 && d.tabId >= 0) stats.resetTab(d.tabId);
  },
  { urls: ["<all_urls>"], types: ["main_frame"] },
);
// auto-cache: which documents allow data: copies (CSP), which copies a page asked for, and which ones it blocked.
chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    const headers = (d.responseHeaders ?? []).filter((h) => h.name.toLowerCase() === "content-security-policy").map((h) => h.value ?? "");
    void cache.noteDocument({ url: d.url, headers }).catch(() => {});
  },
  { urls: ["http://*/*", "https://*/*"], types: ["main_frame", "sub_frame"] },
  ["responseHeaders"],
);
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    cache.touch(d.url);
  },
  { urls: ["http://*/*", "https://*/*"], types: ["script", "stylesheet", "font"] },
);
// A copy the page's CSP blocked (a <meta> policy, a stricter subdomain) aborts: the host stops getting copies and the
// tab reloads once, now from the network. noteAborted is true only when the host flips, so this cannot loop.
chrome.webRequest.onErrorOccurred.addListener(
  (d) => {
    if (d.error !== "net::ERR_ABORTED") return;
    void cache
      .noteAborted({ url: d.url, type: d.type, initiator: d.initiator })
      .then((flipped) => (flipped && d.tabId >= 0 ? chrome.tabs.reload(d.tabId) : undefined))
      .catch(() => {});
  },
  { urls: ["http://*/*", "https://*/*"], types: ["script", "stylesheet"] },
);
chrome.tabs.onRemoved.addListener((tabId) => stats.resetTab(tabId));

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  const respond = async () => {
    switch (message.type) {
      case "get-settings":
        return getSettings();
      case "set-settings":
        await setSettings(message.patch);
        refreshGates();
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
      case "get-cached":
        return cache.list();
      case "clear-cached":
        await cache.clear();
        return null;
      case "clear-observed":
        await observer.clear();
        return null;
    }
  };
  respond().then(sendResponse, (err) => sendResponse({ error: String(err) }));
  return true; // async response
});
