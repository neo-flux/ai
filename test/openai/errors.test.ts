import { describe, expect, test } from "bun:test";
import { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";
import { toAIError } from "../../src/errors.ts";
import { classifyOpenAIError } from "../../src/openai/errors.ts";

// Hand-built shapes from openai@7.57.0 core/error.js (APIError.generate puts body.error under
// `.error` and copies code/type/param). Codes from https://platform.openai.com/docs/guides/error-codes
// (checked 2026-11-18), for errors that can't be recorded safely.
const http = (status: number, code: string, type = "invalid_request_error") =>
  APIError.generate(
    status,
    { error: { message: "m", type, param: null, code } },
    undefined,
    new Headers(),
  );
const map = (error: unknown) =>
  toAIError(error, { provider: "openai", classify: classifyOpenAIError });

describe("classifyOpenAIError", () => {
  test("429 insufficient_quota is billing; other 429s stay rate_limit", () => {
    expect(map(http(429, "insufficient_quota", "insufficient_quota"))).toMatchObject({
      code: "billing",
      retryable: false,
      failover: true,
      status: 429,
    });
    expect(map(http(429, "rate_limit_exceeded", "requests")).code).toBe("rate_limit");
  });

  test("400 context_length_exceeded is context_length", () => {
    expect(map(http(400, "context_length_exceeded"))).toMatchObject({
      code: "context_length",
      failover: false,
    });
    expect(map(http(400, "integer_below_min_value")).code).toBe("invalid_request");
  });

  test("status-less stream errors are mapped by code", () => {
    const mid = (code: string) =>
      Object.assign(new Error("response failed"), { status: undefined, error: { code }, code });
    expect(map(mid("rate_limit_exceeded")).code).toBe("rate_limit");
    expect(map(mid("context_length_exceeded")).code).toBe("context_length");
    expect(map(mid("insufficient_quota")).code).toBe("billing");
    expect(map(mid("server_error")).code).toBe("provider_unavailable");
    expect(map(mid("something_new")).code).toBe("provider_unavailable");
  });

  test("the SDK's timeout and connection errors", () => {
    expect(map(new APIConnectionTimeoutError())).toMatchObject({ code: "timeout", failover: true });
    expect(map(new APIConnectionError({ message: undefined, cause: new Error("x") })).code).toBe(
      "provider_unavailable",
    );
  });

  test("other statuses fall through to the core defaults", () => {
    expect(map(http(401, "invalid_api_key")).code).toBe("auth");
    expect(map(http(404, "model_not_found")).code).toBe("invalid_request");
    expect(map(http(500, "server_error", "server_error")).code).toBe("provider_unavailable");
  });
});
