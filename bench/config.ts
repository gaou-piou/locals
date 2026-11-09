/** Shared paths and knobs of the benchmark. Everything under bench/.cache and bench/out is git-ignored. */
import path from "node:path";

export const ROOT = path.resolve(import.meta.dirname, "..");
export const BENCH = path.join(ROOT, "bench");
export const CACHE = path.join(BENCH, ".cache");
export const OUT = path.join(BENCH, "out");
export const SITES_FILE = path.join(BENCH, "sites.txt");
export const CAPTURE_FILE = path.join(OUT, "capture.json");

/** Tranco list the committed sites.txt was built from (2026-11-08). */
export const LIST_ID = "8P8NV";

/** Competitors, pinned. Decentraleyes comes from the Chrome Web Store (MV3); LocalCDN is Firefox-only (MV2), used as source. */
export const DECENTRALEYES = { id: "ldpochfccmkkmhdbclfhpagapcfdljkj", version: "3.0.2", dir: path.join(CACHE, "decentraleyes") };
export const LOCALCDN = { repo: "https://codeberg.org/nobody/LocalCDN.git", ref: "main", dir: path.join(CACHE, "localcdn") };
export const LOCALS_DIR = path.join(ROOT, "dist");
/** A profile that browsed the corpus once with λocals (train.ts): what auto-cache has learned by then. */
export const TRAINED_PROFILE = path.join(CACHE, "trained-profile");

/** Resource types that the extensions can serve locally. */
export const TYPES = ["script", "stylesheet", "font"] as const;
