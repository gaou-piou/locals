import * as v from "valibot";
import { AssetTypeSchema, Sha256Schema } from "../shared/manifest-schema.ts";
import { PRIORITY } from "../shared/priorities.ts";
import { MATCH_ID_BASE } from "./match.ts";

type Rule = chrome.declarativeNetRequest.Rule;

const LearnedEntrySchema = v.object({
  url: v.pipe(v.string(), v.regex(/^https?:\/\/[^/?#]+\/[^?#]*$/)),
  file: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}\.(?:js|css|woff2?)$/)),
  sha256: Sha256Schema,
  type: AssetTypeSchema,
});
const LearnedIndexSchema = v.object({ schema: v.literal(1), entries: v.array(v.unknown()) });

export type LearnedEntry = v.InferOutput<typeof LearnedEntrySchema>;

/** Dynamic rule ids at or above this belong to learned libraries; site exceptions use lower ids. */
export const LEARNED_ID_BASE = 200_000;

/** Reads `libs/learned/index.json`, written by `locals-learn`; anything malformed is ignored. */
export function parseLearnedIndex(raw: unknown): LearnedEntry[] {
  const index = v.safeParse(LearnedIndexSchema, raw);
  return index.success ? index.output.entries.filter((e) => v.is(LearnedEntrySchema, e)) : [];
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
