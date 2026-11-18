import { classifyCompatError } from "../compat/errors.ts";
import { resolveQuirks } from "../compat/quirks.ts";
import type { Classification, ErrorShape } from "../errors.ts";

// https://platform.openai.com/docs/guides/error-codes (checked 2026-11-18).
const BY_CODE: Readonly<Record<string, Classification>> = {
  insufficient_quota: { code: "billing" },
  context_length_exceeded: { code: "context_length" },
  rate_limit_exceeded: { code: "rate_limit" },
};

const openaiCodes = (shape: ErrorShape): Classification | undefined => {
  const code = shape.code;
  if (code === undefined || !Object.hasOwn(BY_CODE, code)) return undefined;
  // With a status, only the codes that change what the status alone would say are mapped.
  if (shape.status === 429 && code === "insufficient_quota") return BY_CODE[code];
  if (shape.status === 400 && code === "context_length_exceeded") return BY_CODE[code];
  return shape.status === undefined ? BY_CODE[code] : undefined;
};

/** OpenAI error mapping: provider codes first, then the shared SDK shapes, then core's statuses. */
export const classifyOpenAIError: (
  shape: ErrorShape,
  error: unknown,
) => Classification | undefined = classifyCompatError(
  resolveQuirks({ classifyError: openaiCodes }),
);
