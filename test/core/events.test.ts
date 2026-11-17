import { describe, expect, test } from "bun:test";
import { AIError } from "../../src/errors.ts";
import {
  assertEventOrder,
  checkEventOrder,
  EventOrderError,
  type OrderRule,
  type StreamEvent,
} from "../../src/events.ts";

const flags = { inputIncludesCached: true, outputIncludesReasoning: true };
const finish: StreamEvent = { type: "finish", reason: "stop" };
const error: StreamEvent = { type: "error", error: new AIError({ code: "rate_limit" }) };
const start = (id: string, name = "t"): StreamEvent => ({ type: "tool-call-start", id, name });
const delta = (id: string, inputDelta = "{}"): StreamEvent => ({
  type: "tool-call-delta",
  id,
  inputDelta,
});
const end = (id: string): StreamEvent => ({ type: "tool-call-end", id });

const violates = (events: unknown[], rule: OrderRule, index: number) => {
  try {
    assertEventOrder(events as StreamEvent[]);
  } catch (e) {
    expect(e).toBeInstanceOf(EventOrderError);
    expect({ rule: (e as EventOrderError).rule, index: (e as EventOrderError).index }).toEqual({
      rule,
      index,
    });
    return;
  }
  throw new Error(`expected ${rule} at ${index}`);
};

async function* from(events: StreamEvent[]): AsyncGenerator<StreamEvent> {
  yield* events;
}

describe("valid streams", () => {
  const valid: Record<string, StreamEvent[]> = {
    "text only": [{ type: "text-delta", text: "a" }, { type: "text-delta", text: "" }, finish],
    "reasoning closed explicitly with metadata": [
      { type: "reasoning-delta", text: "hm" },
      { type: "reasoning-end", providerMetadata: { fake: { signature: "s" } } },
      { type: "reasoning-delta", text: "second block" },
      { type: "reasoning-end" },
      { type: "text-delta", text: "answer" },
      finish,
    ],
    "reasoning closed implicitly by text": [
      { type: "reasoning-delta", text: "hm" },
      { type: "text-delta", text: "a" },
      finish,
    ],
    "interleaved tool calls": [
      start("a"),
      start("b"),
      delta("a", '{"x":'),
      delta("b"),
      delta("a", "1}"),
      end("b"),
      end("a"),
      { type: "finish", reason: "tool-calls" },
    ],
    "repeated usage anywhere before the end": [
      { type: "usage", usage: { ...flags, inputTokens: 3 } },
      { type: "text-delta", text: "a" },
      { type: "usage", usage: { ...flags, inputTokens: 3, outputTokens: 0 } },
      { type: "finish", reason: "length", providerMetadata: { fake: 1 } },
    ],
    "error with an open tool call": [start("a"), delta("a"), error],
    "error first": [error],
    "finish only": [finish],
  };
  for (const [name, events] of Object.entries(valid)) {
    test(name, () => {
      expect(() => assertEventOrder(events)).not.toThrow();
    });
  }
});

describe("violations", () => {
  test("O0 malformed events", () => {
    violates([{ type: "nope" }], "O0", 0);
    violates([{ type: "text-delta", text: 1 }], "O0", 0);
    violates([{ type: "reasoning-delta" }], "O0", 0);
    violates([{ type: "tool-call-start", id: "", name: "t" }], "O0", 0);
    violates([{ type: "tool-call-start", id: "a", name: "" }], "O0", 0);
    violates([start("a"), { type: "tool-call-delta", id: "a", inputDelta: 1 }], "O0", 1);
    violates([{ type: "finish", reason: "done" }], "O0", 0);
    violates([{ type: "error", error: new Error("x") }], "O0", 0);
    violates([null], "O0", 0);
    violates([start("a"), { type: "tool-call-end", id: "" }], "O0", 1);
  });

  test("O1 exactly one terminal event, nothing after it", () => {
    violates([], "O1", 0);
    violates([{ type: "text-delta", text: "a" }], "O1", 1);
    violates([finish, { type: "text-delta", text: "a" }], "O1", 1);
    violates([finish, finish], "O1", 1);
    violates([error, finish], "O1", 1);
    violates([finish, { type: "usage", usage: flags }], "O1", 1);
  });

  test("O2 tool call ids are unique", () => {
    violates([start("a"), start("a")], "O2", 1);
    violates([start("a"), end("a"), start("a")], "O2", 2);
  });

  test("O3 deltas and ends need an open call", () => {
    violates([delta("a")], "O3", 0);
    violates([end("a")], "O3", 0);
    violates([start("a"), end("a"), delta("a")], "O3", 2);
    violates([start("a"), end("a"), end("a")], "O3", 2);
  });

  test("O5 every open call ends before finish", () => {
    violates([start("a"), finish], "O5", 1);
    violates([start("a"), start("b"), end("a"), { type: "finish", reason: "tool-calls" }], "O5", 3);
  });

  test("O6 reasoning-end needs open reasoning", () => {
    violates([{ type: "reasoning-end" }], "O6", 0);
    violates(
      [
        { type: "reasoning-delta", text: "a" },
        { type: "reasoning-end" },
        { type: "reasoning-end" },
      ],
      "O6",
      2,
    );
    violates(
      [
        { type: "reasoning-delta", text: "a" },
        { type: "text-delta", text: "b" },
        { type: "reasoning-end" },
      ],
      "O6",
      2,
    );
    violates(
      [{ type: "reasoning-delta", text: "a" }, start("x"), { type: "reasoning-end" }],
      "O6",
      2,
    );
  });

  test("O7 tool-calls finish needs an ended tool call", () => {
    violates([{ type: "finish", reason: "tool-calls" }], "O7", 0);
  });

  test("O8 usage values are non-negative safe integers and flags are booleans", () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3", 2 ** 53]) {
      violates([{ type: "usage", usage: { ...flags, outputTokens: bad } }], "O8", 0);
    }
    violates([{ type: "usage", usage: { inputTokens: 1 } }], "O8", 0);
    violates([{ type: "usage", usage: { ...flags, inputIncludesCached: "yes" } }], "O8", 0);
    violates([{ type: "usage" }], "O8", 0);
  });

  test("the error message names the rule and index but no event content", () => {
    try {
      assertEventOrder([finish, { type: "text-delta", text: "SECRET-CONTENT" }]);
    } catch (e) {
      expect((e as Error).message).toBe("event 1 (text-delta) breaks O1");
      expect((e as EventOrderError).eventType).toBe("text-delta");
      return;
    }
    throw new Error("expected a throw");
  });
});

describe("checkEventOrder", () => {
  test("passes events through in order", async () => {
    const events: StreamEvent[] = [{ type: "text-delta", text: "a" }, finish];
    const seen: StreamEvent[] = [];
    for await (const event of checkEventOrder(from(events))) seen.push(event);
    expect(seen).toEqual(events);
    expect(seen[0]).toBe(events[0] as StreamEvent);
  });

  test("throws at the violating event, after yielding the earlier ones", async () => {
    const seen: string[] = [];
    const run = async () => {
      for await (const event of checkEventOrder(from([finish, finish]))) seen.push(event.type);
    };
    await expect(run()).rejects.toMatchObject({ rule: "O1", index: 1 });
    expect(seen).toEqual(["finish"]);
  });

  test("throws at the end when no terminal event came", async () => {
    const run = async () => {
      for await (const _ of checkEventOrder(from([{ type: "text-delta", text: "a" }]))) {
        // drain
      }
    };
    await expect(run()).rejects.toMatchObject({ rule: "O1", index: 1 });
  });
});
