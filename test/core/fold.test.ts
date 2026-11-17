import { describe, expect, test } from "bun:test";
import { AIError } from "../../src/errors.ts";
import { Fold, fold } from "../../src/fold.ts";

const flags = { inputIncludesCached: true, outputIncludesReasoning: true };

describe("fold", () => {
  test("joins text deltas into one part", () => {
    const r = fold([
      { type: "text-delta", text: "Hel" },
      { type: "text-delta", text: "" },
      { type: "text-delta", text: "lo" },
      { type: "finish", reason: "stop" },
    ]);
    expect(r.content).toEqual([{ type: "text", text: "Hello" }]);
    expect(r.text).toBe("Hello");
    expect(r.finishReason).toBe("stop");
  });

  test("an empty text delta creates no part", () => {
    const r = fold([
      { type: "text-delta", text: "" },
      { type: "finish", reason: "stop" },
    ]);
    expect(r.content).toEqual([]);
    expect(r.text).toBe("");
  });

  test("keeps part order across reasoning, text and tool calls", () => {
    const sig = { fake: { signature: "abc" } };
    const callMeta = { fake: { itemId: "fc_1" } };
    const finishMeta = { fake: { responseId: "r1" } };
    const r = fold([
      { type: "reasoning-delta", text: "think " },
      { type: "reasoning-delta", text: "more" },
      { type: "reasoning-end", providerMetadata: sig },
      { type: "reasoning-delta", text: "" },
      { type: "reasoning-end", providerMetadata: { fake: { redacted: "x" } } },
      { type: "text-delta", text: "a" },
      { type: "tool-call-start", id: "c1", name: "weather" },
      { type: "tool-call-delta", id: "c1", inputDelta: '{"city"' },
      { type: "tool-call-delta", id: "c1", inputDelta: ':"x"}' },
      { type: "tool-call-end", id: "c1", providerMetadata: callMeta },
      { type: "text-delta", text: "b" },
      { type: "finish", reason: "tool-calls", providerMetadata: finishMeta },
    ]);
    expect(r.content).toEqual([
      { type: "reasoning", text: "think more", providerMetadata: sig },
      { type: "reasoning", text: "", providerMetadata: { fake: { redacted: "x" } } },
      { type: "text", text: "a" },
      {
        type: "tool-call",
        id: "c1",
        name: "weather",
        input: { city: "x" },
        providerMetadata: callMeta,
      },
      { type: "text", text: "b" },
    ]);
    expect(r.text).toBe("ab");
    expect(r.reasoning).toBe("think more");
    expect((r.content[0] as { providerMetadata: unknown }).providerMetadata).toBe(sig);
    expect((r.content[3] as { providerMetadata: unknown }).providerMetadata).toBe(callMeta);
    expect(r.providerMetadata).toBe(finishMeta);
    expect(r.toolCalls).toEqual([
      { id: "c1", name: "weather", rawInput: '{"city":"x"}', providerMetadata: callMeta },
    ]);
  });

  test("reasoning blocks without reasoning-end are split by other content", () => {
    const r = fold([
      { type: "reasoning-delta", text: "a" },
      { type: "text-delta", text: "t" },
      { type: "reasoning-delta", text: "b" },
      { type: "finish", reason: "stop" },
    ]);
    expect(r.content.map((p) => p.type)).toEqual(["reasoning", "text", "reasoning"]);
    expect(r.reasoning).toBe("ab");
  });

  test("reasoning is undefined when there was none", () => {
    expect(fold([{ type: "finish", reason: "stop" }]).reasoning).toBeUndefined();
  });

  test("interleaved tool calls accumulate separately, ordered by start", () => {
    const r = fold([
      { type: "tool-call-start", id: "a", name: "x" },
      { type: "tool-call-start", id: "b", name: "y" },
      { type: "tool-call-delta", id: "b", inputDelta: "[1" },
      { type: "tool-call-delta", id: "a", inputDelta: "{}" },
      { type: "tool-call-delta", id: "b", inputDelta: "]" },
      { type: "tool-call-end", id: "a" },
      { type: "tool-call-end", id: "b" },
      { type: "finish", reason: "tool-calls" },
    ]);
    expect(r.toolCalls.map((c) => [c.id, c.rawInput])).toEqual([
      ["a", "{}"],
      ["b", "[1]"],
    ]);
    expect(r.content).toEqual([
      { type: "tool-call", id: "a", name: "x", input: {} },
      { type: "tool-call", id: "b", name: "y", input: [1] },
    ]);
  });

  test("tool call input in the message is the raw text when it isn't JSON", () => {
    const r = fold([
      { type: "tool-call-start", id: "a", name: "x" },
      { type: "tool-call-delta", id: "a", inputDelta: "{oops" },
      { type: "tool-call-end", id: "a" },
      { type: "finish", reason: "tool-calls" },
    ]);
    expect(r.content[0]).toEqual({ type: "tool-call", id: "a", name: "x", input: "{oops" });
  });

  test("merges usage and keeps the error", () => {
    const error = new AIError({ code: "rate_limit" });
    const r = fold([
      { type: "usage", usage: { ...flags, inputTokens: 5 } },
      { type: "usage", usage: { ...flags, outputTokens: 2 } },
      { type: "error", error },
    ]);
    expect(r.usage).toEqual({ ...flags, inputTokens: 5, outputTokens: 2 });
    expect(r.error).toBe(error);
    expect(r.finishReason).toBeUndefined();
  });

  test("result() is a snapshot that later events don't change", () => {
    const f = new Fold();
    f.push({ type: "text-delta", text: "a" });
    const first = f.result();
    f.push({ type: "text-delta", text: "b" });
    expect(first.text).toBe("a");
    expect(first.content).toEqual([{ type: "text", text: "a" }]);
    expect(f.result().text).toBe("ab");
  });
});
