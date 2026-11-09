import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HttpError, buildLibs, hashLibs, registryTarballUrl } from "../scripts/lib-pipeline.ts";
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

  // A bundled stylesheet is served from chrome-extension://, so its relative font URLs resolve inside the extension.
  // An @font-face none of whose sources is bundled loads nothing: the icons on the page break.
  describe("stylesheet fonts", () => {
    const FACE = (srcs: string) => `@font-face{font-family:"X";src:${srcs}}.i{font-family:"X"}`;
    const css = (body: string, extra: Record<string, string> = {}) => {
      const files = [{ path: "css/all.min.css", type: "stylesheet" as const, sha256: sha(body) }, ...Object.keys(extra).map((path) => ({ path, type: "font" as const, sha256: sha(extra[path]) }))];
      const entry = entryFor({ name: "fa", npm: "fa", versions: [{ version: "6.0.0", files }] });
      const t = () => makeTarball({ "css/all.min.css": body, LICENSE: "x", ...extra });
      return buildLibs([entry], { outDir: tmp(), fetchTarball: t });
    };

    it("throws when no source of an @font-face is bundled", async () => {
      await expect(css(FACE(`url(../webfonts/v4.woff2) format("woff2"),url(../webfonts/v4.ttf) format("truetype")`))).rejects.toThrow(
        "font missing: fa@6.0.0 css/all.min.css needs one of webfonts/v4.woff2, webfonts/v4.ttf",
      );
    });

    it("accepts an @font-face when one of its sources is bundled", async () => {
      await expect(css(FACE(`url(../webfonts/s.woff2) format("woff2"),url(../webfonts/s.ttf)`), { "webfonts/s.woff2": "w2" })).resolves.toBeUndefined();
    });

    it("ignores absolute, protocol-relative and data: sources, query strings and fragments", async () => {
      const body =
        FACE(`url("https://fonts.example/a.woff2")`) + FACE(`url(//cdn.example/b.woff2)`) + FACE(`url(data:font/woff2;base64,AAAA)`) + FACE(`url('../webfonts/q.woff2?v=4.7.0#iefix')`);
      await expect(css(body, { "webfonts/q.woff2": "q" })).resolves.toBeUndefined();
    });
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
      fetchUrl: async (url) => {
        throw new HttpError(url, 404);
      },
    });
    expect(e.patterns[0].cdnSha256).toBeUndefined();
  });

  it("does not mistake a transient CDN failure (503, network error) for a missing version", async () => {
    const deps = (fail: (url: string) => Error) => ({ fetchTarball: async () => tarball(), fetchUrl: async (url: string): Promise<Buffer> => Promise.reject(fail(url)) });
    await expect(hashLibs([placeholder()], deps((u) => new HttpError(u, 503)))).rejects.toThrow(/503/);
    await expect(hashLibs([placeholder()], deps(() => new TypeError("fetch failed")))).rejects.toThrow(/fetch failed/);
  });
});
