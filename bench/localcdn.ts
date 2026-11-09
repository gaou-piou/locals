/**
 * LocalCDN's own URL → bundled-resource logic, run in a Node vm. LocalCDN is Firefox-only (MV2, blocking webRequest),
 * so it cannot be loaded in Chromium; its core files are plain browser scripts that share globals, which a vm context
 * reproduces. The browser APIs they touch at load time are stubbed; the decision itself is LocalCDN's code unchanged,
 * as on Firefox (BrowserType.FIREFOX).
 */
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { LOCALCDN } from "./config.ts";

const FILES = [
  "core/constants.js",
  "modules/internal/helpers.js",
  "modules/internal/targets.js",
  "core/resources.js",
  "core/mappings.js",
  "core/shorthands.js",
  "core/request-analyzer.js",
];

export type LocalcdnTarget = { path: string; versionRequested?: string; versionDelivered?: string } | null;

export function loadLocalcdn(dir = LOCALCDN.dir) {
  const noop = () => {};
  const ctx = vm.createContext({
    console: { log: noop, warn: noop, error: noop, info: noop, debug: noop },
    URL,
    browser: { storage: { onChanged: { addListener: noop } }, runtime: { getURL: (p: string) => p, getManifest: () => ({ version: "0" }) } },
    chrome: undefined,
    navigator: { userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0" },
    storageManager: { ready: new Promise(noop), type: { get: noop } },
    log: { append: noop, console: noop },
  });
  for (const f of FILES) vm.runInContext(readFileSync(`${dir}/${f}`, "utf8"), ctx, { filename: f });
  vm.runInContext("BrowserType.FIREFOX = true; BrowserType.CHROMIUM = false;", ctx);
  const analyzer = vm.runInContext("requestAnalyzer", ctx);
  const cdn: Record<string, unknown> = vm.runInContext("mappings.cdn", ctx);

  /** The local file LocalCDN would serve for this URL, or null. `initiator` is the page origin. */
  return (url: string, initiator: string): LocalcdnTarget => {
    const u = new URL(url);
    if (!cdn[u.host]) return null;
    // isValidCandidate: Firefox branch, GET only
    if (initiator.includes("yandex.com") && url.includes("yastatic.net")) return null;
    try {
      const t = analyzer.getLocalTarget({ url }, initiator);
      return t && typeof t.path === "string" ? { path: t.path, versionRequested: t.versionRequested, versionDelivered: t.versionDelivered } : null;
    } catch {
      return null;
    }
  };
}
