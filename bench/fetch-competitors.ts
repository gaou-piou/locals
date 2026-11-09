/**
 * Fetches the two extensions λocals is compared with into bench/.cache:
 *  - Decentraleyes from the Chrome Web Store (its MV3 build; the GitHub mirror only has the old MV2 code). The CRX is
 *    unpacked and given the declarativeNetRequestFeedback permission, so that testMatchOutcome and the
 *    onRuleMatchedDebug counter work on it exactly as on λocals. Nothing else in it is touched.
 *  - LocalCDN as source from Codeberg. It is Firefox-only MV2 and does not load in current Chromium, so the coverage
 *    step runs its own URL→resource logic in Node instead.
 *
 *   pnpm tsx bench/fetch-competitors.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { CACHE, DECENTRALEYES, LOCALCDN } from "./config.ts";

await mkdir(CACHE, { recursive: true });

async function decentraleyes() {
  const crx = `${CACHE}/decentraleyes.crx`;
  const url = `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=150.0&acceptformat=crx3&x=id%3D${DECENTRALEYES.id}%26uc`;
  execFileSync("curl", ["-sfL", "-o", crx, url]);
  // a CRX3 is a header followed by a plain zip
  const bytes = await readFile(crx);
  const zip = `${CACHE}/decentraleyes.zip`;
  await writeFile(zip, bytes.subarray(bytes.indexOf(Buffer.from("PK\x03\x04", "latin1"))));
  await rm(DECENTRALEYES.dir, { recursive: true, force: true });
  execFileSync("unzip", ["-q", "-o", zip, "-d", DECENTRALEYES.dir]);
  await rm(`${DECENTRALEYES.dir}/_metadata`, { recursive: true, force: true });

  const manifestFile = `${DECENTRALEYES.dir}/manifest.json`;
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  if (manifest.version !== DECENTRALEYES.version) console.warn(`decentraleyes: store has ${manifest.version}, bench pins ${DECENTRALEYES.version}`);
  delete manifest.update_url;
  manifest.permissions = [...manifest.permissions, "declarativeNetRequestFeedback"];
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
  console.log(`decentraleyes ${manifest.version} → ${DECENTRALEYES.dir}`);
}

function localcdn() {
  if (!existsSync(LOCALCDN.dir)) execFileSync("git", ["clone", "--quiet", "--depth", "1", "--branch", LOCALCDN.ref, LOCALCDN.repo, LOCALCDN.dir]);
  else execFileSync("git", ["-C", LOCALCDN.dir, "pull", "--quiet", "--ff-only"]);
  const head = execFileSync("git", ["-C", LOCALCDN.dir, "log", "-1", "--format=%h %cs"], { encoding: "utf8" }).trim();
  const version = JSON.parse(execFileSync("cat", [`${LOCALCDN.dir}/manifest.json`], { encoding: "utf8" })).version;
  console.log(`localcdn ${version} (${head}) → ${LOCALCDN.dir}`);
}

await decentraleyes();
localcdn();
