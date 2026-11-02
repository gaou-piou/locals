import { execFileSync } from "node:child_process";

/** The e2e specs load `dist/`; build it once up front. Needs `.cache/libs` (pnpm build:libs). */
export default function globalSetup() {
  execFileSync("pnpm", ["build"], { stdio: "inherit" });
}
