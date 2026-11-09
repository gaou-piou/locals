import { describe, expect, it } from "vitest";
import { keptFiles, mergeProbe, pickVersions, urlsFor } from "../scripts/expand-libs.ts";
import type { LibSpec } from "../scripts/libs-spec.ts";
import type { LibraryEntry } from "../src/shared/manifest-schema.ts";

const sha = (c: string) => c.repeat(64);

describe("pickVersions", () => {
  it("keeps every stable version below the cap", () => {
    expect(pickVersions(["1.0.0", "1.0.1", "1.1.0"], { max: 5 })).toEqual(["1.0.0", "1.0.1", "1.1.0"]);
  });
  it("thins to the last patch of each minor when over the cap, newest kept", () => {
    const all = ["1.0.0", "1.0.1", "1.1.0", "1.1.1", "1.2.0"];
    expect(pickVersions(all, { max: 3 })).toEqual(["1.0.1", "1.1.1", "1.2.0"]);
  });
  it("honours since and only", () => {
    expect(pickVersions(["1.9.0", "2.0.0", "3.0.0"], { since: "2.0.0", only: /^[23]\./ })).toEqual(["2.0.0", "3.0.0"]);
  });
});

describe("urlsFor", () => {
  const spec: LibSpec = { name: "x", npm: "x-pkg", cdnjs: "x.js", files: [] };
  it("covers jsDelivr, unpkg and every cdnjs mirror, plus explicit hosts", () => {
    const urls = urlsFor(spec, { path: "dist/x.min.js", type: "script", cdnjs: "x.min.js", hosts: ["https://h.example/{version}/x.js"] });
    expect(urls).toContain("https://cdn.jsdelivr.net/npm/x-pkg@{version}/dist/x.min.js");
    expect(urls).toContain("https://unpkg.com/x-pkg@{version}/dist/x.min.js");
    expect(urls).toContain("https://cdn.bootcdn.net/ajax/libs/x.js/{version}/x.min.js");
    expect(urls).toContain("https://cdn.staticfile.org/x.js/{version}/x.min.js");
    expect(urls).toContain("https://h.example/{version}/x.js");
  });
  it("skips the cdnjs mirrors for a file cdnjs does not ship", () => {
    expect(urlsFor(spec, { path: "a.js", type: "script" })).toHaveLength(2);
  });
});

describe("mergeProbe", () => {
  const base: LibraryEntry = {
    name: "x",
    npm: "x",
    license: "MIT",
    versions: [{ version: "1.0.0", files: [{ path: "a.js", type: "script", sha256: sha("a") }] }],
    patterns: [{ url: "https://u/{version}/a.js", file: "a.js", cdnSha256: { "1.0.0": sha("a") } }],
  };
  it("adds a version and a pattern hit without touching existing ones", () => {
    const out = mergeProbe(base, {
      version: "1.1.0",
      license: "MIT",
      files: [{ path: "a.js", type: "script", sha256: sha("b") }],
      hits: new Map([["https://u/{version}/a.js|a.js", sha("b")], ["https://v/{version}/a.js|a.js", sha("b")]]),
    });
    expect(out.versions.map((v) => v.version)).toEqual(["1.0.0", "1.1.0"]);
    expect(out.patterns).toHaveLength(2);
    expect(out.patterns[0].cdnSha256).toEqual({ "1.0.0": sha("a"), "1.1.0": sha("b") });
  });
  it("never replaces a pinned hash", () => {
    const out = mergeProbe(base, { version: "1.0.0", license: "MIT", files: [{ path: "a.js", type: "script", sha256: sha("z") }], hits: new Map() });
    expect(out.versions[0].files[0].sha256).toBe(sha("a"));
  });
});

describe("keptFiles", () => {
  const css = { path: "css/x.css", type: "stylesheet" as const };
  const font = (path: string) => ({ path, type: "font" as const, companion: true });

  it("keeps files a CDN serves, plus companions only when something was served", () => {
    const present = [css, font("fonts/a.woff2")];
    expect(keptFiles(present, new Set(["css/x.css"])).map((f) => f.path)).toEqual(["css/x.css", "fonts/a.woff2"]);
    expect(keptFiles(present, new Set())).toEqual([]);
  });

  it("keeps a .woff companion only when the package has no .woff2 of the same font", () => {
    const present = [css, font("fonts/a.woff2"), font("fonts/a.woff"), font("fonts/b.woff")];
    expect(keptFiles(present, new Set(["css/x.css"])).map((f) => f.path)).toEqual(["css/x.css", "fonts/a.woff2", "fonts/b.woff"]);
  });
});
