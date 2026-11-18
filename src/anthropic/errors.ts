import { classifyCompatError } from "../compat/errors.ts";
import { resolveQuirks } from "../compat/quirks.ts";
import type { Classification, ErrorShape } from "../errors.ts";

// https://platform.claude.com/docs/en/api/errors (checked 2026-11-18). The type is set on the
// SDK error for HTTP errors and for SSE error events, which have no status.
const BY_TYPE: Readonly<Record<string, Classification>> = {
  invalid_request_error: { code: "invalid_request" },
  not_found_error: { code: "invalid_request" },
  authentication_error: { code: "auth" },
  permission_error: { code: "auth" },
  billing_error: { code: "billing" },
  rate_limit_error: { code: "rate_limit" },
  api_error: { code: "provider_unavailable" },
  overloaded_error: { code: "provider_unavailable" },
  timeout_error: { code: "timeout" },
};

const anthropicTypes = (shape: ErrorShape): Classification | undefined =>
  shape.type !== undefined && Object.hasOwn(BY_TYPE, shape.type) ? BY_TYPE[shape.type] : undefined;

/** Anthropic error mapping: documented error types, then the shared SDK shapes, then statuses. */
export const classifyAnthropicError: (
  shape: ErrorShape,
  error: unknown,
) => Classification | undefined = classifyCompatError(
  resolveQuirks({ classifyError: anthropicTypes }),
);
