import { describe, expect, test } from "bun:test";
import type OpenAI from "openai";
import { APIError } from "openai";
import { z } from "zod";
import { openaiCompatible } from "../../src/compat/index.ts";
import type { StreamEvent } from "../../src/events.ts";
import { generate } from "../../src/generate.ts";
import type { Message } from "../../src/messages.ts";
import { streamText } from "../../src/stream-text.ts";
import { checkEventOrder } from "../../src/testing/index.ts";

interface Call {
  params: Record<string, unknown>;
  options: { signal?: AbortSignal } | undefined;
}

// A hand-built client with only what the adapter may touch: chat.completions.create.
function client(turns: (unknown[] | (() => never))[]) {
  const calls: Call[] = [];
  const create = async (params: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
    calls.push({ params, options });
    const turn = turns[calls.length - 1];
    if (turn === undefined) throw new Error("no more turns");
    if (typeof turn === "function") turn();
    const chunks = turn as unknown[];
    return (async function* () {
      for (const c of chunks) {
        if (options?.signal?.aborted === true) return;
        await new Promise((r) => setTimeout(r, 1));
        yield c;
      }
    })();
  };
  return { calls, sdk: { chat: { completions: { create } } } as unknown as OpenAI };
}

const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) => ({
  id: "c",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta, finish_reason: finish }],
  ...(usage === undefined ? {} : { usage }),
});
const messages: Message[] = [{ role: "user", content: "hi" }];
const collect = async (it: AsyncIterable<StreamEvent>) => {
  const out: StreamEvent[] = [];
  for await (const e of checkEventOrder(it)) out.push(e);
  return out;
};

describe("openaiCompatible", () => {
  test("streams through core with the context signal passed to create()", async () => {
    const { sdk, calls } = client([
      [
        chunk({ content: "Hel" }),
        chunk({ content: "lo" }, "stop", { prompt_tokens: 2, completion_tokens: 1 }),
      ],
    ]);
    const m = openaiCompatible({ client: sdk })("my-model");
    const s = streamText({ model: m, messages });
    const events = await collect(s);
    expect(events.map((e) => e.type)).toEqual(["text-delta", "text-delta", "usage", "finish"]);
    const r = await s.result;
    expect(r.text).toBe("Hello");
    expect(r.usage).toMatchObject({ inputTokens: 2, outputTokens: 1 });
    expect(calls[0]?.params).toMatchObject({ model: "my-model", stream: true });
    expect(calls[0]?.options?.signal).toBeInstanceOf(AbortSignal);
    expect(m.provider).toBe("openai-compatible");
  });

  test("a custom provider name keys the reasoning metadata and errors", async () => {
    const { sdk } = client([
      [chunk({ reasoning_content: "r" }), chunk({ content: "a" }, "stop")],
      () => {
        throw APIError.generate(401, undefined, undefined, new Headers());
      },
    ]);
    const m = openaiCompatible({
      client: sdk,
      provider: "acme",
      quirks: { reasoningField: "reasoning_content" },
    })("x");
    const r = await generate({ model: m, messages });
    const part = (r.message.content as readonly unknown[])[0];
    expect(part).toMatchObject({
      type: "reasoning",
      providerMetadata: { acme: { reasoningField: "reasoning_content" } },
    });
    await expect(generate({ model: m, messages })).rejects.toMatchObject({
      code: "auth",
      provider: "acme",
    });
  });

  test("an invalid request fails before any network call", async () => {
    const { sdk, calls } = client([]);
    const m = openaiCompatible({ client: sdk })("x", { body: { model: "other" } });
    await expect(generate({ model: m, messages })).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(calls).toHaveLength(0);
  });

  test("breaking out of the stream aborts the signal given to create()", async () => {
    const { sdk, calls } = client([
      [chunk({ content: "a" }), chunk({ content: "b" }), chunk({ content: "c" }, "stop")],
    ]);
    for await (const e of streamText({ model: openaiCompatible({ client: sdk })("x"), messages })) {
      if (e.type === "text-delta") break;
    }
    expect(calls[0]?.options?.signal?.aborted).toBe(true);
  });

  test("rejects a client without chat.completions.create and an unsafe provider name", () => {
    expect(() => openaiCompatible({ client: {} as OpenAI })).toThrow(TypeError);
    const { sdk } = client([]);
    expect(() => openaiCompatible({ client: sdk, provider: "has spaces" })).toThrow(TypeError);
    expect(() => openaiCompatible({ client: sdk, provider: "" })).toThrow(TypeError);
  });
});

describe("openaiCompatible: a second provider is data, not code", () => {
  // An inline quirk set unlike DeepSeek's, covering what another Chat Completions server needs:
  // json_schema with strict, max_completion_tokens, echoed reasoning, a body field from options,
  // and a typed 403 code mapped by the quirk.
  const quirks = {
    reasoningField: "reasoning_content",
    echoReasoning: true,
    structuredOutput: { mode: "json_schema", strict: true } as const,
    maxTokensField: "max_completion_tokens" as const,
    options: (o: Record<string, unknown>) => ({
      ...(o.think === undefined ? {} : { enable_thinking: o.think }),
      ...(o.body as object),
    }),
    classifyError: (shape: { status: number | undefined; code: string | undefined }) =>
      shape.status === 403 && shape.code === "Access.Unpaid"
        ? { code: "billing" as const }
        : undefined,
  };

  test("request, structured output, reasoning echo and error mapping", async () => {
    const { sdk, calls } = client([
      [
        chunk({ reasoning_content: "plan" }),
        chunk({ content: '{"name":"A","population":1}' }, "stop"),
      ],
      [chunk({ content: "ok" }, "stop")],
      () => {
        throw APIError.generate(
          403,
          { error: { code: "Access.Unpaid" } },
          undefined,
          new Headers(),
        );
      },
    ]);
    const m = openaiCompatible<{ think?: boolean }>({ client: sdk, provider: "other", quirks })(
      "model-b",
      {
        think: true,
      },
    );
    const first = await generate({
      model: m,
      messages,
      output: z.object({ name: z.string(), population: z.number() }),
      maxOutputTokens: 50,
    });
    expect(first.output).toEqual({ name: "A", population: 1 });
    expect(calls[0]?.params).toMatchObject({
      enable_thinking: true,
      max_completion_tokens: 50,
      response_format: { type: "json_schema", json_schema: { name: "output", strict: true } },
    });
    await generate({
      model: m,
      messages: [...messages, first.message, { role: "user", content: "and?" }],
    });
    const sent = (calls[1]?.params.messages as Record<string, unknown>[] | undefined)?.[1];
    expect(sent).toMatchObject({ role: "assistant", reasoning_content: "plan" });
    await expect(generate({ model: m, messages })).rejects.toMatchObject({
      code: "billing",
      failover: true,
    });
  });
});
