import { describe, expect, test } from "bun:test";
import type OpenAI from "openai";
import { type CompatQuirks, resolveQuirks } from "../../src/compat/quirks.ts";
import { ChunkTranslator, translateStream } from "../../src/compat/stream.ts";
import { type AIError, isAIError } from "../../src/errors.ts";
import { assertEventOrder, type StreamEvent } from "../../src/events.ts";

type Chunk = OpenAI.Chat.ChatCompletionChunk;
type Delta = Record<string, unknown>;
type Finish = Chunk["choices"][number]["finish_reason"] | string;

// Hand-written from the ChatCompletionChunk declarations in openai 7.57.0, never from a recording.
const chunk = (delta: Delta, finish: Finish = null, usage?: Record<string, unknown>): Chunk =>
  ({
    id: "c",
    object: "chat.completion.chunk",
    created: 0,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: finish, logprobs: null }],
    ...(usage === undefined ? {} : { usage }),
  }) as unknown as Chunk;
const usageOnly = (usage: Record<string, unknown>): Chunk =>
  ({
    id: "c",
    object: "chat.completion.chunk",
    created: 0,
    model: "m",
    choices: [],
    usage,
  }) as unknown as Chunk;

const DS: CompatQuirks = { reasoningField: "reasoning_content" };
const run = (chunks: unknown[], quirks: CompatQuirks = {}): StreamEvent[] => {
  const t = new ChunkTranslator(resolveQuirks(quirks), "acme");
  const events = chunks.flatMap((c) => t.push(c));
  const end = t.end();
  events.push(...end.events);
  if (end.error !== undefined) throw end.error;
  assertEventOrder(events);
  return events;
};
const types = (events: StreamEvent[]) => events.map((e) => e.type);
const usageOf = (events: StreamEvent[]) =>
  (events.find((e) => e.type === "usage") as { usage: Record<string, unknown> } | undefined)?.usage;
const meta = { acme: { reasoningField: "reasoning_content" } };

describe("ChunkTranslator: text and reasoning", () => {
  test("empty deltas and role-only chunks emit nothing", () => {
    const events = run([
      chunk({ role: "assistant", content: "" }),
      chunk({ content: "Hi" }),
      chunk({ content: "" }),
      chunk({ content: null }),
      chunk({ content: "" }, "stop"),
    ]);
    expect(events).toEqual([
      { type: "text-delta", text: "Hi" },
      { type: "finish", reason: "stop" },
    ]);
  });

  test("reasoning, then text: reasoning-end with metadata exactly once", () => {
    const events = run(
      [
        chunk({ role: "assistant", content: null, reasoning_content: "" }),
        chunk({ reasoning_content: "think" }),
        chunk({ reasoning_content: "" }),
        chunk({ reasoning_content: " more" }),
        chunk({ content: "answer", reasoning_content: null }),
        chunk({ content: " done" }),
        chunk({ content: "", reasoning_content: null }, "stop"),
      ],
      DS,
    );
    expect(events).toEqual([
      { type: "reasoning-delta", text: "think" },
      { type: "reasoning-delta", text: " more" },
      { type: "reasoning-end", providerMetadata: meta },
      { type: "text-delta", text: "answer" },
      { type: "text-delta", text: " done" },
      { type: "finish", reason: "stop" },
    ]);
  });

  test("reasoning, then a tool call closes reasoning before the start", () => {
    const events = run(
      [
        chunk({ reasoning_content: "r" }),
        chunk({
          tool_calls: [
            { index: 0, id: "t1", type: "function", function: { name: "f", arguments: "" } },
          ],
        }),
        chunk({}, "tool_calls"),
      ],
      DS,
    );
    expect(types(events)).toEqual([
      "reasoning-delta",
      "reasoning-end",
      "tool-call-start",
      "tool-call-end",
      "finish",
    ]);
  });

  test("reasoning still open at the end is closed before finish", () => {
    const events = run([chunk({ reasoning_content: "r" }, "length")], DS);
    expect(events).toEqual([
      { type: "reasoning-delta", text: "r" },
      { type: "reasoning-end", providerMetadata: meta },
      { type: "finish", reason: "length" },
    ]);
  });

  test("without a reasoning field, reasoning-looking keys are ignored", () => {
    expect(types(run([chunk({ reasoning_content: "r" }), chunk({}, "stop")]))).toEqual(["finish"]);
  });

  test("a refusal is reported as text", () => {
    expect(run([chunk({ refusal: "no" }, "stop")])[0]).toEqual({ type: "text-delta", text: "no" });
  });

  test("only the first choice is read", () => {
    const two = {
      ...chunk({ content: "a" }),
      choices: [
        { index: 1, delta: { content: "other" }, finish_reason: null, logprobs: null },
        { index: 0, delta: { content: "a" }, finish_reason: "stop", logprobs: null },
      ],
    };
    expect(run([two])).toEqual([
      { type: "text-delta", text: "a" },
      { type: "finish", reason: "stop" },
    ]);
  });
});

describe("ChunkTranslator: usage", () => {
  const usage = {
    prompt_tokens: 30,
    completion_tokens: 20,
    prompt_tokens_details: { cached_tokens: 10 },
    completion_tokens_details: { reasoning_tokens: 5 },
  };
  const expected = {
    inputTokens: 30,
    outputTokens: 20,
    cachedInputTokens: 10,
    reasoningTokens: 5,
    inputIncludesCached: true,
    outputIncludesReasoning: true,
  };

  test("usage on the finish chunk and on a later usage-only chunk give the same events", () => {
    const sameChunk = run([chunk({ content: "x" }), chunk({ content: "" }, "stop", usage)]);
    const later = run([chunk({ content: "x" }), chunk({ content: "" }, "stop"), usageOnly(usage)]);
    expect(sameChunk).toEqual(later);
    expect(types(later)).toEqual(["text-delta", "usage", "finish"]);
    expect(usageOf(later)).toEqual(expected);
  });

  test("null usage is ignored and missing detail fields stay undefined", () => {
    const events = run([
      chunk({ content: "x" }, null, undefined),
      { ...chunk({ content: "" }, "stop"), usage: null },
      usageOnly({ prompt_tokens: 3, completion_tokens: 1 }),
    ]);
    const u = usageOf(events) as Record<string, unknown>;
    expect(u.inputTokens).toBe(3);
    expect(u.cachedInputTokens).toBeUndefined();
    expect(u.reasoningTokens).toBeUndefined();
    expect(u.cacheWriteTokens).toBeUndefined();
  });

  test("the usage quirk fills only fields the standard mapping left undefined", () => {
    const quirks: CompatQuirks = {
      usage: (raw) => ({ cachedInputTokens: raw.prompt_cache_hit_tokens as number }),
    };
    const standard = run([chunk({}, "stop", { ...usage, prompt_cache_hit_tokens: 99 })], quirks);
    expect(usageOf(standard)?.cachedInputTokens).toBe(10);
    const filled = run(
      [chunk({}, "stop", { prompt_tokens: 3, completion_tokens: 1, prompt_cache_hit_tokens: 2 })],
      quirks,
    );
    expect(usageOf(filled)?.cachedInputTokens).toBe(2);
  });

  test("no usage, no usage event", () => {
    expect(types(run([chunk({ content: "x" }, "stop")]))).toEqual(["text-delta", "finish"]);
  });
});

describe("ChunkTranslator: tool calls", () => {
  const call = (index: number, extra: Record<string, unknown>) =>
    chunk({ tool_calls: [{ index, ...extra }] });

  test("two interleaved calls by index, ended in index order before finish", () => {
    const events = run([
      call(0, { id: "a", type: "function", function: { name: "f", arguments: "" } }),
      call(1, { id: "b", type: "function", function: { name: "g", arguments: '{"x"' } }),
      call(0, { function: { arguments: '{"y":1}' } }),
      call(1, { function: { arguments: ":2}" } }),
      chunk({ content: "" }, "tool_calls"),
    ]);
    expect(events).toEqual([
      { type: "tool-call-start", id: "a", name: "f" },
      { type: "tool-call-start", id: "b", name: "g" },
      { type: "tool-call-delta", id: "b", inputDelta: '{"x"' },
      { type: "tool-call-delta", id: "a", inputDelta: '{"y":1}' },
      { type: "tool-call-delta", id: "b", inputDelta: ":2}" },
      { type: "tool-call-end", id: "a" },
      { type: "tool-call-end", id: "b" },
      { type: "finish", reason: "tool-calls" },
    ]);
  });

  test("arguments before the name are buffered and flushed at the start", () => {
    const events = run([
      call(0, { id: "a", function: { arguments: '{"q"' } }),
      call(0, { function: { name: "f", arguments: ":1}" } }),
      chunk({}, "tool_calls"),
    ]);
    expect(events.slice(0, 3)).toEqual([
      { type: "tool-call-start", id: "a", name: "f" },
      { type: "tool-call-delta", id: "a", inputDelta: '{"q"' },
      { type: "tool-call-delta", id: "a", inputDelta: ":1}" },
    ]);
  });

  test("repeated or empty ids and names never overwrite", () => {
    const events = run([
      call(0, { id: "a", function: { name: "f", arguments: "" } }),
      call(0, { id: "", function: { name: "", arguments: "{}" } }),
      call(0, { id: "a", function: { name: "f" } }),
      chunk({}, "tool_calls"),
    ]);
    expect(events.filter((e) => e.type === "tool-call-start")).toEqual([
      { type: "tool-call-start", id: "a", name: "f" },
    ]);
  });

  test("a call that never got an id is named call_<index> at the end", () => {
    const events = run([
      call(2, { function: { name: "f", arguments: "{}" } }),
      chunk({}, "tool_calls"),
    ]);
    expect(events.slice(0, 3)).toEqual([
      { type: "tool-call-start", id: "call_2", name: "f" },
      { type: "tool-call-delta", id: "call_2", inputDelta: "{}" },
      { type: "tool-call-end", id: "call_2" },
    ]);
  });

  test("a call with no name at the end is an error, not an invalid event", () => {
    const t = new ChunkTranslator(resolveQuirks(), "acme");
    t.push(call(0, { id: "a", function: { arguments: "{}" } }));
    t.push(chunk({}, "tool_calls"));
    const end = t.end();
    expect(end.error).toMatchObject({ code: "provider_unavailable", provider: "acme" });
  });
});

describe("ChunkTranslator: finish reasons", () => {
  const reason = (finish: string, quirks: CompatQuirks = {}) =>
    (run([chunk({ content: "x" }, finish)], quirks).at(-1) as { reason: string }).reason;

  test("standard reasons", () => {
    expect(reason("stop")).toBe("stop");
    expect(reason("length")).toBe("length");
    expect(reason("content_filter")).toBe("content-filter");
    expect(reason("something_new")).toBe("other");
  });

  test("tool_calls and function_call with a call map to tool-calls, without one to other", () => {
    const withCall = (finish: string) =>
      run([
        chunk({ tool_calls: [{ index: 0, id: "a", function: { name: "f", arguments: "{}" } }] }),
        chunk({}, finish),
      ]).at(-1);
    expect(withCall("tool_calls")).toEqual({ type: "finish", reason: "tool-calls" });
    expect(withCall("function_call")).toEqual({ type: "finish", reason: "tool-calls" });
    expect(reason("tool_calls")).toBe("other");
  });

  test("the quirk map adds reasons and wins over the standard ones", () => {
    expect(reason("halted", { finishReasons: { halted: "length" } })).toBe("length");
    expect(reason("stop", { finishReasons: { stop: "other" } })).toBe("other");
  });

  test("a quirk error replaces finish, after the usage event", () => {
    const t = new ChunkTranslator(
      resolveQuirks({ finishReasons: { overloaded: { error: { code: "provider_unavailable" } } } }),
      "acme",
    );
    const events = [
      ...t.push(chunk({ content: "x" })),
      ...t.push(chunk({}, "overloaded", { prompt_tokens: 1, completion_tokens: 1 })),
    ];
    const end = t.end();
    expect(types([...events, ...end.events])).toEqual(["text-delta", "usage"]);
    expect(isAIError(end.error)).toBe(true);
    expect(end.error).toMatchObject({
      code: "provider_unavailable",
      retryable: true,
      failover: true,
      provider: "acme",
      providerCode: "overloaded",
    });
  });

  test("a stream with no finish_reason is a retryable provider_unavailable", () => {
    const t = new ChunkTranslator(resolveQuirks(), "acme");
    t.push(chunk({ content: "x" }));
    expect(t.end().error).toMatchObject({ code: "provider_unavailable", retryable: true });
  });
});

describe("translateStream", () => {
  async function* source(chunks: unknown[], onEach?: (i: number) => void) {
    for (const [i, c] of chunks.entries()) {
      onEach?.(i);
      yield c;
    }
  }
  const collect = async (it: AsyncIterable<StreamEvent>) => {
    const out: StreamEvent[] = [];
    for await (const e of it) out.push(e);
    return out;
  };

  test("yields translated events in order", async () => {
    const events = await collect(
      translateStream(
        source([chunk({ content: "a" }), chunk({}, "stop")]),
        resolveQuirks(),
        "acme",
        new AbortController().signal,
      ),
    );
    expect(types(events)).toEqual(["text-delta", "finish"]);
  });

  test("a silent return after an abort throws the signal's reason", async () => {
    const controller = new AbortController();
    const reason = new Error("caller abort");
    const it = translateStream(
      // The SDK stops iterating without an error once the signal aborts.
      (async function* () {
        yield chunk({ content: "a" });
        controller.abort(reason);
      })(),
      resolveQuirks(),
      "acme",
      controller.signal,
    );
    const seen: StreamEvent[] = [];
    const thrown = await (async () => {
      for await (const e of it) seen.push(e);
    })().catch((e: unknown) => e);
    expect(thrown).toBe(reason);
    expect(types(seen)).toEqual(["text-delta"]);
  });

  test("a quirk finish error is thrown after the events before it", async () => {
    const it = translateStream(
      source([chunk({ content: "a" }), chunk({}, "halted")]),
      resolveQuirks({ finishReasons: { halted: { error: { code: "provider_unavailable" } } } }),
      "acme",
      new AbortController().signal,
    );
    const seen: StreamEvent[] = [];
    const thrown = (await (async () => {
      for await (const e of it) seen.push(e);
    })().catch((e: unknown) => e)) as AIError;
    expect(types(seen)).toEqual(["text-delta"]);
    expect(thrown.code).toBe("provider_unavailable");
  });
});
