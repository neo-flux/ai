import { describe, expect, test } from "bun:test";
import {
  anthropicBlocks,
  CASE_IDS,
  CITY_SCHEMA,
  casesFor,
  chatAssistant,
  INVALID_KEY,
  OPT_IN,
  PROMPTS,
  TOOL_RESULT,
} from "../../scripts/recorder/cases.ts";
import { MISSING_MODEL, PROVIDERS, type Provider } from "../../scripts/recorder/models.ts";
import type { CaseSpec, PlannedCall } from "../../scripts/recorder/record.ts";
import type { FixtureCall } from "../../src/testing/fixture.ts";

const spec = (provider: Provider, id: string): CaseSpec => {
  const found = casesFor(provider).find((c) => c.id === id);
  if (found === undefined) throw new Error(`no ${id} for ${provider}`);
  return found;
};
const build = (provider: Provider, id: string, turn = 0, previous: FixtureCall[] = []) =>
  spec(provider, id).build({ turn, model: "m", previous });
const params = (planned: PlannedCall) => planned.params as Record<string, unknown>;
const recorded = (chunks: unknown[]): FixtureCall => ({
  index: 0,
  request: {},
  options: {},
  chunks,
  outcome: "completed",
});

const COMMON = [
  "text",
  "stream-long",
  "length",
  "tool-round-trip",
  "tool-parallel",
  "structured",
  "reasoning",
  "reasoning-tool-round-trip",
  "abort",
  "error-auth",
  "error-model",
  "error-param",
  "error-timeout",
  "error-context",
];

describe("case list", () => {
  test("has exactly the agreed cases per provider", () => {
    expect([...CASE_IDS] as string[]).toEqual(COMMON);
    expect(casesFor("openai").map((c) => c.id)).toEqual(COMMON);
    expect(casesFor("anthropic").map((c) => c.id)).toEqual(COMMON);
    expect(casesFor("qwen").map((c) => c.id)).toEqual(COMMON);
    expect(casesFor("deepseek").map((c) => c.id)).toEqual([...COMMON, "error-reasoning-missing"]);
    expect([...OPT_IN]).toEqual(["error-context"]);
  });

  test("uses each provider's API and turn counts", () => {
    const apis: Record<Provider, string> = {
      openai: "responses",
      anthropic: "messages",
      deepseek: "chat.completions",
      qwen: "chat.completions",
    };
    for (const provider of PROVIDERS) {
      for (const c of casesFor(provider)) {
        expect({ provider, id: c.id, api: c.api as string }).toEqual({
          provider,
          id: c.id,
          api: apis[provider] as string,
        });
        const twoTurn = ["tool-round-trip", "reasoning-tool-round-trip", "error-reasoning-missing"];
        expect({ id: c.id, turns: c.turns }).toEqual({
          id: c.id,
          turns: twoTurn.includes(c.id) ? 2 : 1,
        });
      }
    }
  });

  test("every request streams and uses the shared prompts and model", () => {
    for (const provider of PROVIDERS) {
      const text = JSON.stringify(params(build(provider, "text")));
      expect(text).toContain(PROMPTS.text);
      expect(params(build(provider, "text")).stream).toBe(true);
      expect(params(build(provider, "text")).model).toBe("m");
      expect(JSON.stringify(params(build(provider, "stream-long")))).toContain(PROMPTS.count);
      expect(JSON.stringify(params(build(provider, "tool-round-trip")))).toContain(PROMPTS.tool);
    }
  });

  test("chat providers ask for usage in the stream", () => {
    for (const provider of ["deepseek", "qwen"] as const) {
      expect(params(build(provider, "text")).stream_options).toEqual({ include_usage: true });
    }
  });

  test("structured output uses the shared schema natively, and JSON mode on DeepSeek", () => {
    const openai = params(build("openai", "structured"));
    expect(openai.text).toEqual({
      format: { type: "json_schema", name: "city", schema: CITY_SCHEMA, strict: true },
    });
    expect(params(build("anthropic", "structured")).output_config).toEqual({
      format: { type: "json_schema", schema: CITY_SCHEMA },
    });
    expect(params(build("qwen", "structured")).response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "city", schema: CITY_SCHEMA, strict: true },
    });
    const deepseek = params(build("deepseek", "structured"));
    expect(deepseek.response_format).toEqual({ type: "json_object" });
    expect(JSON.stringify(deepseek.messages)).toContain(
      JSON.stringify(JSON.stringify(CITY_SCHEMA)).slice(1, -1),
    );
  });

  test("thinking is off for plain cases and on for reasoning cases on chat providers", () => {
    expect(params(build("deepseek", "text")).thinking).toEqual({ type: "disabled" });
    expect(params(build("deepseek", "reasoning")).thinking).toEqual({ type: "enabled" });
    expect(params(build("qwen", "text")).enable_thinking).toBe(false);
    expect(params(build("qwen", "reasoning")).enable_thinking).toBe(true);
  });

  test("reasoning settings for OpenAI and Anthropic", () => {
    const openai = params(build("openai", "reasoning"));
    expect(openai.reasoning).toEqual({ effort: "low", summary: "auto" });
    expect(openai.include).toEqual(["reasoning.encrypted_content"]);
    expect(openai.store).toBe(false);
    const anthropic = params(build("anthropic", "reasoning"));
    expect(anthropic.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
    expect(anthropic.max_tokens as number).toBeGreaterThan(1024);
  });

  test("length caps output at 16 tokens", () => {
    expect(params(build("openai", "length")).max_output_tokens).toBe(16);
    for (const provider of ["anthropic", "deepseek", "qwen"] as const) {
      expect(params(build(provider, "length")).max_tokens).toBe(16);
    }
  });

  test("error and abort cases are set up as agreed", () => {
    for (const provider of PROVIDERS) {
      expect(build(provider, "error-auth").invalidKey).toBe(true);
      expect(params(build(provider, "error-model")).model).toBe(MISSING_MODEL);
      expect(build(provider, "error-timeout").timeoutMs).toBe(1);
      expect(build(provider, "abort").abortAfterChunks).toBe(3);
      expect(JSON.stringify(params(build(provider, "abort")))).toContain(PROMPTS.count);
      expect(build(provider, "text").invalidKey).toBeUndefined();
      const context = JSON.stringify(params(build(provider, "error-context")));
      expect(context.length).toBeGreaterThan(1_000_000);
    }
    expect(params(build("openai", "error-param")).max_output_tokens).toBe(0);
    for (const provider of ["anthropic", "deepseek", "qwen"] as const) {
      expect(params(build(provider, "error-param")).max_tokens).toBe(0);
    }
    expect(INVALID_KEY).toBe("neoflux-fixture-invalid-key");
  });

  test("tool cases force the tool on turn 1 and not on turn 2", () => {
    expect(params(build("openai", "tool-round-trip")).tool_choice).toEqual({
      type: "function",
      name: "get_weather",
    });
    expect(params(build("anthropic", "tool-round-trip")).tool_choice).toEqual({
      type: "tool",
      name: "get_weather",
    });
    expect(params(build("deepseek", "tool-round-trip")).tool_choice).toEqual({
      type: "function",
      function: { name: "get_weather" },
    });
    expect(params(build("openai", "tool-parallel")).parallel_tool_calls).toBe(true);
    expect(params(build("qwen", "tool-parallel")).parallel_tool_calls).toBe(true);
    expect(JSON.stringify(params(build("openai", "tool-parallel")))).toContain(PROMPTS.parallel);
  });
});

describe("turn 2 builders", () => {
  const openaiTurn1 = recorded([
    { type: "response.created", response: { id: "resp_1", output: [] } },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        output: [
          { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc-1" },
          {
            type: "function_call",
            id: "fc_1",
            call_id: "call_1",
            name: "get_weather",
            arguments: '{"city":"Lahore"}',
          },
        ],
      },
    },
  ]);

  test("OpenAI tool round trip returns the call and its output, without forcing the tool", () => {
    const p = params(build("openai", "tool-round-trip", 1, [openaiTurn1]));
    const input = p.input as Record<string, unknown>[];
    expect(input.at(-2)).toMatchObject({ type: "function_call", call_id: "call_1" });
    expect(input.at(-1)).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: TOOL_RESULT,
    });
    expect(input.some((i) => i.type === "reasoning")).toBe(false);
    expect(p.tool_choice).toBeUndefined();
  });

  test("OpenAI reasoning round trip passes the reasoning item back with its encrypted content", () => {
    const p = params(build("openai", "reasoning-tool-round-trip", 1, [openaiTurn1]));
    const input = p.input as Record<string, unknown>[];
    expect(input).toContainEqual({
      type: "reasoning",
      id: "rs_1",
      summary: [],
      encrypted_content: "enc-1",
    });
    expect(input.at(-1)).toEqual({
      type: "function_call_output",
      call_id: "call_1",
      output: TOOL_RESULT,
    });
    expect(p.include).toEqual(["reasoning.encrypted_content"]);
  });

  const anthropicTurn1 = recorded([
    { type: "message_start", message: { id: "msg_1", content: [] } },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "Lahore " },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "first." },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig-1" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "redacted_thinking", data: "red-1" },
    },
    { type: "content_block_stop", index: 1 },
    {
      type: "content_block_start",
      index: 2,
      content_block: { type: "text", text: "", citations: null },
    },
    { type: "content_block_delta", index: 2, delta: { type: "text_delta", text: "Checking." } },
    { type: "content_block_stop", index: 2 },
    {
      type: "content_block_start",
      index: 3,
      content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
    },
    {
      type: "content_block_delta",
      index: 3,
      delta: { type: "input_json_delta", partial_json: '{"city":' },
    },
    {
      type: "content_block_delta",
      index: 3,
      delta: { type: "input_json_delta", partial_json: '"Lahore"}' },
    },
    { type: "content_block_stop", index: 3 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
    { type: "message_stop" },
  ]);

  test("anthropicBlocks rebuilds content blocks from stream events, in order", () => {
    expect(anthropicBlocks(anthropicTurn1.chunks)).toEqual([
      { type: "thinking", thinking: "Lahore first.", signature: "sig-1" },
      { type: "redacted_thinking", data: "red-1" },
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "Lahore" } },
    ]);
  });

  test("Anthropic round trip returns thinking before the tool use, then the tool result", () => {
    const p = params(build("anthropic", "reasoning-tool-round-trip", 1, [anthropicTurn1]));
    const messages = p.messages as { role: string; content: unknown }[];
    expect(messages).toHaveLength(3);
    expect(messages[1]?.role).toBe("assistant");
    expect(messages[1]?.content).toEqual(anthropicBlocks(anthropicTurn1.chunks));
    expect(messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: TOOL_RESULT }],
    });
    expect(p.thinking).toEqual({ type: "enabled", budget_tokens: 1024 });
  });

  const chatTurn1 = recorded([
    {
      id: "c1",
      choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "Check " } }],
    },
    { id: "c1", choices: [{ index: 0, delta: { reasoning_content: "Lahore." } }] },
    {
      id: "c1",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "get_weather", arguments: '{"city":' },
              },
            ],
          },
        },
      ],
    },
    {
      id: "c1",
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '"Lahore"}' } }] },
        },
      ],
    },
    {
      id: "c1",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 5 },
    },
  ]);

  test("chatAssistant accumulates content, reasoning and tool calls", () => {
    expect(chatAssistant(chatTurn1.chunks, true)).toEqual({
      role: "assistant",
      content: null,
      reasoning_content: "Check Lahore.",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "get_weather", arguments: '{"city":"Lahore"}' },
        },
      ],
    });
    expect("reasoning_content" in chatAssistant(chatTurn1.chunks, false)).toBe(false);
  });

  test("DeepSeek round trip returns reasoning_content; the missing variant leaves it out", () => {
    const p = params(build("deepseek", "reasoning-tool-round-trip", 1, [chatTurn1]));
    const messages = p.messages as Record<string, unknown>[];
    expect(messages.at(-2)).toEqual(chatAssistant(chatTurn1.chunks, true));
    expect(messages.at(-1)).toEqual({ role: "tool", tool_call_id: "call_1", content: TOOL_RESULT });
    const missing = params(build("deepseek", "error-reasoning-missing", 1, [chatTurn1]));
    const assistant = (missing.messages as Record<string, unknown>[]).at(-2) as Record<
      string,
      unknown
    >;
    expect("reasoning_content" in assistant).toBe(false);
    expect(assistant.tool_calls).toEqual(chatAssistant(chatTurn1.chunks, true).tool_calls);
    expect(missing.thinking).toEqual({ type: "enabled" });
  });

  test("Qwen round trip preserves thinking", () => {
    const p = params(build("qwen", "reasoning-tool-round-trip", 1, [chatTurn1]));
    expect(p.preserve_thinking).toBe(true);
    expect(p.enable_thinking).toBe(true);
    expect((p.messages as unknown[]).at(-2)).toEqual(chatAssistant(chatTurn1.chunks, true));
  });

  test("turn 2 without a recorded tool call fails clearly", () => {
    expect(() => build("openai", "tool-round-trip", 1, [recorded([])])).toThrow(/no function_call/);
    expect(() => build("anthropic", "tool-round-trip", 1, [recorded([])])).toThrow(/no tool_use/);
    expect(() => build("deepseek", "tool-round-trip", 1, [recorded([])])).toThrow(/no tool call/);
  });
});

describe("case builders: audit follow-ups", () => {
  const chunk = (delta: unknown) => ({ id: "c1", choices: [{ index: 0, delta }] });

  test("Qwen-shaped continuations with empty id and name keep the first id and name", () => {
    const qwen = recorded([
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: "" },
          },
        ],
      }),
      chunk({
        tool_calls: [
          { index: 0, id: "", type: "function", function: { name: "", arguments: '{"city":' } },
        ],
      }),
      chunk({
        tool_calls: [
          { index: 0, id: "", type: "function", function: { name: "", arguments: '"Lahore"}' } },
        ],
      }),
    ]);
    expect(chatAssistant(qwen.chunks, false).tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Lahore"}' },
      },
    ]);
  });

  test("a provider repeating the full name on each chunk doesn't duplicate it", () => {
    const repeated = recorded([
      chunk({
        tool_calls: [
          { index: 0, id: "call_1", function: { name: "get_weather", arguments: "{}" } },
        ],
      }),
      chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "get_weather" } }] }),
    ]);
    expect(chatAssistant(repeated.chunks, false).tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "get_weather", arguments: "{}" } },
    ]);
  });

  test("anthropicBlocks drops text blocks that stayed empty", () => {
    expect(
      anthropicBlocks([
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_stop", index: 0 },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
        },
        { type: "content_block_stop", index: 1 },
      ]),
    ).toEqual([{ type: "tool_use", id: "toolu_1", name: "get_weather", input: {} }]);
  });

  const toolTurn1: Record<Provider, FixtureCall> = {
    openai: recorded([
      {
        type: "response.completed",
        response: {
          output: [
            {
              type: "message",
              id: "msg_1",
              role: "assistant",
              content: [{ type: "output_text", text: "Checking." }],
            },
            {
              type: "function_call",
              id: "fc_1",
              call_id: "call_1",
              name: "get_weather",
              arguments: "{}",
            },
          ],
        },
      },
    ]),
    anthropic: recorded([
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_1", name: "get_weather", input: {} },
      },
      { type: "content_block_stop", index: 0 },
    ]),
    deepseek: recorded([
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: "{}" },
          },
        ],
      }),
    ]),
    qwen: recorded([
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: "{}" },
          },
        ],
      }),
    ]),
  };

  test("turn 2 of every two-turn case keeps the tools and doesn't force one", () => {
    for (const provider of PROVIDERS) {
      for (const id of ["tool-round-trip", "reasoning-tool-round-trip"]) {
        const p = params(build(provider, id, 1, [toolTurn1[provider]]));
        expect({
          provider,
          id,
          tools: Array.isArray(p.tools) && (p.tools as unknown[]).length === 1,
        }).toEqual({
          provider,
          id,
          tools: true,
        });
        const choice = p.tool_choice as { type?: string } | string | undefined;
        const forced =
          typeof choice === "object" && (choice.type === "tool" || choice.type === "function");
        expect({ provider, id, forced }).toEqual({ provider, id, forced: false });
      }
    }
  });

  test("Anthropic reasoning with tools leaves the choice to the model on both turns", () => {
    expect(params(build("anthropic", "reasoning-tool-round-trip")).tool_choice).toEqual({
      type: "auto",
    });
    expect(
      params(build("anthropic", "reasoning-tool-round-trip", 1, [toolTurn1.anthropic])).tool_choice,
    ).toEqual({
      type: "auto",
    });
  });

  test("OpenAI reasoning round trip passes message items back too", () => {
    const input = params(build("openai", "reasoning-tool-round-trip", 1, [toolTurn1.openai]))
      .input as Record<string, unknown>[];
    expect(input.some((item) => item.type === "message" && item.id === "msg_1")).toBe(true);
  });

  test("OpenAI requests turn off stream obfuscation padding", () => {
    for (const c of casesFor("openai")) {
      const p = params(c.build({ turn: 0, model: "m", previous: [] }));
      expect({ id: c.id, so: p.stream_options }).toEqual({
        id: c.id,
        so: { include_obfuscation: false },
      });
    }
  });
});
