import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

const dist = new URL("../dist/", import.meta.url);
const read = (p: string) => readFileSync(new URL(p, dist), "utf8");

describe("build output", () => {
  beforeAll(() => {
    execFileSync("pnpm", ["build"], { cwd: new URL("../", import.meta.url), stdio: "pipe" });
  }, 180_000);

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

  it.each(["popup", "options"])("%s page is at the dist root and CSP-clean", (name) => {
    const html = read(`${name}/index.html`);
    expect(existsSync(new URL("src/", dist))).toBe(false);
    const inline = [...html.matchAll(/<script\b([^>]*)>/g)].filter((m) => !/\bsrc=/.test(m[1]));
    expect(inline).toEqual([]);
  });
});
