# cdn-mirror — design

Date: 2026-11-02 · Owner: gaou-piou · Status: draft for approval

## Intent and why

Decentraleyes (the original CDN-emulation extension) is archived on GitHub
(2018) and its Chromium code lived on an `experimental` MV2 branch. LocalCDN, its
actively maintained fork (Codeberg, last commit 2026-10-31), is Firefox-only: its
author states MV3 removed APIs it needs and will not fix Chromium issues.
Result: **no maintained CDN-emulation extension exists for Chromium MV3.**

cdn-mirror fills that gap: a Manifest V3 Chromium extension that serves popular
libraries/fonts/icons from files bundled in the extension instead of letting pages
contact third-party CDNs, with a full UI, and a pipeline that keeps the bundled
libraries current ("alive"). Distributed as an AUR package.

## Goals

- MV3 Chromium extension; redirects CDN requests to bundled files via
  `declarativeNetRequest` (DNR) rules pointing at `web_accessible_resources`.
- Full UI (Svelte 5): popup (per-tab/site status, toggle for the current site),
  options page (global settings, per-site allow/deny lists, statistics, rules/library
  browser, import/export of settings). Exact screens are the builder's call, guided by
  LocalCDN's feature set (stats day/week/month/year, config export/import, per-site toggles).
- Automated freshness: a git-tracked manifest lists libraries (name, npm package,
  version, file path in package, sha256, CDN URL patterns). A script fetches files
  from npm, verifies sha256, bundles them, and generates the DNR rules. A scheduled
  GitHub Action bumps versions and opens a PR/release.
- Reuse prior art: library/CDN mappings informed by LocalCDN (`core/mappings.js`,
  `core/resources.js`), MPL-2.0 compatible, with attribution to the source.
- AUR package `cdn-mirror` (name tentative) in the user's AUR account.

## Non-goals

- Firefox support (LocalCDN covers it).
- Replicating features impossible in MV3: response-body HTML filtering (removing
  `integrity`/`crossorigin` attributes) and header stripping via blocking
  `webRequest`. Builder should investigate DNR alternatives (e.g. `modifyHeaders`
  for request headers on redirected/CDN requests) and document what is dropped.
- Chrome Web Store publication (not requested; can be revisited).
- Replacing Google Fonts-style dynamic services (LocalCDN excludes them deliberately).

## Anti-goals

- Breaking sites silently. Version substitution (e.g. jQuery 3.5.0 → 3.5.1) must be
  conservative, and the user must be able to disable per site and see what was replaced.
- Committing large vendored library files to git.
- Depending on an abandoned build plugin or a non-reproducible build.

## Decisions made by the user

- Own repo, user `gaou-piou`, at `/mnt/SSD/works/cdn-mirror`.
- UI in Svelte 5 (not SvelteKit). Full UI from the start.
- Library *files* are not stored in git; git holds the manifest/lists.
- **CI builds the extension package and publishes it as a GitHub release asset;
  the AUR PKGBUILD downloads that release with a pinned checksum** (not built in the PKGBUILD).

## Decisions made by me (assistant) — please check

- Svelte 5 (runes) + Vite + TypeScript; service worker as plain TS module outside
  Svelte; a small hash router or tabs inside options page. SvelteKit rejected: its
  static output adds inline bootstrap script that MV3 CSP forbids, for no benefit.
- Vite extension plugin to be chosen by the builder after checking which is actively
  maintained (not yet verified; do not rely on an abandoned one).
- Project name `cdn-mirror` is tentative.
- DNR approach is untested: static rule count limits and redirect-to-extension-resource
  behaviour should be verified in a spike before committing to the architecture.

## Additional calls from the builder check (assistant's calls, please check)

- **Spike first:** the first plan step is a go/no-go spike of DNR redirect to
  `web_accessible_resources` (CORS, `crossorigin`, SRI pages). UI work waits on it.
  If it only partly works: ship with a documented caveat (SRI pages are not
  replaced), restricted to resource types that work.
- **Host permissions:** requested at install, so the extension works with zero
  configuration. Per-site allow/deny uses `initiatorDomains` / `excludedInitiatorDomains`.
- **Versions:** the manifest may hold several pinned versions per library for exact
  matches. Substituting a nearby version is opt-in, same major only, off by default.
- **Statistics:** may be approximate (per-tab/badge counts via `getMatchedRules`);
  exact per-request logs are a nice-to-have, not required. This relaxes the
  "see what was replaced" anti-goal to "see per-tab counts and the library list".
- **License:** repo is MPL-2.0 (LocalCDN's Codeberg page states MPL-2.0; Decentraleyes
  is MPL-2.0). Verify the LICENSE file in LocalCDN before copying its mappings.
- AUR checksum bumps are manual per release at first. First-release CDN scope is the
  builder's choice (cdnjs, jsDelivr, unpkg, Google/Microsoft hosted libraries, ajax.aspnetcdn).

## Constraints

- Chromium MV3 only; optional host permissions model must be considered.
- DNR static ruleset limits (guaranteed per-extension rule count) bound how many
  patterns can ship; builder must check current limits.
- Extension size grows with bundled libraries (LocalCDN is ~17 MB); keep it reasonable.
- AUR: PKGBUILD installs the unpacked extension under `/usr/share/`; how Chromium
  loads it (`--load-extension`, external extension JSON, policy) needs verification
  since unpacked/external extensions have restrictions in normal profiles.
- License: MPL-2.0 for anything derived from LocalCDN/Decentraleyes mappings.

## Left to the builder

- Repo layout, test strategy, exact UI screens and visual design, statistics storage,
  rule-generation details, release tagging scheme, CI workflow specifics.

## Open items for later

- Whether to publish on the Chrome Web Store.
- Final project name.
