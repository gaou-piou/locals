import { describe, expect, it } from "vitest";
import { parseManifest } from "../src/shared/manifest-schema.ts";

const H = "a".repeat(64);
const entry = (over: Record<string, unknown> = {}) => ({
  name: "jquery",
  npm: "jquery",
  license: "MIT",
  versions: [{ version: "3.7.1", files: [{ path: "dist/jquery.min.js", type: "script", sha256: H }] }],
  patterns: [
    {
      url: "https://cdnjs.cloudflare.com/ajax/libs/jquery/{version}/jquery.min.js",
      file: "dist/jquery.min.js",
      cdnSha256: { "3.7.1": H },
    },
  ],
  ...over,
});

describe("parseManifest", () => {
  it("accepts a valid entry", () => {
    const [e] = parseManifest([entry()]);
    expect(e.name).toBe("jquery");
    expect(e.patterns[0].cdnSha256).toEqual({ "3.7.1": H });
  });

  it("accepts a pattern without cdnSha256", () => {
    const e = entry();
    delete (e.patterns[0] as Record<string, unknown>).cdnSha256;
    expect(parseManifest([e])[0].patterns[0].cdnSha256).toBeUndefined();
  });

  it("rejects a non-hex sha256", () => {
    const e = entry({ versions: [{ version: "3.7.1", files: [{ path: "a.js", type: "script", sha256: "zz" }] }] });
    expect(() => parseManifest([e])).toThrow();
  });

  it("rejects a pattern without scheme and host", () => {
    const e = entry({ patterns: [{ url: "ajax/libs/jquery/{version}/jquery.min.js", file: "dist/jquery.min.js" }] });
    expect(() => parseManifest([e])).toThrow();
  });

  it("rejects a pattern without the {version} placeholder", () => {
    const e = entry({ patterns: [{ url: "https://cdnjs.cloudflare.com/jquery.min.js", file: "dist/jquery.min.js" }] });
    expect(() => parseManifest([e])).toThrow();
  });

  it.each(["../x.js", "a/../x.js", "/etc/x.js"])("rejects file path %s", (path) => {
    const e = entry({ versions: [{ version: "3.7.1", files: [{ path, type: "script", sha256: H }] }] });
    expect(() => parseManifest([e])).toThrow();
  });

  it.each(["..", "a/../b", "/abs"])("rejects library name %s", (name) => {
    expect(() => parseManifest([entry({ name })])).toThrow();
  });

  it("rejects a pattern whose file is not a file of any version", () => {
    const e = entry({ patterns: [{ url: "https://x.example/{version}/a.js", file: "nope.js" }] });
    expect(() => parseManifest([e])).toThrow();
  });

  it("rejects non-array input", () => {
    expect(() => parseManifest({})).toThrow();
  });
});
