# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), versions follow semver.

## [Unreleased]

### Added

- Serving by name (`byname` ruleset, on by default): a site's own copy named after a bundled library and version is served from the bundled copy at once, then verified by sha256 in the background and kept, corrected to the right version or handed back to the site.
- Options → Discovered lists the files that were handed back.

### Changed

- The extension is called λocals (Greek lambda) and its icon is a λ. Paths, commands (`locals-install`, `locals-learn`) and the repository name stay `locals`.
- Detected copies keep being served while they are re-checked (stale-while-revalidate) instead of expiring and loading from the network once a week.
- The worker's own downloads bypass every redirect, so re-checks see the real file.

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
