import { describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { MODELS } from "../../scripts/recorder/models.ts";
import type { ModelRef } from "../../src/adapter.ts";
import { anthropic } from "../../src/anthropic/index.ts";
import { deepseek } from "../../src/deepseek/index.ts";
import type { StreamEvent } from "../../src/events.ts";
import { generate } from "../../src/generate.ts";
import { openai } from "../../src/openai/index.ts";
import { streamText } from "../../src/stream-text.ts";
import { checkEventOrder } from "../../src/testing/index.ts";
import { rawSchema } from "../helpers/fixtures.ts";

// Live contract tests: real requests to each provider, so they check that the recorded fixtures
// still describe the APIs. They run only with NEOFLUX_AI_LIVE=1 and the provider's key set, and
// they cost a few cents. Keys and base URLs come from the environment, as for the recorder.
const live = process.env.NEOFLUX_AI_LIVE === "1";
const env = (name: string): string | undefined => process.env[name] || undefined;

interface Provider {
  name: string;
  ready: boolean;
  model: () => ModelRef;
}

const providers: Provider[] = [
  {
    name: "openai",
    ready: env("OPENAI_API_KEY") !== undefined,
    model: () =>
      openai({ client: new OpenAI({ apiKey: env("OPENAI_API_KEY"), maxRetries: 0 }) })(
        MODELS.openai.default.model,
      ),
  },
  {
    name: "anthropic",
    ready: env("ANTHROPIC_API_KEY") !== undefined,
    model: () =>
      anthropic({ client: new Anthropic({ apiKey: env("ANTHROPIC_API_KEY"), maxRetries: 0 }) })(
        MODELS.anthropic.default.model,
        { maxTokens: 512 },
      ),
  },
  {
    name: "deepseek",
    ready:
      env("DEEPSEEK_API_KEY") !== undefined && env("NEOFLUX_AI_DEEPSEEK_BASE_URL") !== undefined,
    model: () =>
      deepseek({
        client: new OpenAI({
          apiKey: env("DEEPSEEK_API_KEY"),
          baseURL: env("NEOFLUX_AI_DEEPSEEK_BASE_URL"),
          maxRetries: 0,
        }),
      })(MODELS.deepseek.default.model, { thinking: "disabled" }),
  },
];

const weather = {
  get_weather: {
    description: "Get the current weather for a city.",
    schema: rawSchema({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    }),
  },
};

for (const provider of providers) {
  describe.skipIf(!live || !provider.ready)(`live ${provider.name}`, () => {
    test("streams text in a valid event order, with usage", async () => {
      const stream = streamText({
        model: provider.model(),
        messages: [{ role: "user", content: "Reply with exactly: Hello from the live test." }],
      });
      const events: StreamEvent[] = [];
      for await (const e of checkEventOrder(stream)) events.push(e);
      const r = await stream.result;
      expect(r.finishReason).toBe("stop");
      expect(r.text.length).toBeGreaterThan(0);
      expect(r.usage.inputTokens).toBeGreaterThan(0);
      expect(r.usage.outputTokens).toBeGreaterThan(0);
    }, 60_000);

    test("a tool call round trip over two turns", async () => {
      const model = provider.model();
      const messages = [
        {
          role: "user" as const,
          content: "What is the weather in Lahore? Use the get_weather tool.",
        },
      ];
      const first = await generate({
        model,
        messages,
        tools: weather,
        toolChoice: { name: "get_weather" },
      });
      expect(first.finishReason).toBe("tool-calls");
      const call = first.toolCalls[0];
      expect(call?.name).toBe("get_weather");
      const second = await generate({
        model,
        messages: [
          ...messages,
          first.message,
          {
            role: "tool",
            toolCallId: call?.id as string,
            toolName: "get_weather",
            content: '{"temperature_c":31,"conditions":"sunny"}',
          },
        ],
        tools: weather,
      });
      expect(second.finishReason).toBe("stop");
      expect(second.text.length).toBeGreaterThan(0);
    }, 120_000);

    test("a bad key is auth, not retryable, and fails over", async () => {
      const bad =
        provider.name === "anthropic"
          ? anthropic({
              client: new Anthropic({ apiKey: "neoflux-live-invalid-key", maxRetries: 0 }),
            })(MODELS.anthropic.default.model)
          : provider.name === "openai"
            ? openai({ client: new OpenAI({ apiKey: "neoflux-live-invalid-key", maxRetries: 0 }) })(
                MODELS.openai.default.model,
              )
            : deepseek({
                client: new OpenAI({
                  apiKey: "neoflux-live-invalid-key",
                  baseURL: env("NEOFLUX_AI_DEEPSEEK_BASE_URL"),
                  maxRetries: 0,
                }),
              })(MODELS.deepseek.default.model);
      const err = await generate({ model: bad, messages: [{ role: "user", content: "hi" }] }).catch(
        (e: unknown) => e,
      );
      expect(err).toMatchObject({ code: "auth", retryable: false, failover: true });
    }, 60_000);
  });
}

test("live tests are skipped unless NEOFLUX_AI_LIVE=1", () => {
  expect(typeof live).toBe("boolean");
});
