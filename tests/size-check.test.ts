import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUDGET_BYTES, dirSize, checkSize } from "../scripts/size-check.ts";
import { tmp } from "./helpers.ts";

describe("size-check", () => {
  it("budget is the 128 MB agreed for the wide library set", () => {
    expect(BUDGET_BYTES).toBe(128 * 1024 * 1024);
  });

  it("sums file sizes recursively", () => {
    const d = tmp();
    mkdirSync(join(d, "a/b"), { recursive: true });
    writeFileSync(join(d, "x"), Buffer.alloc(10));
    writeFileSync(join(d, "a/b/y"), Buffer.alloc(32));
    expect(dirSize(d)).toBe(42);
  });

  it("fails above the budget and passes at it", () => {
    expect(checkSize(BUDGET_BYTES).ok).toBe(true);
    const over = checkSize(BUDGET_BYTES + 1);
    expect(over.ok).toBe(false);
    expect(over.message).toMatch(/exceeds/);
  });
});
