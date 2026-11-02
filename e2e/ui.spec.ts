import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { EXTENSION_KEY } from "../src/manifest";
import { extensionIdFromKey } from "../scripts/rules";
import { launchWithExtension } from "./extension";

const EXT = `chrome-extension://${extensionIdFromKey(EXTENSION_KEY)}`;
let ctx: BrowserContext;

test.beforeAll(async () => {
  ctx = await launchWithExtension("dist");
  if (!ctx.serviceWorkers().length) await ctx.waitForEvent("serviceworker");
});
test.afterAll(async () => {
  await ctx.close();
});

const settings = (page: Page) => page.evaluate(() => chrome.runtime.sendMessage({ type: "get-settings" }));

test("popup renders and links to the options page", async () => {
  const page = await ctx.newPage();
  await page.goto(`${EXT}/popup/index.html`);
  await expect(page.getByText("No website")).toBeVisible();
  await expect(page.getByRole("switch")).toBeDisabled();
  await page.screenshot({ path: "test-results/popup.png" });
  await expect(page.getByRole("button", { name: "Options" })).toBeVisible();
});

test("options: general, sites, stats, libraries and backup work end to end", async () => {
  const page = await ctx.newPage();
  await page.goto(`${EXT}/options/index.html`);
  await page.setViewportSize({ width: 900, height: 700 });

  // General
  const substitute = page.getByRole("switch", { name: "Substitute close versions" });
  await substitute.click();
  await expect.poll(async () => (await settings(page)).substitute).toBe(true);
  await expect(substitute).toBeChecked();
  await page.screenshot({ path: "test-results/options-general.png" });

  // Sites
  await page.getByRole("tab", { name: "Sites" }).click();
  await page.getByLabel("Add to “Never on these sites”").fill("https://Example.com/path");
  await page.getByRole("button", { name: "Add" }).first().click();
  await expect(page.getByText("example.com", { exact: true })).toBeVisible();
  await expect.poll(async () => (await settings(page)).disabledSites).toEqual(["example.com"]);
  await page.getByLabel("Add to “Only on these sites”").fill("not a host!");
  await page.getByRole("button", { name: "Add" }).nth(1).click();
  await expect(page.getByRole("alert")).toContainText("hostname");
  await page.screenshot({ path: "test-results/options-sites.png" });
  await page.getByRole("button", { name: "Remove example.com" }).click();
  await expect.poll(async () => (await settings(page)).disabledSites).toEqual([]);

  // Stats
  await page.getByRole("tab", { name: "Stats" }).click();
  await expect(page.getByText("Requests served from the extension")).toBeVisible();
  await page.screenshot({ path: "test-results/options-stats.png" });

  // Libraries
  await page.getByRole("tab", { name: "Libraries" }).click();
  await expect(page.getByRole("cell", { name: "jquery", exact: true })).toBeVisible();
  await page.getByRole("searchbox").fill("boot");
  await expect(page.getByRole("cell", { name: "jquery", exact: true })).toBeHidden();
  await expect(page.getByRole("cell", { name: "bootstrap", exact: true })).toBeVisible();
  await page.screenshot({ path: "test-results/options-libraries.png" });

  // Backup: a bad file is rejected and changes nothing; a schema-0 file is migrated
  await page.getByRole("tab", { name: "Backup" }).click();
  const input = page.locator('input[type="file"]');
  await input.setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from('{"evil":1}') });
  await expect(page.getByRole("alert")).toContainText("Invalid configuration");
  expect((await settings(page)).substitute).toBe(true);
  await input.setInputFiles({ name: "old.json", mimeType: "application/json", buffer: Buffer.from('{"substitute":false,"disabledSites":["Old.org"]}') });
  await expect(page.getByRole("status")).toHaveText("Settings imported.");
  await expect.poll(async () => settings(page)).toMatchObject({ substitute: false, disabledSites: ["old.org"] });
  await page.screenshot({ path: "test-results/options-backup.png" });
});
