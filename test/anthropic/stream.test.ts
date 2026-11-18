import { describe, expect, test } from "bun:test";
import { MessagesTranslator, translateMessages } from "../../src/anthropic/stream.ts";
import { assertEventOrder, type StreamEvent } from "../../src/events.ts";

// Hand-written from RawMessageStreamEvent in @anthropic-ai/sdk@1.9.0 resources/messages/messages.d.ts.
type Ev = Record<string, unknown>;
const start = (
  usage: Ev = {
    input_tokens: 10,
    cache_creation_input_tokens: 2,
    cache_read_input_tokens: 3,
    output_tokens: 1,
  },
): Ev => ({
  type: "message_start",
  message: { id: "msg_1", type: "message", role: "assistant", content: [], usage },
});
const blockStart = (index: number, content_block: Ev): Ev => ({
  type: "content_block_start",
  index,
  content_block,
});
const delta = (index: number, d: Ev): Ev => ({ type: "content_block_delta", index, delta: d });
const stop = (index: number): Ev => ({ type: "content_block_stop", index });
const messageDelta = (
  stop_reason: string | null,
  usage: Ev = { output_tokens: 20, output_tokens_details: { thinking_tokens: 7 } },
): Ev => ({
  type: "message_delta",
  delta: { stop_reason, stop_sequence: null },
  usage,
});
const end: Ev = { type: "message_stop" };
const text = (index: number, parts: string[]): Ev[] => [
  blockStart(index, { type: "text", text: "" }),
  ...parts.map((t) => delta(index, { type: "text_delta", text: t })),
  stop(index),
];

const run = (events: Ev[]): StreamEvent[] => {
  const t = new MessagesTranslator();
  const out = events.flatMap((e) => t.push(e));
  const done = t.end();
  out.push(...done.events);
  if (done.error !== undefined) throw done.error;
  assertEventOrder(out);
  return out;
};
const types = (events: StreamEvent[]) => events.map((e) => e.type);

describe("MessagesTranslator: text, usage, finish", () => {
  test("text deltas, then merged usage and finish", () => {
    const events = run([start(), ...text(0, ["Hel", "", "lo"]), messageDelta("end_turn"), end]);
    expect(events).toEqual([
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
      {
        type: "usage",
        usage: {
          inputTokens: 10,
          outputTokens: 20,
          cachedInputTokens: 3,
          cacheWriteTokens: 2,
          reasoningTokens: 7,
          inputIncludesCached: false,
          outputIncludesReasoning: true,
        },
      },
      { type: "finish", reason: "stop" },
    ]);
  });

  test("null fields in message_delta usage don't erase message_start values", () => {
    const events = run([
      start(),
      ...text(0, ["x"]),
      messageDelta("end_turn", {
        input_tokens: null,
        cache_read_input_tokens: null,
        output_tokens: 5,
      }),
      end,
    ]);
    const u = (
      events.find((e) => e.type === "usage") as unknown as { usage: Record<string, unknown> }
    ).usage;
    expect(u).toMatchObject({ inputTokens: 10, cachedInputTokens: 3, outputTokens: 5 });
    expect(u.reasoningTokens).toBeUndefined();
  });

  test("stop reasons", () => {
    const reason = (r: string) =>
      (run([start(), ...text(0, ["x"]), messageDelta(r), end]).at(-1) as { reason: string }).reason;
    expect(reason("end_turn")).toBe("stop");
    expect(reason("stop_sequence")).toBe("stop");
    expect(reason("max_tokens")).toBe("length");
    expect(reason("model_context_window_exceeded")).toBe("length");
    expect(reason("refusal")).toBe("content-filter");
    expect(reason("pause_turn")).toBe("other");
    // tool_use with no tool call started can only finish as "other" (the ordering rules need a call).
    expect(reason("tool_use")).toBe("other");
    expect(reason("constructor")).toBe("other");
  });

  test("no message_stop is a retryable provider_unavailable", () => {
    const t = new MessagesTranslator();
    t.push(start());
    expect(t.end().error).toMatchObject({
      code: "provider_unavailable",
      retryable: true,
      provider: "anthropic",
    });
  });
});

describe("MessagesTranslator: thinking", () => {
  test("thinking deltas, then reasoning-end with the signature", () => {
    const events = run([
      start(),
      blockStart(0, { type: "thinking", thinking: "", signature: "" }),
      delta(0, { type: "thinking_delta", thinking: "hmm" }),
      delta(0, { type: "thinking_delta", thinking: "" }),
      delta(0, { type: "signature_delta", signature: "sig-a" }),
      delta(0, { type: "signature_delta", signature: "sig-b" }),
      stop(0),
      ...text(1, ["0.05"]),
      messageDelta("end_turn"),
      end,
    ]);
    expect(events.slice(0, 3)).toEqual([
      { type: "reasoning-delta", text: "hmm" },
      { type: "reasoning-end", providerMetadata: { anthropic: { signature: "sig-asig-b" } } },
      { type: "text-delta", text: "0.05" },
    ]);
  });

  test("omitted thinking (no text, only a signature) still ends a block", () => {
    const events = run([
      start(),
      blockStart(0, { type: "thinking", thinking: "", signature: "" }),
      delta(0, { type: "signature_delta", signature: "s" }),
      stop(0),
      messageDelta("end_turn"),
      end,
    ]);
    expect(events.slice(0, 2)).toEqual([
      { type: "reasoning-delta", text: "" },
      { type: "reasoning-end", providerMetadata: { anthropic: { signature: "s" } } },
    ]);
  });

  test("text in the block start is emitted", () => {
    const events = run([
      start(),
      blockStart(0, { type: "thinking", thinking: "pre", signature: "s0" }),
      stop(0),
      messageDelta("end_turn"),
      end,
    ]);
    expect(events.slice(0, 2)).toEqual([
      { type: "reasoning-delta", text: "pre" },
      { type: "reasoning-end", providerMetadata: { anthropic: { signature: "s0" } } },
    ]);
  });

  test("redacted thinking becomes its own block carrying the data", () => {
    const events = run([
      start(),
      blockStart(0, { type: "redacted_thinking", data: "blob" }),
      stop(0),
      messageDelta("end_turn"),
      end,
    ]);
    expect(events.slice(0, 2)).toEqual([
      { type: "reasoning-delta", text: "" },
      { type: "reasoning-end", providerMetadata: { anthropic: { redacted: "blob" } } },
    ]);
  });
});

describe("MessagesTranslator: tool use", () => {
  const toolBlock = (index: number, id: string, parts: string[]): Ev[] => [
    blockStart(index, { type: "tool_use", id, name: "get_weather", input: {} }),
    ...parts.map((p) => delta(index, { type: "input_json_delta", partial_json: p })),
    stop(index),
  ];

  test("tool use blocks become tool calls, and tool_use finishes as tool-calls", () => {
    const events = run([
      start(),
      ...toolBlock(0, "toolu_1", ["", '{"city"', ':"Lahore"}']),
      ...toolBlock(1, "toolu_2", ["{}"]),
      messageDelta("tool_use"),
      end,
    ]);
    expect(events.filter((e) => e.type !== "usage")).toEqual([
      { type: "tool-call-start", id: "toolu_1", name: "get_weather" },
      { type: "tool-call-delta", id: "toolu_1", inputDelta: '{"city"' },
      { type: "tool-call-delta", id: "toolu_1", inputDelta: ':"Lahore"}' },
      { type: "tool-call-end", id: "toolu_1" },
      { type: "tool-call-start", id: "toolu_2", name: "get_weather" },
      { type: "tool-call-delta", id: "toolu_2", inputDelta: "{}" },
      { type: "tool-call-end", id: "toolu_2" },
      { type: "finish", reason: "tool-calls" },
    ]);
  });

  test("a tool call still open at message_stop is ended", () => {
    const events = run([
      start(),
      blockStart(0, { type: "tool_use", id: "t", name: "f", input: {} }),
      messageDelta("tool_use"),
      end,
    ]);
    expect(types(events)).toEqual(["tool-call-start", "tool-call-end", "usage", "finish"]);
  });

  test("deltas and stops for unknown blocks are ignored", () => {
    expect(
      types(
        run([
          start(),
          delta(5, { type: "input_json_delta", partial_json: "{}" }),
          stop(5),
          ...text(0, ["x"]),
          messageDelta("end_turn"),
          end,
        ]),
      ),
    ).toEqual(["text-delta", "usage", "finish"]);
  });

  test("a reused tool id is not started twice", () => {
    const events = run([
      start(),
      ...toolBlock(0, "t", ["{}"]),
      ...toolBlock(1, "t", ["{}"]),
      messageDelta("tool_use"),
      end,
    ]);
    expect(events.filter((e) => e.type === "tool-call-start")).toHaveLength(1);
  });
});

describe("MessagesTranslator: errors and abort", () => {
  test("an error event throws in the SDK's shape", () => {
    const t = new MessagesTranslator();
    let thrown: unknown;
    try {
      t.push({ type: "error", error: { type: "overloaded_error", message: "busy" } });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({
      status: undefined,
      type: "overloaded_error",
      error: { type: "error", error: { type: "overloaded_error" } },
    });
  });

  test("a silent return after an abort throws the signal's reason", async () => {
    const controller = new AbortController();
    const reason = new Error("caller");
    const it = translateMessages(
      (async function* () {
        yield start();
        yield blockStart(0, { type: "text", text: "" });
        yield delta(0, { type: "text_delta", text: "a" });
        controller.abort(reason);
      })(),
      controller.signal,
    );
    const seen: StreamEvent[] = [];
    const thrown = await (async () => {
      for await (const e of it) seen.push(e);
    })().catch((e: unknown) => e);
    expect(thrown).toBe(reason);
    expect(types(seen)).toEqual(["text-delta"]);
  });
});

describe("MessagesTranslator: mutation follow-ups", () => {
  test("negative or fractional token counts are dropped", () => {
    const events = run([
      start({ input_tokens: -1, output_tokens: 1.5 }),
      ...text(0, ["x"]),
      messageDelta("end_turn", {}),
      end,
    ]);
    const u = (
      events.find((e) => e.type === "usage") as unknown as { usage: Record<string, unknown> }
    ).usage;
    expect(u.inputTokens).toBeUndefined();
    expect(u.outputTokens).toBeUndefined();
  });
});

describe("MessagesTranslator: audit follow-ups", () => {
  test("a thinking block still open at message_stop is ended with its signature", () => {
    const events = run([
      start(),
      blockStart(0, { type: "thinking", thinking: "", signature: "" }),
      delta(0, { type: "signature_delta", signature: "s" }),
      messageDelta("end_turn"),
      end,
    ]);
    expect(events.find((e) => e.type === "reasoning-end")).toEqual({
      type: "reasoning-end",
      providerMetadata: { anthropic: { signature: "s" } },
    });
  });

  test("zero token counts are kept as 0", () => {
    const events = run([
      start({
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 0,
      }),
      ...text(0, ["x"]),
      messageDelta("end_turn", { output_tokens: 0, output_tokens_details: null }),
      end,
    ]);
    const u = (
      events.find((e) => e.type === "usage") as unknown as { usage: Record<string, unknown> }
    ).usage;
    expect(u).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(u.reasoningTokens).toBeUndefined();
  });

  test("redacted thinking without data, and tool use without an id or name, are dropped", () => {
    const events = run([
      start(),
      blockStart(0, { type: "redacted_thinking" }),
      stop(0),
      blockStart(1, { type: "tool_use", id: "t", input: {} }),
      stop(1),
      blockStart(2, { type: "tool_use", name: "f", input: {} }),
      stop(2),
      ...text(3, ["x"]),
      messageDelta("end_turn"),
      end,
    ]);
    expect(types(events)).toEqual(["text-delta", "usage", "finish"]);
  });

  test("text in a text block's start is emitted", () => {
    const events = run([
      start(),
      blockStart(0, { type: "text", text: "pre" }),
      stop(0),
      messageDelta("end_turn"),
      end,
    ]);
    expect(events[0]).toEqual({ type: "text-delta", text: "pre" });
  });

  test("a block that starts while thinking is open closes the thinking first", () => {
    const events = run([
      start(),
      blockStart(0, { type: "thinking", thinking: "", signature: "" }),
      delta(0, { type: "thinking_delta", thinking: "t" }),
      delta(0, { type: "signature_delta", signature: "s" }),
      blockStart(1, { type: "tool_use", id: "a", name: "f", input: {} }),
      stop(0),
      stop(1),
      blockStart(2, { type: "thinking", thinking: "", signature: "" }),
      blockStart(3, { type: "redacted_thinking", data: "r" }),
      stop(2),
      stop(3),
      messageDelta("tool_use"),
      end,
    ]);
    expect(types(events)).toEqual([
      "reasoning-delta",
      "reasoning-end",
      "tool-call-start",
      "tool-call-end",
      "reasoning-delta",
      "reasoning-end",
      "reasoning-delta",
      "reasoning-end",
      "usage",
      "finish",
    ]);
  });
});

describe("MessagesTranslator: security review follow-ups", () => {
  test("a block start reusing an open index ends the earlier block first", () => {
    const events = run([
      start(),
      blockStart(0, { type: "tool_use", id: "a", name: "f", input: {} }),
      blockStart(0, { type: "tool_use", id: "b", name: "f", input: {} }),
      stop(0),
      messageDelta("tool_use"),
      end,
    ]);
    expect(
      events.filter((e) => e.type === "tool-call-end").map((e) => (e as { id: string }).id),
    ).toEqual(["a", "b"]);
  });

  test("a thinking block without a signature carries no signature metadata", () => {
    const events = run([
      start(),
      blockStart(0, { type: "thinking", thinking: "t", signature: "" }),
      stop(0),
      messageDelta("end_turn"),
      end,
    ]);
    expect(events.find((e) => e.type === "reasoning-end")).toEqual({ type: "reasoning-end" });
  });
});
