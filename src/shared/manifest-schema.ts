import { z } from "zod";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex chars");
const safePath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/") && !p.split("/").includes(".."), "path must be relative and contain no '..'");

export const LibraryFileSchema = z.object({
  path: safePath,
  type: z.enum(["script", "stylesheet", "font"]),
  sha256,
});

export const LibraryPatternSchema = z.object({
  /** CDN URL with a `{version}` placeholder. */
  url: z
    .string()
    .regex(/^https:\/\/[^/{}\s]+\/\S*$/, "url must be https://host/path")
    .refine((u) => u.includes("{version}"), "url must contain {version}"),
  /** `path` of a LibraryFile this URL serves. */
  file: safePath,
  /**
   * sha256 of the bytes the CDN serves, per pinned version. The pattern is redirected for a
   * version only when this equals the bundled file's sha256 (otherwise SRI pages would break).
   */
  cdnSha256: z.record(z.string(), sha256).optional(),
});

export const LibraryVersionSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, "version must be semver"),
  files: z.array(LibraryFileSchema).min(1),
});

export const LibraryEntrySchema = z
  .object({
    name: safePath,
    npm: z.string().min(1),
    license: z.string().min(1),
    versions: z.array(LibraryVersionSchema).min(1),
    patterns: z.array(LibraryPatternSchema),
  })
  .superRefine((e, ctx) => {
    const paths = new Set(e.versions.flatMap((v) => v.files.map((f) => f.path)));
    e.patterns.forEach((p, i) => {
      if (!paths.has(p.file)) {
        ctx.addIssue({ code: "custom", path: ["patterns", i, "file"], message: `unknown file ${p.file}` });
      }
    });
  });

export type LibraryFile = z.infer<typeof LibraryFileSchema>;
export type LibraryPattern = z.infer<typeof LibraryPatternSchema>;
export type LibraryEntry = z.infer<typeof LibraryEntrySchema>;

export function parseManifest(raw: unknown): LibraryEntry[] {
  return z.array(LibraryEntrySchema).parse(raw);
}
