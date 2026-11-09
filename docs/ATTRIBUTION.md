# Attribution

λocals is inspired by two earlier projects and shares their idea, not their code:

- [Decentraleyes](https://github.com/Synzvato/decentraleyes) (MPL-2.0) — the original local CDN emulation extension.
- [LocalCDN](https://codeberg.org/nobody/LocalCDN) (MPL-2.0, see its `LICENSE.txt`) — its list of supported CDN hosts and libraries guided which libraries and CDNs `libraries.json` covers.

`libraries.json` was written from scratch against the public URL layouts of cdnjs, jsDelivr, unpkg, Google Hosted Libraries, Microsoft Ajax CDN and code.jquery.com. No file from either project is copied. Both are MPL-2.0, the same license as this repository, so any mapping taken from them later stays license-compatible; add the source here when that happens.

Bundled library files are fetched from the npm registry at build time and verified against the sha256 recorded in `libraries.json`; each library's own LICENSE ships next to it in the release zip.

The icon is the outline of the λ glyph from [Geologica](https://github.com/googlefonts/geologica) Bold (SIL Open Font License 1.1), converted to an SVG path on a plain background; no font file is shipped.
