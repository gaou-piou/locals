import { fetchBuffer, fetchTarballFromNpm, hashLibs } from "./lib-pipeline.ts";
import { readLibraries, writeLibraries } from "./manifest-io.ts";

const hashed = await hashLibs(readLibraries(), { fetchTarball: fetchTarballFromNpm, fetchUrl: fetchBuffer });
writeLibraries(hashed);
for (const e of hashed) {
  for (const p of e.patterns) {
    const same = Object.entries(p.cdnSha256 ?? {}).map(([v, h]) => {
      const f = e.versions.find((x) => x.version === v)?.files.find((x) => x.path === p.file);
      return `${v}:${f?.sha256 === h ? "same" : "DIFF"}`;
    });
    console.log(`${e.name.padEnd(14)} ${p.url.replace("https://", "").padEnd(80)} ${same.join(" ") || "unavailable"}`);
  }
}
