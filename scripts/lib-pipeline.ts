import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { Readable } from "node:stream";
import { chain, map, uniq } from "ramda";
import postcss from "postcss";
import { Parser } from "tar";
import type { LibraryEntry } from "../src/shared/manifest-schema.ts";

export type FetchTarball = (pkg: string, version: string) => Promise<Buffer>;
export type FetchUrl = (url: string) => Promise<Buffer>;

export const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
export const LICENSE_RE = /^(?:licen[cs]e|copying)(?:[.-][\w.-]+)?$/i;

export function registryTarballUrl(pkg: string, version: string): string {
  const base = pkg.split("/").pop()!;
  return `https://registry.npmjs.org/${pkg}/-/${base}-${version}.tgz`;
}

export const fetchTarballFromNpm: FetchTarball = (pkg, version) => fetchBuffer(registryTarballUrl(pkg, version));

export class HttpError extends Error {
  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`GET ${url} → ${status}`);
    this.name = "HttpError";
  }
}

const FETCH_TIMEOUT_MS = 60_000;

export async function fetchBuffer(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new HttpError(url, res.status);
  return Buffer.from(await res.arrayBuffer());
}

/** Reads the files of an npm tarball into memory, keyed by path relative to the package root. */
export async function extract(tgz: Buffer, want: (path: string) => boolean): Promise<Map<string, Buffer>> {
  const out = new Map<string, Buffer>();
  const parser = new Parser({
    filter: (path) => want(path.split("/").slice(1).join("/")),
    onReadEntry: (entry) => {
      const chunks: Buffer[] = [];
      entry.on("data", (c: Buffer) => chunks.push(c));
      entry.on("end", () => out.set(entry.path.split("/").slice(1).join("/"), Buffer.concat(chunks)));
    },
  });
  await new Promise<void>((resolve, reject) => {
    parser.on("end", resolve).on("error", reject);
    Readable.from(tgz).pipe(parser);
  });
  return out;
}

type Tuple = { entry: LibraryEntry; version: string; files: LibraryEntry["versions"][number]["files"] };
const tuples = (entries: LibraryEntry[]): Tuple[] =>
  chain((entry) => map((v) => ({ entry, version: v.version, files: v.files }), entry.versions), entries);

const URL_RE = /url\(\s*(["']?)([^"')]+)\1\s*\)/g;

/** Package-relative paths of the url()s in a CSS value; absolute, protocol-relative and data: URLs are not the package's. */
const relativeUrls = (value: string, cssPath: string) =>
  [...value.matchAll(URL_RE)]
    .map(([, , url]) => url)
    .filter((url) => !/^(?:[a-z][\w+.-]*:|\/|#)/i.test(url))
    .map((url) => posix.join(posix.dirname(cssPath), url.replace(/[?#].*$/, "")));

/**
 * What a stylesheet at `cssPath` loads relative to itself: each @font-face as a group of alternatives (one is enough),
 * and every other url() (images) on its own. Served from chrome-extension://, the stylesheet finds only bundled files.
 */
export function cssNeeds(css: string, cssPath: string): { fonts: string[][]; files: string[] } {
  const root = postcss.parse(css);
  const faces: postcss.AtRule[] = [];
  root.walkAtRules(/^font-face$/i, (r) => void faces.push(r));
  const fonts = faces
    .map((r) => uniq(r.nodes?.flatMap((d) => (d.type === "decl" && /^src$/i.test(d.prop) ? relativeUrls(d.value, cssPath) : [])) ?? []))
    .filter((urls) => urls.length > 0);
  const files: string[] = [];
  root.walkDecls((d) => {
    if (!(d.parent?.type === "atrule" && faces.includes(d.parent as postcss.AtRule))) files.push(...relativeUrls(d.value, cssPath));
  });
  return { fonts, files: uniq(files) };
}

export async function buildLibs(
  entries: LibraryEntry[],
  opts: { outDir: string; fetchTarball: FetchTarball },
): Promise<void> {
  // Phase 1: fetch + verify everything in memory; nothing touches the disk until all hashes match.
  const writes: { path: string; data: Buffer }[] = [];
  for (const { entry, version, files } of tuples(entries)) {
    const id = `${entry.name}@${version}`;
    const wanted = new Set(files.map((f) => f.path));
    // The whole package: a stylesheet's needs are checked against what the package ships.
    const got = await extract(await opts.fetchTarball(entry.npm, version), () => true);
    const base = join(opts.outDir, entry.name, version);
    for (const f of files) {
      const data = got.get(f.path);
      if (!data) throw new Error(`file missing: ${id} ${f.path}`);
      if (sha256(data) !== f.sha256) throw new Error(`sha256 mismatch: ${id}`);
      writes.push({ path: join(base, f.path), data });
    }
    // Only what the package ships counts: a file it lacks fails on the CDN as well.
    for (const f of files.filter((f) => f.type === "stylesheet")) {
      const needs = cssNeeds(got.get(f.path)!.toString(), f.path);
      for (const face of needs.fonts) {
        const shipped = face.filter((p) => got.has(p));
        if (shipped.length && !shipped.some((p) => wanted.has(p))) throw new Error(`font missing: ${id} ${f.path} needs one of ${shipped.join(", ")}`);
      }
      const missing = needs.files.find((p) => got.has(p) && !wanted.has(p));
      if (missing) throw new Error(`file missing: ${id} ${f.path} needs ${missing}`);
    }
    const licenseName = [...got.keys()].find((k) => LICENSE_RE.test(k));
    if (!licenseName) throw new Error(`license missing: ${id}`);
    writes.push({ path: join(base, "LICENSE"), data: got.get(licenseName)! });
  }
  // Phase 2: write.
  for (const w of writes) {
    mkdirSync(dirname(w.path), { recursive: true });
    writeFileSync(w.path, w.data);
  }
}

export async function hashLibs(
  entries: LibraryEntry[],
  deps: { fetchTarball: FetchTarball; fetchUrl: FetchUrl },
): Promise<LibraryEntry[]> {
  const result: LibraryEntry[] = [];
  for (const entry of entries) {
    const versions = [];
    for (const v of entry.versions) {
      const wanted = new Set(v.files.map((f) => f.path));
      const got = await extract(await deps.fetchTarball(entry.npm, v.version), (p) => wanted.has(p));
      versions.push({
        ...v,
        files: v.files.map((f) => {
          const data = got.get(f.path);
          if (!data) throw new Error(`file missing: ${entry.name}@${v.version} ${f.path}`);
          return { ...f, sha256: sha256(data) };
        }),
      });
    }
    const patterns = [];
    for (const p of entry.patterns) {
      const cdnSha256: Record<string, string> = {};
      for (const v of entry.versions) {
        try {
          cdnSha256[v.version] = sha256(await deps.fetchUrl(p.url.replaceAll("{version}", v.version)));
        } catch (e) {
          // Only a 404 means "the CDN does not serve this version" (left out, never redirected).
          // Anything else (5xx, 429, network, timeout) is transient: fail instead of silently dropping coverage.
          if (!(e instanceof HttpError && e.status === 404)) throw e;
        }
      }
      const { cdnSha256: _old, ...rest } = p;
      patterns.push(Object.keys(cdnSha256).length ? { ...rest, cdnSha256 } : rest);
    }
    result.push({ ...entry, versions, patterns });
  }
  return result;
}
