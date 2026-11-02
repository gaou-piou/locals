#!/usr/bin/env node
// Downloads the candidates exported from the extension's "Discovered" tab into libs/learned/.
// A URL is only kept when two downloads return identical bytes, so it is safe to serve instead of the CDN.
// Usage: cdn-mirror-learn candidates.json [--dir ~/.local/share/cdn-mirror]
"use strict";
const { createHash } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MAX_BYTES = 2 * 1024 * 1024;
const EXT = { script: "js", stylesheet: "css", font: "woff2" };
const FONT_EXT = /\.(woff2?)$/i;

const args = process.argv.slice(2);
const dirAt = args.indexOf("--dir");
const dir = dirAt >= 0 ? args.splice(dirAt, 2)[1] : path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share"), "cdn-mirror");
const input = args[0];
if (!input) {
  console.error("usage: cdn-mirror-learn candidates.json [--dir <extension folder>]");
  process.exit(2);
}
const allowHttp = process.env.CDN_MIRROR_ALLOW_HTTP === "1";
const learnedDir = path.join(dir, "libs", "learned");
const indexPath = path.join(learnedDir, "index.json");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function download(url) {
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "cdn-mirror-learn" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0 || buf.length > MAX_BYTES) throw new Error(`size ${buf.length}`);
  return buf;
}

function readIndex() {
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    return raw && raw.schema === 1 && Array.isArray(raw.entries) ? raw.entries : [];
  } catch {
    return [];
  }
}

async function main() {
  const { candidates } = JSON.parse(fs.readFileSync(input, "utf8"));
  if (!Array.isArray(candidates)) throw new Error("no candidates array in input");
  fs.mkdirSync(learnedDir, { recursive: true });
  const entries = readIndex();
  let added = 0;
  for (const c of candidates) {
    const url = c && c.url;
    const type = c && c.type;
    if (typeof url !== "string" || !EXT[type]) continue;
    if (!/^https:\/\//.test(url) && !(allowHttp && /^http:\/\//.test(url))) {
      console.log(`skip (not https): ${url}`);
      continue;
    }
    if (entries.some((e) => e.url === url)) continue;
    try {
      const first = await download(url);
      const second = await download(url);
      if (sha256(first) !== sha256(second)) {
        console.log(`skip (unstable): ${url}`);
        continue;
      }
      const hash = sha256(first);
      const ext = type === "font" ? (FONT_EXT.exec(new URL(url).pathname) || [, "woff2"])[1].toLowerCase() : EXT[type];
      const file = `${hash}.${ext}`;
      fs.writeFileSync(path.join(learnedDir, file), first);
      entries.push({ url, file, sha256: hash, type });
      added++;
      console.log(`learned: ${url}`);
    } catch (err) {
      console.log(`skip (${err.message}): ${url}`);
    }
  }
  const tmp = `${indexPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ schema: 1, entries }, null, 2) + "\n");
  fs.renameSync(tmp, indexPath);
  console.log(`${added} added, ${entries.length} total. Press "Apply learned" in the extension's Discovered tab.`);
}

main().catch((err) => {
  console.error(`cdn-mirror-learn: ${err.message}`);
  process.exit(1);
});
