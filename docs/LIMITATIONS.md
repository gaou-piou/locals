# Limitations

## No HTML filtering

Decentraleyes and LocalCDN (on Firefox) rewrite page HTML to drop `integrity` and `crossorigin` attributes so that Subresource Integrity never blocks a replacement. Chromium MV3 has no response-body filtering (`webRequest.filterResponseData` is gone), so cdn-mirror cannot do this.

## Subresource Integrity

A page with `integrity="sha…"` accepts the redirected file only if the bundled bytes are identical to what the page's hash was computed from. The pipeline therefore hashes what each CDN really serves and records it as `cdnSha256` per pinned version; a CDN URL pattern is redirected for a version **only when those bytes equal the bundled file**. Where a CDN re-minifies a file (so the bytes differ), that pattern is skipped and the page loads from the CDN as before — correctness over coverage. Spike result: jQuery 3.7.1 is byte-identical on cdnjs, jsDelivr, unpkg and npm.

## Version substitution is conservative

Substitution is off by default. When enabled, requests for other versions of a library are served by the newest pinned release of the same major only (one regex rule per library, CDN and major); it can be disabled per site. **Substitution breaks pages that pin the script with an SRI hash**: the extension cannot see `integrity` attributes, so the browser blocks the different version. That is the reason it is opt-in.

## Header stripping (`modifyHeaders`)

The spike showed `declarativeNetRequest` `modifyHeaders` can remove request headers such as `Referer` (observed on a same-origin fetch). It only helps for CDN requests that stay on the network — redirected requests never leave the browser. It is **not implemented in v0.1**; it is an optional follow-up.

## Other

- Only unpacked loading: no CRX, update manifest or Web Store listing. Reload the extension after an upgrade.
- Statistics rely on `onRuleMatchedDebug`, which exists only for unpacked extensions (`declarativeNetRequestFeedback`) — fine for the supported install route.
- Dynamic font services (e.g. Google Fonts CSS) are deliberately not emulated.
- Rule limits: well under Chromium's 30000 guaranteed static rules and 1000 regex rules (one regex per library, CDN and major).
- **Not tested in Brave or other Chromium forks.** Everything, including the end-to-end suite, was run with Playwright's bundled Chromium 156 (headless) over HTTP fixtures; HTTPS pages were not exercised (the patterns are scheme-agnostic). Brave Shields may interact with redirects: please report findings.
- The e2e suite and `docs/spike-results.md` describe the probes behind these statements.
- Turning a site on or off applies to new requests; reload the open tab to see the change.
- Allow-list mode (a non-empty allow list) exempts everything except the listed sites and their subdomains; third-party iframes embedded on a listed site are not served locally.
- Pages can detect that the extension is installed (its id is fixed and its files are web-accessible to every site). This is inherent to the redirect approach.
- Installed from the AUR, load the extension from the copy made by `cdn-mirror-install` (`~/.local/share/cdn-mirror`), not from `/usr/share/cdn-mirror`: Chromium writes an `_metadata/` folder into an unpacked extension and cannot do so in a root-owned directory.
