import { buildLibs, fetchTarballFromNpm } from "./lib-pipeline.ts";
import { readLibraries, root } from "./manifest-io.ts";

const entries = readLibraries();
await buildLibs(entries, { outDir: `${root}.cache/libs`, fetchTarball: fetchTarballFromNpm });
console.log(`bundled ${entries.length} libraries into .cache/libs`);
