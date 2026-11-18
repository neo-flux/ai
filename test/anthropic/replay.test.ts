import { describe, expect, test } from "bun:test";
import type Anthropic from "@anthropic-ai/sdk";
import { CITY_SCHEMA, PROMPTS, TOOL_RESULT } from "../../scripts/recorder/cases.ts";
import { anthropic } from "../../src/anthropic/index.ts";
import { type AIError, getProviderError } from "../../src/errors.ts";
import type { StreamEvent } from "../../src/events.ts";
import { generate } from "../../src/generate.ts";
import type { AssistantMessage, Message } from "../../src/messages.ts";
import { streamText } from "../../src/stream-text.ts";
import type { Fixture } from "../../src/testing/fixture.ts";
import { fakeAdapter } from "../../src/testing/index.ts";
import { replayClient } from "../../src/testing/replay.ts";
import { loadFixture, rawSchema, recordedCases, recordedRequest } from "../helpers/fixtures.ts";
import { collect, replaySuite, textOf } from "../helpers/replay.ts";

// The adapter's requests are compared with the recordings as they are, with no normalization.
const { replayTest, parity, registered } = replaySuite((params) => params);

const replay = async (caseId: string, chunkDelayMs?: number) => {
  const fixture = await loadFixture("anthropic", caseId);
  const client = replayClient(fixture, chunkDelayMs === undefined ? {} : { chunkDelayMs });
  return {
    fixture,
    client,
    an: anthropic({ client: client as unknown as Anthropic }),
    model: fixture.meta.model,
  };
};
const system = (fixture: Fixture): Message => ({
  role: "system",
  content: recordedRequest(fixture, 0).system as string,
});
const maxTokens = (fixture: Fixture): number => recordedRequest(fixture, 0).max_tokens as number;
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
const thinking = { thinking: { type: "adaptive", display: "summarized" }, effort: "high" };
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

describe("anthropic replay: text", () => {
  replayTest(["text"], "streams the recorded text", async () => {
    const { fixture, client, an, model } = await replay("text");
    const s = streamText({
      model: an(model),
      messages: [system(fixture), { role: "user", content: PROMPTS.text }],
      maxOutputTokens: maxTokens(fixture),
    });
    const events = await collect(s);
    parity(fixture, client, 0);
    expect(textOf(events)).toBe("Hello from the fixture.");
    const r = await s.result;
    expect(r.finishReason).toBe("stop");
    const delta = fixture.calls[0]?.chunks.find(
      (c) => (c as { type: string }).type === "message_delta",
    ) as {
      usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens: number;
        cache_creation_input_tokens: number;
      };
    };
    expect(r.usage.inputTokens).toBe(
      delta.usage.input_tokens +
        delta.usage.cache_read_input_tokens +
        delta.usage.cache_creation_input_tokens,
    );
    expect(r.usage.outputTokens).toBe(delta.usage.output_tokens);
  });

  replayTest(["stream-long"], "one text delta per recorded delta", async () => {
    const { fixture, client, an, model } = await replay("stream-long");
    const events = await collect(
      streamText({
        model: an(model),
        messages: [system(fixture), { role: "user", content: PROMPTS.count }],
        maxOutputTokens: maxTokens(fixture),
      }),
    );
    parity(fixture, client, 0);
    const recorded = fixture.calls[0]?.chunks
      .map((c) => c as { type: string; delta?: { type: string; text?: string } })
      .filter((c) => c.type === "content_block_delta" && c.delta?.type === "text_delta")
      .map((c) => c.delta?.text ?? "")
      .filter((t) => t !== "");
    expect(events.filter((e) => e.type === "text-delta")).toHaveLength(recorded?.length ?? -1);
    expect(textOf(events)).toBe(recorded?.join("") ?? "missing");
    expect(events.slice(-2).map((e) => e.type)).toEqual(["usage", "finish"]);
  });

  replayTest(["length"], "max_tokens is length", async () => {
    const { fixture, client, an, model } = await replay("length");
    const r = await generate({
      model: an(model),
      messages: [system(fixture), { role: "user", content: PROMPTS.count }],
      maxOutputTokens: 16,
    });
    parity(fixture, client, 0);
    expect(r.finishReason).toBe("length");
  });

  replayTest(["structured"], "output_config.format, validated output", async () => {
    const { fixture, client, an, model } = await replay("structured");
    const r = await generate({
      model: an(model),
      messages: [system(fixture), { role: "user", content: PROMPTS.structured }],
      output: rawSchema(CITY_SCHEMA),
      maxOutputTokens: maxTokens(fixture),
    });
    parity(fixture, client, 0);
    expect(client.calls).toHaveLength(1);
    expect(Object.keys(r.output as object).sort()).toEqual(["name", "population"]);
  });
});

describe("anthropic replay: tools", () => {
  replayTest(["tool-round-trip"], "two turns", async () => {
    const { fixture, client, an, model } = await replay("tool-round-trip");
    const m = an(model);
    const s = streamText({
      model: m,
      messages: [system(fixture), { role: "user", content: PROMPTS.tool }],
      tools: weather,
      toolChoice: { name: "get_weather" },
      maxOutputTokens: maxTokens(fixture),
    });
    const events = await collect(s);
    parity(fixture, client, 0);
    expect(events.filter((e) => e.type !== "tool-call-delta").map((e) => e.type)).toEqual([
      "tool-call-start",
      "tool-call-end",
      "usage",
      "finish",
    ]);
    const first = await s.result;
    expect(first.finishReason).toBe("tool-calls");
    expect(first.toolCalls[0]).toMatchObject({ name: "get_weather", input: { city: "Lahore" } });
    const second = await generate({
      model: m,
      messages: toolTurn(fixture, PROMPTS.tool, first.message),
      tools: weather,
      maxOutputTokens: maxTokens(fixture),
    });
    parity(fixture, client, 1);
    expect(second.finishReason).toBe("stop");
  });

  replayTest(["tool-parallel"], "two calls in one turn", async () => {
    const { fixture, client, an, model } = await replay("tool-parallel");
    const r = await generate({
      model: an(model),
      messages: [system(fixture), { role: "user", content: PROMPTS.parallel }],
      tools: weather,
      toolChoice: "required",
      maxOutputTokens: maxTokens(fixture),
    });
    parity(fixture, client, 0);
    expect(r.toolCalls.map((c) => c.input)).toEqual([{ city: "Lahore" }, { city: "Karachi" }]);
    expect(r.finishReason).toBe("tool-calls");
  });
});

describe("anthropic replay: reasoning", () => {
  replayTest(["reasoning"], "thinking with its signature", async () => {
    const { fixture, client, an, model } = await replay("reasoning");
    const s = streamText({
      model: an(model, thinking),
      messages: [system(fixture), { role: "user", content: PROMPTS.reasoning }],
      maxOutputTokens: maxTokens(fixture),
    });
    const events = await collect(s);
    parity(fixture, client, 0);
    const ends = events.filter((e) => e.type === "reasoning-end");
    expect(ends).toEqual([
      {
        type: "reasoning-end",
        providerMetadata: { anthropic: { signature: "fixture-opaque-0001" } },
      },
    ]);
    const r = await s.result;
    const part = (r.message.content as readonly { type: string; text?: string }[])[0];
    expect(part?.type).toBe("reasoning");
    const recorded =
      fixture.calls[0]?.chunks
        .map((c) => c as { type: string; delta?: { type: string; thinking?: string } })
        .filter((c) => c.type === "content_block_delta" && c.delta?.type === "thinking_delta")
        .map((c) => c.delta?.thinking ?? "")
        .join("") ?? "";
    expect(recorded.length).toBeGreaterThan(0);
    expect(part?.text).toBe(recorded);
  });

  replayTest(
    ["reasoning-tool-round-trip"],
    "the thinking block goes back before the tool result",
    async () => {
      const { fixture, client, an, model } = await replay("reasoning-tool-round-trip");
      const m = an(model, thinking);
      const first = await generate({
        model: m,
        messages: [system(fixture), { role: "user", content: PROMPTS.reasoningTool }],
        tools: weather,
        toolChoice: "auto",
        maxOutputTokens: maxTokens(fixture),
      });
      parity(fixture, client, 0);
      expect((first.message.content as readonly { type: string }[]).map((p) => p.type)).toEqual([
        "reasoning",
        "tool-call",
      ]);
      const second = await generate({
        model: m,
        messages: toolTurn(fixture, PROMPTS.reasoningTool, first.message),
        tools: weather,
        toolChoice: "auto",
        maxOutputTokens: maxTokens(fixture),
      });
      // Exact, signature included: the API rejects thinking blocks that differ from what it sent.
      parity(fixture, client, 1);
      expect(second.finishReason).toBe("stop");
    },
  );
});

describe("anthropic replay: abort and errors", () => {
  replayTest(["abort"], "abort after text: one aborted error, no finish, no fallback", async () => {
    const { fixture, client, an, model } = await replay("abort", 5);
    const b = fallbackTo();
    const controller = new AbortController();
    const seen: StreamEvent[] = [];
    for await (const e of streamText({
      model: [an(model), b("b")],
      messages: [system(fixture), { role: "user", content: PROMPTS.count }],
      maxOutputTokens: maxTokens(fixture),
      signal: controller.signal,
    })) {
      seen.push(e);
      if (e.type === "text-delta") controller.abort();
    }
    parity(fixture, client, 0);
    expect(seen.map((e) => e.type)).toEqual(["text-delta", "error"]);
    expect((seen[1] as { error: AIError }).error).toMatchObject({
      code: "aborted",
      failover: false,
    });
    expect(b.calls).toHaveLength(0);
  });

  replayTest(["error-auth"], "auth, fails over, provider text kept out", async () => {
    const { fixture, client, an, model } = await replay("error-auth");
    const messages: Message[] = [system(fixture), { role: "user", content: PROMPTS.text }];
    const err = (await generate({ model: an(model), messages, maxOutputTokens: 512 }).catch(
      (e) => e,
    )) as AIError;
    parity(fixture, client, 0);
    expect(err).toMatchObject({
      code: "auth",
      retryable: false,
      failover: true,
      status: 401,
      provider: "anthropic",
      providerType: "authentication_error",
    });
    for (const shown of [err.message, String(err), JSON.stringify(err)]) {
      expect(shown).not.toContain("bearer");
      expect(shown).not.toContain("req_");
    }
    expect((getProviderError(err) as { status: number }).status).toBe(401);
    const again = await replay("error-auth");
    expect(
      (
        await generate({
          model: [again.an(model), fallbackTo()("b")],
          messages,
          maxOutputTokens: 512,
        })
      ).modelRef.id,
    ).toBe("b");
  });

  replayTest(["error-model", "error-param"], "invalid_request, no failover", async () => {
    for (const caseId of ["error-model", "error-param"]) {
      const { fixture, client, an } = await replay(caseId);
      const b = fallbackTo();
      const err = await generate({
        model: [an(recordedRequest(fixture, 0).model as string), b("b")],
        messages: [system(fixture), { role: "user", content: PROMPTS.text }],
        maxOutputTokens: maxTokens(fixture),
      }).catch((e: unknown) => e);
      parity(fixture, client, 0);
      expect(err).toMatchObject({ code: "invalid_request", failover: false });
      expect(b.calls).toHaveLength(0);
    }
  });

  replayTest(["error-timeout"], "a retryable timeout that fails over", async () => {
    const { fixture, client, an, model } = await replay("error-timeout");
    const seen: AIError[] = [];
    const r = await generate({
      model: [an(model), fallbackTo()("b")],
      messages: [system(fixture), { role: "user", content: PROMPTS.text }],
      maxOutputTokens: maxTokens(fixture),
      hooks: { onError: (e) => void seen.push(e) },
    });
    parity(fixture, client, 0);
    expect(seen[0]).toMatchObject({ code: "timeout", retryable: true, failover: true });
    expect(r.modelRef.id).toBe("b");
  });
});

describe("anthropic replay: coverage", () => {
  test("every recorded Anthropic case has a replay test", () => {
    expect([...new Set(registered)].sort()).toEqual(recordedCases("anthropic"));
  });
});
