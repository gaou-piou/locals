import type { TabCount } from "./stats.ts";

/** A badge holds about four characters; "saved·detected" when it fits, the total otherwise (the title has both). */
export function badgeText({ saved, detected }: TabCount): string {
  if (saved + detected === 0) return "";
  if (detected === 0) return String(saved);
  const pair = `${saved}·${detected}`;
  return pair.length <= 4 ? pair : String(saved + detected);
}

export const badgeTitle = ({ saved, detected }: TabCount): string =>
  `λocals: ${saved} from saved copies, ${detected} from detected copies`;
