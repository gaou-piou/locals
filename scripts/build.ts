import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createManifest } from "../src/manifest.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const run = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

// 1. vite (empties dist/ first, so nothing below may run before it)
run("pnpm", ["exec", "vite", "build"]);

// 2. manifest
const { version } = JSON.parse(readFileSync(`${root}package.json`, "utf8"));
writeFileSync(`${root}dist/manifest.json`, JSON.stringify(createManifest(version), null, 2) + "\n");

// 2b. icons (PNGs rendered once from static/icons/icon.svg and committed: no rasteriser needed to build)
cpSync(`${root}static/icons`, `${root}dist/icons`, { recursive: true, filter: (p) => !p.endsWith(".svg") });

// 3. bundled libraries
if (existsSync(`${root}.cache/libs`)) cpSync(`${root}.cache/libs`, `${root}dist/libs`, { recursive: true });

// 3b. library metadata for the options UI
if (existsSync(`${root}libraries.json`)) cpSync(`${root}libraries.json`, `${root}dist/libraries.json`);

// 4. generated DNR rulesets + web_accessible_resources (added by the rule generator)
if (existsSync(`${root}scripts/gen-rules.ts`)) run("pnpm", ["gen:rules"]);
