import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildLibs, hashLibs, registryTarballUrl } from "../scripts/lib-pipeline.ts";
import type { LibraryEntry } from "../src/shared/manifest-schema.ts";
import { makeTarball, sha, tmp } from "./helpers.ts";

const JS = "/* jquery */";
const entryFor = (over: Partial<LibraryEntry> = {}): LibraryEntry => ({
  name: "jquery",
  npm: "jquery",
  license: "MIT",
  versions: [{ version: "3.7.1", files: [{ path: "dist/jquery.min.js", type: "script", sha256: sha(JS) }] }],
  patterns: [{ url: "https://cdn.example/jquery/{version}/jquery.min.js", file: "dist/jquery.min.js" }],
  ...over,
});
const tarball = () => makeTarball({ "dist/jquery.min.js": JS, "LICENSE.txt": "MIT License text" });

describe("registryTarballUrl", () => {
  it("builds unscoped URLs", () => {
    expect(registryTarballUrl("jquery", "3.7.1")).toBe("https://registry.npmjs.org/jquery/-/jquery-3.7.1.tgz");
  });
  it("builds scoped URLs", () => {
    expect(registryTarballUrl("@fortawesome/fontawesome-free", "6.5.1")).toBe(
      "https://registry.npmjs.org/@fortawesome/fontawesome-free/-/fontawesome-free-6.5.1.tgz",
    );
  });
});

describe("buildLibs", () => {
  it("writes files and the package LICENSE under <name>/<version>/", async () => {
    const outDir = tmp();
    const calls: string[] = [];
    await buildLibs([entryFor()], {
      outDir,
      fetchTarball: async (pkg, version) => {
        calls.push(`${pkg}@${version}`);
        return tarball();
      },
    });
    expect(calls).toEqual(["jquery@3.7.1"]);
    expect(readFileSync(join(outDir, "jquery/3.7.1/dist/jquery.min.js"), "utf8")).toBe(JS);
    expect(readFileSync(join(outDir, "jquery/3.7.1/LICENSE"), "utf8")).toBe("MIT License text");
  });

  it("throws on sha256 mismatch and writes nothing", async () => {
    const outDir = tmp();
    const bad = entryFor({
      versions: [{ version: "3.7.1", files: [{ path: "dist/jquery.min.js", type: "script", sha256: "0".repeat(64) }] }],
    });
    await expect(buildLibs([bad], { outDir, fetchTarball: async () => tarball() })).rejects.toThrow(
      "sha256 mismatch: jquery@3.7.1",
    );
    expect(readdirSync(outDir)).toEqual([]);
  });

  it("writes nothing for any library when a later one mismatches", async () => {
    const outDir = tmp();
    const bad = entryFor({
      name: "bad",
      versions: [{ version: "1.0.0", files: [{ path: "dist/jquery.min.js", type: "script", sha256: "1".repeat(64) }] }],
    });
    await expect(buildLibs([entryFor(), bad], { outDir, fetchTarball: async () => tarball() })).rejects.toThrow(
      "sha256 mismatch: bad@1.0.0",
    );
    expect(existsSync(join(outDir, "jquery"))).toBe(false);
  });

  it("passes a scoped package name to fetchTarball", async () => {
    const outDir = tmp();
    const seen: string[] = [];
    const fa = entryFor({
      name: "fontawesome",
      npm: "@fortawesome/fontawesome-free",
      versions: [{ version: "6.5.1", files: [{ path: "dist/jquery.min.js", type: "script", sha256: sha(JS) }] }],
    });
    await buildLibs([fa], { outDir, fetchTarball: async (pkg) => (seen.push(pkg), tarball()) });
    expect(seen).toEqual(["@fortawesome/fontawesome-free"]);
  });

  it("throws when the package has no license file", async () => {
    const t = () => makeTarball({ "dist/jquery.min.js": JS });
    await expect(buildLibs([entryFor()], { outDir: tmp(), fetchTarball: t })).rejects.toThrow(
      "license missing: jquery@3.7.1",
    );
  });

  it("throws when a listed file is missing from the tarball", async () => {
    const t = () => makeTarball({ "LICENSE": "x" });
    await expect(buildLibs([entryFor()], { outDir: tmp(), fetchTarball: t })).rejects.toThrow(
      "file missing: jquery@3.7.1 dist/jquery.min.js",
    );
  });
});

describe("hashLibs", () => {
  const placeholder = () =>
    entryFor({
      versions: [{ version: "3.7.1", files: [{ path: "dist/jquery.min.js", type: "script", sha256: "0".repeat(64) }] }],
    });

  it("fills sha256 from npm and cdnSha256 equal to it when the CDN serves the same bytes", async () => {
    const [e] = await hashLibs([placeholder()], {
      fetchTarball: async () => tarball(),
      fetchUrl: async (url) => {
        expect(url).toBe("https://cdn.example/jquery/3.7.1/jquery.min.js");
        return Buffer.from(JS);
      },
    });
    expect(e.versions[0].files[0].sha256).toBe(sha(JS));
    expect(e.patterns[0].cdnSha256).toEqual({ "3.7.1": sha(JS) });
  });

  it("keeps cdnSha256 different from sha256 when the CDN bytes differ", async () => {
    const [e] = await hashLibs([placeholder()], {
      fetchTarball: async () => tarball(),
      fetchUrl: async () => Buffer.from("re-minified"),
    });
    expect(e.patterns[0].cdnSha256!["3.7.1"]).toBe(sha("re-minified"));
    expect(e.patterns[0].cdnSha256!["3.7.1"]).not.toBe(e.versions[0].files[0].sha256);
  });

  it("omits the version when the CDN does not have it", async () => {
    const [e] = await hashLibs([placeholder()], {
      fetchTarball: async () => tarball(),
      fetchUrl: async () => {
        throw new Error("404");
      },
    });
    expect(e.patterns[0].cdnSha256).toBeUndefined();
  });
});
