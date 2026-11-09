/**
 * DNR rule priorities. A higher number wins.
 *  - redirects (static rulesets): byname, substitute < exact (byname never touches CDN hosts, substitute only those)
 *  - per-URL corrections of byname (dynamic, matched/rejected) use `exact`
 *  - allow-list layout (dynamic): `catchAll` exempts every site, `allow` re-enables the listed ones
 *  - deny list (dynamic): `deny` exempts a site and always wins over everything else
 */
export const PRIORITY = { byname: 1, substitute: 1, exact: 2, catchAll: 50, deny: 100 } as const;
