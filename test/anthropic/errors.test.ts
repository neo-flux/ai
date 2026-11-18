import { describe, expect, test } from "bun:test";
import { APIConnectionError, APIConnectionTimeoutError, APIError } from "@anthropic-ai/sdk";
import { classifyAnthropicError } from "../../src/anthropic/errors.ts";
import { MessagesTranslator } from "../../src/anthropic/stream.ts";
import { type AIErrorCode, toAIError } from "../../src/errors.ts";

// Hand-built from @anthropic-ai/sdk@1.9.0 core/error.js (APIError.generate keeps the whole body
// under `.error` and the inner type as `.type`). Types and statuses from
// https://platform.claude.com/docs/en/api/errors (checked 2026-11-18).
const http = (status: number, type: string) =>
  APIError.generate(
    status,
    { type: "error", error: { type, message: "m" } },
    undefined,
    new Headers(),
  );
const map = (error: unknown) =>
  toAIError(error, { provider: "anthropic", classify: classifyAnthropicError });

describe("classifyAnthropicError", () => {
  test("documented error types", () => {
    const cases: [number, string, AIErrorCode, boolean][] = [
      [400, "invalid_request_error", "invalid_request", false],
      [401, "authentication_error", "auth", true],
      [402, "billing_error", "billing", true],
      [403, "permission_error", "auth", true],
      [404, "not_found_error", "invalid_request", false],
      [429, "rate_limit_error", "rate_limit", true],
      [500, "api_error", "provider_unavailable", true],
      [504, "timeout_error", "timeout", true],
      [500, "timeout_error", "timeout", true],
      [529, "overloaded_error", "provider_unavailable", true],
    ];
    for (const [status, type, code, failover] of cases) {
      const err = map(http(status, type));
      expect({ status, type, code: err.code, failover: err.failover }).toEqual({
        status,
        type,
        code,
        failover,
      });
    }
  });

  test("mid-stream error events are mapped by type with no status", () => {
    const thrown = (type: string) => {
      try {
        new MessagesTranslator().push({ type: "error", error: { type, message: "m" } });
      } catch (e) {
        return e;
      }
    };
    expect(map(thrown("overloaded_error"))).toMatchObject({
      code: "provider_unavailable",
      status: undefined,
      providerType: "overloaded_error",
    });
    expect(map(thrown("rate_limit_error")).code).toBe("rate_limit");
    expect(map(thrown("invalid_request_error")).code).toBe("invalid_request");
    expect(map(thrown("something_new")).code).toBe("provider_unavailable");
  });

  test("an unknown type with a status falls back to the status", () => {
    expect(map(http(409, "conflict_error")).code).toBe("invalid_request");
    expect(map(http(413, "request_too_large")).code).toBe("context_length");
  });

  test("a type named like an Object.prototype member is not a known type", () => {
    expect(map(http(503, "constructor")).code).toBe("provider_unavailable");
  });

  test("the SDK's timeout and connection errors", () => {
    expect(new APIConnectionTimeoutError().message).toBe("Request timed out.");
    expect(map(new APIConnectionTimeoutError())).toMatchObject({ code: "timeout", failover: true });
    expect(map(new APIConnectionError({ message: undefined, cause: new Error("x") })).code).toBe(
      "provider_unavailable",
    );
  });
});
