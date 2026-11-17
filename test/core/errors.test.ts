import { describe, expect, test } from "bun:test";
import { inspect } from "node:util";
import {
  AIError,
  type AIErrorCode,
  isAIError,
  parseRetryAfter,
  toAIError,
} from "../../src/errors.ts";

const SECRET = "SECRET-KEY-123";
const CONTENT = "USER-CONTENT-XYZ";
const BRAND = Symbol.for("neoflux.ai.error");

describe("AIError", () => {
  test("is an Error with name, code and a message built from safe fields only", () => {
    const err = new AIError({ code: "rate_limit", provider: "anthropic", status: 429 });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("AIError");
    expect(err.code).toBe("rate_limit");
    expect(err.message).toBe("rate_limit (anthropic, HTTP 429)");
    expect(err.toString()).toBe("AIError: rate_limit (anthropic, HTTP 429)");
    expect(new AIError({ code: "auth" }).message).toBe("auth");
    expect(new AIError({ code: "auth", provider: "openai" }).message).toBe("auth (openai)");
    expect(new AIError({ code: "auth", status: 401 }).message).toBe("auth (HTTP 401)");
  });

  test("default retryable per code", () => {
    const expected: Record<AIErrorCode, boolean> = {
      rate_limit: true,
      timeout: true,
      provider_unavailable: true,
      context_length: false,
      auth: false,
      content_filter: false,
      invalid_request: false,
      output_validation: false,
      aborted: false,
      unknown: false,
    };
    for (const [code, retryable] of Object.entries(expected)) {
      expect({ code, retryable: new AIError({ code: code as AIErrorCode }).retryable }).toEqual({
        code,
        retryable,
      });
    }
  });

  test("retryable can be overridden, except for aborted", () => {
    expect(new AIError({ code: "rate_limit", retryable: false }).retryable).toBe(false);
    expect(new AIError({ code: "unknown", retryable: true }).retryable).toBe(true);
    expect(new AIError({ code: "aborted", retryable: true }).retryable).toBe(false);
  });

  test("never exposes cause, rawText or issues through message, toString, JSON or spread", () => {
    const err = new AIError({
      code: "output_validation",
      provider: "fake",
      cause: new Error(`${SECRET} ${CONTENT}`),
      rawText: CONTENT,
      issues: [{ message: CONTENT, path: [SECRET] }],
    });
    expect(err.rawText).toBe(CONTENT);
    expect(err.issues?.[0]?.message).toBe(CONTENT);
    const surfaces = [
      err.message,
      err.toString(),
      JSON.stringify(err),
      JSON.stringify({ ...err }),
      Object.keys(err).join(","),
      String(err.stack).split("\n")[0],
    ];
    for (const s of surfaces) {
      expect(s).not.toContain(SECRET);
      expect(s).not.toContain(CONTENT);
    }
    expect(Object.keys(err)).not.toContain("rawText");
    expect(Object.keys(err)).not.toContain("issues");
    expect(Object.keys(err)).not.toContain("cause");
  });

  test("toJSON lists only safe fields", () => {
    const err = new AIError({
      code: "rate_limit",
      provider: "openai",
      status: 429,
      providerCode: "rate_limit_exceeded",
      providerType: "requests",
      retryAfterMs: 1500,
      rawText: CONTENT,
      cause: SECRET,
    });
    expect(err.toJSON()).toEqual({
      name: "AIError",
      code: "rate_limit",
      retryable: true,
      provider: "openai",
      status: 429,
      providerCode: "rate_limit_exceeded",
      providerType: "requests",
      retryAfterMs: 1500,
    });
    expect(new AIError({ code: "auth" }).toJSON()).toEqual({
      name: "AIError",
      code: "auth",
      retryable: false,
    });
  });

  test("drops provider codes and types that are not short identifiers", () => {
    const err = new AIError({
      code: "invalid_request",
      providerCode: `bad value ${CONTENT}`,
      providerType: "x".repeat(65),
      provider: "has space",
    });
    expect(err.providerCode).toBeUndefined();
    expect(err.providerType).toBeUndefined();
    expect(err.provider).toBeUndefined();
    expect(new AIError({ code: "auth", providerCode: "invalid_api_key" }).providerCode).toBe(
      "invalid_api_key",
    );
  });

  test("keeps cause for debugging", () => {
    const cause = new Error("x");
    expect(new AIError({ code: "unknown", cause }).cause).toBe(cause);
    expect("cause" in new AIError({ code: "unknown" })).toBe(false);
  });
});

describe("isAIError and instanceof", () => {
  test("recognise instances and branded objects from another copy", () => {
    const foreign = Object.defineProperty(Object.create(Error.prototype), BRAND, { value: true });
    expect(isAIError(new AIError({ code: "auth" }))).toBe(true);
    expect(isAIError(foreign)).toBe(true);
    expect(foreign instanceof AIError).toBe(true);
    expect(new AIError({ code: "auth" }) instanceof AIError).toBe(true);
  });

  test("reject look-alikes", () => {
    for (const value of [
      { code: "auth", retryable: false, name: "AIError" },
      new Error("x"),
      null,
      undefined,
      "AIError",
      { [BRAND]: "true" },
      { [Symbol("neoflux.ai.error")]: true },
    ]) {
      expect(isAIError(value)).toBe(false);
      expect(value instanceof AIError).toBe(false);
    }
  });

  test("brand is non-enumerable", () => {
    const err = new AIError({ code: "auth" });
    expect(Object.getOwnPropertyDescriptor(err, BRAND)?.enumerable).toBe(false);
    expect(inspect(err)).not.toContain("neoflux.ai.error");
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");

  test("reads delta seconds and milliseconds, preferring milliseconds", () => {
    expect(parseRetryAfter({ "retry-after": "2" }, now)).toBe(2000);
    expect(parseRetryAfter({ "retry-after-ms": "150" }, now)).toBe(150);
    expect(parseRetryAfter({ "retry-after-ms": "150", "retry-after": "9" }, now)).toBe(150);
    expect(parseRetryAfter({ "retry-after-ms": "12.5" }, now)).toBe(13);
  });

  test("reads an HTTP date relative to now, never negative", () => {
    expect(parseRetryAfter({ "retry-after": "Thu, 01 Jan 2026 00:00:05 GMT" }, now)).toBe(5000);
    expect(parseRetryAfter({ "retry-after": "Wed, 31 Dec 2025 23:59:00 GMT" }, now)).toBe(0);
  });

  test("drops values that aren't finite safe integers", () => {
    expect(parseRetryAfter({ "retry-after": "9".repeat(400) }, now)).toBeUndefined();
    expect(parseRetryAfter({ "retry-after-ms": "9".repeat(400) }, now)).toBeUndefined();
    expect(parseRetryAfter({ "retry-after": "9007199254740993" }, now)).toBeUndefined();
  });

  test("ignores garbage and negatives", () => {
    expect(parseRetryAfter({ "retry-after": "soon" }, now)).toBeUndefined();
    expect(parseRetryAfter({ "retry-after": "-3" }, now)).toBeUndefined();
    expect(parseRetryAfter({ "retry-after-ms": "-3", "retry-after": "1" }, now)).toBe(1000);
    expect(parseRetryAfter({}, now)).toBeUndefined();
    expect(parseRetryAfter(undefined, now)).toBeUndefined();
  });

  test("reads Headers instances and records case-insensitively", () => {
    expect(parseRetryAfter(new Headers({ "Retry-After": "3" }), now)).toBe(3000);
    expect(parseRetryAfter({ "Retry-After-Ms": "40" }, now)).toBe(40);
    expect(parseRetryAfter({ "retry-after": ["4"] }, now)).toBe(4000);
  });
});

describe("toAIError", () => {
  const provider = "fake";
  const http = (status: number, extra: Record<string, unknown> = {}) => ({ status, ...extra });

  test("maps HTTP status by shape", () => {
    const cases: [number, AIErrorCode, boolean][] = [
      [400, "invalid_request", false],
      [401, "auth", false],
      [403, "auth", false],
      [404, "invalid_request", false],
      [408, "timeout", true],
      [413, "context_length", false],
      [422, "invalid_request", false],
      [429, "rate_limit", true],
      [499, "invalid_request", false],
      [500, "provider_unavailable", true],
      [503, "provider_unavailable", true],
      [529, "provider_unavailable", true],
      [599, "provider_unavailable", true],
    ];
    for (const [status, code, retryable] of cases) {
      const err = toAIError(http(status), { provider });
      expect({ status, code: err.code, retryable: err.retryable }).toEqual({
        status,
        code,
        retryable,
      });
      expect(err.status).toBe(status);
      expect(err.provider).toBe(provider);
    }
  });

  test("reads statusCode as an alias and ignores non-numeric status", () => {
    expect(toAIError({ statusCode: 429 }, { provider }).code).toBe("rate_limit");
    expect(toAIError({ status: "429" }, { provider }).code).toBe("unknown");
  });

  test("an unmapped status outside 4xx and 5xx is unknown", () => {
    expect(toAIError(http(302), { provider }).code).toBe("unknown");
  });

  test("passes an AIError through by identity", () => {
    const err = new AIError({ code: "auth" });
    expect(toAIError(err, { provider })).toBe(err);
  });

  test("adapter classify wins over status defaults and receives the shape", () => {
    const seen: unknown[] = [];
    const err = toAIError(
      { status: 400, error: { type: "invalid_request_error", code: "context_length_exceeded" } },
      {
        provider,
        classify: (shape) => {
          seen.push(shape);
          return shape.code === "context_length_exceeded" ? { code: "context_length" } : undefined;
        },
      },
    );
    expect(err.code).toBe("context_length");
    expect(err.providerCode).toBe("context_length_exceeded");
    expect(err.providerType).toBe("invalid_request_error");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      status: 400,
      code: "context_length_exceeded",
      type: "invalid_request_error",
    });
  });

  test("classify may override retryable", () => {
    const err = toAIError(http(429), {
      provider,
      classify: () => ({ code: "rate_limit", retryable: false }),
    });
    expect(err.retryable).toBe(false);
  });

  test("classify returning undefined falls back to status", () => {
    expect(toAIError(http(401), { provider, classify: () => undefined }).code).toBe("auth");
  });

  test("top-level type and code are read too", () => {
    const err = toAIError({ status: 400, type: "t1", code: "c1" }, { provider });
    expect(err.providerType).toBe("t1");
    expect(err.providerCode).toBe("c1");
  });

  test("a caller abort wins over everything and is never retryable", () => {
    const controller = new AbortController();
    controller.abort();
    const err = toAIError(http(429), { provider, signal: controller.signal });
    expect(err.code).toBe("aborted");
    expect(err.retryable).toBe(false);
  });

  test("a caller timeout signal is a non-retryable timeout", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("timed out", "TimeoutError"));
    const signal = controller.signal;
    const err = toAIError({ name: "AbortError" }, { provider, signal });
    expect(err.code).toBe("timeout");
    expect(err.retryable).toBe(false);
  });

  test("TimeoutError without a caller abort is a retryable timeout", () => {
    const err = toAIError(
      { name: "TimeoutError" },
      { provider, signal: new AbortController().signal },
    );
    expect(err.code).toBe("timeout");
    expect(err.retryable).toBe(true);
  });

  test("AbortError without a caller abort is a retryable provider_unavailable", () => {
    const err = toAIError({ name: "AbortError" }, { provider });
    expect(err.code).toBe("provider_unavailable");
    expect(err.retryable).toBe(true);
  });

  test("anything else is unknown, non-retryable, with the original as cause", () => {
    for (const value of ["boom", new TypeError("x"), 42, null, undefined, {}]) {
      const err = toAIError(value, { provider });
      expect(err.code).toBe("unknown");
      expect(err.retryable).toBe(false);
      expect(err.cause).toBe(value);
    }
  });

  test("reads retry headers from the shape", () => {
    const err = toAIError(http(429, { headers: new Headers({ "retry-after": "7" }) }), {
      provider,
    });
    expect(err.retryAfterMs).toBe(7000);
  });

  test("never copies provider message text into the error message", () => {
    const err = toAIError(
      { status: 400, message: `${SECRET} ${CONTENT}`, error: { message: CONTENT } },
      { provider },
    );
    expect(err.message).toBe("invalid_request (fake, HTTP 400)");
    expect(JSON.stringify(err)).not.toContain(CONTENT);
  });
});
