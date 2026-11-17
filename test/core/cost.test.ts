import { describe, expect, test } from "bun:test";
import { computeCost } from "../../src/cost.ts";
import { isAIError } from "../../src/errors.ts";
import { EMPTY_USAGE, type Usage } from "../../src/usage.ts";

const usage = (u: Partial<Usage>): Usage => ({ ...EMPTY_USAGE, ...u });

describe("computeCost", () => {
  const price = { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75, reasoning: 20 };

  test("prices every bucket at its own rate, per million tokens", () => {
    const cost = computeCost(
      usage({
        inputTokens: 1_000_000,
        cachedInputTokens: 200_000,
        cacheWriteTokens: 100_000,
        outputTokens: 500_000,
        reasoningTokens: 100_000,
      }),
      price,
    );
    // 700k*3 + 200k*0.3 + 100k*3.75 + 400k*15 + 100k*20, all over 1e6
    expect(cost).toBeCloseTo(2.1 + 0.06 + 0.375 + 6 + 2, 10);
  });

  test("missing subset prices fall back to the base rate", () => {
    const u = usage({
      inputTokens: 1_000_000,
      cachedInputTokens: 500_000,
      cacheWriteTokens: 250_000,
      outputTokens: 1_000_000,
      reasoningTokens: 400_000,
    });
    expect(computeCost(u, { input: 2, output: 10 })).toBeCloseTo(2 + 10, 10);
    expect(computeCost(u, { input: 2, output: 10, cachedInput: 1 })).toBeCloseTo(1.5 + 10, 10);
    expect(computeCost(u, { input: 2, output: 10, cacheWrite: 4 })).toBeCloseTo(2.5 + 10, 10);
    expect(computeCost(u, { input: 2, output: 10, reasoning: 0 })).toBeCloseTo(2 + 6, 10);
  });

  test("unknown subsets are billed at the base rate", () => {
    expect(computeCost(usage({ inputTokens: 1000, outputTokens: 1000 }), price)).toBeCloseTo(
      (1000 * 3 + 1000 * 15) / 1e6,
      12,
    );
  });

  test("unknown input or output makes the cost unknown, but zero tokens cost zero", () => {
    expect(computeCost(usage({ outputTokens: 5 }), price)).toBeUndefined();
    expect(computeCost(usage({ inputTokens: 5 }), price)).toBeUndefined();
    expect(computeCost(usage({ inputTokens: 0, outputTokens: 0 }), price)).toBe(0);
  });

  test("subsets larger than their total are an adapter bug", () => {
    for (const bad of [
      usage({ inputTokens: 10, cachedInputTokens: 8, cacheWriteTokens: 5, outputTokens: 1 }),
      usage({ inputTokens: 10, outputTokens: 1, reasoningTokens: 2 }),
    ]) {
      try {
        computeCost(bad, price);
        throw new Error("expected a throw");
      } catch (error) {
        expect(isAIError(error)).toBe(true);
        expect((error as { code: string }).code).toBe("unknown");
      }
    }
  });
});
