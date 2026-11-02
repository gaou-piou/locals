export const EXTENSION_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApYCDwkUKdNMtweOtraeC2mVUpFoVztSBBk/yqHP1L38zhKVVQXB16xdWrtUAkFopWcnbOSYdiRbxseSnr6b00hFEy9AQ778Joz4tsNdC121ftD+dajTzzL5DmOz1rHMUTKFKCzB1fXErjf+/ruV7gnF3KULkZ3GlXnIkE5d13Wd9Q3turq/DIUpGw14d4pMDQvH8QIJnJ5UfuLAP8IHkBLaKpRHUx/B0mYSE4ZH7Ak/wxQOG7qTzFWxKt07bu8deaeWAQKuQRm23VQAy/s7rqJLjor8E2SM9pD05P5G+axtiUGCWx+1LwrWqhpvgH2Kg6Wplbtlu2jT2UONQXfVjKwIDAQAB";

export function createManifest(version: string): chrome.runtime.ManifestV3 {
  return {
    manifest_version: 3,
    name: "Locals",
    description: "Serves popular JavaScript libraries, stylesheets and fonts from a local copy instead of a CDN.",
    version,
    key: EXTENSION_KEY,
    minimum_chrome_version: "120",
    permissions: ["declarativeNetRequest", "declarativeNetRequestFeedback", "storage", "webRequest"],
    host_permissions: ["<all_urls>"],
    background: { service_worker: "background.js", type: "module" },
    action: { default_title: "Locals", default_popup: "popup/index.html" },
    options_ui: { page: "options/index.html", open_in_tab: true },
  };
}
