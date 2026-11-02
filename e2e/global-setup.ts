import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";

/** The e2e specs load `dist/`; build it once up front. Needs `.cache/libs` (pnpm build:libs). */
export default function globalSetup() {
  execFileSync("pnpm", ["build"], { stdio: "inherit" });
  seedSpikeLibs();
}

/**
 * The spike extension redirects to files under `spike/libs/`, which is git-ignored (third-party
 * bytes are not committed). Take them from the freshly built `dist/` so a clean checkout works.
 */
function seedSpikeLibs() {
  mkdirSync("spike/libs/jquery/3.7.1", { recursive: true });
  copyFileSync("dist/libs/jquery/3.7.1/dist/jquery.min.js", "spike/libs/jquery/3.7.1/jquery.min.js");
  mkdirSync("spike/libs/font", { recursive: true });
  // the browser sniffs the format, so a woff2 served as f.ttf loads fine
  copyFileSync("dist/libs/fontawesome/6.6.0/webfonts/fa-regular-400.woff2", "spike/libs/font/f.ttf");
}
