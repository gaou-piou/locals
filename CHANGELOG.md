# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), versions follow semver.

## [Unreleased]

### Fixed

- Substitute close versions no longer serves an older release than the page asked for (jQuery 3.7.2 got 3.7.1, Font Awesome 6.99 got 6.7.2); it only steps up within the same major.
- The badge and popup count could lose the first files of a page on a slow device: the count was reset when the browser reported the tab as loading, which can arrive after those files. It now resets on the page's own request.

## [0.2.0] - 2026-11-09

### Added

- Serving by name (`byname` ruleset, on by default): a site's own copy named after a bundled library and version is served from the bundled copy at once, then verified by sha256 in the background and kept, corrected to the right version or handed back to the site.
- Options → Discovered lists the files that were handed back.
- The badge and the popup count the current page's requests in two numbers: served from saved copies and from detected copies (`5·2`; the total when the pair would not fit). On Android the badge shows once λocals is pinned in the extensions menu.

### Changed

- The extension is called λocals (Greek lambda) and its icon is a λ. Paths, commands (`locals-install`, `locals-learn`) and the repository name stay `locals`.
- Detected copies keep being served while they are re-checked (stale-while-revalidate) instead of expiring and loading from the network once a week.
- The worker's own downloads bypass every redirect, so re-checks see the real file.
- Validation uses valibot instead of zod, and every state read back from storage (settings, observed and matched files, per-tab counts, the learned index) is checked by a schema: a damaged part falls back to its default instead of breaking the worker.

## [0.1.0] - 2026-11-08

### Fixed

- Mobile (Lemur on Android): viewport meta and no fixed minimum width on the options page, scrollable tab bar, a switch that stays visible when the browser force-darkens the page.
- The statistics page follows new counts while open instead of showing the numbers from when it was opened.
- The extension has icons (toolbar, extensions page).

### Added

- `declarativeNetRequest` redirects from cdnjs, jsDelivr, unpkg, Google Hosted Libraries, Microsoft Ajax CDN and code.jquery.com to bundled libraries (jQuery, Bootstrap, Vue, React, React DOM, lodash, Font Awesome).
- Per-site allow/deny lists, global switch, opt-in same-major version substitution.
- Popup and options UI (Svelte 5, shadcn-svelte): site toggle, statistics, library browser, config import/export.
- Library pipeline: `libraries.json` manifest, npm fetch with sha256 verification, CDN byte comparison for SRI safety.
- CI, weekly library bump pull request, tagged release workflow, AUR package.
