import { describe, expect, test } from "bun:test";
import type OpenAI from "openai";
import { APIConnectionError, APIError } from "openai";
import { deepseek } from "../../src/deepseek/index.ts";
import { type AIError, type AIErrorCode, toAIError } from "../../src/errors.ts";
import { generate } from "../../src/generate.ts";

// Hand-built shapes for errors that can't be triggered safely, so they are not in fixtures/.
// Statuses: https://api-docs.deepseek.com/quick_start/error_codes (checked 2026-11-17).
// Error classes: openai@7.57.0 core/error.js (APIError.generate) and core/streaming.js (mid-stream
// errors are `new APIError(undefined, body, ...)`). The bodies mirror the recorded DeepSeek errors.
const body = (type: string) => ({
  error: { message: "m", type, param: null, code: "invalid_request_error" },
});
const http = (status: number, headers: Record<string, string> = {}) =>
  APIError.generate(status, body("invalid_request_error"), undefined, new Headers(headers));

const ds = deepseek({
  client: { chat: { completions: { create: async () => [] } } } as unknown as OpenAI,
});
const classify = ds("deepseek-flash").adapter.classifyError;
const map = (error: unknown): AIError =>
  toAIError(error, { provider: "deepseek", classify, now: Date.parse("2026-11-17T00:00:00Z") });

describe("deepseek error shapes", () => {
  test("402 insufficient balance is billing: not retryable, fails over", () => {
    expect(map(http(402))).toMatchObject({
      code: "billing",
      retryable: false,
      failover: true,
      status: 402,
    });
  });

  test("the documented statuses", () => {
    const cases: [number, AIErrorCode, boolean][] = [
      [400, "invalid_request", false],
      [401, "auth", true],
      [413, "context_length", false],
      [422, "invalid_request", false],
      [429, "rate_limit", true],
      [500, "provider_unavailable", true],
      [503, "provider_unavailable", true],
      [504, "provider_unavailable", true],
    ];
    for (const [status, code, failover] of cases) {
      expect({ status, ...pick(map(http(status))) }).toEqual({ status, code, failover });
    }
  });

  test("429 reads retry-after", () => {
    expect(map(http(429, { "retry-after": "3" })).retryAfterMs).toBe(3000);
  });

  test("a mid-stream error and a connection error are provider_unavailable", () => {
    const midStream = new APIError(undefined, body("server_error").error, undefined, undefined);
    expect(map(midStream)).toMatchObject({ code: "provider_unavailable", failover: true });
    const connection = new APIConnectionError({ message: undefined, cause: new Error("reset") });
    expect(map(connection).code).toBe("provider_unavailable");
  });
});

describe("deepseek finish reasons that mean the answer was cut off", () => {
  const stream = (finish: string) =>
    deepseek({
      client: {
        chat: {
          completions: {
            create: async () =>
              (async function* () {
                yield {
                  choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
                };
                yield { choices: [{ index: 0, delta: { content: "" }, finish_reason: finish }] };
              })(),
          },
        },
      } as unknown as OpenAI,
    })("deepseek-flash");

  test("insufficient_system_resource and aborted are provider_unavailable errors", async () => {
    for (const finish of ["insufficient_system_resource", "aborted"]) {
      const err = await generate({
        model: stream(finish),
        messages: [{ role: "user", content: "q" }],
      }).catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: "provider_unavailable",
        retryable: true,
        failover: true,
        providerCode: finish,
      });
    }
  });
});

const pick = (e: AIError) => ({ code: e.code, failover: e.failover });
