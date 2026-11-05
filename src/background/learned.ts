import { PRIORITY } from "../shared/priorities.ts";
import { MATCH_ID_BASE } from "./match.ts";

type Rule = chrome.declarativeNetRequest.Rule;

export type LearnedEntry = { url: string; file: string; sha256: string; type: "script" | "stylesheet" | "font" };

/** Dynamic rule ids at or above this belong to learned libraries; site exceptions use lower ids. */
export const LEARNED_ID_BASE = 200_000;

const FILE_RE = /^[0-9a-f]{64}\.(?:js|css|woff2?)$/;
const TYPES = new Set(["script", "stylesheet", "font"]);

const isEntry = (e: unknown): e is LearnedEntry => {
  if (typeof e !== "object" || e === null) return false;
  const r = e as Record<string, unknown>;
  return (
    typeof r.url === "string" &&
    /^https?:\/\/[^/?#]+\/[^?#]*$/.test(r.url) &&
    typeof r.file === "string" &&
    FILE_RE.test(r.file) &&
    typeof r.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(r.sha256) &&
    typeof r.type === "string" &&
    TYPES.has(r.type)
  );
};

/** Reads `libs/learned/index.json`, written by `locals-learn`; anything malformed is ignored. */
export function parseLearnedIndex(raw: unknown): LearnedEntry[] {
  if (typeof raw !== "object" || raw === null) return [];
  const r = raw as { schema?: unknown; entries?: unknown };
  return r.schema === 1 && Array.isArray(r.entries) ? r.entries.filter(isEntry) : [];
}

export function learnedRules(entries: LearnedEntry[]): Rule[] {
  return entries.map((e, i) => ({
    id: LEARNED_ID_BASE + i,
    priority: PRIORITY.exact,
    action: { type: "redirect" as chrome.declarativeNetRequest.RuleActionType, redirect: { extensionPath: `/libs/learned/${e.file}` } },
    condition: {
      urlFilter: `||${e.url.replace(/^https?:\/\//, "")}^`,
      resourceTypes: [e.type as chrome.declarativeNetRequest.ResourceType],
    },
  }));
}

export async function loadLearned(): Promise<LearnedEntry[]> {
  try {
    const res = await fetch(chrome.runtime.getURL("libs/learned/index.json"), { cache: "no-store" });
    return res.ok ? parseLearnedIndex(await res.json()) : [];
  } catch {
    return [];
  }
}

/** Replaces the learned dynamic rules with the current index; returns how many are active. */
export async function applyLearned(): Promise<number> {
  const rules = learnedRules(await loadLearned());
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.filter((r) => r.id >= LEARNED_ID_BASE && r.id < MATCH_ID_BASE).map((r) => r.id),
    addRules: rules,
  });
  return rules.length;
}

/** Candidates that are already served locally no longer need learning, so they leave the Ready/Waiting lists. */
export function excludeLearned<T extends { url: string }>(candidates: T[], learned: LearnedEntry[]): T[] {
  const have = new Set(learned.map((e) => e.url));
  return candidates.filter((c) => !have.has(c.url));
}
