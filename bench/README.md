# Benchmark: λocals vs Decentraleyes vs LocalCDN

Two questions, measured separately:

1. **Coverage**: of the scripts, styles and fonts real sites request from CDNs, how many does each extension serve
   locally, and is it the version the page asked for? No network is involved: every URL goes through each extension's
   own matching logic.
2. **Speed and breakage**: do real page loads get faster, and do they log more errors?

## Steps

```sh
pnpm tsx bench/sites.ts              # Tranco top sites → bench/sites.txt (top 250 + 750 seeded random from rank 1001–200000)
pnpm tsx bench/fetch-competitors.ts  # Decentraleyes from the Chrome Web Store, LocalCDN from Codeberg → bench/.cache
pnpm build:libs && pnpm build        # λocals from dist/
pnpm tsx bench/capture.ts            # load every site in plain Chromium, record CDN-able requests → out/capture.jsonl (~1.5 h)
pnpm tsx bench/coverage.ts           # → out/coverage.md
pnpm tsx bench/live.ts --throttle 4g # paired page loads → out/live-4g.jsonl (resumable)
pnpm tsx bench/report.ts --throttle 4g  # → out/live-4g.md
```

`sites.txt` is committed so runs are comparable; `out/` and `.cache/` are not.

## How each extension is asked

- **λocals and Decentraleyes**: their real DNR rulesets, through `declarativeNetRequest.testMatchOutcome` in a Chromium
  with the unpacked extension loaded (`fetch-competitors.ts` adds `declarativeNetRequestFeedback` to Decentraleyes).
  λocals runs twice (default, and with version substitution on), Decentraleyes too (default, and with its opt-in
  "staging" ruleset).
- **LocalCDN**: Firefox-only (MV2, and it does not load in current Chromium). `localcdn.ts` runs its own resolver
  (`requestAnalyzer.getLocalTarget`) in a Node vm. Coverage only; it cannot be part of the live loads.

"Same version" means the file served is the version in the URL. LocalCDN, and λocals with substitution, serve the
newest release of the major instead; a page that pins the file with SRI then refuses it.

## Live loads

Each site is loaded with no extension, with λocals and with Decentraleyes (defaults), in a fresh profile per load
(cold) and once more in the same profile (warm). Conditions are interleaved and their order rotated each run.
Throttling uses Chrome's DevTools presets (`4g`: 150 ms RTT, 9 Mbps; `3g`: 400 ms, 1.6 Mbps).

Live sites change between loads (ads, A/B tests, CDN edges), so the report pairs each extension with the no-extension
load of the same site and takes medians over runs and then over sites. A difference of a few tens of ms is noise.

Errors: console errors and page errors are counted per load. Chromium logs `Denying load of chrome-extension://….ttf`
for every format of an `@font-face` src list that the extension does not bundle, even though it uses the bundled
woff2; these are counted apart and not as errors.
