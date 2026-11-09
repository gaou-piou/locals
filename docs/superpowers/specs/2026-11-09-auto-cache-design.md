# auto-cache — design

Date: 2026-11-09 · Owner: gaou-piou · Status: approved ("προχώρα")

## Intent

λocals serves what it bundles. Everything else a page loads from a third-party CDN goes to the network,
on every site, again and again (the browser's HTTP cache is partitioned per site). The benchmark showed
the gap: Google Fonts files on 238 of 310 sites, plus swiper, gsap, web-vitals and many more.

auto-cache makes the extension grow with use: a file that is **immutable** (versioned or content-hashed
URL), **third-party**, and seen on **at least 3 different sites** is downloaded once by the worker and from
then on served locally, on every site. The more you browse, the more is served locally, so the faster pages load.
Nothing leaves the browser; it is just a cross-site cache of public, immutable files.

## How it serves: `data:` redirects

MV3 has no writable extension storage that pages can load (a service-worker fetch handler does not intercept
`chrome-extension://` subresources). A DNR dynamic rule can redirect to a `data:` URL instead
(spikes, `bench/out/swspike*.mjs`):

| check | result |
|---|---|
| `data:` redirect for script / stylesheet / font | works; SRI (`integrity` + `crossorigin`) passes |
| size | ≤ ~1.5 MB of base64 works; ~2.6 MB silently fails (Chromium URL limit 2 MB) |
| 60 rules × 400 KB | accepted, persist across restarts, startup unaffected |
| page CSP without `data:` in the directive | **blocks** the redirect (`chrome-extension://` would not be blocked) |
| CSP block, seen by the worker | `webRequest.onErrorOccurred` `net::ERR_ABORTED` for script/stylesheet (fonts abort even on success) |
| CSP header | visible in `onHeadersReceived` (`main_frame`, `sub_frame`) |

## CSP gate

`data:` redirects only apply where the page allows them. Per resource type the effective directive is
`script-src-elem → script-src → default-src`, `style-src-elem → style-src → default-src`, `font-src → default-src`;
a type is safe when no directive applies or its source list has `data:` (`'strict-dynamic'` makes scripts unsafe).
Every enforced policy must allow it (report-only is ignored).

Each document host gets a per-type verdict; unsafe is sticky, hosts not seen for 30 days are forgotten.
Gate rules (dynamic, `allow`, priority `gate`) per type:

- A: everything except `excludedInitiatorDomains: <safe hosts>` — unknown sites never get `data:` (first visit
  is plain network; "faster the more you use it").
- B: `initiatorDomains: <unsafe hosts>` — `excludedInitiatorDomains` also matches subdomains, B takes them back.

Self-healing: a cached script/stylesheet that aborts (meta CSP, a stricter subdomain) marks the host unsafe for
every type and the tab reloads once.

## Priorities

`data:` rules must lose to every `chrome-extension://` redirect (CSP-proof), and the gate must only disable
`data:` rules: `cached 1 < gate 2 < byname = substitute 3 < exact 4 < catchAll 50 < deny 100`
(matched/rejected/learned stay at `exact`). Static rulesets are regenerated from `PRIORITY` at build.

## What is cached

- script, stylesheet, font; `isImmutableUrl`; ≥ 3 sites (observer, salted host hashes); not a bundled file
  (the matcher serves those from the extension).
- ≤ 1 MB per file (base64 ≈ 1.33 MB), ≤ 24 MB and ≤ 500 files in total; least recently used goes first.
- Stylesheets with relative `url()` / `@import` are skipped (they would resolve against `data:`), and so are
  scripts that locate themselves or load siblings (`currentScript`, `import.meta`, relative `import`, scanning
  `<script>` tags).
- Usage is tracked from `onBeforeRequest`; files unused for 60 days expire.

## Ids and settings

- Dynamic ids: gates `500_000..500_005`, cached files `500_100 + slot`; the matcher owns `[300_000, 500_000)`.
- `autoCache` setting (default on). Off: the gate blocks every `data:` rule and nothing new is learned.
- Stats count cached hits as saved (unpacked builds only, as today).

## Not now

- Rewriting relative URLs in stylesheets (Google Fonts `css2` is not immutable anyway; its woff2 files are).
- Firefox / mobile build (a smaller budget there).
- UI beyond the toggle and a count.

## Measure

Benchmark: a "trained" condition — visit the corpus once, clear the HTTP cache, keep extension state, measure again.
