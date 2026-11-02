import { describe, expect, it, vi } from "vitest";
import { bumpLibs } from "../scripts/bump-libs.ts";
import { parseManifest, type LibraryEntry } from "../src/shared/manifest-schema.ts";

const Z = "0".repeat(64);
const ver = (version: string, path = "dist/x.min.js") => ({ version, files: [{ path, type: "script" as const, sha256: Z }] });
const entry = (name: string, versions: string[]): LibraryEntry => ({
  name,
  npm: name,
  license: "MIT",
  versions: versions.map((v) => ver(v)),
  patterns: [{ url: `https://cdn.example.com/${name}/{version}/x.min.js`, file: "dist/x.min.js" }],
});

/** Stand-in for hashLibs: stamps a recognisable hash on every file. */
const hash = vi.fn(async (entries: LibraryEntry[]) =>
  entries.map((e) => ({ ...e, versions: e.versions.map((v) => ({ ...v, files: v.files.map((f) => ({ ...f, sha256: "a".repeat(64) })) })) })),
);
const latest = (map: Record<string, string>) => async (npm: string) => map[npm]!;

describe("bumpLibs", () => {
  it("appends the newest version, keeps the existing ones and returns hashed, valid entries", async () => {
    const out = await bumpLibs([entry("jq", ["3.6.4", "3.7.1"])], latest({ jq: "3.8.0" }), hash);
    expect(out[0].versions.map((v) => v.version)).toEqual(["3.6.4", "3.7.1", "3.8.0"]);
    expect(out[0].versions[2].files[0].sha256).toBe("a".repeat(64));
    expect(() => parseManifest(out)).not.toThrow();
  });

  it("reuses the file layout of the newest pinned version", async () => {
    const e: LibraryEntry = { ...entry("jq", ["1.0.0"]), versions: [ver("1.0.0", "dist/a.js")], patterns: [{ url: "https://c.example.com/{version}/a.js", file: "dist/a.js" }] };
    const out = await bumpLibs([e], latest({ jq: "1.1.0" }), hash);
    expect(out[0].versions[1].files.map((f) => f.path)).toEqual(["dist/a.js"]);
  });

  it("does nothing when the newest version is already pinned, or older than what is pinned", async () => {
    const e = entry("jq", ["3.7.1"]);
    expect(await bumpLibs([e], latest({ jq: "3.7.1" }), hash)).toEqual([e]);
    expect(await bumpLibs([e], latest({ jq: "3.6.0" }), hash)).toEqual([e]);
  });

  it("ignores prereleases", async () => {
    const e = entry("jq", ["3.7.1"]);
    expect(await bumpLibs([e], latest({ jq: "4.0.0-beta.2" }), hash)).toEqual([e]);
  });

  it("caps pinned versions at the 3 newest per major, dropping the oldest of that major only", async () => {
    const out = await bumpLibs([entry("lib", ["1.0.0", "1.1.0", "1.2.0", "2.0.0"])], latest({ lib: "1.3.0" }), hash);
    expect(out[0].versions.map((v) => v.version)).toEqual(["1.1.0", "1.2.0", "1.3.0", "2.0.0"]);
  });

  it("keeps versions sorted ascending by semver, not lexically", async () => {
    const out = await bumpLibs([entry("lib", ["1.9.0"])], latest({ lib: "1.10.0" }), hash);
    expect(out[0].versions.map((v) => v.version)).toEqual(["1.9.0", "1.10.0"]);
  });

  it("leaves a library unchanged when its new version cannot be fetched or hashed, and still bumps the others", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing = vi.fn(async (entries: LibraryEntry[]) => {
      if (entries[0].name === "bad") throw new Error("file missing");
      return hash(entries);
    });
    const bad = entry("bad", ["1.0.0"]);
    const out = await bumpLibs([bad, entry("good", ["1.0.0"])], latest({ bad: "1.1.0", good: "1.1.0" }), failing);
    expect(out[0]).toEqual(bad);
    expect(out[1].versions.map((v) => v.version)).toEqual(["1.0.0", "1.1.0"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("bad"));
    warn.mockRestore();
  });

  it("does not mutate its input", async () => {
    const input = [entry("jq", ["3.7.1"])];
    const copy = structuredClone(input);
    await bumpLibs(input, latest({ jq: "3.8.0" }), hash);
    expect(input).toEqual(copy);
  });

  it("hashes only the new version, so a flaky CDN cannot erase the hashes already pinned", async () => {
    const seen: string[][] = [];
    const spy = vi.fn(async (entries: LibraryEntry[]) => {
      seen.push(entries[0].versions.map((v) => v.version));
      return hash(entries);
    });
    const old = entry("jq", ["3.7.1"]);
    old.patterns[0].cdnSha256 = { "3.7.1": "b".repeat(64) };
    const out = await bumpLibs([old], latest({ jq: "3.8.0" }), spy);
    expect(seen).toEqual([["3.8.0"]]);
    expect(out[0].versions.map((v) => v.version)).toEqual(["3.7.1", "3.8.0"]);
    expect(out[0].versions[0].files[0].sha256).toBe(Z); // untouched, not re-hashed
    expect(out[0].patterns[0].cdnSha256).toEqual({ "3.7.1": "b".repeat(64) });
  });

  it("adds the new version's CDN hash next to the existing ones", async () => {
    const withCdn = (entries: LibraryEntry[]) =>
      hash(entries).then((r) => r.map((e) => ({ ...e, patterns: e.patterns.map((p) => ({ ...p, cdnSha256: { [e.versions[0].version]: "c".repeat(64) } })) })));
    const old = entry("jq", ["3.7.1"]);
    old.patterns[0].cdnSha256 = { "3.7.1": "b".repeat(64) };
    const out = await bumpLibs([old], latest({ jq: "3.8.0" }), withCdn);
    expect(out[0].patterns[0].cdnSha256).toEqual({ "3.7.1": "b".repeat(64), "3.8.0": "c".repeat(64) });
  });

  it("drops cdn hashes of versions that were pruned", async () => {
    const old = entry("lib", ["1.0.0", "1.1.0", "1.2.0"]);
    old.patterns[0].cdnSha256 = { "1.0.0": "b".repeat(64), "1.1.0": "b".repeat(64), "1.2.0": "b".repeat(64) };
    const out = await bumpLibs([old], latest({ lib: "1.3.0" }), hash);
    expect(Object.keys(out[0].patterns[0].cdnSha256 ?? {})).not.toContain("1.0.0");
    expect(() => parseManifest(out)).not.toThrow();
  });
});
