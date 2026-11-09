import type { Settings } from "../background/settings.ts";
import type { CachedFile } from "../background/cache.ts";
import type { LearnedEntry } from "../background/learned.ts";
import type { MatchedEntry, RejectedEntry } from "../background/match.ts";
import type { Candidate } from "../background/observe.ts";
import type { StatsRange, StatsResult, TabCount } from "../background/stats.ts";

/** UI → service worker requests and their responses. */
export type Message =
  | { type: "get-settings" }
  | { type: "set-settings"; patch: Partial<Omit<Settings, "schema">> }
  | { type: "get-stats"; range: StatsRange }
  | { type: "get-tab-count"; tabId: number }
  | { type: "get-observed" }
  | { type: "get-pending" }
  | { type: "clear-observed" }
  | { type: "refresh-learned" }
  | { type: "get-learned" }
  | { type: "get-matched" }
  | { type: "get-rejected" }
  | { type: "get-cached" }
  | { type: "clear-cached" };

export type Response<M extends Message> = M extends { type: "get-settings" }
  ? Settings
  : M extends { type: "set-settings" }
    ? null
    : M extends { type: "get-stats" }
      ? StatsResult
      : M extends { type: "get-tab-count" }
        ? TabCount
        : M extends { type: "get-observed" }
          ? Candidate[]
          : M extends { type: "get-pending" }
            ? Candidate[]
            : M extends { type: "clear-observed" }
            ? null
            : M extends { type: "refresh-learned" }
              ? number
              : M extends { type: "get-learned" }
                ? LearnedEntry[]
                : M extends { type: "get-matched" }
                  ? MatchedEntry[]
                  : M extends { type: "get-rejected" }
                    ? RejectedEntry[]
                    : M extends { type: "get-cached" }
                      ? CachedFile[]
                      : M extends { type: "clear-cached" }
                        ? null
                        : never;

export type { CachedFile, Candidate, LearnedEntry, MatchedEntry, RejectedEntry, Settings, StatsRange, StatsResult, TabCount };

export async function send<M extends Message>(message: M): Promise<Response<M>> {
  return (await chrome.runtime.sendMessage(message)) as Response<M>;
}
