import { fileURLToPath } from "node:url";
import { pickBy } from "ramda";
import { fetchBuffer, fetchTarballFromNpm, hashLibs } from "./lib-pipeline.ts";
import { readLibraries, writeLibraries } from "./manifest-io.ts";
import { parseManifest, type LibraryEntry } from "../src/shared/manifest-schema.ts";

/** How many pinned versions are kept per major. */
export const MAX_PER_MAJOR = 3;

type Triple = [number, number, number];
const triple = (v: string): Triple => v.split(/[-+]/)[0].split(".").map(Number) as Triple;
const compare = (a: string, b: string): number => {
  const [x, y] = [triple(a), triple(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};
const isStable = (v: string) => /^\d+\.\d+\.\d+$/.test(v);

/** Keeps the `MAX_PER_MAJOR` newest versions of every major, sorted ascending. */
function prune(versions: LibraryEntry["versions"]): LibraryEntry["versions"] {
  const sorted = [...versions].sort((a, b) => compare(a.version, b.version));
  return sorted.filter((v, i) => {
    const major = triple(v.version)[0];
    const newer = sorted.slice(i + 1).filter((o) => triple(o.version)[0] === major).length;
    return newer < MAX_PER_MAJOR;
  });
}

/**
 * Adds the newest npm release of every library as a new pinned version. A library whose new version
 * cannot be hashed (file layout changed, tarball missing) is left untouched and reported.
 */
export async function bumpLibs(
  entries: LibraryEntry[],
  latest: (npm: string) => Promise<string>,
  hash: typeof hashLibs,
): Promise<LibraryEntry[]> {
  const out: LibraryEntry[] = [];
  for (const entry of entries) {
    try {
      const next = await latest(entry.npm);
      const newestOf = (vs: LibraryEntry["versions"]) => vs.reduce((a, b) => (compare(a.version, b.version) >= 0 ? a : b));
      const sameMajor = entry.versions.filter((v) => triple(v.version)[0] === triple(next)[0]);
      // A new major is always news; within a known major only a newer release counts.
      const newest = newestOf(sameMajor.length ? sameMajor : entry.versions);
      if (!isStable(next) || (sameMajor.length > 0 && compare(next, newest.version) <= 0)) {
        out.push(entry);
        continue;
      }
      // The new release is assumed to ship the same files as the newest pinned one; hashing proves it.
      // Only the new version is hashed: re-hashing the pinned ones would let a flaky CDN erase their `cdnSha256`.
      const fresh: LibraryEntry = { ...structuredClone(entry), versions: [{ version: next, files: structuredClone(newest.files) }] };
      const [hashedNew] = await hash([fresh], { fetchTarball: fetchTarballFromNpm, fetchUrl: fetchBuffer });
      const versions = prune([...entry.versions, hashedNew.versions[0]]);
      const kept = new Set(versions.map((v) => v.version));
      const hashed: LibraryEntry = {
        ...entry,
        versions,
        patterns: entry.patterns.map((p, i) => {
          const cdn: Record<string, string> = pickBy((_hash: string, version: string | number) => kept.has(String(version)), { ...p.cdnSha256, ...hashedNew.patterns[i]?.cdnSha256 });
          const { cdnSha256: _drop, ...rest } = p;
          return Object.keys(cdn).length ? { ...rest, cdnSha256: cdn } : rest;
        }),
      };
      out.push(hashed);
    } catch (e) {
      console.warn(`bump-libs: ${entry.name} left unchanged (${(e as Error).message})`);
      out.push(entry);
    }
  }
  parseManifest(out);
  return out;
}

export async function npmLatest(npm: string): Promise<string> {
  const res = JSON.parse((await fetchBuffer(`https://registry.npmjs.org/${npm.replace("/", "%2F")}/latest`)).toString());
  return res.version as string;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const before = readLibraries();
  const after = await bumpLibs(before, npmLatest, hashLibs);
  writeLibraries(after);
  for (const [i, e] of after.entries()) {
    const added = e.versions.map((v) => v.version).filter((v) => !before[i].versions.some((o) => o.version === v));
    if (added.length) console.log(`${e.name}: +${added.join(", ")}`);
  }
}
