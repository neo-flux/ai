import { describe, expect, test } from "bun:test";
import { APIConnectionError, APIConnectionTimeoutError, APIError } from "openai";
import { classifyCompatError } from "../../src/compat/errors.ts";
import { resolveQuirks } from "../../src/compat/quirks.ts";
import { getProviderError, toAIError } from "../../src/errors.ts";

const classify = classifyCompatError(resolveQuirks());
const map = (error: unknown, c = classify) => toAIError(error, { provider: "acme", classify: c });

describe("classifyCompatError", () => {
  test("the SDK's timeout error is a timeout, pinned to the SDK's own message", () => {
    const sdk = new APIConnectionTimeoutError();
    // openai/core/error.js: APIConnectionTimeoutError's default message. If the SDK changes it,
    // this fails and the constant in src/compat/errors.ts has to follow.
    expect(sdk.message).toBe("Request timed out.");
    const err = map(sdk);
    expect(err).toMatchObject({ code: "timeout", retryable: true, failover: true });
    expect(getProviderError(err)).toBe(sdk);
  });

  test("other connection errors are provider_unavailable", () => {
    const err = map(new APIConnectionError({ message: undefined, cause: new Error("ECONNRESET") }));
    expect(err).toMatchObject({ code: "provider_unavailable", retryable: true, failover: true });
  });

  test("a recorded-shape timeout (plain Error with the SDK fields) is a timeout", () => {
    const replayed = Object.assign(new Error("Request timed out."), {
      status: undefined,
      error: null,
      code: null,
      type: null,
      param: null,
      headers: new Headers(),
    });
    expect(map(replayed).code).toBe("timeout");
  });

  test("a mid-stream error has a body and no status: provider_unavailable", () => {
    const err = map(
      new APIError(undefined, { type: "server_error", message: "x" }, undefined, undefined),
    );
    expect(err).toMatchObject({
      code: "provider_unavailable",
      retryable: true,
      providerType: "server_error",
    });
  });

  test("errors that aren't SDK-shaped are left to core", () => {
    expect(
      classify(
        {
          status: undefined,
          type: undefined,
          code: undefined,
          name: "TypeError",
          headers: undefined,
        },
        new TypeError("bug"),
      ),
    ).toBeUndefined();
    expect(map(new TypeError("bug")).code).toBe("unknown");
  });

  test("status errors fall through to the core defaults", () => {
    const sdk = APIError.generate(
      401,
      { error: { type: "authentication_error" } },
      undefined,
      new Headers(),
    );
    expect(map(sdk)).toMatchObject({ code: "auth", status: 401 });
    expect(map(APIError.generate(503, undefined, undefined, new Headers())).code).toBe(
      "provider_unavailable",
    );
  });

  test("the quirk classifier runs first", () => {
    const c = classifyCompatError(
      resolveQuirks({
        classifyError: (shape) => (shape.status === 402 ? { code: "billing" } : undefined),
      }),
    );
    const err = map(APIError.generate(402, undefined, undefined, new Headers()), c);
    expect(err).toMatchObject({ code: "billing", retryable: false, failover: true });
    expect(map(new APIConnectionTimeoutError(), c).code).toBe("timeout");
  });
});

describe("classifyCompatError: audit follow-ups", () => {
  test("an object with a status key but no error key is not treated as an SDK error", () => {
    const shape = {
      status: undefined,
      type: undefined,
      code: undefined,
      name: undefined,
      headers: undefined,
    };
    expect(classify(shape, { status: undefined, message: "Request timed out." })).toBeUndefined();
  });
});
