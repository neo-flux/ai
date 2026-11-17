import { describe, expect, test } from "bun:test";
import {
  EMPTY_USAGE,
  mergeUsage,
  normalizeUsage,
  sumUsage,
  type Usage,
  type UsageReport,
} from "../../src/usage.ts";

const flags = { inputIncludesCached: true, outputIncludesReasoning: true };
const usage = (u: Partial<Usage>): Usage => ({ ...EMPTY_USAGE, ...u });

describe("mergeUsage", () => {
  test("a later defined value replaces an earlier one", () => {
    expect(mergeUsage({ ...flags, outputTokens: 1 }, { ...flags, outputTokens: 9 })).toEqual({
      ...flags,
      outputTokens: 9,
    });
  });

  test("undefined never erases, and missing keys keep earlier values", () => {
    const merged = mergeUsage(
      { ...flags, inputTokens: 10, outputTokens: 1 },
      { ...flags, inputTokens: undefined },
    );
    expect(merged.inputTokens).toBe(10);
    expect(merged.outputTokens).toBe(1);
  });

  test("a stream-start then stream-end sequence merges like one report", () => {
    const events: UsageReport[] = [
      { ...flags, inputTokens: 20, cachedInputTokens: 5, outputTokens: 1 },
      { ...flags, outputTokens: 7 },
      { ...flags, outputTokens: 12, reasoningTokens: 4 },
    ];
    const merged = events.reduce<UsageReport | undefined>(mergeUsage, undefined);
    expect(merged).toEqual({
      ...flags,
      inputTokens: 20,
      cachedInputTokens: 5,
      outputTokens: 12,
      reasoningTokens: 4,
    });
  });

  test("the latest report's convention flags win", () => {
    const merged = mergeUsage(
      { inputIncludesCached: true, outputIncludesReasoning: true },
      { inputIncludesCached: false, outputIncludesReasoning: false },
    );
    expect(merged.inputIncludesCached).toBe(false);
    expect(merged.outputIncludesReasoning).toBe(false);
  });
});

describe("normalizeUsage", () => {
  test("no report means every field is undefined, never 0", () => {
    const u = normalizeUsage(undefined);
    for (const value of Object.values(u)) expect(value).toBeUndefined();
    expect(Object.keys(u).sort()).toEqual([
      "cacheWriteTokens",
      "cachedInputTokens",
      "inputTokens",
      "outputTokens",
      "reasoningTokens",
    ]);
  });

  test("keeps totals that already include the subsets", () => {
    expect(
      normalizeUsage({
        ...flags,
        inputTokens: 100,
        cachedInputTokens: 30,
        outputTokens: 50,
        reasoningTokens: 20,
      }),
    ).toEqual({
      inputTokens: 100,
      cachedInputTokens: 30,
      cacheWriteTokens: undefined,
      outputTokens: 50,
      reasoningTokens: 20,
    });
  });

  test("adds cache reads and writes to input when the provider excludes them", () => {
    const u = normalizeUsage({
      inputIncludesCached: false,
      outputIncludesReasoning: true,
      inputTokens: 10,
      cachedInputTokens: 30,
      cacheWriteTokens: 5,
    });
    expect(u.inputTokens).toBe(45);
    expect(u.cachedInputTokens).toBe(30);
    expect(u.cacheWriteTokens).toBe(5);
  });

  test("adds reasoning to output when the provider excludes it", () => {
    const u = normalizeUsage({
      inputIncludesCached: true,
      outputIncludesReasoning: false,
      outputTokens: 10,
      reasoningTokens: 6,
    });
    expect(u.outputTokens).toBe(16);
    expect(u.reasoningTokens).toBe(6);
  });

  test("an unknown base total stays unknown even when subsets are known", () => {
    const u = normalizeUsage({
      inputIncludesCached: false,
      outputIncludesReasoning: false,
      cachedInputTokens: 3,
      reasoningTokens: 2,
    });
    expect(u.inputTokens).toBeUndefined();
    expect(u.outputTokens).toBeUndefined();
    expect(u.cachedInputTokens).toBe(3);
  });

  test("unknown subsets add nothing and stay unknown", () => {
    const u = normalizeUsage({
      inputIncludesCached: false,
      outputIncludesReasoning: false,
      inputTokens: 10,
      outputTokens: 4,
    });
    expect(u.inputTokens).toBe(10);
    expect(u.outputTokens).toBe(4);
    expect(u.cachedInputTokens).toBeUndefined();
    expect(u.reasoningTokens).toBeUndefined();
  });
});

describe("normalizeUsage overflow", () => {
  test("a total that is no longer a safe integer throws unknown", () => {
    const big = Number.MAX_SAFE_INTEGER;
    expect(() =>
      normalizeUsage({
        inputIncludesCached: false,
        outputIncludesReasoning: true,
        inputTokens: big,
        cachedInputTokens: big,
      }),
    ).toThrow(expect.objectContaining({ code: "unknown" }));
  });
});

describe("sumUsage", () => {
  test("adds field by field", () => {
    expect(
      sumUsage(
        usage({ inputTokens: 1, outputTokens: 2, cachedInputTokens: 0 }),
        usage({ inputTokens: 10, outputTokens: 20, cachedInputTokens: 3 }),
      ),
    ).toEqual(usage({ inputTokens: 11, outputTokens: 22, cachedInputTokens: 3 }));
  });

  test("unknown in either addend makes the sum unknown", () => {
    const s = sumUsage(usage({ inputTokens: 1, outputTokens: 2 }), usage({ inputTokens: 5 }));
    expect(s.inputTokens).toBe(6);
    expect(s.outputTokens).toBeUndefined();
    expect(sumUsage(usage({}), usage({ reasoningTokens: 4 })).reasoningTokens).toBeUndefined();
  });
});
