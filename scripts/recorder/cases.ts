// The fixture cases: fixed synthetic prompts, one shared tool and one shared schema, and each
// provider's request for every case. Turn-2 requests are built by hand from turn 1's recorded SDK
// chunks, never through an adapter.
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import type { FixtureCall } from "../../src/testing/fixture.ts";
import { MISSING_MODEL, type Provider } from "./models.ts";
import type { BuildInput, CaseSpec, PlannedCall } from "./record.ts";

export const CASE_IDS = [
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
] as const;

/** Recorded only when asked for: one oversized request per provider. */
export const OPT_IN: readonly string[] = ["error-context"];

/** Obviously fake, and shaped so no credential pattern matches it. */
export const INVALID_KEY = "neoflux-fixture-invalid-key";

const SYSTEM = "You are a concise assistant used to record API test fixtures.";

export const PROMPTS = {
  text: "Reply with exactly: Hello from the fixture.",
  count: "Count from 1 to 60, separated by spaces. Output only the numbers.",
  tool: "What is the weather in Lahore right now? Use the get_weather tool.",
  parallel:
    "What is the weather in Lahore and in Karachi right now? Call get_weather once for each city.",
  structured: "Name one large city in Pakistan and its approximate population.",
  reasoning:
    "A bat and a ball cost 1.10 in total. The bat costs 1.00 more than the ball. How much does the ball cost? Answer with just the amount.",
  reasoningTool:
    "Decide which city to check, then call get_weather for Lahore and tell me whether I need an umbrella.",
} as const;

export const CITY_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { name: { type: "string" }, population: { type: "integer" } },
  required: ["name", "population"],
  additionalProperties: false,
};

const WEATHER = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
};

export const TOOL_RESULT: string = JSON.stringify({
  city: "Lahore",
  temperature_c: 31,
  conditions: "sunny",
});

// TODO: confirm per provider: set just above the context window of the model chosen for
// error-context in models.ts. One word of filler is about one token.
const CONTEXT_WORDS: Record<Provider, number> = {
  openai: 1_200_000,
  anthropic: 1_200_000,
  deepseek: 1_200_000,
  qwen: 1_200_000,
};
const filler = (provider: Provider): string => "fixture ".repeat(CONTEXT_WORDS[provider]);

type Builder = (input: BuildInput) => PlannedCall;
const call = (params: unknown, extra: Omit<PlannedCall, "params"> = {}): PlannedCall => ({
  params,
  ...extra,
});
const one = (id: string, api: CaseSpec["api"], build: Builder): CaseSpec => ({
  id,
  api,
  turns: 1,
  build,
});
const two = (id: string, api: CaseSpec["api"], build: Builder): CaseSpec => ({
  id,
  api,
  turns: 2,
  build,
});
const first = (previous: readonly FixtureCall[]): unknown[] => previous[0]?.chunks ?? [];
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

// ---------- OpenAI, Responses API ----------

type ResponseParams = OpenAI.Responses.ResponseCreateParamsStreaming;
type InputItem = OpenAI.Responses.ResponseInputItem;
const OPENAI_TOOL = {
  type: "function",
  name: WEATHER.name,
  description: WEATHER.description,
  parameters: WEATHER.parameters,
  strict: true,
} satisfies OpenAI.Responses.FunctionTool;
const REASONING = { effort: "low", summary: "auto" } satisfies OpenAI.Reasoning;
const ENCRYPTED: OpenAI.Responses.ResponseIncludable[] = ["reasoning.encrypted_content"];

const responses = (model: string, prompt: string, extra: Partial<ResponseParams> = {}) =>
  ({
    model,
    instructions: SYSTEM,
    input: [{ role: "user", content: prompt }],
    stream: true,
    store: false,
    // Random padding on every delta; off, so fixtures hold only what adapters read.
    stream_options: { include_obfuscation: false },
    ...extra,
  }) satisfies ResponseParams;

/** The output items of turn 1's `response.completed` event. */
function responseOutput(chunks: readonly unknown[]): Record<string, unknown>[] {
  const completed = chunks.map(record).find((c) => c.type === "response.completed");
  const output = record(completed?.response).output;
  return Array.isArray(output) ? output.map(record) : [];
}

function functionCallOutput(output: Record<string, unknown>[]): InputItem {
  const fn = output.find((item) => item.type === "function_call");
  if (fn === undefined) throw new Error("turn 1 recorded no function_call to answer");
  return { type: "function_call_output", call_id: String(fn.call_id), output: TOOL_RESULT };
}

function openaiCases(): CaseSpec[] {
  const api = "responses";
  return [
    one("text", api, ({ model }) => call(responses(model, PROMPTS.text))),
    one("stream-long", api, ({ model }) => call(responses(model, PROMPTS.count))),
    one("length", api, ({ model }) =>
      call(responses(model, PROMPTS.count, { max_output_tokens: 16 })),
    ),
    two("tool-round-trip", api, ({ model, turn, previous }) => {
      if (turn === 0) {
        return call(
          responses(model, PROMPTS.tool, {
            tools: [OPENAI_TOOL],
            tool_choice: { type: "function", name: WEATHER.name },
          }),
        );
      }
      const output = responseOutput(first(previous));
      const calls = output.filter(
        (item) => item.type === "function_call",
      ) as unknown as InputItem[];
      return call(
        responses(model, PROMPTS.tool, {
          tools: [OPENAI_TOOL],
          input: [{ role: "user", content: PROMPTS.tool }, ...calls, functionCallOutput(output)],
        }),
      );
    }),
    one("tool-parallel", api, ({ model }) =>
      call(
        responses(model, PROMPTS.parallel, {
          tools: [OPENAI_TOOL],
          tool_choice: "required",
          parallel_tool_calls: true,
        }),
      ),
    ),
    one("structured", api, ({ model }) =>
      call(
        responses(model, PROMPTS.structured, {
          text: {
            format: { type: "json_schema", name: "city", schema: CITY_SCHEMA, strict: true },
          },
        }),
      ),
    ),
    one("reasoning", api, ({ model }) =>
      call(responses(model, PROMPTS.reasoning, { reasoning: REASONING, include: ENCRYPTED })),
    ),
    two("reasoning-tool-round-trip", api, ({ model, turn, previous }) => {
      const base = { reasoning: REASONING, include: ENCRYPTED, tools: [OPENAI_TOOL] };
      if (turn === 0) {
        return call(
          responses(model, PROMPTS.reasoningTool, {
            ...base,
            tool_choice: { type: "function", name: WEATHER.name },
          }),
        );
      }
      // Every output item goes back, reasoning items with their encrypted content included.
      const output = responseOutput(first(previous));
      return call(
        responses(model, PROMPTS.reasoningTool, {
          ...base,
          input: [
            { role: "user", content: PROMPTS.reasoningTool },
            ...(output as unknown as InputItem[]),
            functionCallOutput(output),
          ],
        }),
      );
    }),
    one("abort", api, ({ model }) =>
      call(responses(model, PROMPTS.count), { abortAfterChunks: 3 }),
    ),
    one("error-auth", api, ({ model }) =>
      call(responses(model, PROMPTS.text), { invalidKey: true }),
    ),
    one("error-model", api, () => call(responses(MISSING_MODEL, PROMPTS.text))),
    one("error-param", api, ({ model }) =>
      call(responses(model, PROMPTS.text, { max_output_tokens: 0 })),
    ),
    one("error-timeout", api, ({ model }) =>
      call(responses(model, PROMPTS.text), { timeoutMs: 1 }),
    ),
    one("error-context", api, ({ model }) => call(responses(model, filler("openai")))),
  ];
}

// ---------- Anthropic, Messages API ----------

type MessageParams = Anthropic.MessageCreateParamsStreaming;
const ANTHROPIC_TOOL = {
  name: WEATHER.name,
  description: WEATHER.description,
  input_schema: { ...WEATHER.parameters, type: "object" as const },
} satisfies Anthropic.Tool;
// Current models reject thinking.type "enabled" with budget_tokens: adaptive thinking, steered by
// output_config.effort. "summarized" so the fixture carries reasoning text and not only signatures;
// "high" so the model is likely to think on these small prompts at all.
const THINKING = {
  type: "adaptive",
  display: "summarized",
} satisfies Anthropic.ThinkingConfigParam;
const EFFORT = { effort: "high" } satisfies Anthropic.OutputConfig;

const messages = (model: string, prompt: string, extra: Partial<MessageParams> = {}) =>
  ({
    model,
    max_tokens: 512,
    system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
    stream: true,
    ...extra,
  }) satisfies MessageParams;

/** Rebuilds turn 1's content blocks from its stream events, as request-side block params. */
export function anthropicBlocks(chunks: readonly unknown[]): Anthropic.ContentBlockParam[] {
  const blocks: Record<string, unknown>[] = [];
  const json: string[] = [];
  for (const chunk of chunks.map(record)) {
    const index = Number(chunk.index);
    if (chunk.type === "content_block_start") {
      blocks[index] = { ...record(chunk.content_block) };
      json[index] = "";
    } else if (chunk.type === "content_block_delta") {
      const block = blocks[index];
      const delta = record(chunk.delta);
      if (block === undefined) continue;
      if (delta.type === "text_delta") block.text = `${block.text ?? ""}${delta.text}`;
      if (delta.type === "thinking_delta")
        block.thinking = `${block.thinking ?? ""}${delta.thinking}`;
      if (delta.type === "signature_delta") block.signature = delta.signature;
      if (delta.type === "input_json_delta")
        json[index] = `${json[index] ?? ""}${delta.partial_json}`;
    } else if (chunk.type === "content_block_stop") {
      const block = blocks[index];
      if (block?.type === "tool_use" && json[index] !== "")
        block.input = JSON.parse(json[index] ?? "{}");
    }
  }
  // An empty text block can't be sent back, so it is dropped.
  const kept = blocks.filter(
    (b) => b !== undefined && !(b.type === "text" && (b.text ?? "") === ""),
  );
  return kept.map((block) => {
    switch (block.type) {
      case "text":
        return { type: "text", text: String(block.text) };
      case "thinking":
        return {
          type: "thinking",
          thinking: String(block.thinking),
          signature: String(block.signature),
        };
      case "redacted_thinking":
        return { type: "redacted_thinking", data: String(block.data) };
      case "tool_use":
        return {
          type: "tool_use",
          id: String(block.id),
          name: String(block.name),
          input: block.input,
        };
      default:
        throw new Error(`turn 1 recorded an unexpected ${String(block.type)} block`);
    }
  });
}

function anthropicTurn2(
  model: string,
  prompt: string,
  previous: readonly FixtureCall[],
  extra: Partial<MessageParams>,
) {
  const blocks = anthropicBlocks(first(previous));
  const use = blocks.find((b) => b.type === "tool_use");
  if (use === undefined) throw new Error("turn 1 recorded no tool_use to answer");
  return messages(model, prompt, {
    ...extra,
    messages: [
      { role: "user", content: prompt },
      { role: "assistant", content: blocks },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: (use as { id: string }).id, content: TOOL_RESULT },
        ],
      },
    ],
  });
}

function anthropicCases(): CaseSpec[] {
  const api = "messages";
  const forced = { type: "tool" as const, name: WEATHER.name };
  return [
    one("text", api, ({ model }) => call(messages(model, PROMPTS.text))),
    one("stream-long", api, ({ model }) => call(messages(model, PROMPTS.count))),
    one("length", api, ({ model }) => call(messages(model, PROMPTS.count, { max_tokens: 16 }))),
    two("tool-round-trip", api, ({ model, turn, previous }) =>
      turn === 0
        ? call(messages(model, PROMPTS.tool, { tools: [ANTHROPIC_TOOL], tool_choice: forced }))
        : call(anthropicTurn2(model, PROMPTS.tool, previous, { tools: [ANTHROPIC_TOOL] })),
    ),
    one("tool-parallel", api, ({ model }) =>
      call(
        messages(model, PROMPTS.parallel, {
          tools: [ANTHROPIC_TOOL],
          tool_choice: { type: "any" },
        }),
      ),
    ),
    one("structured", api, ({ model }) =>
      call(
        messages(model, PROMPTS.structured, {
          output_config: { format: { type: "json_schema", schema: CITY_SCHEMA } },
        }),
      ),
    ),
    one("reasoning", api, ({ model }) =>
      call(
        messages(model, PROMPTS.reasoning, {
          max_tokens: 4096,
          thinking: THINKING,
          output_config: EFFORT,
        }),
      ),
    ),
    // A forced tool returns no thinking block, so the prompt asks for the tool instead.
    two("reasoning-tool-round-trip", api, ({ model, turn, previous }) => {
      const extra = {
        max_tokens: 4096,
        thinking: THINKING,
        output_config: EFFORT,
        tools: [ANTHROPIC_TOOL],
        tool_choice: { type: "auto" as const },
      };
      return turn === 0
        ? call(messages(model, PROMPTS.reasoningTool, extra))
        : call(anthropicTurn2(model, PROMPTS.reasoningTool, previous, extra));
    }),
    one("abort", api, ({ model }) => call(messages(model, PROMPTS.count), { abortAfterChunks: 3 })),
    one("error-auth", api, ({ model }) =>
      call(messages(model, PROMPTS.text), { invalidKey: true }),
    ),
    one("error-model", api, () => call(messages(MISSING_MODEL, PROMPTS.text))),
    one("error-param", api, ({ model }) => call(messages(model, PROMPTS.text, { max_tokens: 0 }))),
    one("error-timeout", api, ({ model }) => call(messages(model, PROMPTS.text), { timeoutMs: 1 })),
    one("error-context", api, ({ model }) => call(messages(model, filler("anthropic")))),
  ];
}

// ---------- DeepSeek and Qwen, Chat Completions ----------

type ChatParams = OpenAI.Chat.ChatCompletionCreateParamsStreaming;
type ChatMessage = Record<string, unknown>;
const CHAT_TOOL = { type: "function", function: WEATHER } satisfies OpenAI.Chat.ChatCompletionTool;

/** Turn 1's assistant message, rebuilt from its chunks. */
export function chatAssistant(chunks: readonly unknown[], withReasoning: boolean): ChatMessage {
  let content = "";
  let reasoning = "";
  const calls: { id: string; type: "function"; function: { name: string; arguments: string } }[] =
    [];
  for (const chunk of chunks.map(record)) {
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices.map(record)) {
      const delta = record(choice.delta);
      if (typeof delta.content === "string") content += delta.content;
      if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
      const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const tc of toolCalls.map(record)) {
        const index = Number(tc.index);
        const fn = record(tc.function);
        calls[index] ??= { id: "", type: "function", function: { name: "", arguments: "" } };
        const target = calls[index];
        // Continuation chunks may repeat the id and name, or send them as "": empty values never win.
        if (typeof tc.id === "string" && tc.id !== "") target.id = tc.id;
        if (typeof fn.name === "string" && fn.name !== "" && target.function.name === "") {
          target.function.name = fn.name;
        }
        if (typeof fn.arguments === "string") target.function.arguments += fn.arguments;
      }
    }
  }
  const message: ChatMessage = { role: "assistant", content: content === "" ? null : content };
  if (withReasoning) message.reasoning_content = reasoning;
  if (calls.length > 0) message.tool_calls = calls.filter(Boolean);
  return message;
}

interface ChatFlavour {
  provider: "deepseek" | "qwen";
  thinkingOff: Record<string, unknown>;
  thinkingOn: Record<string, unknown>;
  /** Extra settings for the reasoning round trip. */
  roundTrip: Record<string, unknown>;
  parallel: Record<string, unknown>;
  structured: (prompt: string) => { prompt: string; params: Record<string, unknown> };
}

const DEEPSEEK: ChatFlavour = {
  provider: "deepseek",
  thinkingOff: { thinking: { type: "disabled" } },
  thinkingOn: { thinking: { type: "enabled" } },
  roundTrip: {},
  parallel: {},
  // No json_schema on DeepSeek: JSON mode, with the schema in the prompt.
  structured: (prompt) => ({
    prompt: `${prompt} Reply only with JSON matching this JSON Schema: ${JSON.stringify(CITY_SCHEMA)}`,
    params: { response_format: { type: "json_object" } },
  }),
};

const QWEN: ChatFlavour = {
  provider: "qwen",
  thinkingOff: { enable_thinking: false },
  thinkingOn: { enable_thinking: true },
  roundTrip: { preserve_thinking: true },
  parallel: { parallel_tool_calls: true },
  structured: (prompt) => ({
    prompt,
    params: {
      response_format: {
        type: "json_schema",
        json_schema: { name: "city", schema: CITY_SCHEMA, strict: true },
      },
    },
  }),
};

function chatCases(f: ChatFlavour): CaseSpec[] {
  const api = "chat.completions";
  const chat = (
    model: string,
    prompt: string,
    extra: Record<string, unknown> = {},
    history?: ChatMessage[],
  ) =>
    ({
      model,
      messages: (history ?? [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ]) as unknown as ChatParams["messages"],
      stream: true,
      stream_options: { include_usage: true },
      ...f.thinkingOff,
      ...extra,
    }) satisfies ChatParams;

  const turn2 = (
    model: string,
    prompt: string,
    previous: readonly FixtureCall[],
    reasoning: boolean,
    extra: Record<string, unknown>,
  ) => {
    const assistant = chatAssistant(first(previous), reasoning);
    const calls = assistant.tool_calls as { id: string }[] | undefined;
    if (calls === undefined || calls.length === 0)
      throw new Error("turn 1 recorded no tool call to answer");
    return chat(model, prompt, extra, [
      { role: "system", content: SYSTEM },
      { role: "user", content: prompt },
      assistant,
      ...calls.map((c) => ({ role: "tool", tool_call_id: c.id, content: TOOL_RESULT })),
    ]);
  };

  const forced = { type: "function", function: { name: WEATHER.name } };
  const roundTrip = (id: string, keepReasoning: boolean) =>
    two(id, api, ({ model, turn, previous }) => {
      const extra = { ...f.thinkingOn, ...f.roundTrip, tools: [CHAT_TOOL], tool_choice: "auto" };
      return turn === 0
        ? call(chat(model, PROMPTS.reasoningTool, extra))
        : call(turn2(model, PROMPTS.reasoningTool, previous, keepReasoning, extra));
    });

  const cases = [
    one("text", api, ({ model }) => call(chat(model, PROMPTS.text))),
    one("stream-long", api, ({ model }) => call(chat(model, PROMPTS.count))),
    one("length", api, ({ model }) => call(chat(model, PROMPTS.count, { max_tokens: 16 }))),
    two("tool-round-trip", api, ({ model, turn, previous }) =>
      turn === 0
        ? call(chat(model, PROMPTS.tool, { tools: [CHAT_TOOL], tool_choice: forced }))
        : call(turn2(model, PROMPTS.tool, previous, false, { tools: [CHAT_TOOL] })),
    ),
    one("tool-parallel", api, ({ model }) =>
      call(
        chat(model, PROMPTS.parallel, {
          tools: [CHAT_TOOL],
          tool_choice: "required",
          ...f.parallel,
        }),
      ),
    ),
    one("structured", api, ({ model }) => {
      const s = f.structured(PROMPTS.structured);
      return call(chat(model, s.prompt, s.params));
    }),
    one("reasoning", api, ({ model }) => call(chat(model, PROMPTS.reasoning, f.thinkingOn))),
    roundTrip("reasoning-tool-round-trip", true),
    one("abort", api, ({ model }) => call(chat(model, PROMPTS.count), { abortAfterChunks: 3 })),
    one("error-auth", api, ({ model }) => call(chat(model, PROMPTS.text), { invalidKey: true })),
    one("error-model", api, () => call(chat(MISSING_MODEL, PROMPTS.text))),
    one("error-param", api, ({ model }) => call(chat(model, PROMPTS.text, { max_tokens: 0 }))),
    one("error-timeout", api, ({ model }) => call(chat(model, PROMPTS.text), { timeoutMs: 1 })),
    one("error-context", api, ({ model }) => call(chat(model, filler(f.provider)))),
  ];
  // DeepSeek's docs say a tool turn without its reasoning_content is a 400. The 2026-11-17
  // recording completed instead, so this case shows what happens when the reasoning is dropped.
  if (f.provider === "deepseek") cases.push(roundTrip("error-reasoning-missing", false));
  return cases;
}

export function casesFor(provider: Provider): CaseSpec[] {
  switch (provider) {
    case "openai":
      return openaiCases();
    case "anthropic":
      return anthropicCases();
    case "deepseek":
      return chatCases(DEEPSEEK);
    case "qwen":
      return chatCases(QWEN);
  }
}
