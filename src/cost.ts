import { AIError } from "./errors.ts";
import type { Usage } from "./usage.ts";

/**
 * Prices per million tokens, in whatever unit the caller uses. The library ships no prices.
 * Missing subset prices fall back to the base rate.
 */
export interface Price {
  input: number;
  output: number;
  cachedInput?: number | undefined;
  cacheWrite?: number | undefined;
  reasoning?: number | undefined;
}

const PER = 1_000_000;

/**
 * Cost of one usage record, or `undefined` when input or output tokens are unknown.
 * Unknown subsets (cached, cache-write, reasoning) are billed at the base rate.
 */
export function computeCost(usage: Usage, price: Price): number | undefined {
  const { inputTokens, outputTokens } = usage;
  if (inputTokens === undefined || outputTokens === undefined) return undefined;
  const cached = usage.cachedInputTokens ?? 0;
  const written = usage.cacheWriteTokens ?? 0;
  const reasoning = usage.reasoningTokens ?? 0;
  const uncached = inputTokens - cached - written;
  const visible = outputTokens - reasoning;
  if (uncached < 0 || visible < 0) {
    throw new AIError({ code: "unknown", cause: new RangeError("usage subsets exceed totals") });
  }
  return (
    (uncached * price.input +
      cached * (price.cachedInput ?? price.input) +
      written * (price.cacheWrite ?? price.input) +
      visible * price.output +
      reasoning * (price.reasoning ?? price.output)) /
    PER
  );
}
