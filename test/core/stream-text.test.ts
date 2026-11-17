import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { type Adapter, defineProvider, type ModelRequest } from "../../src/adapter.ts";
import { AIError, type AIErrorCode, isAIError } from "../../src/errors.ts";
import type { StreamEvent } from "../../src/events.ts";
import type { AttemptContext, ErrorContext, UsageInfo } from "../../src/hooks.ts";
import type { Message } from "../../src/messages.ts";
import { streamText } from "../../src/stream-text.ts";
import { fakeAdapter } from "../../src/testing/fake-adapter.ts";

const messages: Message[] = [{ role: "user", content: "hi" }];
const flags = { inputIncludesCached: true, outputIncludesReasoning: true };
const text = (t: string): StreamEvent => ({ type: "text-delta", text: t });
const finish: StreamEvent = { type: "finish", reason: "stop" };
const usage = (inputTokens: number, outputTokens: number): StreamEvent => ({
  type: "usage",
  usage: { ...flags, inputTokens, outputTokens },
});
const ok = (t: string) => ({ events: [text(t), usage(10, 2), finish] });
const rateLimited = { status: 429 };
const badRequest = { status: 400 };

const collect = async (iterable: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
};
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("streamText: basics", () => {
  test("streams events and folds them into the result", async () => {
    const fake = fakeAdapter([ok("hello")]);
    const s = streamText({ model: fake("m"), messages });
    const events = await collect(s);
    expect(events).toEqual([text("hello"), usage(10, 2), finish]);
    const r = await s.result;
    expect(r.text).toBe("hello");
    expect(r.finishReason).toBe("stop");
    expect(r.usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
      cachedInputTokens: undefined,
      cacheWriteTokens: undefined,
      reasoningTokens: undefined,
    });
    expect(r.cost).toBeUndefined();
    expect(r.modelRef.id).toBe("m");
    expect(r.message).toEqual({ role: "assistant", content: [{ type: "text", text: "hello" }] });
  });

  test("passes a normalized request and the signal to the adapter", async () => {
    const fake = fakeAdapter([ok("x")]);
    const tools = { weather: { description: "w", schema: z.object({ city: z.string() }) } };
    await streamText({
      model: fake("m"),
      messages,
      tools,
      toolChoice: { name: "weather" },
      maxOutputTokens: 50,
      temperature: 0.2,
      providerOptions: { fake: { a: 1 } },
    }).result;
    const request = fake.calls[0]?.request as ModelRequest;
    expect(request.messages).toBe(messages);
    expect(request.tools?.[0]).toMatchObject({ name: "weather", description: "w" });
    expect(request.tools?.[0]?.inputSchema).toMatchObject({ type: "object" });
    expect(request.toolChoice).toEqual({ name: "weather" });
    expect(request.maxOutputTokens).toBe(50);
    expect(request.temperature).toBe(0.2);
    expect(request.providerOptions).toEqual({ fake: { a: 1 } });
    expect("output" in request).toBe(false);
    expect(fake.calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  test("omits unset request fields", async () => {
    const fake = fakeAdapter([ok("x")]);
    await streamText({ model: fake("m"), messages }).result;
    expect(Object.keys(fake.calls[0]?.request ?? {})).toEqual(["messages"]);
  });

  test("returns validated tool calls", async () => {
    const fake = fakeAdapter([
      {
        events: [
          { type: "tool-call-start", id: "c1", name: "weather" },
          { type: "tool-call-delta", id: "c1", inputDelta: '{"city":"Lahore"}' },
          { type: "tool-call-end", id: "c1" },
          { type: "finish", reason: "tool-calls" },
        ],
      },
    ]);
    const tools = { weather: { schema: z.object({ city: z.string() }) } };
    const r = await streamText({ model: fake("m"), messages, tools }).result;
    expect(r.toolCalls).toEqual([
      { id: "c1", name: "weather", input: { city: "Lahore" }, rawInput: '{"city":"Lahore"}' },
    ]);
    expect(r.finishReason).toBe("tool-calls");
  });

  test("computes cost from the caller's price", async () => {
    const fake = fakeAdapter([{ events: [usage(1_000_000, 1_000_000), finish] }]);
    const r = await streamText({
      model: fake("m"),
      messages,
      price: (ref) => (ref.id === "m" ? { input: 1, output: 2 } : undefined),
    }).result;
    expect(r.cost).toBe(3);
  });
});

describe("streamText: request validation", () => {
  const expectError = async (options: Parameters<typeof streamText>[0], code: AIErrorCode) => {
    const s = streamText(options);
    const events = await collect(s);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("error");
    expect((events[0] as { error: AIError }).error.code).toBe(code);
    await expect(s.result).rejects.toBe((events[0] as { error: AIError }).error);
  };

  test("invalid messages fail before any call", async () => {
    const fake = fakeAdapter([ok("x")]);
    await expectError({ model: fake("m"), messages: [] }, "invalid_request");
    expect(fake.calls).toHaveLength(0);
  });

  test("an empty or bad model list fails before any call", async () => {
    await expectError({ model: [], messages }, "invalid_request");
    await expectError({ model: "m" as never, messages }, "invalid_request");
  });

  test("toolChoice must name a tool", async () => {
    const fake = fakeAdapter([ok("x")]);
    await expectError(
      { model: fake("m"), messages, toolChoice: { name: "nope" } },
      "invalid_request",
    );
    expect(fake.calls).toHaveLength(0);
  });

  test("output is rejected: structured output is generate-only", async () => {
    const fake = fakeAdapter([ok("x")]);
    await expectError(
      { model: fake("m"), messages, output: z.object({}) } as never,
      "invalid_request",
    );
    expect(fake.calls).toHaveLength(0);
  });

  test("a schema that can't be converted fails before any call", async () => {
    const fake = fakeAdapter([ok("x")]);
    await expectError(
      { model: fake("m"), messages, tools: { t: { schema: { type: "object" } as never } } },
      "invalid_request",
    );
    expect(fake.calls).toHaveLength(0);
  });
});

describe("streamText: fallback", () => {
  test("a retryable error before the first event moves to the next model", async () => {
    const a = fakeAdapter([{ throwBefore: rateLimited }]);
    const b = fakeAdapter([ok("from b")]);
    const r = await streamText({ model: [a("a"), b("b")], messages }).result;
    expect(r.text).toBe("from b");
    expect(r.modelRef.id).toBe("b");
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  test("a non-retryable error stops the chain", async () => {
    const a = fakeAdapter([{ throwBefore: badRequest }]);
    const b = fakeAdapter([ok("from b")]);
    const s = streamText({ model: [a("a"), b("b")], messages });
    const events = await collect(s);
    expect(events.map((e) => e.type)).toEqual(["error"]);
    expect((events[0] as { error: AIError }).error.code).toBe("invalid_request");
    expect(b.calls).toHaveLength(0);
  });

  test("a retryable error after the first event becomes an error event, no switch", async () => {
    const a = fakeAdapter([
      { events: [text("par"), finish], throwAfter: { index: 1, error: rateLimited } },
    ]);
    const b = fakeAdapter([ok("from b")]);
    const s = streamText({ model: [a("a"), b("b")], messages });
    const events = await collect(s);
    expect(events.map((e) => e.type)).toEqual(["text-delta", "error"]);
    expect((events[1] as { error: AIError }).error.code).toBe("rate_limit");
    expect(b.calls).toHaveLength(0);
    await expect(s.result).rejects.toMatchObject({ code: "rate_limit" });
  });

  test("a usage event counts as delivered", async () => {
    const a = fakeAdapter([
      { events: [usage(1, 0), finish], throwAfter: { index: 1, error: rateLimited } },
    ]);
    const b = fakeAdapter([ok("from b")]);
    await collect(streamText({ model: [a("a"), b("b")], messages }));
    expect(b.calls).toHaveLength(0);
  });

  test("the exhausted chain reports the last error", async () => {
    const a = fakeAdapter([{ throwBefore: { status: 503 } }]);
    const b = fakeAdapter([{ throwBefore: rateLimited }]);
    const s = streamText({ model: [a("a"), b("b")], messages });
    await expect(s.result).rejects.toMatchObject({ code: "rate_limit", provider: "fake" });
  });

  test("an aborted caller signal stops the chain", async () => {
    const controller = new AbortController();
    const a = fakeAdapter((_req, ctx) => {
      if (ctx.modelRef.id === "a") controller.abort();
      return { throwBefore: rateLimited };
    });
    const s = streamText({ model: [a("a"), a("b")], messages, signal: controller.signal });
    await expect(s.result).rejects.toMatchObject({ code: "aborted", retryable: false });
    expect(a.calls).toHaveLength(1);
  });

  test("a retryable AIError thrown after a caller abort does not fall back", async () => {
    const controller = new AbortController();
    const a = fakeAdapter(() => {
      controller.abort();
      return { throwBefore: new AIError({ code: "rate_limit" }) };
    });
    const b = fakeAdapter([ok("b")]);
    const seen: boolean[] = [];
    const s = streamText({
      model: [a("a"), b("b")],
      messages,
      signal: controller.signal,
      hooks: { onError: (_e, ctx) => void seen.push(ctx.willFallback) },
    });
    await s.result.catch(() => {});
    expect(seen).toEqual([false]);
    expect(b.calls).toHaveLength(0);
  });

  test("an abort between attempts stops the chain before the next call", async () => {
    const controller = new AbortController();
    const prepared: string[] = [];
    const a = fakeAdapter([{ throwBefore: rateLimited }]);
    const b = fakeAdapter([ok("b")]);
    const s = streamText({
      model: [a("a"), b("b")],
      messages,
      signal: controller.signal,
      hooks: {
        onError: () => controller.abort(),
        beforeRequest: (_r, ctx) => void prepared.push(ctx.modelRef.id),
      },
    });
    await expect(s.result).rejects.toMatchObject({ code: "aborted" });
    expect(prepared).toEqual(["a"]);
    expect(b.calls).toHaveLength(0);
  });

  test("a single model works without an array", async () => {
    const fake = fakeAdapter([ok("x")]);
    expect((await streamText({ model: fake("m"), messages }).result).text).toBe("x");
  });

  test("an adapter-yielded error event is treated like a throw", async () => {
    const a = fakeAdapter([
      { events: [{ type: "error", error: new AIError({ code: "rate_limit" }) }] },
    ]);
    const b = fakeAdapter([ok("from b")]);
    expect((await streamText({ model: [a("a"), b("b")], messages }).result).text).toBe("from b");
  });

  test("uses the adapter's error classification", async () => {
    const adapter: Adapter = {
      provider: "custom",
      // biome-ignore lint/correctness/useYield: fails before any event
      async *stream() {
        throw { status: 400, code: "too_long" };
      },
      classifyError: (shape) =>
        shape.code === "too_long" ? { code: "context_length" } : undefined,
    };
    const s = streamText({ model: defineProvider(adapter)("m"), messages });
    await expect(s.result).rejects.toMatchObject({ code: "context_length", provider: "custom" });
  });
});

describe("streamText: adapter misbehaviour", () => {
  test("out-of-order events become an unknown error", async () => {
    const fake = fakeAdapter([{ events: [finish, text("late")] }]);
    const s = streamText({ model: fake("m"), messages });
    const events = await collect(s);
    expect(events.map((e) => e.type)).toEqual(["error"]);
    const error = (events[0] as { error: AIError }).error;
    expect(error.code).toBe("unknown");
    expect(error.retryable).toBe(false);
    expect((error.cause as { rule: string }).rule).toBe("O1");
  });

  test("a stream that just stops is an unknown error", async () => {
    const fake = fakeAdapter([{ events: [text("a")] }]);
    const events = await collect(streamText({ model: fake("m"), messages }));
    expect(events.map((e) => e.type)).toEqual(["text-delta", "error"]);
    expect((events[1] as { error: AIError }).error.code).toBe("unknown");
  });

  test("an unmappable thrown value is unknown and does not fall back", async () => {
    const a = fakeAdapter([{ throwBefore: new TypeError("bug") }]);
    const b = fakeAdapter([ok("x")]);
    await expect(streamText({ model: [a("a"), b("b")], messages }).result).rejects.toMatchObject({
      code: "unknown",
    });
    expect(b.calls).toHaveLength(0);
  });

  test("usage subsets larger than totals are an unknown error, not a negative cost", async () => {
    const fake = fakeAdapter([
      {
        events: [
          {
            type: "usage",
            usage: { ...flags, inputTokens: 1, cachedInputTokens: 5, outputTokens: 1 },
          },
          finish,
        ],
      },
    ]);
    const events = await collect(
      streamText({ model: fake("m"), messages, price: () => ({ input: 1, output: 1 }) }),
    );
    expect(events.map((e) => e.type)).toEqual(["usage", "error"]);
  });
});

describe("streamText: hooks", () => {
  test("resolveModel replaces the model list", async () => {
    const a = fakeAdapter([ok("a")]);
    const b = fakeAdapter([ok("b")]);
    const seen: string[][] = [];
    const r = await streamText({
      model: [a("a")],
      messages,
      hooks: {
        resolveModel: (models) => {
          seen.push(models.map((m) => m.id));
          return [b("b")];
        },
      },
    }).result;
    expect(r.text).toBe("b");
    expect(seen).toEqual([["a"]]);
    expect(a.calls).toHaveLength(0);
  });

  test("resolveModel returning nothing usable is invalid_request", async () => {
    const a = fakeAdapter([ok("a")]);
    await expect(
      streamText({ model: a("a"), messages, hooks: { resolveModel: () => [] } }).result,
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  test("beforeRequest can replace the request, on every attempt", async () => {
    const a = fakeAdapter([{ throwBefore: rateLimited }]);
    const b = fakeAdapter([ok("b")]);
    const contexts: AttemptContext[] = [];
    await streamText({
      model: [a("a"), b("b")],
      messages,
      hooks: {
        beforeRequest: (request, ctx) => {
          contexts.push(ctx);
          return { ...request, temperature: ctx.attempt };
        },
      },
    }).result;
    expect(contexts.map((c) => [c.modelRef.id, c.attempt, c.kind])).toEqual([
      ["a", 0, "initial"],
      ["b", 1, "initial"],
    ]);
    expect(a.calls[0]?.request.temperature).toBe(0);
    expect(b.calls[0]?.request.temperature).toBe(1);
  });

  test("beforeRequest returning undefined sends the request unchanged", async () => {
    const fake = fakeAdapter([ok("x")]);
    await streamText({
      model: fake("m"),
      messages,
      temperature: 1,
      hooks: { beforeRequest: () => undefined },
    }).result;
    expect(fake.calls[0]?.request.temperature).toBe(1);
  });

  test("a request returned by beforeRequest is validated again", async () => {
    const fake = fakeAdapter([ok("x")]);
    const s = streamText({
      model: fake("m"),
      messages,
      hooks: { beforeRequest: (request) => ({ ...request, messages: [] }) },
    });
    await expect(s.result).rejects.toMatchObject({ code: "invalid_request" });
    expect(fake.calls).toHaveLength(0);
  });

  test("onUsage runs for every attempt that reported usage, failed ones included", async () => {
    const a = fakeAdapter([
      { events: [usage(5, 0), finish], throwAfter: { index: 1, error: badRequest } },
    ]);
    const b = fakeAdapter([ok("x")]);
    const seen: UsageInfo[] = [];
    const s = streamText({
      model: [a("a"), b("b")],
      messages,
      price: () => ({ input: 1_000_000, output: 1_000_000 }),
      hooks: { onUsage: (info) => void seen.push(info) },
    });
    await s.result.catch(() => {});
    expect(seen).toHaveLength(1);
    expect(seen[0]?.usage.inputTokens).toBe(5);
    expect(seen[0]?.cost).toBe(5);
    expect(seen[0]?.ctx.modelRef.id).toBe("a");
  });

  test("onUsage is not called when no usage was reported", async () => {
    const fake = fakeAdapter([{ events: [text("x"), finish] }]);
    let calls = 0;
    await streamText({ model: fake("m"), messages, hooks: { onUsage: () => void calls++ } }).result;
    expect(calls).toBe(0);
  });

  test("onError runs for every failed attempt with willFallback", async () => {
    const a = fakeAdapter([{ throwBefore: rateLimited }]);
    const b = fakeAdapter([{ throwBefore: badRequest }]);
    const seen: [string, string, boolean][] = [];
    const s = streamText({
      model: [a("a"), b("b")],
      messages,
      hooks: {
        onError: (error, ctx: ErrorContext) =>
          void seen.push([ctx.modelRef.id, error.code, ctx.willFallback]),
      },
    });
    await s.result.catch(() => {});
    expect(seen).toEqual([
      ["a", "rate_limit", true],
      ["b", "invalid_request", false],
    ]);
  });

  test("hooks are awaited", async () => {
    const order: string[] = [];
    const fake = fakeAdapter([ok("x")]);
    await streamText({
      model: fake("m"),
      messages,
      hooks: {
        beforeRequest: async () => {
          await tick();
          order.push("before");
          return undefined;
        },
        onUsage: async () => {
          await tick();
          order.push("usage");
        },
      },
    }).result;
    expect(order).toEqual(["before", "usage"]);
  });

  describe("errors thrown by hooks propagate unchanged", () => {
    class BudgetExceeded extends Error {}

    for (const hook of ["resolveModel", "beforeRequest", "onUsage", "onError", "price"] as const) {
      test(hook, async () => {
        const thrown = new BudgetExceeded("over");
        const a = fakeAdapter(hook === "onError" ? [{ throwBefore: rateLimited }] : [ok("x")]);
        const b = fakeAdapter([ok("b")]);
        const errors: unknown[] = [];
        const fail = () => {
          throw thrown;
        };
        const s = streamText({
          model: [a("a"), b("b")],
          messages,
          ...(hook === "price" ? { price: fail } : {}),
          hooks: {
            ...(hook !== "price" && { [hook]: fail }),
            ...(hook !== "onError" && { onError: (e) => void errors.push(e) }),
          },
        });
        await expect(s.result).rejects.toBe(thrown);
        expect(isAIError(thrown)).toBe(false);
        expect(errors).toEqual([]);
        expect(b.calls).toHaveLength(0);
      });
    }

    test("a retryable AIError from beforeRequest does not fall back either", async () => {
      const thrown = new AIError({ code: "rate_limit" });
      const a = fakeAdapter([ok("a")]);
      const b = fakeAdapter([ok("b")]);
      const s = streamText({
        model: [a("a"), b("b")],
        messages,
        hooks: {
          beforeRequest: (_r, ctx) => {
            if (ctx.modelRef.id === "a") throw thrown;
            return undefined;
          },
        },
      });
      await expect(s.result).rejects.toBe(thrown);
      expect(b.calls).toHaveLength(0);
      expect(a.calls).toHaveLength(0);
    });

    test("the iterator rejects with the thrown value after delivering earlier events", async () => {
      const thrown = new BudgetExceeded("over");
      const fake = fakeAdapter([ok("x")]);
      const s = streamText({
        model: fake("m"),
        messages,
        hooks: {
          onUsage: () => {
            throw thrown;
          },
        },
      });
      const seen: string[] = [];
      const consume = async () => {
        for await (const e of s) seen.push(e.type);
      };
      await expect(consume()).rejects.toBe(thrown);
      expect(seen).toEqual(["text-delta", "usage"]);
      await expect(s.result).rejects.toBe(thrown);
    });
  });
});

describe("streamText: lifecycle", () => {
  test("a stream nobody consumes sends no request", async () => {
    const fake = fakeAdapter([ok("x")]);
    streamText({ model: fake("m"), messages });
    await tick();
    expect(fake.calls).toHaveLength(0);
  });

  test("iterating and awaiting result together send exactly one request", async () => {
    const fake = fakeAdapter([ok("x"), ok("y")]);
    const s = streamText({ model: fake("m"), messages });
    const [events, r] = await Promise.all([collect(s), s.result]);
    expect(events.map((e) => e.type)).toEqual(["text-delta", "usage", "finish"]);
    expect(r.text).toBe("x");
    expect(fake.calls).toHaveLength(1);
  });

  test("result first, then iterating, still sends one request and replays every event", async () => {
    const fake = fakeAdapter([ok("x"), ok("y")]);
    const s = streamText({ model: fake("m"), messages });
    const r = await s.result;
    expect((await collect(s)).map((e) => e.type)).toEqual(["text-delta", "usage", "finish"]);
    expect(r.text).toBe("x");
    expect(fake.calls).toHaveLength(1);
  });

  test("result alone drains the stream", async () => {
    const fake = fakeAdapter([ok("x")]);
    expect((await streamText({ model: fake("m"), messages }).result).text).toBe("x");
    expect(fake.calls).toHaveLength(1);
  });

  test("a second iterator throws", () => {
    const s = streamText({ model: fakeAdapter([ok("x")])("m"), messages });
    s[Symbol.asyncIterator]();
    expect(() => s[Symbol.asyncIterator]()).toThrow(TypeError);
  });

  test("breaking out aborts the adapter's signal and rejects result with aborted", async () => {
    const fake = fakeAdapter([{ events: [text("a"), text("b"), finish], delayMs: 20 }]);
    const s = streamText({ model: fake("m"), messages });
    for await (const _ of s) break;
    expect(fake.calls[0]?.signal.aborted).toBe(true);
    await expect(s.result).rejects.toMatchObject({ code: "aborted" });
  });

  test("an adapter that ignores the abort can't hang the stream, and is closed", async () => {
    let returned = 0;
    const adapter: Adapter = {
      provider: "stuck",
      stream: () => ({
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<StreamEvent>>(() => {}),
          return: async () => {
            returned++;
            return { done: true, value: undefined };
          },
        }),
      }),
    };
    const controller = new AbortController();
    const s = streamText({
      model: defineProvider(adapter)("m"),
      messages,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    const events = await collect(s);
    expect(events.map((e) => e.type)).toEqual(["error"]);
    expect((events[0] as { error: AIError }).error.code).toBe("aborted");
    expect(returned).toBe(1);
  });

  test("a stuck async generator adapter can't hang the stream either", async () => {
    const adapter: Adapter = {
      provider: "stuck",
      async *stream() {
        await new Promise(() => {});
      },
    };
    const controller = new AbortController();
    const s = streamText({
      model: defineProvider(adapter)("m"),
      messages,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 10);
    const events = await collect(s);
    expect(events.map((e) => e.type)).toEqual(["error"]);
  }, 2000);

  test("a caller abort mid-stream ends with one aborted error event", async () => {
    const controller = new AbortController();
    const fake = fakeAdapter([{ events: [text("a"), text("b"), finish], delayMs: 10 }]);
    const s = streamText({ model: fake("m"), messages, signal: controller.signal });
    const seen: StreamEvent[] = [];
    for await (const e of s) {
      seen.push(e);
      if (e.type === "text-delta") controller.abort();
    }
    expect(seen.map((e) => e.type)).toEqual(["text-delta", "error"]);
    expect((seen[1] as { error: AIError }).error.code).toBe("aborted");
  });

  test("a caller timeout is a non-retryable timeout and doesn't fall back", async () => {
    const a = fakeAdapter([{ events: [text("a"), finish], delayMs: 200 }]);
    const b = fakeAdapter([ok("b")]);
    const s = streamText({ model: [a("a"), b("b")], messages, signal: AbortSignal.timeout(10) });
    await expect(s.result).rejects.toMatchObject({ code: "timeout", retryable: false });
    expect(b.calls).toHaveLength(0);
  });

  test("an already-aborted signal sends nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const fake = fakeAdapter([ok("x")]);
    const s = streamText({ model: fake("m"), messages, signal: controller.signal });
    await expect(s.result).rejects.toMatchObject({ code: "aborted" });
    expect(fake.calls).toHaveLength(0);
  });

  test("a failed stream whose result is never read raises no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => void unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const fake = fakeAdapter([{ throwBefore: badRequest }]);
      await collect(streamText({ model: fake("m"), messages }));
      await tick();
      await tick();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  test("the error event and result carry the same AIError instance", async () => {
    const fake = fakeAdapter([{ throwBefore: badRequest }]);
    const s = streamText({ model: fake("m"), messages });
    const [event] = await collect(s);
    const error = await s.result.catch((e: unknown) => e);
    expect((event as { error: unknown }).error).toBe(error);
  });
});
