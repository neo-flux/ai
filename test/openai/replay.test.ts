import { describe, expect, test } from "bun:test";
import type OpenAI from "openai";
import { CITY_SCHEMA, PROMPTS, TOOL_RESULT } from "../../scripts/recorder/cases.ts";
import { type AIError, getProviderError } from "../../src/errors.ts";
import type { StreamEvent } from "../../src/events.ts";
import { generate } from "../../src/generate.ts";
import type { AssistantMessage, Message } from "../../src/messages.ts";
import { openai } from "../../src/openai/index.ts";
import { streamText } from "../../src/stream-text.ts";
import type { Fixture } from "../../src/testing/fixture.ts";
import { fakeAdapter } from "../../src/testing/index.ts";
import { replayClient } from "../../src/testing/replay.ts";
import { loadFixture, rawSchema, recordedCases, recordedRequest } from "../helpers/fixtures.ts";
import { collect, replaySuite, textOf } from "../helpers/replay.ts";

// Two documented differences from the recordings:
// - The recorder turned off stream obfuscation (`stream_options.include_obfuscation: false`). The
//   adapter leaves OpenAI's side-channel mitigation on, so it sends no `stream_options`.
// - Core names the structured output format "output"; the recorder named it "city".
const normalize = (params: unknown): unknown => {
  const p = structuredClone(params) as Record<string, unknown>;
  delete p.stream_options;
  const format = (p.text as { format?: { name?: string } } | undefined)?.format;
  if (format !== undefined) format.name = "output";
  return p;
};
const { replayTest, parity, registered } = replaySuite(normalize);

const replay = async (caseId: string, chunkDelayMs?: number) => {
  const fixture = await loadFixture("openai", caseId);
  const client = replayClient(fixture, chunkDelayMs === undefined ? {} : { chunkDelayMs });
  return {
    fixture,
    client,
    oa: openai({ client: client as unknown as OpenAI }),
    model: fixture.meta.model,
  };
};
const system = (fixture: Fixture): Message => ({
  role: "system",
  content: recordedRequest(fixture, 0).instructions as string,
});
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
const reasoning = { effort: "low", summary: "auto" };
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
const fallbackTo = () =>
  fakeAdapter([
    {
      events: [
        { type: "text-delta", text: "b" },
        { type: "finish", reason: "stop" },
      ],
    },
  ]);

describe("openai replay: text", () => {
  replayTest(["text"], "streams the recorded text", async () => {
    const { fixture, client, oa, model } = await replay("text");
    const s = streamText({
      model: oa(model),
      messages: [system(fixture), { role: "user", content: PROMPTS.text }],
    });
    const events = await collect(s);
    parity(fixture, client, 0);
    expect(textOf(events)).toBe("Hello from the fixture.");
    const r = await s.result;
    expect(r.finishReason).toBe("stop");
    expect(r.usage).toEqual({
      inputTokens: 31,
      outputTokens: 9,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
  });

  replayTest(["stream-long"], "one text delta per recorded delta", async () => {
    const { fixture, client, oa, model } = await replay("stream-long");
    const events = await collect(
      streamText({
        model: oa(model),
        messages: [system(fixture), { role: "user", content: PROMPTS.count }],
      }),
    );
    parity(fixture, client, 0);
    const recorded = fixture.calls[0]?.chunks.filter(
      (c) => (c as { type: string }).type === "response.output_text.delta",
    ) as { delta: string }[];
    expect(events.filter((e) => e.type === "text-delta")).toHaveLength(recorded.length);
    expect(textOf(events)).toBe(recorded.map((c) => c.delta).join(""));
    expect(events.slice(-2).map((e) => e.type)).toEqual(["usage", "finish"]);
  });

  replayTest(["length"], "incomplete at max_output_tokens is length", async () => {
    const { fixture, client, oa, model } = await replay("length");
    const r = await generate({
      model: oa(model),
      messages: [system(fixture), { role: "user", content: PROMPTS.count }],
      maxOutputTokens: 16,
    });
    parity(fixture, client, 0);
    expect(r.finishReason).toBe("length");
    expect(r.usage.outputTokens).toBe(16);
  });

  replayTest(["structured"], "json_schema in text.format, validated output", async () => {
    const { fixture, client, oa, model } = await replay("structured");
    const r = await generate({
      model: oa(model, { strictSchemas: true }),
      messages: [system(fixture), { role: "user", content: PROMPTS.structured }],
      output: rawSchema(CITY_SCHEMA),
    });
    parity(fixture, client, 0);
    expect(client.calls).toHaveLength(1);
    expect(r.output).toEqual(JSON.parse(r.text));
    expect(Object.keys(r.output as object).sort()).toEqual(["name", "population"]);
  });
});

describe("openai replay: tools", () => {
  replayTest(["tool-round-trip"], "two turns, the call item sent back verbatim", async () => {
    const { fixture, client, oa, model } = await replay("tool-round-trip");
    const m = oa(model, { strictSchemas: true });
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
    const { fixture, client, oa, model } = await replay("tool-parallel");
    const r = await generate({
      model: oa(model, { strictSchemas: true, body: { parallel_tool_calls: true } }),
      messages: [system(fixture), { role: "user", content: PROMPTS.parallel }],
      tools: weather,
      toolChoice: "required",
    });
    parity(fixture, client, 0);
    expect(r.toolCalls.map((c) => c.input)).toEqual([{ city: "Lahore" }, { city: "Karachi" }]);
    expect(new Set(r.toolCalls.map((c) => c.id)).size).toBe(2);
    expect(r.finishReason).toBe("tool-calls");
  });
});

describe("openai replay: reasoning", () => {
  replayTest(
    ["reasoning"],
    "an empty-summary reasoning item is kept and sent back verbatim",
    async () => {
      const { fixture, client, oa, model } = await replay("reasoning");
      const s = streamText({
        model: oa(model, { reasoning }),
        messages: [system(fixture), { role: "user", content: PROMPTS.reasoning }],
      });
      const events = await collect(s);
      parity(fixture, client, 0);
      const done = fixture.calls[0]?.chunks
        .map((c) => c as { type: string; item?: { type: string } })
        .find((c) => c.type === "response.output_item.done" && c.item?.type === "reasoning")?.item;
      expect(events.slice(0, 2)).toEqual([
        { type: "reasoning-delta", text: "" },
        { type: "reasoning-end", providerMetadata: { openai: { item: done } } },
      ]);
      const r = await s.result;
      expect(r.usage.reasoningTokens).toBe(12);

      // No recording round-trips a reasoning item (the tool case forced tool_choice, which skips
      // reasoning), so turn 2 is checked against a recording client instead.
      const sent: Record<string, unknown>[] = [];
      const recorder = {
        responses: {
          create: async (params: Record<string, unknown>) => {
            sent.push(params);
            return (async function* () {
              yield { type: "response.completed", response: { usage: null } };
            })();
          },
        },
      } as unknown as OpenAI;
      await generate({
        model: openai({ client: recorder })(model, { reasoning }),
        messages: [
          system(fixture),
          { role: "user", content: PROMPTS.reasoning },
          r.message,
          { role: "user", content: "Why?" },
        ],
      });
      const input = sent[0]?.input as unknown[];
      expect(input[1]).toEqual(done);
      expect((input[1] as { encrypted_content: string }).encrypted_content).toBe(
        "fixture-opaque-0002",
      );
      expect(input[2]).toEqual({ role: "assistant", content: r.text });
    },
  );

  replayTest(
    ["reasoning-tool-round-trip"],
    "forced tool choice: no reasoning item, two turns",
    async () => {
      const { fixture, client, oa, model } = await replay("reasoning-tool-round-trip");
      const m = oa(model, { reasoning, strictSchemas: true });
      const first = await generate({
        model: m,
        messages: [system(fixture), { role: "user", content: PROMPTS.reasoningTool }],
        tools: weather,
        toolChoice: { name: "get_weather" },
      });
      parity(fixture, client, 0);
      expect((first.message.content as readonly { type: string }[]).map((p) => p.type)).toEqual([
        "tool-call",
      ]);
      const second = await generate({
        model: m,
        messages: toolTurn(fixture, PROMPTS.reasoningTool, first.message),
        tools: weather,
      });
      parity(fixture, client, 1);
      expect(second.finishReason).toBe("stop");
    },
  );
});

describe("openai replay: abort and errors", () => {
  replayTest(["abort"], "an abort before any text: aborted, no fallback", async () => {
    const { fixture, client, oa, model } = await replay("abort", 20);
    const b = fallbackTo();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 30);
    const seen: StreamEvent[] = [];
    for await (const e of streamText({
      model: [oa(model), b("b")],
      messages: [system(fixture), { role: "user", content: PROMPTS.count }],
      signal: controller.signal,
    })) {
      seen.push(e);
    }
    parity(fixture, client, 0);
    expect(seen.map((e) => e.type)).toEqual(["error"]);
    expect((seen[0] as { error: AIError }).error).toMatchObject({
      code: "aborted",
      failover: false,
    });
    expect(b.calls).toHaveLength(0);
  });

  replayTest(["error-auth"], "auth, fails over, provider text kept out", async () => {
    const { fixture, client, oa, model } = await replay("error-auth");
    const messages: Message[] = [system(fixture), { role: "user", content: PROMPTS.text }];
    const err = (await generate({ model: oa(model), messages }).catch((e) => e)) as AIError;
    parity(fixture, client, 0);
    expect(err).toMatchObject({
      code: "auth",
      retryable: false,
      failover: true,
      status: 401,
      provider: "openai",
      providerCode: "invalid_api_key",
      providerType: "invalid_request_error",
    });
    for (const shown of [err.message, String(err), JSON.stringify(err)]) {
      expect(shown).not.toContain("***");
      expect(shown).not.toContain("Incorrect API key");
    }
    expect((getProviderError(err) as { status: number }).status).toBe(401);
    const again = await replay("error-auth");
    const b = fallbackTo();
    expect((await generate({ model: [again.oa(model), b("b")], messages })).modelRef.id).toBe("b");
  });

  replayTest(["error-model", "error-param"], "invalid_request, no failover", async () => {
    for (const [caseId, extra] of [
      ["error-model", {}],
      ["error-param", { maxOutputTokens: 0 }],
    ] as const) {
      const { fixture, client, oa } = await replay(caseId);
      const b = fallbackTo();
      const err = await generate({
        model: [oa(recordedRequest(fixture, 0).model as string), b("b")],
        messages: [system(fixture), { role: "user", content: PROMPTS.text }],
        ...extra,
      }).catch((e: unknown) => e);
      parity(fixture, client, 0);
      expect(err).toMatchObject({ code: "invalid_request", failover: false });
      expect(b.calls).toHaveLength(0);
    }
  });

  replayTest(["error-timeout"], "a retryable timeout that fails over", async () => {
    const { fixture, client, oa, model } = await replay("error-timeout");
    const b = fallbackTo();
    const r = await generate({
      model: [oa(model), b("b")],
      messages: [system(fixture), { role: "user", content: PROMPTS.text }],
      hooks: {
        onError: (e) =>
          void expect(e).toMatchObject({ code: "timeout", retryable: true, failover: true }),
      },
    });
    parity(fixture, client, 0);
    expect(r.modelRef.id).toBe("b");
  });
});

describe("openai replay: coverage", () => {
  test("every recorded OpenAI case has a replay test", () => {
    expect([...new Set(registered)].sort()).toEqual(recordedCases("openai"));
  });
});
