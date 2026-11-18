import { describe, expect, test } from "bun:test";
import { isAIError } from "../../src/errors.ts";
import { assertEventOrder, type StreamEvent } from "../../src/events.ts";
import { ResponsesTranslator, translateResponses } from "../../src/openai/stream.ts";

// Hand-written from ResponseStreamEvent in openai@7.57.0 resources/responses/responses.d.ts.
type Ev = Record<string, unknown>;
const usage = {
  input_tokens: 40,
  input_tokens_details: { cached_tokens: 10, cache_write_tokens: 5 },
  output_tokens: 20,
  output_tokens_details: { reasoning_tokens: 8 },
  total_tokens: 60,
};
const completed = (u: unknown = usage): Ev => ({
  type: "response.completed",
  response: { status: "completed", incomplete_details: null, usage: u, output: [] },
});
const incomplete = (reason: string): Ev => ({
  type: "response.incomplete",
  response: { status: "incomplete", incomplete_details: { reason }, usage, output: [] },
});
const text = (delta: string, item = "msg_1"): Ev => ({
  type: "response.output_text.delta",
  item_id: item,
  delta,
});
const reasoningItem = (id: string, extra: Ev = {}) => ({
  id,
  type: "reasoning",
  summary: [],
  ...extra,
});
const added = (item: Ev): Ev => ({ type: "response.output_item.added", item });
const done = (item: Ev): Ev => ({ type: "response.output_item.done", item });
const fcItem = (n: number, args = "") => ({
  id: `fc_${n}`,
  type: "function_call",
  status: args === "" ? "in_progress" : "completed",
  arguments: args,
  call_id: `call_${n}`,
  name: "get_weather",
});
const argsDelta = (n: number, delta: string): Ev => ({
  type: "response.function_call_arguments.delta",
  item_id: `fc_${n}`,
  delta,
});

const run = (events: Ev[]): StreamEvent[] => {
  const t = new ResponsesTranslator();
  const out = events.flatMap((e) => t.push(e));
  const end = t.end();
  out.push(...end.events);
  if (end.error !== undefined) throw end.error;
  assertEventOrder(out);
  return out;
};
const types = (events: StreamEvent[]) => events.map((e) => e.type);

describe("ResponsesTranslator: text and finish", () => {
  test("text deltas, empty ones skipped, then usage and finish", () => {
    const events = run([
      { type: "response.created", response: {} },
      added({ id: "msg_1", type: "message", content: [] }),
      text("Hel"),
      text(""),
      text("lo"),
      { type: "response.output_text.done", text: "Hello" },
      completed(),
    ]);
    expect(events).toEqual([
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "lo" },
      {
        type: "usage",
        usage: {
          inputTokens: 40,
          outputTokens: 20,
          cachedInputTokens: 10,
          cacheWriteTokens: 5,
          reasoningTokens: 8,
          inputIncludesCached: true,
          outputIncludesReasoning: true,
        },
      },
      { type: "finish", reason: "stop" },
    ]);
  });

  test("a refusal is reported as text", () => {
    const events = run([
      { type: "response.refusal.delta", item_id: "msg_1", delta: "no" },
      completed(),
    ]);
    expect(events[0]).toEqual({ type: "text-delta", text: "no" });
  });

  test("incomplete reasons", () => {
    const reason = (r: string) =>
      (run([text("x"), incomplete(r)]).at(-1) as { reason: string }).reason;
    expect(reason("max_output_tokens")).toBe("length");
    expect(reason("content_filter")).toBe("content-filter");
    expect(reason("something_else")).toBe("other");
  });

  test("missing usage fields stay undefined", () => {
    const events = run([text("x"), completed({ input_tokens: 3, output_tokens: 1 })]);
    const u = (
      events.find((e) => e.type === "usage") as unknown as { usage: Record<string, unknown> }
    ).usage;
    expect(u.cachedInputTokens).toBeUndefined();
    expect(u.cacheWriteTokens).toBeUndefined();
    expect(u.reasoningTokens).toBeUndefined();
  });

  test("no usage object, no usage event", () => {
    expect(types(run([text("x"), completed(null)]))).toEqual(["text-delta", "finish"]);
  });

  test("a stream with no terminal event is a retryable provider_unavailable", () => {
    const t = new ResponsesTranslator();
    t.push(text("x"));
    expect(t.end().error).toMatchObject({
      code: "provider_unavailable",
      retryable: true,
      provider: "openai",
    });
  });
});

describe("ResponsesTranslator: reasoning", () => {
  test("an empty-summary reasoning item still ends with its item as metadata", () => {
    const final = reasoningItem("rs_1", { encrypted_content: "done-blob" });
    const events = run([
      added(reasoningItem("rs_1", { encrypted_content: "added-blob" })),
      done(final),
      text("0.05"),
      completed(),
    ]);
    expect(events.slice(0, 3)).toEqual([
      { type: "reasoning-delta", text: "" },
      { type: "reasoning-end", providerMetadata: { openai: { item: final } } },
      { type: "text-delta", text: "0.05" },
    ]);
  });

  test("summary deltas, with a blank line between summary parts", () => {
    const final = reasoningItem("rs_1");
    const delta = (d: string, summary_index: number): Ev => ({
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_1",
      summary_index,
      delta: d,
    });
    const events = run([
      added(reasoningItem("rs_1")),
      delta("a", 0),
      delta("b", 0),
      delta("c", 1),
      done(final),
      completed(),
    ]);
    expect(events.filter((e) => e.type === "reasoning-delta")).toEqual([
      { type: "reasoning-delta", text: "a" },
      { type: "reasoning-delta", text: "b" },
      { type: "reasoning-delta", text: "\n\nc" },
    ]);
    expect(events.filter((e) => e.type === "reasoning-end")).toHaveLength(1);
  });

  test("raw reasoning text deltas are reasoning too", () => {
    const events = run([
      added(reasoningItem("rs_1")),
      { type: "response.reasoning_text.delta", item_id: "rs_1", content_index: 0, delta: "r" },
      done(reasoningItem("rs_1")),
      completed(),
    ]);
    expect(types(events)).toEqual(["reasoning-delta", "reasoning-end", "usage", "finish"]);
  });

  test("two reasoning items make two blocks", () => {
    const events = run([
      added(reasoningItem("rs_1")),
      done(reasoningItem("rs_1")),
      added(fcItem(1)),
      done(fcItem(1, "{}")),
      added(reasoningItem("rs_2")),
      done(reasoningItem("rs_2")),
      completed(),
    ]);
    expect(events.filter((e) => e.type === "reasoning-end")).toHaveLength(2);
  });
});

describe("ResponsesTranslator: tool calls", () => {
  test("call_id is the tool call id and item_id routes the deltas", () => {
    const final = fcItem(1, '{"city":"Lahore"}');
    const events = run([
      added(fcItem(1)),
      argsDelta(1, '{"city"'),
      argsDelta(1, ':"Lahore"}'),
      done(final),
      completed(),
    ]);
    expect(events.slice(0, 4)).toEqual([
      { type: "tool-call-start", id: "call_1", name: "get_weather" },
      { type: "tool-call-delta", id: "call_1", inputDelta: '{"city"' },
      { type: "tool-call-delta", id: "call_1", inputDelta: ':"Lahore"}' },
      { type: "tool-call-end", id: "call_1", providerMetadata: { openai: { item: final } } },
    ]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool-calls" });
  });

  test("interleaved parallel calls", () => {
    const events = run([
      added(fcItem(1)),
      added(fcItem(2)),
      argsDelta(2, "{}"),
      argsDelta(1, "{}"),
      done(fcItem(2, "{}")),
      done(fcItem(1, "{}")),
      completed(),
    ]);
    expect(
      events.filter((e) => e.type !== "usage").map((e) => [e.type, (e as { id?: string }).id]),
    ).toEqual([
      ["tool-call-start", "call_1"],
      ["tool-call-start", "call_2"],
      ["tool-call-delta", "call_2"],
      ["tool-call-delta", "call_1"],
      ["tool-call-end", "call_2"],
      ["tool-call-end", "call_1"],
      ["finish", undefined],
    ]);
  });

  test("a call that only arrives as done is started and gets its arguments", () => {
    const events = run([done(fcItem(1, '{"a":1}')), completed()]);
    expect(types(events).slice(0, 3)).toEqual([
      "tool-call-start",
      "tool-call-delta",
      "tool-call-end",
    ]);
    expect(events[1]).toEqual({ type: "tool-call-delta", id: "call_1", inputDelta: '{"a":1}' });
  });

  test("a call left open at the end is ended without metadata", () => {
    const events = run([added(fcItem(1)), argsDelta(1, "{}"), completed()]);
    expect(events.find((e) => e.type === "tool-call-end")).toEqual({
      type: "tool-call-end",
      id: "call_1",
    });
  });

  test("deltas for an unknown item are ignored", () => {
    expect(types(run([argsDelta(9, "{}"), text("x"), completed()]))).toEqual([
      "text-delta",
      "usage",
      "finish",
    ]);
  });
});

describe("ResponsesTranslator: errors", () => {
  test("response.failed throws a shaped error with the provider's code", () => {
    const t = new ResponsesTranslator();
    let thrown: unknown;
    try {
      t.push({
        type: "response.failed",
        response: { status: "failed", error: { code: "server_error", message: "boom" } },
      });
    } catch (e) {
      thrown = e;
    }
    expect(isAIError(thrown)).toBe(false);
    expect(thrown).toMatchObject({
      status: undefined,
      code: "server_error",
      error: { code: "server_error" },
    });
  });

  test("an error event throws a shaped error", () => {
    const t = new ResponsesTranslator();
    expect(() =>
      t.push({ type: "error", code: "rate_limit_exceeded", message: "slow", param: null }),
    ).toThrow(expect.objectContaining({ code: "rate_limit_exceeded" }));
  });
});

describe("translateResponses", () => {
  test("a silent return after an abort throws the signal's reason", async () => {
    const controller = new AbortController();
    const reason = new Error("caller");
    const it = translateResponses(
      (async function* () {
        yield text("a");
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

describe("ResponsesTranslator: ordering edge cases", () => {
  test("text between a reasoning item's deltas and its done still ends a valid block", () => {
    const final = reasoningItem("rs_1");
    const events = run([
      added(reasoningItem("rs_1")),
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "rs_1",
        summary_index: 0,
        delta: "r",
      },
      text("early"),
      done(final),
      completed(),
    ]);
    expect(types(events)).toEqual([
      "reasoning-delta",
      "text-delta",
      "reasoning-delta",
      "reasoning-end",
      "usage",
      "finish",
    ]);
  });
});

describe("ResponsesTranslator: mutation follow-ups", () => {
  test("raw reasoning text carries its text", () => {
    const events = run([
      added(reasoningItem("rs_1")),
      { type: "response.reasoning_text.delta", item_id: "rs_1", content_index: 0, delta: "r" },
      done(reasoningItem("rs_1")),
      completed(),
    ]);
    expect(events[0]).toEqual({ type: "reasoning-delta", text: "r" });
  });

  test("an incomplete reason named like an Object.prototype member is other", () => {
    expect((run([text("x"), incomplete("constructor")]).at(-1) as { reason: string }).reason).toBe(
      "other",
    );
  });
});

describe("ResponsesTranslator: audit follow-ups", () => {
  test("a tool call between reasoning deltas and the reasoning done keeps the order valid", () => {
    const final = reasoningItem("rs_1");
    const events = run([
      added(reasoningItem("rs_1")),
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "rs_1",
        summary_index: 0,
        delta: "r",
      },
      added(fcItem(1)),
      done(final),
      done(fcItem(1, "{}")),
      completed(),
    ]);
    expect(types(events).slice(0, 4)).toEqual([
      "reasoning-delta",
      "tool-call-start",
      "reasoning-delta",
      "reasoning-end",
    ]);
  });

  test("each reasoning block carries its own item", () => {
    const a = reasoningItem("rs_1", { encrypted_content: "A" });
    const b = reasoningItem("rs_2", { encrypted_content: "B" });
    const events = run([added(a), done(a), text("x"), added(b), done(b), completed()]);
    expect(events.filter((e) => e.type === "reasoning-end")).toEqual([
      { type: "reasoning-end", providerMetadata: { openai: { item: a } } },
      { type: "reasoning-end", providerMetadata: { openai: { item: b } } },
    ]);
  });

  test("stream errors keep code, type and param, and have no status", () => {
    const t = new ResponsesTranslator();
    let thrown: unknown;
    try {
      t.push({
        type: "error",
        code: "invalid_prompt",
        message: "m",
        param: "input",
        type_: undefined,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({ status: undefined, code: "invalid_prompt", param: "input" });
    try {
      t.push({
        type: "response.failed",
        response: { error: { code: "server_error", type: "server_error", message: "m" } },
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toMatchObject({
      code: "server_error",
      type: "server_error",
      error: { code: "server_error" },
    });
    expect(() => t.push({ type: "response.failed", response: {} })).toThrow();
  });

  test("invalid token counts are dropped", () => {
    const events = run([text("x"), completed({ input_tokens: -1, output_tokens: 1.5 })]);
    const u = (
      events.find((e) => e.type === "usage") as unknown as { usage: Record<string, unknown> }
    ).usage;
    expect(u.inputTokens).toBeUndefined();
    expect(u.outputTokens).toBeUndefined();
  });

  test("a call still open at completed counts as a tool call", () => {
    const events = run([added(fcItem(1)), argsDelta(1, "{}"), completed()]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool-calls" });
  });

  test("a duplicate done and a reused call_id don't restart a call", () => {
    const events = run([
      added(fcItem(1)),
      done(fcItem(1, "{}")),
      done(fcItem(1, "{}")),
      added({ ...fcItem(2), call_id: "call_1" }),
      completed(),
    ]);
    expect(events.filter((e) => e.type === "tool-call-start")).toHaveLength(1);
  });

  test("a function call without an item id is keyed by its call_id", () => {
    const { id: _, ...noId } = fcItem(1, '{"a":1}');
    const events = run([done(noId), completed()]);
    expect(types(events).slice(0, 3)).toEqual([
      "tool-call-start",
      "tool-call-delta",
      "tool-call-end",
    ]);
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool-calls" });
  });
});

describe("ResponsesTranslator: security review follow-ups", () => {
  test("an error event doesn't report its envelope type as the provider type", () => {
    let thrown: unknown;
    try {
      new ResponsesTranslator().push({
        type: "error",
        code: "server_error",
        message: "m",
        param: null,
      });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as { type?: unknown }).type).toBeUndefined();
    expect((thrown as { error: { type?: unknown } }).error.type).toBeUndefined();
  });
});
