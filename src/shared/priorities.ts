/**
 * DNR rule priorities. A higher number wins.
 *  - `data:` copies learned by auto-cache (dynamic) lose to every redirect into the extension: a page CSP can block
 *    `data:` but never `chrome-extension://`; their `gate` (allow rules) only outranks them, so it disables nothing else
 *  - redirects (static rulesets): byname, substitute < exact (byname never touches CDN hosts, substitute only those)
 *  - per-URL corrections of byname (dynamic, matched/rejected) use `exact`
 *  - allow-list layout (dynamic): `catchAll` exempts every site, `allow` re-enables the listed ones
 *  - deny list (dynamic): `deny` exempts a site and always wins over everything else
 */
export const PRIORITY = { cached: 1, gate: 2, byname: 3, substitute: 3, exact: 4, catchAll: 50, deny: 100 } as const;
