# cdn-mirror

MV3 Chromium extension that emulates CDNs by serving popular libraries locally (inspired by Decentraleyes and LocalCDN).

_Work in progress._

## Build tooling

Plain Vite (multi-entry: popup, options, service worker) with `@sveltejs/vite-plugin-svelte`, Svelte 5, Tailwind v4 and shadcn-svelte components. No CRXJS/WXT: the extension has three entry points and a hand-written manifest, so a plugin would add a moving part without removing any work.
