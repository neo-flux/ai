import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { anthropic } from "../../src/anthropic/index.ts";
import { generate } from "../../src/generate.ts";

describe("anthropic adapter", () => {
  test("passes the context signal to messages.create", async () => {
    const options: { signal?: AbortSignal }[] = [];
    const client = {
      messages: {
        create: async (_params: unknown, o: { signal?: AbortSignal }) => {
          options.push(o);
          return (async function* () {
            yield { type: "message_delta", delta: { stop_reason: "end_turn" } };
            yield { type: "message_stop" };
          })();
        },
      },
    } as unknown as Anthropic;
    await generate({
      model: anthropic({ client })("m"),
      messages: [{ role: "user", content: "q" }],
    });
    expect(options[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("rejects a client without messages.create", () => {
    expect(() => anthropic({ client: {} as Anthropic })).toThrow(TypeError);
    expect(() => anthropic({ client: { messages: {} } as unknown as Anthropic })).toThrow(
      TypeError,
    );
  });
});
