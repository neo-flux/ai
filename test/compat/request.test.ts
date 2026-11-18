import { describe, expect, test } from "bun:test";
import { type Adapter, defineProvider, type ModelRequest } from "../../src/adapter.ts";
import { resolveQuirks } from "../../src/compat/quirks.ts";
import { toChatParams } from "../../src/compat/request.ts";
import { isAIError } from "../../src/errors.ts";
import type { AssistantMessage, Message, UserMessage } from "../../src/messages.ts";

const adapter: Adapter = {
  provider: "acme",
  // biome-ignore lint/correctness/useYield: never streamed in these tests
  async *stream() {
    throw new Error("unused");
  },
};
const model = (options?: unknown) => defineProvider(adapter)("m-1", options);
const user = (content: UserMessage["content"]): Message => ({ role: "user", content });
const base = { model: "m-1", stream: true, stream_options: { include_usage: true } };
const params = (request: ModelRequest, quirks = {}, options?: unknown) =>
  toChatParams(request, model(options), resolveQuirks(quirks), "acme");
const invalid = (fn: () => unknown) => {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(isAIError(thrown)).toBe(true);
  expect(thrown).toMatchObject({ code: "invalid_request", provider: "acme" });
};

describe("toChatParams: messages", () => {
  test("system and string user messages", () => {
    const out = params({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
    });
    expect(out).toEqual({
      ...base,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
      ],
    });
  });

  test("user parts: text, data URL image, image bytes", () => {
    const out = params({
      messages: [
        user([
          { type: "text", text: "look" },
          { type: "image", data: "data:image/png;base64,AAAA" },
          { type: "image", data: new Uint8Array([104, 105]), mediaType: "image/gif" },
        ]),
      ],
    });
    expect(out.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
          { type: "image_url", image_url: { url: "data:image/gif;base64,aGk=" } },
        ],
      },
    ]);
  });

  test("large image bytes are encoded in full", () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 256);
    const out = params({
      messages: [user([{ type: "image", data: bytes, mediaType: "image/png" }])],
    });
    const url = (out.messages as { content: { image_url: { url: string } }[] }[])[0]?.content[0]
      ?.image_url.url as string;
    const decoded = Uint8Array.from(atob(url.slice("data:image/png;base64,".length)), (c) =>
      c.charCodeAt(0),
    );
    expect(decoded).toEqual(bytes);
  });

  test("image bytes without a media type and file parts are rejected", () => {
    invalid(() => params({ messages: [user([{ type: "image", data: new Uint8Array([1]) }])] }));
    invalid(() =>
      params({
        messages: [
          user([{ type: "file", data: new Uint8Array([1]), mediaType: "application/pdf" }]),
        ],
      }),
    );
  });

  test("assistant text, tool calls and tool results", () => {
    const out = params({
      messages: [
        user("q"),
        {
          role: "assistant",
          content: [
            { type: "text", text: "a" },
            { type: "text", text: "b" },
            { type: "tool-call", id: "c1", name: "f", input: { x: 1 } },
            { type: "tool-call", id: "c2", name: "g", input: "{not json" },
          ],
        },
        { role: "tool", toolCallId: "c1", toolName: "f", content: "r1", isError: true },
        { role: "tool", toolCallId: "c2", toolName: "g", content: "r2" },
      ],
    });
    expect(out.messages).toEqual([
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: "ab",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "f", arguments: '{"x":1}' } },
          { id: "c2", type: "function", function: { name: "g", arguments: "{not json" } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "r1" },
      { role: "tool", tool_call_id: "c2", content: "r2" },
    ]);
  });

  test("assistant content is null with tool calls and no text, empty without either", () => {
    const out = params({
      messages: [
        user("q"),
        { role: "assistant", content: [{ type: "tool-call", id: "c1", name: "f", input: {} }] },
        { role: "tool", toolCallId: "c1", toolName: "f", content: "r" },
        { role: "assistant", content: [{ type: "reasoning", text: "hmm" }] },
        { role: "assistant", content: "plain" },
      ],
    });
    const messages = out.messages as Record<string, unknown>[];
    expect(messages[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
    });
    expect(messages[3]).toEqual({ role: "assistant", content: "" });
    expect(messages[4]).toEqual({ role: "assistant", content: "plain" });
  });
});

describe("toChatParams: reasoning echo", () => {
  const quirks = { reasoningField: "reasoning_content", echoReasoning: true };
  const own = { acme: { reasoningField: "reasoning_content" } };
  const turn = (content: AssistantMessage["content"]): ModelRequest => ({
    messages: [user("q"), { role: "assistant", content }],
  });
  const assistant = (request: ModelRequest, q: object = quirks) =>
    (params(request, q).messages as Record<string, unknown>[])[1];

  test("own reasoning parts are joined in order into the reasoning field", () => {
    const out = assistant(
      turn([
        { type: "reasoning", text: "one ", providerMetadata: own },
        { type: "text", text: "t" },
        { type: "reasoning", text: "two", providerMetadata: own },
      ]),
    );
    expect(out).toEqual({ role: "assistant", content: "t", reasoning_content: "one two" });
  });

  test("foreign and unmarked reasoning is not echoed, and no key is written", () => {
    const out = assistant(
      turn([
        { type: "reasoning", text: "theirs", providerMetadata: { anthropic: { signature: "s" } } },
        { type: "reasoning", text: "nobody's" },
        { type: "text", text: "t" },
      ]),
    );
    expect(out).toEqual({ role: "assistant", content: "t" });
  });

  test("nothing is echoed when echoReasoning is off", () => {
    const out = assistant(turn([{ type: "reasoning", text: "r", providerMetadata: own }]), {
      reasoningField: "reasoning_content",
    });
    expect(out).toEqual({ role: "assistant", content: "" });
  });

  test("the echo uses the configured field name", () => {
    const out = assistant(
      turn([{ type: "reasoning", text: "r", providerMetadata: { acme: { reasoningField: "x" } } }]),
      { reasoningField: "thoughts", echoReasoning: true },
    );
    expect(out).toEqual({ role: "assistant", content: "", thoughts: "r" });
  });
});

describe("toChatParams: tools, output and options", () => {
  const schema = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { city: { type: "string", $schema: "nested-stays" } },
  };

  test("tools strip only the top-level $schema and omit a missing description", () => {
    const out = params({
      messages: [user("q")],
      tools: [
        { name: "f", description: "does f", inputSchema: schema },
        { name: "g", description: undefined, inputSchema: { type: "object" } },
      ],
    });
    expect(out.tools).toEqual([
      {
        type: "function",
        function: {
          name: "f",
          description: "does f",
          parameters: {
            type: "object",
            properties: { city: { type: "string", $schema: "nested-stays" } },
          },
        },
      },
      { type: "function", function: { name: "g", parameters: { type: "object" } } },
    ]);
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  test("tool choice", () => {
    const choice = (toolChoice: ModelRequest["toolChoice"]) =>
      params({ messages: [user("q")], toolChoice }).tool_choice;
    expect(choice("auto")).toBe("auto");
    expect(choice("none")).toBe("none");
    expect(choice("required")).toBe("required");
    expect(choice({ name: "f" })).toEqual({ type: "function", function: { name: "f" } });
    expect("tool_choice" in params({ messages: [user("q")] })).toBe(false);
  });

  test("json_schema output, with strict only when set", () => {
    const output = { name: "output", schema };
    const plain = params({ messages: [user("q")], output });
    expect(plain.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "output", schema: { type: "object", properties: schema.properties } },
    });
    const strict = params(
      { messages: [user("q")], output },
      {
        structuredOutput: { mode: "json_schema", strict: true },
      },
    );
    expect(
      (strict.response_format as { json_schema: { strict: boolean } }).json_schema.strict,
    ).toBe(true);
  });

  test("json_object output adds the schema instruction after the caller's system messages", () => {
    const out = params(
      {
        messages: [{ role: "system", content: "s1" }, { role: "system", content: "s2" }, user("q")],
        output: { name: "output", schema: { type: "object" } },
      },
      { structuredOutput: { mode: "json_object" } },
    );
    expect(out.response_format).toEqual({ type: "json_object" });
    expect(out.messages).toEqual([
      { role: "system", content: "s1" },
      { role: "system", content: "s2" },
      {
        role: "system",
        content: 'Reply only with JSON matching this JSON Schema: {"type":"object"}',
      },
      { role: "user", content: "q" },
    ]);
  });

  test("max tokens field, temperature, and stream usage", () => {
    const request: ModelRequest = { messages: [user("q")], maxOutputTokens: 16, temperature: 0 };
    expect(params(request)).toMatchObject({ max_tokens: 16, temperature: 0 });
    const other = params(request, { maxTokensField: "max_completion_tokens", streamUsage: false });
    expect(other.max_completion_tokens).toBe(16);
    expect("max_tokens" in other).toBe(false);
    expect("stream_options" in other).toBe(false);
  });

  test("undefined fields are never written", () => {
    const out = params({
      messages: [user("q")],
      tools: undefined,
      toolChoice: undefined,
      output: undefined,
      maxOutputTokens: undefined,
      temperature: undefined,
    });
    expect(out).toEqual({ ...base, messages: [{ role: "user", content: "q" }] });
  });

  test("body fields come from model options, overridden key by key by call options", () => {
    const out = params(
      { messages: [user("q")], providerOptions: { acme: { body: { b: 2, c: 3 } } } },
      {},
      { body: { a: 1, b: 1 } },
    );
    expect(out).toMatchObject({ a: 1, b: 2, c: 3 });
  });

  test("the options quirk maps provider options to body fields", () => {
    const out = params(
      { messages: [user("q")], providerOptions: { acme: { mode: "fast" } } },
      { options: (o: Record<string, unknown>) => ({ speed: o.mode, ...(o.body as object) }) },
      { mode: "slow", body: { extra: true } },
    );
    expect(out).toMatchObject({ speed: "fast", extra: true });
  });

  test("body may not set a field the adapter owns", () => {
    for (const key of [
      "model",
      "messages",
      "stream",
      "stream_options",
      "tools",
      "tool_choice",
      "response_format",
      "max_tokens",
      "max_completion_tokens",
      "temperature",
      "n",
    ]) {
      invalid(() => params({ messages: [user("q")] }, {}, { body: { [key]: 1 } }));
    }
  });

  test("option fields mapped to undefined are not written", () => {
    const out = params({ messages: [user("q")] }, {}, { body: { a: undefined, b: 1 } });
    expect("a" in out).toBe(false);
    expect(out.b).toBe(1);
  });

  test("provider options that aren't objects are rejected", () => {
    invalid(() => params({ messages: [user("q")], providerOptions: { acme: "fast" } }));
    invalid(() => params({ messages: [user("q")] }, {}, { body: "x" }));
  });
});

describe("toChatParams: audit follow-ups", () => {
  test("the default options mapper sends body fields and nothing else", () => {
    const out = params({ messages: [user("q")] }, {}, { body: { top_k: 40 }, other: 1 });
    expect(out).toEqual({ ...base, messages: [{ role: "user", content: "q" }], top_k: 40 });
  });

  test("a __proto__ key in a JSON-parsed body is skipped and can't change the prototype", () => {
    const body = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}');
    const out = params({ messages: [user("q")] }, {}, { body });
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(out.safe).toBe(1);
    expect(Object.hasOwn(out, "__proto__")).toBe(false);
  });

  test("a tool call with undefined input sends {} as its arguments", () => {
    const out = params({
      messages: [
        user("q"),
        {
          role: "assistant",
          content: [{ type: "tool-call", id: "c1", name: "f", input: undefined }],
        },
        { role: "tool", toolCallId: "c1", toolName: "f", content: "r" },
      ],
    });
    const calls = (out.messages as { tool_calls?: { function: { arguments: unknown } }[] }[])[1]
      ?.tool_calls;
    expect(calls?.[0]?.function.arguments).toBe("{}");
  });
});
