import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseManifest, type LibraryEntry } from "../src/shared/manifest-schema.ts";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const MANIFEST_PATH = `${root}libraries.json`;

export const readLibraries = (path = MANIFEST_PATH): LibraryEntry[] =>
  parseManifest(JSON.parse(readFileSync(path, "utf8")));

export const writeLibraries = (entries: LibraryEntry[], path = MANIFEST_PATH): void => {
  parseManifest(entries); // never write an invalid manifest
  writeFileSync(path, JSON.stringify(entries, null, 2) + "\n");
};
