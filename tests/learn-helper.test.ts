import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { root } from "../scripts/manifest-io.ts";
import { parseLearnedIndex } from "../src/background/learned.ts";
import { tmp } from "./helpers.ts";

const script = join(root, "packaging/aur/cdn-mirror-learn.cjs");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

let server: http.Server;
let origin = "";
let flip = 0;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/ok@1.2.3.js") return void res.writeHead(200).end("console.log(1)");
    if (req.url === "/moving@1.2.3.js") return void res.writeHead(200).end(`console.log(${flip++})`);
    if (req.url === "/big@1.2.3.js") return void res.writeHead(200).end("x".repeat(3_000_000));
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function learn(urls: string[], dir = tmp()) {
  const file = join(tmp(), "c.json");
  writeFileSync(file, JSON.stringify({ schema: 1, candidates: urls.map((u) => ({ url: u, type: "script", sites: 2, hits: 3 })) }));
  const { stdout } = await promisify(execFile)("node", [script, file, "--dir", dir], { env: { ...process.env, CDN_MIRROR_ALLOW_HTTP: "1" } });
  return { dir, stdout };
}
const index = (dir: string) => parseLearnedIndex(JSON.parse(readFileSync(join(dir, "libs/learned/index.json"), "utf8")));

describe("cdn-mirror-learn", () => {
  it("stores a stable file under its hash and lists it in the index", async () => {
    const { dir } = await learn([`${origin}/ok@1.2.3.js`]);
    const h = sha("console.log(1)");
    expect(readFileSync(join(dir, `libs/learned/${h}.js`), "utf8")).toBe("console.log(1)");
    expect(index(dir)).toEqual([{ url: `${origin}/ok@1.2.3.js`, file: `${h}.js`, sha256: h, type: "script" }]);
  });

  it("rejects a URL whose bytes change between two downloads", async () => {
    const { dir, stdout } = await learn([`${origin}/moving@1.2.3.js`]);
    expect(index(dir)).toEqual([]);
    expect(stdout).toMatch(/unstable/);
  });

  it("skips errors and oversized files without failing the rest", async () => {
    const { dir } = await learn([`${origin}/missing@1.2.3.js`, `${origin}/big@1.2.3.js`, `${origin}/ok@1.2.3.js`]);
    expect(index(dir).map((e) => e.url)).toEqual([`${origin}/ok@1.2.3.js`]);
  });

  it("keeps earlier entries when run again and does not duplicate", async () => {
    const dir = tmp();
    await learn([`${origin}/ok@1.2.3.js`], dir);
    await learn([`${origin}/ok@1.2.3.js`], dir);
    expect(index(dir)).toHaveLength(1);
  });

  it("refuses plain http unless explicitly allowed", async () => {
    const file = join(tmp(), "c.json");
    writeFileSync(file, JSON.stringify({ schema: 1, candidates: [{ url: `${origin}/ok@1.2.3.js`, type: "script" }] }));
    const dir = tmp();
    const env = { ...process.env, CDN_MIRROR_ALLOW_HTTP: "" };
    await promisify(execFile)("node", [script, file, "--dir", dir], { env });
    expect(existsSync(join(dir, "libs/learned/index.json")) ? index(dir) : []).toEqual([]);
  });
});
