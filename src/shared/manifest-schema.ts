import * as v from "valibot";

export const Sha256Schema = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex chars"));
const safePath = v.pipe(v.string(), v.minLength(1), v.check((p) => !p.startsWith("/") && !p.split("/").includes(".."), "path must be relative and contain no '..'"));
export const AssetTypeSchema = v.picklist(["script", "stylesheet", "font"]);

export const LibraryFileSchema = v.object({
  path: safePath,
  /** "image": only ever loaded by a bundled stylesheet; web-accessible, never the target of a rule. */
  type: v.picklist([...AssetTypeSchema.options, "image"]),
  sha256: Sha256Schema,
});

export const LibraryPatternSchema = v.object({
  /** CDN URL with a `{version}` placeholder. */
  url: v.pipe(v.string(), v.regex(/^https:\/\/[^/{}\s]+\/\S*$/, "url must be https://host/path"), v.includes("{version}", "url must contain {version}")),
  /** `path` of a LibraryFile this URL serves. */
  file: safePath,
  /**
   * sha256 of the bytes the CDN serves, per pinned version. The pattern is redirected for a
   * version only when this equals the bundled file's sha256 (otherwise SRI pages would break).
   */
  cdnSha256: v.optional(v.record(v.string(), Sha256Schema)),
});

export const LibraryVersionSchema = v.object({
  version: v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, "version must be semver")),
  files: v.pipe(v.array(LibraryFileSchema), v.minLength(1)),
});

export const LibraryEntrySchema = v.pipe(
  v.object({
    name: safePath,
    npm: v.pipe(v.string(), v.minLength(1)),
    license: v.pipe(v.string(), v.minLength(1)),
    versions: v.pipe(v.array(LibraryVersionSchema), v.minLength(1)),
    patterns: v.array(LibraryPatternSchema),
  }),
  v.rawCheck(({ dataset, addIssue }) => {
    if (!dataset.typed) return;
    const e = dataset.value;
    const paths = new Set(e.versions.flatMap((ver) => ver.files.map((f) => f.path)));
    e.patterns.forEach((p, i) => {
      if (!paths.has(p.file)) {
        addIssue({
          message: `unknown file ${p.file}`,
          path: [
            { type: "object", origin: "value", input: e, key: "patterns", value: e.patterns },
            { type: "array", origin: "value", input: e.patterns, key: i, value: p },
            { type: "object", origin: "value", input: p, key: "file", value: p.file },
          ],
        });
      }
    });
  }),
);

export type LibraryFile = v.InferOutput<typeof LibraryFileSchema>;
export type LibraryPattern = v.InferOutput<typeof LibraryPatternSchema>;
export type LibraryEntry = v.InferOutput<typeof LibraryEntrySchema>;

/** "versions.0.files: Invalid length…; patterns.2.file: unknown file x" */
export const describeIssues = (issues: readonly v.BaseIssue<unknown>[]): string => issues.map((i) => `${v.getDotPath(i) || "(root)"}: ${i.message}`).join("; ");

export function parseManifest(raw: unknown): LibraryEntry[] {
  const result = v.safeParse(v.array(LibraryEntrySchema), raw);
  if (!result.success) throw new Error(`Invalid libraries manifest: ${describeIssues(result.issues)}`);
  return result.output;
}
