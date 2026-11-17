import { describe, expect, expectTypeOf, test } from "bun:test";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";
import { z } from "zod";
import { type AIError, isAIError } from "../../src/errors.ts";
import type { StreamEvent } from "../../src/events.ts";
import { generate, parseOutput, repairPrompt } from "../../src/generate.ts";
import type { AttemptContext } from "../../src/hooks.ts";
import type { Message } from "../../src/messages.ts";
import { fakeAdapter } from "../../src/testing/fake-adapter.ts";

const messages: Message[] = [{ role: "user", content: "give me a city" }];
const flags = { inputIncludesCached: true, outputIncludesReasoning: true };
const answer = (text: string, inputTokens = 10, outputTokens = 5) => ({
  events: [
    { type: "text-delta", text } as StreamEvent,
    { type: "usage", usage: { ...flags, inputTokens, outputTokens } } as StreamEvent,
    { type: "finish", reason: "stop" } as StreamEvent,
  ],
});
const city = z.object({ name: z.string(), population: z.number() });

describe("generate", () => {
  test("returns the folded result, with output undefined when no schema is given", async () => {
    const fake = fakeAdapter([answer("hello")]);
    const r = await generate({ model: fake("m"), messages });
    expect(r.text).toBe("hello");
    expect(r.output).toBeUndefined();
    expect(r.usage.inputTokens).toBe(10);
    expectTypeOf(r.output).toEqualTypeOf<undefined>();
  });

  test("throws the AIError the stream ended with", async () => {
    const fake = fakeAdapter([{ throwBefore: { status: 401 } }]);
    const error = await generate({ model: fake("m"), messages }).catch((e: unknown) => e);
    expect(isAIError(error)).toBe(true);
    expect((error as AIError).code).toBe("auth");
  });

  test("falls back like streamText", async () => {
    const a = fakeAdapter([{ throwBefore: { status: 429 } }]);
    const b = fakeAdapter([answer("b")]);
    expect((await generate({ model: [a("a"), b("b")], messages })).modelRef.id).toBe("b");
  });

  test("hook errors propagate unchanged", async () => {
    const thrown = { mine: true };
    const fake = fakeAdapter([answer("x")]);
    await expect(
      generate({
        model: fake("m"),
        messages,
        hooks: {
          beforeRequest: () => {
            throw thrown;
          },
        },
      }),
    ).rejects.toBe(thrown);
  });

  test("round-trips provider metadata into the next request untouched", async () => {
    const reasoningMeta = { fake: { signature: "sig" } };
    const callMeta = { fake: { item: "i1" } };
    const messageMeta = { fake: { response: "r1" } };
    const fake = fakeAdapter([
      {
        events: [
          { type: "reasoning-delta", text: "hm" },
          { type: "reasoning-end", providerMetadata: reasoningMeta },
          { type: "tool-call-start", id: "c1", name: "lookup" },
          { type: "tool-call-delta", id: "c1", inputDelta: "{}" },
          { type: "tool-call-end", id: "c1", providerMetadata: callMeta },
          { type: "finish", reason: "tool-calls", providerMetadata: messageMeta },
        ],
      },
      answer("done"),
    ]);
    const tools = { lookup: { schema: z.object({}) } };
    const first = await generate({ model: fake("m"), messages, tools });
    expect(first.toolCalls[0]?.providerMetadata).toBe(callMeta);
    await generate({
      model: fake("m"),
      tools,
      messages: [
        ...messages,
        first.message,
        { role: "tool", toolCallId: "c1", toolName: "lookup", content: "ok" },
      ],
    });
    const sent = fake.calls[1]?.request.messages[1];
    expect(sent).toBe(first.message);
    if (sent?.role !== "assistant" || typeof sent.content === "string") throw new Error("shape");
    expect(sent.providerMetadata).toBe(messageMeta);
    expect((sent.content[0] as { providerMetadata: unknown }).providerMetadata).toBe(reasoningMeta);
    expect((sent.content[1] as { providerMetadata: unknown }).providerMetadata).toBe(callMeta);
  });
});

describe("generate: structured output", () => {
  test("valid on the first try: one call, typed output, schema sent to the adapter", async () => {
    const fake = fakeAdapter([answer('{"name":"Lahore","population":13}')]);
    const r = await generate({ model: fake("m"), messages, output: city });
    expect(r.output).toEqual({ name: "Lahore", population: 13 });
    expectTypeOf(r.output).toEqualTypeOf<{ name: string; population: number }>();
    expect(fake.calls).toHaveLength(1);
    const request = fake.calls[0]?.request;
    expect(request?.output?.name).toBe("output");
    expect(request?.output?.schema).toMatchObject({ type: "object" });
  });

  test("accepts JSON inside a Markdown fence", async () => {
    const fake = fakeAdapter([answer('```json\n{"name":"A","population":1}\n```')]);
    expect((await generate({ model: fake("m"), messages, output: city })).output).toEqual({
      name: "A",
      population: 1,
    });
  });

  test("works with Valibot", async () => {
    const fake = fakeAdapter([answer('{"name":"A"}')]);
    const schema = toStandardJsonSchema(v.object({ name: v.string() }));
    const r = await generate({ model: fake("m"), messages, output: schema });
    expect(r.output).toEqual({ name: "A" });
    expectTypeOf(r.output).toEqualTypeOf<{ name: string }>();
  });

  test("an invalid answer is repaired once with the exact repair messages", async () => {
    const bad = '{"name":"Lahore","population":"many"}';
    const fake = fakeAdapter([
      answer(bad, 10, 5),
      answer('{"name":"Lahore","population":13}', 20, 6),
    ]);
    const r = await generate({ model: fake("m"), messages, output: city });
    expect(r.output).toEqual({ name: "Lahore", population: 13 });
    expect(fake.calls).toHaveLength(2);
    const repair = fake.calls[1]?.request.messages ?? [];
    expect(repair.slice(0, -2)).toEqual(messages);
    expect(repair.at(-2)).toEqual({ role: "assistant", content: bad });
    expect(repair.at(-1)).toEqual({
      role: "user",
      content:
        "Your previous response was not valid JSON matching the required schema. Problems:\n" +
        "- population: Invalid input: expected number, received string\n" +
        "Reply with only the corrected JSON.",
    });
    expect(fake.calls[1]?.request.output).toEqual(fake.calls[0]?.request.output);
    expect(r.usage.inputTokens).toBe(30);
    expect(r.usage.outputTokens).toBe(11);
  });

  test("invalid JSON is repaired too", async () => {
    const fake = fakeAdapter([answer("not json"), answer('{"name":"A","population":1}')]);
    const r = await generate({ model: fake("m"), messages, output: city });
    expect(r.output).toEqual({ name: "A", population: 1 });
    expect(fake.calls[1]?.request.messages.at(-1)?.content).toContain(
      "The response is not valid JSON.",
    );
  });

  test("two failures throw output_validation with the last raw text and issues", async () => {
    const fake = fakeAdapter([answer("first bad"), answer('{"name":1}'), answer("never")]);
    const error = await generate({ model: fake("m"), messages, output: city }).catch(
      (e: unknown) => e,
    );
    expect(isAIError(error)).toBe(true);
    const e = error as AIError;
    expect(e.code).toBe("output_validation");
    expect(e.retryable).toBe(false);
    expect(e.rawText).toBe('{"name":1}');
    expect(e.issues?.length).toBeGreaterThan(0);
    expect(e.message).not.toContain("name");
    expect(fake.calls).toHaveLength(2);
  });

  test("the repair goes to the model that answered, not back through the chain", async () => {
    const a = fakeAdapter([{ throwBefore: { status: 503 } }, answer("unused")]);
    const b = fakeAdapter([answer("bad"), answer('{"name":"A","population":1}')]);
    const attempts: [string, number, string][] = [];
    const r = await generate({
      model: [a("a"), b("b")],
      messages,
      output: city,
      hooks: {
        beforeRequest: (_req, ctx: AttemptContext) => {
          attempts.push([ctx.modelRef.id, ctx.attempt, ctx.kind]);
          return undefined;
        },
        resolveModel: (models) => models,
      },
    });
    expect(r.modelRef.id).toBe("b");
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(2);
    expect(attempts).toEqual([
      ["a", 0, "initial"],
      ["b", 1, "initial"],
      ["b", 2, "repair"],
    ]);
  });

  test("onUsage sees the repair attempt and cost is summed", async () => {
    const fake = fakeAdapter([
      answer("bad", 1_000_000, 0),
      answer('{"name":"A","population":1}', 1_000_000, 0),
    ]);
    const kinds: string[] = [];
    const r = await generate({
      model: fake("m"),
      messages,
      output: city,
      price: () => ({ input: 2, output: 0 }),
      hooks: { onUsage: ({ ctx }) => void kinds.push(ctx.kind) },
    });
    expect(kinds).toEqual(["initial", "repair"]);
    expect(r.cost).toBe(4);
  });

  test("a failing repair request throws its own AIError", async () => {
    const fake = fakeAdapter([answer("bad"), { throwBefore: { status: 429 } }]);
    await expect(generate({ model: fake("m"), messages, output: city })).rejects.toMatchObject({
      code: "rate_limit",
    });
  });
});

describe("parseOutput and repairPrompt", () => {
  test("parseOutput trims and validates", async () => {
    expect(await parseOutput(city, ' {"name":"A","population":2}\n')).toEqual({
      ok: true,
      value: { name: "A", population: 2 },
    });
  });

  test("repairPrompt lists issues with dotted paths, including segment objects", () => {
    expect(
      repairPrompt([{ message: "bad", path: ["a", 0, { key: "b" }] }, { message: "top" }]),
    ).toBe(
      "Your previous response was not valid JSON matching the required schema. Problems:\n" +
        "- a.0.b: bad\n- top\nReply with only the corrected JSON.",
    );
  });
});
