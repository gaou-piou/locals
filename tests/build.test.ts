import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

const dist = new URL("../dist/", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, dist), "utf8");

describe("build output", () => {
  beforeAll(() => {
    // Vitest sets VITEST and NODE_ENV=test; inherited by the build they switch Svelte to its dev/server code
    // (the popup then dies on mount) and this test would overwrite the real dist/. Build like a user does.
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production" };
    delete env.VITEST;
    delete env.VITEST_WORKER_ID;
    delete env.VITEST_POOL_ID;
    execFileSync("pnpm", ["build"], { cwd: new URL("../", import.meta.url), stdio: "pipe", env });
  }, 180_000);

  it("bundles the browser build of Svelte (the server build throws on mount: white popup)", () => {
    const assets = new URL("assets/", dist);
    const files = readdirSync(assets).filter((f) => f.endsWith(".js"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(readFileSync(new URL(f, assets), "utf8")).not.toContain("lifecycle_function_unavailable");
  });

  it("has an MV3 manifest with a key and no license field", () => {
    const m = JSON.parse(read("manifest.json"));
    expect(m.manifest_version).toBe(3);
    expect(typeof m.key).toBe("string");
    expect(m).not.toHaveProperty("license");
    expect(m.background.service_worker).toBe("background.js");
    expect(existsSync(new URL("background.js", dist))).toBe(true);
    expect(m.host_permissions).toEqual(["<all_urls>"]);
    expect(m.permissions).toEqual(
      expect.arrayContaining(["declarativeNetRequest", "declarativeNetRequestFeedback", "storage"]),
    );
  });

  it("ships every icon the manifest names", () => {
    const m = JSON.parse(read("manifest.json"));
    const paths = [...Object.values(m.icons ?? {}), ...Object.values(m.action.default_icon ?? {})] as string[];
    expect(Object.keys(m.icons ?? {})).toEqual(expect.arrayContaining(["16", "32", "48", "128"]));
    for (const p of paths) expect(existsSync(new URL(p, dist)), p).toBe(true);
  });

  it.each(["popup", "options"])("%s page has a mobile viewport and no fixed minimum width", (name) => {
    const html = read(`${name}/index.html`);
    expect(html).toMatch(/<meta name="viewport" content="width=device-width, initial-scale=1"/);
    expect(html).not.toMatch(/min-w-\[/);
  });

  it.each(["popup", "options"])("%s page is at the dist root and CSP-clean", (name) => {
    const html = read(`${name}/index.html`);
    expect(existsSync(new URL("src/", dist))).toBe(false);
    const inline = [...html.matchAll(/<script\b([^>]*)>/g)].filter((m) => !/\bsrc=/.test(m[1]));
    expect(inline).toEqual([]);
  });
});
