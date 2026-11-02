# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/), versions follow semver.

## [Unreleased]

### Added

- `declarativeNetRequest` redirects from cdnjs, jsDelivr, unpkg, Google Hosted Libraries, Microsoft Ajax CDN and code.jquery.com to bundled libraries (jQuery, Bootstrap, Vue, React, React DOM, lodash, Font Awesome).
- Per-site allow/deny lists, global switch, opt-in same-major version substitution.
- Popup and options UI (Svelte 5, shadcn-svelte): site toggle, statistics, library browser, config import/export.
- Library pipeline: `libraries.json` manifest, npm fetch with sha256 verification, CDN byte comparison for SRI safety.
- CI, weekly library bump pull request, tagged release workflow, AUR package.
