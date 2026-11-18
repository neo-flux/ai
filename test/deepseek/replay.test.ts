import { describe, expect, test } from "bun:test";
import type OpenAI from "openai";
import { z } from "zod";
import { CITY_SCHEMA, PROMPTS, TOOL_RESULT } from "../../scripts/recorder/cases.ts";
import { deepseek } from "../../src/deepseek/index.ts";
import { type AIError, getProviderError } from "../../src/errors.ts";
import type { StreamEvent } from "../../src/events.ts";
import { generate } from "../../src/generate.ts";
import type { AssistantMessage, Message } from "../../src/messages.ts";
import { streamText } from "../../src/stream-text.ts";
import type { Fixture } from "../../src/testing/fixture.ts";
import { checkEventOrder, fakeAdapter } from "../../src/testing/index.ts";
import { replayClient } from "../../src/testing/replay.ts";
import { loadFixture, rawSchema, recordedCases, recordedRequest } from "../helpers/fixtures.ts";

// Every recorded case is registered by the test that replays it, when the file loads, so the
// coverage check doesn't depend on test order or on `-t` filters.
const REGISTERED: string[] = [];
let paritied = new Set<string>();
const replayTest = (caseIds: readonly string[], title: string, fn: () => Promise<void>) => {
  REGISTERED.push(...caseIds);
  test(`${caseIds.join(", ")}: ${title}`, async () => {
    paritied = new Set();
    await fn();
    // Each case must compare the adapter's request with the recorded one.
    for (const id of caseIds)
      expect({ id, parity: paritied.has(id) }).toEqual({ id, parity: true });
  });
};
const replay = async (caseId: string, chunkDelayMs?: number) => {
  const fixture = await loadFixture("deepseek", caseId);
  const client = replayClient(fixture, chunkDelayMs === undefined ? {} : { chunkDelayMs });
  const ds = deepseek({ client: client as unknown as OpenAI });
  return { fixture, client, ds, model: fixture.meta.model };
};
const system = (fixture: Fixture): Message => {
  const first = (recordedRequest(fixture, 0).messages as { content: string }[])[0];
  return { role: "system", content: first?.content as string };
};
const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const e of checkEventOrder(it)) out.push(e);
  return out;
};
const textOf = (events: StreamEvent[]) =>
  events.map((e) => (e.type === "text-delta" ? e.text : "")).join("");
// The adapter re-serializes tool arguments ({"city": "Lahore"} becomes {"city":"Lahore"}), so
// arguments are compared parsed.
const normalize = (params: unknown): unknown => {
  const p = structuredClone(params) as {
    messages?: { tool_calls?: { function: { arguments: string } }[] }[];
  };
  for (const m of p.messages ?? []) {
    for (const tc of m.tool_calls ?? []) tc.function.arguments = JSON.parse(tc.function.arguments);
  }
  return p;
};
const sent = (client: { calls: readonly { params: unknown }[] }, i: number) =>
  client.calls[i]?.params;
/** The adapter's request for call `i` equals the recorded one, minus `omit` keys. */
const parity = (
  fixture: Fixture,
  client: { calls: readonly { params: unknown }[] },
  i: number,
  omit: readonly string[] = [],
) => {
  const strip = (v: unknown) => {
    const copy = { ...(normalize(v) as Record<string, unknown>) };
    for (const key of omit) delete copy[key];
    return copy;
  };
  expect(client.calls.length).toBeGreaterThan(i);
  expect(strip(sent(client, i))).toEqual(strip(recordedRequest(fixture, i)));
  paritied.add(fixture.meta.case);
};
const weather = {
  get_weather: {
    description: "Get the current weather for a city.",
    schema: rawSchema({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
      additionalProperties: false,
    }),
  },
};
const toolTurn = (fixture: Fixture, prompt: string, first: AssistantMessage): Message[] => {
  const call = (first.content as readonly { type: string; id?: string }[]).find(
    (p) => p.type === "tool-call",
  );
  return [
    system(fixture),
    { role: "user", content: prompt },
    first,
    { role: "tool", toolCallId: call?.id as string, toolName: "get_weather", content: TOOL_RESULT },
  ];
};

describe("deepseek replay: text", () => {
  replayTest(["text"], "streams the recorded text", async () => {
    const { fixture, client, ds, model } = await replay("text");
    const s = streamText({
      model: ds(model, { thinking: "disabled" }),
      messages: [system(fixture), { role: "user", content: PROMPTS.text }],
    });
    const events = await collect(s);
    parity(fixture, client, 0);
    expect(textOf(events)).toBe("Hello from the fixture.");
    expect(events.at(-1)).toEqual({ type: "finish", reason: "stop" });
    const r = await s.result;
    expect(r.usage.inputTokens).toBe(26);
    expect(r.usage.outputTokens).toBe(5);
    expect(r.usage.cachedInputTokens).toBe(0);
    expect(r.usage.reasoningTokens).toBeUndefined();
  });

  replayTest(["stream-long"], "one delta per non-empty chunk", async () => {
    const { fixture, client, ds, model } = await replay("stream-long");
    const events = await collect(
      streamText({
        model: ds(model, { thinking: "disabled" }),
        messages: [system(fixture), { role: "user", content: PROMPTS.count }],
      }),
    );
    parity(fixture, client, 0);
    const recorded = fixture.calls[0]?.chunks
      .map(
        (c) =>
          (c as { choices: { delta: { content?: string } }[] }).choices[0]?.delta.content ?? "",
      )
      .filter((t) => t !== "") as string[];
    expect(events.filter((e) => e.type === "text-delta")).toHaveLength(recorded.length);
    expect(textOf(events)).toBe(recorded.join(""));
    expect(events.slice(-2).map((e) => e.type)).toEqual(["usage", "finish"]);
    expect(events.filter((e) => e.type === "usage")).toHaveLength(1);
  });

  replayTest(["length"], "finish length", async () => {
    const { fixture, client, ds, model } = await replay("length");
    const r = await generate({
      model: ds(model, { thinking: "disabled" }),
      messages: [system(fixture), { role: "user", content: PROMPTS.count }],
      maxOutputTokens: 16,
    });
    parity(fixture, client, 0);
    expect(r.finishReason).toBe("length");
    expect(r.usage.outputTokens).toBe(16);
  });

  replayTest(["structured"], "JSON mode with the schema in an added system message", async () => {
    const { fixture, client, ds, model } = await replay("structured");
    const r = await generate({
      model: ds(model, { thinking: "disabled" }),
      messages: [system(fixture), { role: "user", content: PROMPTS.structured }],
      output: z.object({ name: z.string(), population: z.number().int() }),
    });
    expect(client.calls).toHaveLength(1);
    expect(r.output).toEqual(JSON.parse(r.text));
    // The recording put the instruction in the user prompt; the adapter adds a system message.
    parity(fixture, client, 0, ["messages"]);
    expect((sent(client, 0) as Record<string, unknown>).response_format).toEqual({
      type: "json_object",
    });
    const sentMessages = (sent(client, 0) as { messages: { role: string; content: string }[] })
      .messages;
    const recordedMessages = recordedRequest(fixture, 0).messages as { content: string }[];
    expect(sentMessages).toHaveLength(3);
    expect(sentMessages[0]).toEqual(recordedMessages[0] as never);
    expect(sentMessages[2]).toEqual({ role: "user", content: PROMPTS.structured });
    expect(recordedMessages[1]?.content).toStartWith(PROMPTS.structured);
    const prefix = "Reply only with JSON matching this JSON Schema: ";
    expect(sentMessages[1]?.role).toBe("system");
    expect(sentMessages[1]?.content).toStartWith(prefix);
    const schema = JSON.parse((sentMessages[1]?.content ?? "").slice(prefix.length));
    expect(Object.keys(schema.properties)).toEqual(Object.keys(CITY_SCHEMA.properties as object));
    expect(schema.required).toEqual(CITY_SCHEMA.required);
  });
});

describe("deepseek replay: tools", () => {
  replayTest(["tool-round-trip"], "two turns", async () => {
    const { fixture, client, ds, model } = await replay("tool-round-trip");
    const m = ds(model, { thinking: "disabled" });
    const s = streamText({
      model: m,
      messages: [system(fixture), { role: "user", content: PROMPTS.tool }],
      tools: weather,
      toolChoice: { name: "get_weather" },
    });
    const events = await collect(s);
    parity(fixture, client, 0);
    expect(events.filter((e) => e.type !== "tool-call-delta").map((e) => e.type)).toEqual([
      "tool-call-start",
      "tool-call-end",
      "usage",
      "finish",
    ]);
    expect(events[0]).toEqual({
      type: "tool-call-start",
      id: "call_fixture0003",
      name: "get_weather",
    });
    const first = await s.result;
    expect(first.finishReason).toBe("tool-calls");
    expect(first.toolCalls[0]).toMatchObject({ name: "get_weather", input: { city: "Lahore" } });

    const second = await generate({
      model: m,
      messages: toolTurn(fixture, PROMPTS.tool, first.message),
      tools: weather,
    });
    parity(fixture, client, 1);
    expect(second.finishReason).toBe("stop");
    expect(second.text.length).toBeGreaterThan(0);
  });

  replayTest(["tool-parallel"], "two calls in one turn", async () => {
    const { fixture, client, ds, model } = await replay("tool-parallel");
    const s = streamText({
      model: ds(model, { thinking: "disabled" }),
      messages: [system(fixture), { role: "user", content: PROMPTS.parallel }],
      tools: weather,
      toolChoice: "required",
    });
    const events = await collect(s);
    parity(fixture, client, 0);
    const starts = events.filter((e) => e.type === "tool-call-start");
    expect(starts).toHaveLength(2);
    expect(new Set(starts.map((e) => (e as { id: string }).id)).size).toBe(2);
    const r = await s.result;
    expect(r.toolCalls.map((c) => c.input)).toEqual([{ city: "Lahore" }, { city: "Karachi" }]);
    expect(r.finishReason).toBe("tool-calls");
  });
});

describe("deepseek replay: reasoning", () => {
  replayTest(
    ["reasoning"],
    "one reasoning-end with DeepSeek's marker, before the text",
    async () => {
      const { fixture, client, ds, model } = await replay("reasoning");
      const s = streamText({
        model: ds(model, { thinking: "enabled" }),
        messages: [system(fixture), { role: "user", content: PROMPTS.reasoning }],
      });
      const events = await collect(s);
      parity(fixture, client, 0);
      const ends = events.filter((e) => e.type === "reasoning-end");
      expect(ends).toEqual([
        {
          type: "reasoning-end",
          providerMetadata: { deepseek: { reasoningField: "reasoning_content" } },
        },
      ]);
      const firstText = events.findIndex((e) => e.type === "text-delta");
      expect(events.findIndex((e) => e.type === "reasoning-end")).toBe(firstText - 1);
      const r = await s.result;
      expect(r.usage.reasoningTokens).toBe(76);
      expect(r.usage.outputTokens).toBe(81);
    },
  );

  replayTest(
    ["reasoning-tool-round-trip"],
    "turn 2 sends the reasoning back byte for byte",
    async () => {
      const { fixture, client, ds, model } = await replay("reasoning-tool-round-trip");
      const m = ds(model, { thinking: "enabled" });
      const first = await generate({
        model: m,
        messages: [system(fixture), { role: "user", content: PROMPTS.reasoningTool }],
        tools: weather,
        toolChoice: "auto",
      });
      parity(fixture, client, 0);
      expect((first.message.content as readonly { type: string }[]).map((p) => p.type)).toEqual([
        "reasoning",
        "tool-call",
      ]);
      const second = await streamText({
        model: m,
        messages: toolTurn(fixture, PROMPTS.reasoningTool, first.message),
        tools: weather,
        toolChoice: "auto",
      });
      const events = await collect(second);
      parity(fixture, client, 1);
      const assistant = (sent(client, 1) as { messages: Record<string, unknown>[] }).messages[2];
      const recorded = (recordedRequest(fixture, 1).messages as Record<string, unknown>[])[2];
      expect(assistant?.reasoning_content).toBe(recorded?.reasoning_content as string);
      // Turn 2's only reasoning chunk is "", so it has no reasoning part.
      expect(events.some((e) => e.type === "reasoning-delta")).toBe(false);
      expect((await second.result).finishReason).toBe("stop");
    },
  );

  replayTest(
    ["error-reasoning-missing"],
    "a history without DeepSeek reasoning still works",
    async () => {
      const { fixture, client, ds, model } = await replay("error-reasoning-missing");
      const m = ds(model, { thinking: "enabled" });
      const first = await generate({
        model: m,
        messages: [system(fixture), { role: "user", content: PROMPTS.reasoningTool }],
        tools: weather,
        toolChoice: "auto",
      });
      const trimmed: AssistantMessage = {
        ...first.message,
        content: (first.message.content as AssistantMessage["content"] & unknown[]).filter(
          (p) => (p as { type: string }).type !== "reasoning",
        ) as AssistantMessage["content"],
      };
      const second = await generate({
        model: m,
        messages: toolTurn(fixture, PROMPTS.reasoningTool, trimmed),
        tools: weather,
        toolChoice: "auto",
      });
      // The recorded turn 2 had no reasoning_content, and DeepSeek answered it normally.
      parity(fixture, client, 1);
      const assistant = (sent(client, 1) as { messages: Record<string, unknown>[] }).messages[2];
      expect("reasoning_content" in (assistant ?? {})).toBe(false);
      expect(second.finishReason).toBe("stop");
    },
  );

  replayTest(
    ["error-reasoning-missing"],
    "another provider's reasoning is not echoed",
    async () => {
      const { fixture, client, ds, model } = await replay("error-reasoning-missing");
      const m = ds(model, { thinking: "enabled" });
      const first = await generate({
        model: m,
        messages: [system(fixture), { role: "user", content: PROMPTS.reasoningTool }],
        tools: weather,
        toolChoice: "auto",
      });
      const foreign: AssistantMessage = {
        ...first.message,
        content: (first.message.content as readonly { type: string }[]).map((p) =>
          p.type === "reasoning"
            ? {
                type: "reasoning",
                text: "other model's thinking",
                providerMetadata: { anthropic: { signature: "s" } },
              }
            : p,
        ) as AssistantMessage["content"],
      };
      await generate({
        model: m,
        messages: toolTurn(fixture, PROMPTS.reasoningTool, foreign),
        tools: weather,
        toolChoice: "auto",
      });
      parity(fixture, client, 1);
    },
  );
});

describe("deepseek replay: abort and errors", () => {
  replayTest(["abort"], "one aborted error event after text, no finish", async () => {
    const { fixture, client, ds, model } = await replay("abort", 5);
    const fake = fakeAdapter([{ events: [{ type: "finish", reason: "stop" }] }]);
    const controller = new AbortController();
    const seen: StreamEvent[] = [];
    for await (const e of streamText({
      model: [ds(model, { thinking: "disabled" }), fake("b")],
      messages: [system(fixture), { role: "user", content: PROMPTS.count }],
      signal: controller.signal,
    })) {
      seen.push(e);
      if (e.type === "text-delta") controller.abort();
    }
    parity(fixture, client, 0);
    expect(seen.map((e) => e.type)).toEqual(["text-delta", "error"]);
    expect((seen[1] as { error: AIError }).error.code).toBe("aborted");
    expect(
      (client.calls[0]?.options as { signal?: AbortSignal } | undefined)?.signal?.aborted,
    ).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });

  replayTest(
    ["error-auth"],
    "auth, fails over, and keeps the provider's text out of the error",
    async () => {
      const { fixture, client, ds, model } = await replay("error-auth");
      const messages: Message[] = [system(fixture), { role: "user", content: PROMPTS.text }];
      const err = (await generate({ model: ds(model, { thinking: "disabled" }), messages }).catch(
        (e) => e,
      )) as AIError;
      parity(fixture, client, 0);
      expect(err).toMatchObject({
        code: "auth",
        retryable: false,
        failover: true,
        status: 401,
        provider: "deepseek",
        providerType: "authentication_error",
        providerCode: "invalid_request_error",
      });
      for (const shown of [err.message, String(err), JSON.stringify(err)]) {
        expect(shown).not.toContain("****");
        expect(shown).not.toContain("Authentication Fails");
      }
      expect((getProviderError(err) as { status: number }).status).toBe(401);
    },
  );

  replayTest(["error-auth"], "in a chain, moves to the next model", async () => {
    const { fixture, client, ds, model } = await replay("error-auth");
    const fake = fakeAdapter([
      {
        events: [
          { type: "text-delta", text: "b" },
          { type: "finish", reason: "stop" },
        ],
      },
    ]);
    const r = await generate({
      model: [ds(model, { thinking: "disabled" }), fake("b")],
      messages: [system(fixture), { role: "user", content: PROMPTS.text }],
    });
    expect(r.modelRef.id).toBe("b");
    parity(fixture, client, 0);
  });

  replayTest(["error-model", "error-param"], "invalid_request, no failover", async () => {
    for (const [caseId, extra] of [
      ["error-model", {}],
      ["error-param", { maxOutputTokens: 0 }],
    ] as const) {
      const { fixture, client, ds } = await replay(caseId);
      const model = recordedRequest(fixture, 0).model as string;
      const fake = fakeAdapter([{ events: [{ type: "finish", reason: "stop" }] }]);
      const err = await generate({
        model: [ds(model, { thinking: "disabled" }), fake("b")],
        messages: [system(fixture), { role: "user", content: PROMPTS.text }],
        ...extra,
      }).catch((e: unknown) => e);
      parity(fixture, client, 0);
      expect(err).toMatchObject({ code: "invalid_request", status: 400, failover: false });
      expect(fake.calls).toHaveLength(0);
    }
  });

  replayTest(["error-timeout"], "a retryable timeout that fails over", async () => {
    const { fixture, client, ds, model } = await replay("error-timeout");
    const messages: Message[] = [system(fixture), { role: "user", content: PROMPTS.text }];
    const err = await generate({ model: ds(model, { thinking: "disabled" }), messages }).catch(
      (e: unknown) => e,
    );
    parity(fixture, client, 0);
    expect(err).toMatchObject({ code: "timeout", retryable: true, failover: true });
    const again = await replay("error-timeout");
    const fake = fakeAdapter([
      {
        events: [
          { type: "text-delta", text: "b" },
          { type: "finish", reason: "stop" },
        ],
      },
    ]);
    const r = await generate({
      model: [again.ds(model, { thinking: "disabled" }), fake("b")],
      messages,
    });
    expect(r.modelRef.id).toBe("b");
  });
});

describe("deepseek replay: abort before any event", () => {
  replayTest(["abort"], "an abort before the first event doesn't fail over", async () => {
    const { fixture, client, ds, model } = await replay("abort", 50);
    const fake = fakeAdapter([{ events: [{ type: "finish", reason: "stop" }] }]);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const err = await generate({
      model: [ds(model, { thinking: "disabled" }), fake("b")],
      messages: [system(fixture), { role: "user", content: PROMPTS.count }],
      signal: controller.signal,
    }).catch((e: unknown) => e);
    parity(fixture, client, 0);
    expect(err).toMatchObject({ code: "aborted", retryable: false, failover: false });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("deepseek replay: coverage", () => {
  test("every recorded DeepSeek case has a replay test", () => {
    expect([...new Set(REGISTERED)].sort()).toEqual(recordedCases("deepseek"));
  });
});
