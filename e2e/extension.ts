import { chromium, type BrowserContext } from "@playwright/test";
import path from "node:path";
import os from "node:os";
import { mkdtemp } from "node:fs/promises";

/** Launches bundled Chromium with an unpacked extension; CDN hosts can be made unreachable. */
export async function launchWithExtension(
  extensionDir: string,
  opts: { blockedHosts?: string[]; userDataDir?: string } = {},
): Promise<BrowserContext> {
  const userDataDir = opts.userDataDir ?? (await mkdtemp(path.join(os.tmpdir(), "cdn-mirror-")));
  const rules = (opts.blockedHosts ?? []).map((h) => `MAP ${h} ~NOTFOUND`).join(",");
  return chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: true,
    args: [
      `--disable-extensions-except=${path.resolve(extensionDir)}`,
      `--load-extension=${path.resolve(extensionDir)}`,
      ...(rules ? [`--host-resolver-rules=${rules}`] : []),
    ],
  });
}
