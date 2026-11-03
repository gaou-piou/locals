# DNR redirect spike — results

Date: 2026-11-02 · Browser: Playwright bundled Chromium 156 (`channel: "chromium"`, headless) · Extension: unpacked, MV3 · Tests: `e2e/spike.spec.ts` (10/10 pass)

## Verdict: **GO**

Every probe in the plan's checklist behaved as the design needs.

| Probe | Result |
|---|---|
| Redirect `https://cdnjs.cloudflare.com/.../jquery.min.js` → `web_accessible_resources` file (`extensionPath`), with the CDN host made unresolvable | Works; page gets jQuery 3.7.1 |
| (a) `urlFilter` `||host/path^` | Matches `?v=1` and the `http://` variant; does **not** match `.min.js.map`. Verified with `declarativeNetRequest.testMatchOutcome` (needs `declarativeNetRequestFeedback`, unpacked only) |
| (b) SRI `integrity` + `crossorigin="anonymous"` | Passes when the bundled bytes equal what the page's hash was computed from; a wrong hash blocks the script. jQuery 3.7.1 bytes are **identical** on cdnjs, jsDelivr, unpkg and npm (same sha256 `fc9a93dd…`), so SRI pages keep working for it. The `cdnSha256` check stays for libraries where a CDN re-minifies |
| (c) `regexSubstitution` → `chrome-extension://<id>/...` with a manifest `key` (fixed id) | Works (`code.jquery.com/jquery-3.6.0.min.js` served as 3.7.1 by an opt-in-style regex rule) |
| (d) Font via redirect (`resourceTypes: ["font"]`) | Loads (`document.fonts` status `loaded`) |
| (e) Protocol-relative URL on an `http://` page | Redirected |
| (f) Page CSP `script-src https://cdnjs.cloudflare.com` | The redirected script still loads |
| (g) `allowAllRequests` + `requestDomains: [site]` + `resourceTypes: [main_frame, sub_frame]`, priority 100 (dynamic rule) | Exempts the site's own requests **and** a third-party iframe (different host) on it; without the rule the redirect applies |
| (h) Limits (from the running browser) | `GUARANTEED_MINIMUM_STATIC_RULES` 30000, `MAX_NUMBER_OF_REGEX_RULES` 1000, `MAX_NUMBER_OF_ENABLED_STATIC_RULESETS` 50, `MAX_NUMBER_OF_STATIC_RULESETS` 100, `MAX_NUMBER_OF_DYNAMIC_RULES` 30000. `MAX_NUMBER_OF_STATIC_RULES` is no longer defined |
| (i) `onRuleMatchedDebug` | Fires in an unpacked extension (rule id 1 reported) — usable for exact stats |
| (j) `modifyHeaders` | Can remove the `referer` request header (observed on a same-origin fetch). So Referer/Cookie/Origin stripping is possible for requests that are **not** redirected; for redirected requests no network request happens at all |

## Consequences for the plan

- Rules budget: stay well under 30000 static rules (guaranteed) and 1000 regex rules; one regex per (library, CDN, major) for the substitute ruleset.
- Stats: use `onRuleMatchedDebug` as the source, as planned.
- Header stripping (LocalCDN's metadata stripping) is feasible with `modifyHeaders` for CDN requests that remain on the network; record as an optional follow-up, not part of v0.1.
- HTML filter (removing `integrity` attributes) is still impossible in MV3; SRI pages work only when bytes are identical.
- Size budget: 128 MB since the library set grew to ~70 libraries and ~630 pinned versions (dist is ~79 MB; LocalCDN ships about 85 MB). Loaded unpacked, so no Web Store limit applies.

## Not verified here

- Brave and other Chromium forks (manual check in Task 6/8).
- Behaviour on HTTPS pages (fixtures are served over HTTP from localhost; `||host^` patterns are scheme-agnostic, and the redirect target is an extension URL, so no mixed-content issue was observed on HTTP pages).
