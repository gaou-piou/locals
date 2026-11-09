import type { Settings } from "../background/settings.ts";
import type { LearnedEntry } from "../background/learned.ts";
import type { MatchedEntry, RejectedEntry } from "../background/match.ts";
import type { Candidate } from "../background/observe.ts";
import type { StatsRange, StatsResult } from "../background/stats.ts";

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
  | { type: "get-rejected" };

export type Response<M extends Message> = M extends { type: "get-settings" }
  ? Settings
  : M extends { type: "set-settings" }
    ? null
    : M extends { type: "get-stats" }
      ? StatsResult
      : M extends { type: "get-tab-count" }
        ? number
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
                    : never;

export type { Candidate, LearnedEntry, MatchedEntry, RejectedEntry, Settings, StatsRange, StatsResult };

export async function send<M extends Message>(message: M): Promise<Response<M>> {
  return (await chrome.runtime.sendMessage(message)) as Response<M>;
}
