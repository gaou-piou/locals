import { vi } from "vitest";

type Rule = chrome.declarativeNetRequest.Rule;

/** Minimal in-memory `chrome` with the storage and declarativeNetRequest pieces the worker uses. */
export function installFakeChrome() {
  const local: Record<string, unknown> = {};
  const state = { dynamic: [] as Rule[], enabled: new Set<string>(["exact"]) };
  const fake = {
    storage: {
      local: {
        get: async (key: string) => (key in local ? { [key]: structuredClone(local[key]) } : {}),
        set: async (items: Record<string, unknown>) => void Object.assign(local, structuredClone(items)),
      },
      session: (() => {
        const s: Record<string, unknown> = {};
        return {
          get: async (key: string) => (key in s ? { [key]: structuredClone(s[key]) } : {}),
          set: async (items: Record<string, unknown>) => void Object.assign(s, structuredClone(items)),
        };
      })(),
    },
    declarativeNetRequest: {
      getDynamicRules: async () => structuredClone(state.dynamic),
      updateDynamicRules: async ({ removeRuleIds = [], addRules = [] }: { removeRuleIds?: number[]; addRules?: Rule[] }) => {
        const keep = state.dynamic.filter((r) => !removeRuleIds.includes(r.id));
        const clash = addRules.find((r) => keep.some((k) => k.id === r.id));
        if (clash) throw new Error(`duplicate rule id ${clash.id}`);
        state.dynamic = [...keep, ...structuredClone(addRules)];
      },
      updateEnabledRulesets: async ({ enableRulesetIds = [], disableRulesetIds = [] }: { enableRulesetIds?: string[]; disableRulesetIds?: string[] }) => {
        disableRulesetIds.forEach((i) => state.enabled.delete(i));
        enableRulesetIds.forEach((i) => state.enabled.add(i));
      },
    },
    runtime: { getURL: (p: string) => `chrome-extension://fake/${p}` },
  };
  vi.stubGlobal("chrome", fake);
  return { local, state, fake };
}
