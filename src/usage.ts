/** Normalized token usage. `undefined` means the provider didn't report it, never 0. */
export interface Usage {
  /** All input tokens, including cache reads and cache writes. */
  inputTokens: number | undefined;
  /** All output tokens, including reasoning. */
  outputTokens: number | undefined;
  /** The part of `inputTokens` read from a prompt cache. */
  cachedInputTokens: number | undefined;
  /** The part of `inputTokens` written to a prompt cache. */
  cacheWriteTokens: number | undefined;
  /** The part of `outputTokens` spent on reasoning. */
  reasoningTokens: number | undefined;
}

/**
 * What an adapter reports in a `usage` event. Values are cumulative for the request, and the
 * flags say which convention the provider's totals follow so core can normalize them.
 */
export interface UsageReport {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
  reasoningTokens?: number | undefined;
  /** Whether `inputTokens` already includes cache reads and writes. */
  inputIncludesCached: boolean;
  /** Whether `outputTokens` already includes reasoning tokens. */
  outputIncludesReasoning: boolean;
}

export const USAGE_FIELDS: readonly (keyof Usage)[] = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
  "reasoningTokens",
];

export const EMPTY_USAGE: Usage = Object.freeze({
  inputTokens: undefined,
  outputTokens: undefined,
  cachedInputTokens: undefined,
  cacheWriteTokens: undefined,
  reasoningTokens: undefined,
});

export function mergeUsage(previous: UsageReport | undefined, next: UsageReport): UsageReport {
  const merged: UsageReport = {
    ...previous,
    inputIncludesCached: next.inputIncludesCached,
    outputIncludesReasoning: next.outputIncludesReasoning,
  };
  for (const field of USAGE_FIELDS) {
    const value = next[field];
    if (value !== undefined) merged[field] = value;
  }
  return merged;
}

const plus = (total: number | undefined, ...parts: (number | undefined)[]): number | undefined =>
  total === undefined ? undefined : parts.reduce<number>((sum, part) => sum + (part ?? 0), total);

export function normalizeUsage(report: UsageReport | undefined): Usage {
  if (report === undefined) return { ...EMPTY_USAGE };
  return {
    inputTokens: report.inputIncludesCached
      ? report.inputTokens
      : plus(report.inputTokens, report.cachedInputTokens, report.cacheWriteTokens),
    outputTokens: report.outputIncludesReasoning
      ? report.outputTokens
      : plus(report.outputTokens, report.reasoningTokens),
    cachedInputTokens: report.cachedInputTokens,
    cacheWriteTokens: report.cacheWriteTokens,
    reasoningTokens: report.reasoningTokens,
  };
}

/** Field-wise sum. Unknown in either addend makes that field unknown: a partial sum under-reports. */
export function sumUsage(a: Usage, b: Usage): Usage {
  const sum = { ...EMPTY_USAGE };
  for (const field of USAGE_FIELDS) {
    const x = a[field];
    const y = b[field];
    sum[field] = x === undefined || y === undefined ? undefined : x + y;
  }
  return sum;
}
