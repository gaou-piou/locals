import { PRIORITY } from "../shared/priorities.ts";

type Rule = chrome.declarativeNetRequest.Rule;
const FRAMES = ["main_frame", "sub_frame"] as chrome.declarativeNetRequest.ResourceType[];

/**
 * Dynamic rule layout (ids are positional, so repeated calls with the same lists are stable):
 *
 *   id 1                 catch-all `allowAllRequests` (priority catchAll) — only when allowedSites is non-empty;
 *                        it excludes the listed sites via `excludedRequestDomains`
 *   id 100_000 + i       `allowAllRequests` for disabledSites[i] (priority deny)
 *
 * `allowAllRequests` on a frame's navigation request exempts every request of that frame from
 * redirects, so a disabled site (and a third-party iframe on it) is left alone. Chrome applies an
 * `allowAllRequests` rule whenever it matches the frame request, even if a higher-priority `allow`
 * rule also matches it, so the allow-list cannot be an `allow` rule: the catch-all must simply not
 * match the listed sites. `deny` outranks everything, so a site on both lists is exempt.
 */
export const ID = { catchAll: 1, denyBase: 100_000 } as const;

export function exceptionRules(lists: { disabledSites: string[]; allowedSites: string[] }): Rule[] {
  const rules: Rule[] = [];
  const allowAll = "allowAllRequests" as chrome.declarativeNetRequest.RuleActionType;
  if (lists.allowedSites.length) {
    rules.push({
      id: ID.catchAll,
      priority: PRIORITY.catchAll,
      action: { type: allowAll },
      condition: { excludedRequestDomains: lists.allowedSites, resourceTypes: FRAMES },
    });
  }
  lists.disabledSites.forEach((site, i) =>
    rules.push({
      id: ID.denyBase + i,
      priority: PRIORITY.deny,
      action: { type: allowAll },
      condition: { requestDomains: [site], resourceTypes: FRAMES },
    }),
  );
  return rules;
}

/** Replaces all dynamic rules with the layout for these lists, atomically. */
export async function applyExceptions(lists: { disabledSites: string[]; allowedSites: string[] }): Promise<void> {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: exceptionRules(lists),
  });
}
