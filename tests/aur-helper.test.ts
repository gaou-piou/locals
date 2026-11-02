import { execFileSync } from "node:child_process";
import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { root } from "../scripts/manifest-io.ts";
import { tmp } from "./helpers.ts";

const script = join(root, "packaging/aur/cdn-mirror-install");
const run = (src: string, data: string) =>
  execFileSync("sh", [script], { env: { ...process.env, CDN_MIRROR_SRC: src, XDG_DATA_HOME: data }, encoding: "utf8", stdio: "pipe" });

/** Chromium writes `_metadata/` into an unpacked extension, so a root-owned /usr/share copy cannot be loaded. */
describe("cdn-mirror-install", () => {
  it("copies the packaged extension into a user-writable directory and prints it", () => {
    const src = tmp();
    mkdirSync(join(src, "libs"));
    writeFileSync(join(src, "manifest.json"), "{}");
    writeFileSync(join(src, "libs/x.js"), "x");
    const data = tmp();
    const out = run(src, data);
    const dest = join(data, "cdn-mirror");
    expect(out).toContain(dest);
    expect(readFileSync(join(dest, "libs/x.js"), "utf8")).toBe("x");
    accessSync(join(dest, "manifest.json"), constants.W_OK);
  });

  it("refreshes an earlier copy and removes files that no longer exist", () => {
    const src = tmp();
    writeFileSync(join(src, "manifest.json"), '{"v":2}');
    const data = tmp();
    const dest = join(data, "cdn-mirror");
    mkdirSync(dest);
    writeFileSync(join(dest, "stale.js"), "old");
    run(src, data);
    expect(readFileSync(join(dest, "manifest.json"), "utf8")).toBe('{"v":2}');
    expect(() => accessSync(join(dest, "stale.js"))).toThrow();
  });

  it("fails loudly when the packaged extension is missing", () => {
    expect(() => run(join(tmp(), "nope"), tmp())).toThrow();
  });
});
