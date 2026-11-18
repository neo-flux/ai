import { describe, expect, test } from "bun:test";
import type OpenAI from "openai";
import { generate } from "../../src/generate.ts";
import { openai } from "../../src/openai/index.ts";

describe("openai adapter", () => {
  test("passes the context signal to responses.create", async () => {
    const options: { signal?: AbortSignal }[] = [];
    const client = {
      responses: {
        create: async (_params: unknown, o: { signal?: AbortSignal }) => {
          options.push(o);
          return (async function* () {
            yield { type: "response.completed", response: { usage: null } };
          })();
        },
      },
    } as unknown as OpenAI;
    await generate({ model: openai({ client })("m"), messages: [{ role: "user", content: "q" }] });
    expect(options[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("rejects a client without responses.create", () => {
    expect(() => openai({ client: {} as OpenAI })).toThrow(TypeError);
    expect(() => openai({ client: { responses: {} } as unknown as OpenAI })).toThrow(TypeError);
  });
});
