import { describe, expect, it } from "vitest";
import { badgeText, badgeTitle } from "../src/background/badge.ts";

describe("badge", () => {
  it("is empty while nothing was served", () => {
    expect(badgeText({ saved: 0, detected: 0 })).toBe("");
  });

  it("shows the saved count alone when nothing detected was served", () => {
    expect(badgeText({ saved: 5, detected: 0 })).toBe("5");
    expect(badgeText({ saved: 123, detected: 0 })).toBe("123");
  });

  it("shows saved·detected when both fit in four characters", () => {
    expect(badgeText({ saved: 5, detected: 2 })).toBe("5·2");
    expect(badgeText({ saved: 0, detected: 3 })).toBe("0·3");
    expect(badgeText({ saved: 12, detected: 3 })).toBe("12·3");
  });

  it("falls back to the total when the pair would be cut off", () => {
    expect(badgeText({ saved: 12, detected: 10 })).toBe("22");
  });

  it("the title spells both numbers out", () => {
    expect(badgeTitle({ saved: 5, detected: 2 })).toBe("λocals: 5 from saved copies, 2 from detected copies");
    expect(badgeTitle({ saved: 1, detected: 0 })).toBe("λocals: 1 from saved copies, 0 from detected copies");
  });
});
