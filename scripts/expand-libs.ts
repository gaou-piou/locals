import { fileURLToPath } from "node:url";
import { LICENSE_RE, extract, fetchBuffer, fetchTarballFromNpm, HttpError, sha256 } from "./lib-pipeline.ts";
import { readLibraries, writeLibraries } from "./manifest-io.ts";
import { CDNJS_MIRRORS, SPEC, type FileSpec, type LibSpec } from "./libs-spec.ts";
import type { LibraryEntry } from "../src/shared/manifest-schema.ts";

type Version = LibraryEntry["versions"][number];
type Pattern = LibraryEntry["patterns"][number];

const STABLE = /^\d+\.\d+\.\d+$/;
const triple = (v: string) => v.split(".").map(Number);
const compare = (a: string, b: string) => {
  const [x, y] = [triple(a), triple(b)];
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
};

/** Counting semaphore: keeps the number of in-flight HTTP requests (and so CDN rate limits) bounded. */
function limiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    while (active >= max) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}
const http = limiter(12);

/** Retries rate limits and 5xx; a 404 (or any final failure) means "this CDN does not serve it". */
async function tryFetch(url: string): Promise<Buffer | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await http(() => fetchBuffer(url));
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  return null;
}

async function npmVersions(npm: string): Promise<string[]> {
  const res = await http(() => fetch(`https://registry.npmjs.org/${npm.replace("/", "%2F")}`, { headers: { accept: "application/vnd.npm.install-v1+json" } }));
  if (!res.ok) throw new Error(`registry ${npm} → ${res.status}`);
  return Object.keys(((await res.json()) as { versions: object }).versions).filter((v) => STABLE.test(v));
}

/** Newest `max` versions; when there are more, only the last patch of every minor competes. */
export function pickVersions(all: string[], spec: Pick<LibSpec, "max" | "since" | "only">): string[] {
  let vs = all.filter((v) => (!spec.since || compare(v, spec.since) >= 0) && (!spec.only || spec.only.test(v))).sort(compare);
  const max = spec.max ?? 12;
  if (vs.length > max) {
    const lastOfMinor = new Map<string, string>();
    for (const v of vs) lastOfMinor.set(triple(v).slice(0, 2).join("."), v);
    vs = [...lastOfMinor.values()].sort(compare);
  }
  return vs.slice(-max);
}

export function urlsFor(spec: LibSpec, file: FileSpec): string[] {
  const urls = [`https://cdn.jsdelivr.net/npm/${spec.npm}@{version}/${file.path}`, `https://unpkg.com/${spec.npm}@{version}/${file.path}`];
  if (file.cdnjs) for (const m of CDNJS_MIRRORS) urls.push(`${m}/${spec.cdnjs ?? spec.name}/{version}/${file.cdnjs}`);
  return [...urls, ...(file.hosts ?? [])];
}

type Probe = { version: string; license: string; files: Version["files"]; hits: Map<string, string> }; // hits: `${url}|${file}` → sha

async function probe(spec: LibSpec, version: string): Promise<Probe | null> {
  let tgz: Buffer;
  try {
    tgz = await http(() => fetchTarballFromNpm(spec.npm, version));
  } catch {
    return null;
  }
  const wanted = new Set(spec.files.map((f) => f.path));
  const got = await extract(tgz, (p) => wanted.has(p) || LICENSE_RE.test(p) || p === "package.json");
  if (![...got.keys()].some((k) => LICENSE_RE.test(k))) return null; // buildLibs insists on a licence file
  const pkg = JSON.parse(got.get("package.json")?.toString() ?? "{}");
  const license: string = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? pkg.licenses?.[0]?.type ?? "");
  const present = spec.files.filter((f) => got.has(f.path));
  const hits = new Map<string, string>();
  await Promise.all(
    present.flatMap((file) => {
      const own = sha256(got.get(file.path)!);
      return urlsFor(spec, file).map(async (url) => {
        const body = await tryFetch(url.replaceAll("{version}", version));
        if (body && sha256(body) === own) hits.set(`${url}|${file.path}`, own);
      });
    }),
  );
  const hitFiles = new Set([...hits.keys()].map((k) => k.split("|")[1]));
  const files = present
    .filter((f) => hitFiles.has(f.path) || (f.companion && hitFiles.size > 0))
    .map((f) => ({ path: f.path, type: f.type, sha256: sha256(got.get(f.path)!) }));
  return hitFiles.size && license ? { version, license, files, hits } : null;
}

export function mergeProbe(entry: LibraryEntry, p: Probe): LibraryEntry {
  const versions = entry.versions.filter((v) => v.version !== p.version);
  const old = entry.versions.find((v) => v.version === p.version);
  const files = [...(old?.files ?? [])];
  for (const f of p.files) {
    const have = files.find((o) => o.path === f.path);
    if (!have) files.push(f);
    else if (have.sha256 !== f.sha256) console.warn(`expand-libs: ${entry.name}@${p.version} ${f.path} differs from the pinned hash; keeping the pinned one`);
  }
  versions.push({ version: p.version, files });
  versions.sort((a, b) => compare(a.version, b.version));

  const patterns = entry.patterns.map((x) => ({ ...x }));
  for (const [key, sha] of p.hits) {
    const [url, file] = key.split("|");
    let pat = patterns.find((x) => x.url === url && x.file === file);
    if (!pat) patterns.push((pat = { url, file }));
    pat.cdnSha256 = { ...pat.cdnSha256, [p.version]: sha };
  }
  return { ...entry, versions, patterns };
}

export async function expand(entries: LibraryEntry[], spec: LibSpec[], log = console.log): Promise<LibraryEntry[]> {
  const out = [...entries];
  for (const s of spec) {
    const idx = out.findIndex((e) => e.name === s.name);
    const existing = idx >= 0 ? out[idx] : { name: s.name, npm: s.npm, license: "", versions: [], patterns: [] as Pattern[] };
    // Already pinned versions are re-probed too: new hosts may now serve them.
    const wanted = [...new Set([...pickVersions(await npmVersions(s.npm), s), ...existing.versions.map((v) => v.version)])];
    const probes = (await Promise.all(wanted.map((v) => probe(s, v)))).filter((p): p is Probe => p !== null);
    let entry: LibraryEntry = existing;
    for (const p of probes) entry = mergeProbe({ ...entry, license: entry.license || p.license }, p);
    if (!entry.versions.length) {
      log(`${s.name}: nothing byte-identical on any CDN, skipped`);
      continue;
    }
    log(`${s.name}: ${entry.versions.length} versions (${probes.length}/${wanted.length} probed ok), ${entry.patterns.length} patterns`);
    if (idx >= 0) out[idx] = entry;
    else out.push(entry);
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const only = process.argv.slice(2);
  const spec = only.length ? SPEC.filter((s) => only.includes(s.name)) : SPEC;
  const result = await expand(readLibraries(), spec);
  writeLibraries(result);
  console.log(`libraries.json: ${result.length} libraries, ${result.reduce((n, e) => n + e.versions.length, 0)} versions`);
}
