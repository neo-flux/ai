import { describe, expect, test } from "bun:test";
import type OpenAI from "openai";
import { deepseek } from "../../src/deepseek/index.ts";
import { generate } from "../../src/generate.ts";

// A client that records the request and answers with one hand-built chunk.
function recording(usage: Record<string, unknown>) {
  const params: Record<string, unknown>[] = [];
  const client = {
    chat: {
      completions: {
        create: async (p: Record<string, unknown>) => {
          params.push(p);
          return (async function* () {
            yield {
              choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
              usage,
            };
          })();
        },
      },
    },
  } as unknown as OpenAI;
  return { params, ds: deepseek({ client }) };
}
const messages = [{ role: "user" as const, content: "q" }];

describe("deepseek options and usage", () => {
  test("thinking, reasoningEffort and body become request fields; call options win", async () => {
    const { params, ds } = recording({ prompt_tokens: 1, completion_tokens: 1 });
    await generate({
      model: ds("deepseek-flash", {
        thinking: "enabled",
        reasoningEffort: "low",
        body: { top_p: 0.9 },
      }),
      messages,
      providerOptions: { deepseek: { reasoningEffort: "max" } },
    });
    expect(params[0]).toMatchObject({
      thinking: { type: "enabled" },
      reasoning_effort: "max",
      top_p: 0.9,
    });
  });

  test("unset options aren't sent", async () => {
    const { params, ds } = recording({ prompt_tokens: 1, completion_tokens: 1 });
    await generate({ model: ds("deepseek-flash"), messages });
    expect("thinking" in (params[0] ?? {})).toBe(false);
    expect("reasoning_effort" in (params[0] ?? {})).toBe(false);
  });

  test("cached input falls back to prompt_cache_hit_tokens", async () => {
    const { ds } = recording({
      prompt_tokens: 10,
      completion_tokens: 1,
      prompt_cache_hit_tokens: 4,
    });
    const r = await generate({ model: ds("deepseek-flash"), messages });
    expect(r.usage.cachedInputTokens).toBe(4);
  });
});
