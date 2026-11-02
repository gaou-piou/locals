# cdn-mirror

A Manifest V3 Chromium extension that serves popular JavaScript libraries, stylesheets and fonts from a local copy instead of letting pages contact third-party CDNs (cdnjs, jsDelivr, unpkg, Google Hosted Libraries, Microsoft Ajax CDN, code.jquery.com).

## Why

[Decentraleyes](https://github.com/Synzvato/decentraleyes) is archived and its Chromium code lived on an MV2 branch. [LocalCDN](https://codeberg.org/nobody/LocalCDN) is maintained but Firefox-only: its author states that MV3 removed APIs it needs. cdn-mirror fills the gap for Chromium MV3 with `declarativeNetRequest` redirects to `web_accessible_resources`, a full UI, and a pipeline that keeps the bundled libraries current. See [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md).

What it does:

- redirects requests to the supported CDNs to bundled files (exact version matches, and an opt-in version substitution (off by default) that maps older requests of a major to the newest pinned release of that major);
- popup with the status of the current site and a one-click per-site toggle;
- options page: global switch, allow-list / deny-list per site, statistics (day, week, month, year), library browser, config export and import;
- the library list is a plain file (`libraries.json`); the files themselves are fetched from npm at build time and verified against the recorded sha256, never committed;
- a weekly CI job adds new library releases and opens a pull request.

What it cannot do in MV3 is in [docs/LIMITATIONS.md](docs/LIMITATIONS.md).

## Install

### Arch Linux (AUR)

```sh
yay -S cdn-mirror        # or any AUR helper
```

The package installs the extension to `/usr/share/cdn-mirror/` and a helper that makes a user-writable copy (Chromium writes an `_metadata/` folder into every unpacked extension, which fails in a root-owned directory):

```sh
cdn-mirror-install      # copies to ~/.local/share/cdn-mirror and prints the path
```

Then load that folder with *Load unpacked* (below). Run the helper again after each package upgrade and reload the extension.

### Load unpacked (any distribution)

1. Download `cdn-mirror-<version>.zip` from the GitHub releases and check it against the `.sha256` file.
2. Unzip it.
3. Open `chrome://extensions` (Brave: `brave://extensions`), enable *Developer mode*, choose *Load unpacked* and pick the unzipped folder (AUR: the folder printed by `cdn-mirror-install`). The folder must be writable.

Unpacked extensions are not auto-updated: reload the extension card after upgrading.

Target browsers: Chromium-based browsers with MV3 support (Chromium 120+). Tested with Chromium; **not yet tested in Brave** (see limitations).

## Development

Requirements: Node 24 and pnpm.

```sh
pnpm install
pnpm build:libs     # fetch the pinned libraries from npm into .cache/libs (sha256-verified)
pnpm build          # vite build + manifest + libs + generated DNR rulesets  ->  dist/
pnpm test           # unit tests (vitest)
pnpm test:e2e       # Playwright with the bundled Chromium (loads dist/ as an extension)
pnpm typecheck
pnpm size           # fails above the 25 MB budget
pnpm libs:hash      # recompute sha256 values in libraries.json
pnpm libs:bump      # add the newest npm release of each library as a new pinned version
```

Load `dist/` unpacked to try a build. Releases are cut by pushing a `v<version>` tag: the workflow checks that the tag equals the `package.json` and manifest version, then publishes the zip and its checksum. After a release, update `pkgver` and the first `sha256sums` entry (the zip) in `packaging/aur/PKGBUILD`; it ships as a placeholder that makes `makepkg` fail until replaced.

### Stack

Svelte 5 (no SvelteKit), Tailwind v4, [shadcn-svelte](https://shadcn-svelte.com) components, [runed](https://runed.dev), ramda, zod. Plain Vite with three entry points (popup, options, service worker): a build plugin such as CRXJS or WXT would add a moving part without removing work for a hand-written manifest.

> **shadcn caveat.** `src/lib/components/ui/tabs/*` and `ui/switch/switch.svelte` are patched: the registry classes target `data-active` / `data-horizontal` style attributes, while the installed bits-ui emits `data-state` and `data-orientation`. Re-adding these components with the shadcn CLI would bring the invisible/mis-laid-out tabs and switch back. Re-apply the patch if you do.

## Layout

| Path | What |
|---|---|
| `libraries.json` | library manifest: npm package, pinned versions, file hashes, CDN URL patterns |
| `scripts/` | library pipeline, rule generator, build, bump and size tools |
| `src/background/` | service worker: settings, site exceptions, statistics |
| `src/popup/`, `src/options/` | the UI |
| `packaging/aur/` | PKGBUILD and `.install` |
| `docs/` | spike results, limitations, attribution, design spec |

## License

[MPL-2.0](LICENSE). Bundled libraries keep their own licenses (MIT, and CC-BY-4.0 / OFL-1.1 for Font Awesome); each one's LICENSE ships next to its files in the release zip. Decentraleyes and LocalCDN are MPL-2.0 too; no code is copied from either.
