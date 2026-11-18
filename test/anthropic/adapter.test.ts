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

  test("the signal given to create() is the one aborted when the caller stops reading", async () => {
    const signals: AbortSignal[] = [];
    const client = {
      messages: {
        create: async (_params: unknown, o: { signal: AbortSignal }) => {
          signals.push(o.signal);
          return (async function* () {
            yield {
              type: "content_block_start",
              index: 0,
              content_block: { type: "text", text: "" },
            };
            yield {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: "a" },
            };
            await new Promise((r) => setTimeout(r, 50));
          })();
        },
      },
    } as unknown as Anthropic;
    const { streamText } = await import("../../src/stream-text.ts");
    for await (const e of streamText({
      model: anthropic({ client })("m"),
      messages: [{ role: "user", content: "q" }],
    })) {
      if (e.type === "text-delta") break;
    }
    expect(signals[0]?.aborted).toBe(true);
  });

  test("rejects a client without messages.create", () => {
    expect(() => anthropic({ client: {} as Anthropic })).toThrow(TypeError);
    expect(() => anthropic({ client: { messages: {} } as unknown as Anthropic })).toThrow(
      TypeError,
    );
  });
});
