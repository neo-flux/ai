import { describe, expect, test } from "bun:test";
import { type Adapter, defineProvider, type ModelRequest } from "../../src/adapter.ts";
import { toMessagesParams } from "../../src/anthropic/request.ts";
import { isAIError } from "../../src/errors.ts";
import type { AssistantMessage, Message, UserMessage } from "../../src/messages.ts";

const adapter: Adapter = {
  provider: "anthropic",
  // biome-ignore lint/correctness/useYield: never streamed here
  async *stream() {
    throw new Error("unused");
  },
};
const model = (options?: unknown) => defineProvider(adapter)("claude-x", options);
const params = (request: ModelRequest, options?: unknown) =>
  toMessagesParams(request, model(options));
const q: Message = { role: "user", content: "q" };
const base = { model: "claude-x", max_tokens: 4096, stream: true };
const invalid = (fn: () => unknown) => {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(isAIError(thrown)).toBe(true);
  expect(thrown).toMatchObject({ code: "invalid_request", provider: "anthropic" });
};
const user = (content: UserMessage["content"]): Message => ({ role: "user", content });
const asst = (content: AssistantMessage["content"]): Message => ({ role: "assistant", content });

describe("toMessagesParams: messages", () => {
  test("system messages become system, joined by a blank line", () => {
    expect(
      params({ messages: [{ role: "system", content: "a" }, { role: "system", content: "b" }, q] }),
    ).toEqual({
      ...base,
      system: "a\n\nb",
      messages: [{ role: "user", content: "q" }],
    });
    expect("system" in params({ messages: [q] })).toBe(false);
  });

  test("user parts: text, images from bytes and data URLs, PDF and text documents", () => {
    const out = params({
      messages: [
        user([
          { type: "text", text: "see" },
          { type: "image", data: "data:image/png;base64,AAAA" },
          { type: "image", data: new Uint8Array([104, 105]), mediaType: "image/webp" },
          {
            type: "file",
            data: new Uint8Array([104, 105]),
            mediaType: "application/pdf",
            filename: "a.pdf",
          },
          { type: "file", data: new TextEncoder().encode("héllo"), mediaType: "text/plain" },
        ]),
      ],
    });
    expect(out.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "see" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          { type: "image", source: { type: "base64", media_type: "image/webp", data: "aGk=" } },
          {
            type: "document",
            source: { type: "base64", media_type: "application/pdf", data: "aGk=" },
            title: "a.pdf",
          },
          { type: "document", source: { type: "text", media_type: "text/plain", data: "héllo" } },
        ],
      },
    ]);
  });

  test("unsupported images and files are rejected before sending", () => {
    invalid(() =>
      params({
        messages: [user([{ type: "image", data: new Uint8Array([1]), mediaType: "image/bmp" }])],
      }),
    );
    invalid(() => params({ messages: [user([{ type: "image", data: new Uint8Array([1]) }])] }));
    invalid(() =>
      params({ messages: [user([{ type: "image", data: "data:image/png,notbase64" }])] }),
    );
    invalid(() =>
      params({ messages: [user([{ type: "image", data: "data:image/svg+xml;base64,AA" }])] }),
    );
    invalid(() =>
      params({
        messages: [
          user([{ type: "file", data: new Uint8Array([1]), mediaType: "application/zip" }]),
        ],
      }),
    );
  });

  test("assistant parts: text, own thinking and redacted thinking, tool use", () => {
    const out = params({
      messages: [
        q,
        asst([
          {
            type: "reasoning",
            text: "think",
            providerMetadata: { anthropic: { signature: "sig" } },
          },
          { type: "reasoning", text: "", providerMetadata: { anthropic: { redacted: "blob" } } },
          { type: "text", text: "a" },
          { type: "tool-call", id: "toolu_1", name: "f", input: { x: 1 } },
          { type: "tool-call", id: "toolu_2", name: "g", input: '{"y":2}' },
          { type: "tool-call", id: "toolu_3", name: "h", input: "{bad" },
        ]),
        { role: "tool", toolCallId: "toolu_1", toolName: "f", content: "r1" },
        { role: "tool", toolCallId: "toolu_2", toolName: "g", content: "r2", isError: true },
        { role: "tool", toolCallId: "toolu_3", toolName: "h", content: "r3" },
      ],
    });
    expect(out.messages).toEqual([
      { role: "user", content: "q" },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "think", signature: "sig" },
          { type: "redacted_thinking", data: "blob" },
          { type: "text", text: "a" },
          { type: "tool_use", id: "toolu_1", name: "f", input: { x: 1 } },
          { type: "tool_use", id: "toolu_2", name: "g", input: { y: 2 } },
          { type: "tool_use", id: "toolu_3", name: "h", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "r1" },
          { type: "tool_result", tool_use_id: "toolu_2", content: "r2", is_error: true },
          { type: "tool_result", tool_use_id: "toolu_3", content: "r3" },
        ],
      },
    ]);
  });

  test("reasoning from other providers, or with malformed metadata, is dropped", () => {
    const out = params({
      messages: [
        q,
        asst([
          { type: "reasoning", text: "theirs", providerMetadata: { openai: { item: {} } } },
          { type: "reasoning", text: "none" },
          { type: "reasoning", text: "bad", providerMetadata: { anthropic: { signature: 5 } } },
          {
            type: "reasoning",
            text: "x",
            providerMetadata: Object.create({ anthropic: { signature: "s" } }),
          },
          { type: "text", text: "t" },
        ]),
      ],
    });
    expect((out.messages as unknown[])[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "t" }],
    });
  });

  test("an assistant string is sent as is; an empty assistant message is skipped", () => {
    const out = params({ messages: [q, asst("plain"), q, asst(""), asst([]), q] });
    expect(out.messages).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "plain" },
      { role: "user", content: "q" },
      { role: "user", content: "q" },
    ]);
  });

  test("tool results split by another message become separate user messages", () => {
    const out = params({
      messages: [
        q,
        asst([{ type: "tool-call", id: "a", name: "f", input: {} }]),
        { role: "tool", toolCallId: "a", toolName: "f", content: "r" },
        q,
      ],
    });
    expect((out.messages as unknown[]).slice(2)).toEqual([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "r" }] },
      { role: "user", content: "q" },
    ]);
  });
});

describe("toMessagesParams: tools, output and options", () => {
  const schema = { $schema: "x", type: "object", properties: { city: { type: "string" } } };

  test("tools", () => {
    expect(
      params({
        messages: [q],
        tools: [
          { name: "f", description: "does f", inputSchema: schema },
          { name: "g", description: undefined, inputSchema: { type: "object" } },
        ],
      }).tools,
    ).toEqual([
      {
        name: "f",
        description: "does f",
        input_schema: { type: "object", properties: schema.properties },
      },
      { name: "g", input_schema: { type: "object" } },
    ]);
    expect("tools" in params({ messages: [q], tools: [] })).toBe(false);
  });

  test("tool choice", () => {
    const choice = (toolChoice: ModelRequest["toolChoice"]) =>
      params({ messages: [q], toolChoice }).tool_choice;
    expect(choice("auto")).toEqual({ type: "auto" });
    expect(choice("required")).toEqual({ type: "any" });
    expect(choice("none")).toEqual({ type: "none" });
    expect(choice({ name: "f" })).toEqual({ type: "tool", name: "f" });
  });

  test("structured output and effort share output_config", () => {
    const out = params({ messages: [q], output: { name: "output", schema } }, { effort: "high" });
    expect(out.output_config).toEqual({
      effort: "high",
      format: { type: "json_schema", schema: { type: "object", properties: schema.properties } },
    });
    expect(params({ messages: [q] }, { effort: "low" }).output_config).toEqual({ effort: "low" });
    expect("output_config" in params({ messages: [q] })).toBe(false);
  });

  test("thinking is passed through as given", () => {
    const thinking = { type: "adaptive", display: "summarized" };
    expect(params({ messages: [q] }, { thinking }).thinking).toEqual(thinking);
    expect(
      params({ messages: [q] }, { thinking: { type: "enabled", budget_tokens: 1024 } }).thinking,
    ).toEqual({
      type: "enabled",
      budget_tokens: 1024,
    });
  });

  test("max_tokens: request, then the option, then 4096", () => {
    expect(params({ messages: [q], maxOutputTokens: 16 }, { maxTokens: 99 }).max_tokens).toBe(16);
    expect(params({ messages: [q] }, { maxTokens: 99 }).max_tokens).toBe(99);
    expect(params({ messages: [q] }).max_tokens).toBe(4096);
  });

  test("temperature", () => {
    expect(params({ messages: [q], temperature: 0 }).temperature).toBe(0);
  });

  test("call options win; typed options win over body; body may not set derived keys", () => {
    const out = params(
      { messages: [q], providerOptions: { anthropic: { effort: "max", body: { top_k: 5 } } } },
      {
        effort: "low",
        body: { top_k: 1, thinking: { type: "disabled" }, metadata: { user_id: "u" } },
      },
    );
    expect(out).toMatchObject({
      output_config: { effort: "max" },
      top_k: 5,
      thinking: { type: "disabled" },
    });
    expect(
      params(
        { messages: [q] },
        { thinking: { type: "adaptive" }, body: { thinking: { type: "disabled" } } },
      ).thinking,
    ).toEqual({
      type: "adaptive",
    });
    for (const key of [
      "model",
      "messages",
      "system",
      "stream",
      "tools",
      "tool_choice",
      "max_tokens",
      "temperature",
      "output_config",
    ]) {
      invalid(() => params({ messages: [q] }, { body: { [key]: 1 } }));
    }
  });

  test("undefined values and __proto__ body keys are not written", () => {
    const body = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}');
    body.gone = undefined;
    const out = params({ messages: [q] }, { body });
    expect(Object.hasOwn(out, "gone")).toBe(false);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(params({ messages: [q], tools: undefined, temperature: undefined })).toEqual({
      ...base,
      messages: [{ role: "user", content: "q" }],
    });
  });
});

describe("toMessagesParams: mutation follow-ups", () => {
  test("tool input that parses to a non-object is sent as {}", () => {
    const out = params({
      messages: [
        q,
        asst([{ type: "tool-call", id: "a", name: "f", input: "[1,2]" }]),
        { role: "tool", toolCallId: "a", toolName: "f", content: "r" },
      ],
    });
    const blocks = (out.messages as { content: { input?: unknown }[] }[])[1]?.content ?? [];
    expect(blocks[0]?.input).toEqual({});
  });

  test("a later tool group starts a new user message", () => {
    const out = params({
      messages: [
        q,
        asst([{ type: "tool-call", id: "a", name: "f", input: {} }]),
        { role: "tool", toolCallId: "a", toolName: "f", content: "r1" },
        asst([{ type: "tool-call", id: "b", name: "f", input: {} }]),
        { role: "tool", toolCallId: "b", toolName: "f", content: "r2" },
      ],
    });
    expect((out.messages as unknown[]).slice(2)).toEqual([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "r1" }] },
      { role: "assistant", content: [{ type: "tool_use", id: "b", name: "f", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: "r2" }] },
    ]);
  });
});

describe("toMessagesParams: audit follow-ups", () => {
  test("non-object tool inputs are sent as {}", () => {
    for (const input of [[1, 2], 3, null, undefined]) {
      const out = params({
        messages: [
          q,
          asst([{ type: "tool-call", id: "a", name: "f", input }]),
          { role: "tool", toolCallId: "a", toolName: "f", content: "r" },
        ],
      });
      const blocks = (out.messages as { content: { input?: unknown }[] }[])[1]?.content ?? [];
      expect(blocks[0]?.input).toEqual({});
    }
  });

  test("a base64 data URL wrapped over lines is accepted", () => {
    const out = params({
      messages: [user([{ type: "image", data: "data:image/png;base64,AAAA\nBBBB" }])],
    });
    const blocks =
      (out.messages as { content: { source?: { data: string } }[] }[])[0]?.content ?? [];
    expect(blocks[0]?.source?.data).toBe("AAAA\nBBBB");
  });

  test("a system message between tool results ends the group", () => {
    const out = params({
      messages: [
        q,
        asst([
          { type: "tool-call", id: "a", name: "f", input: {} },
          { type: "tool-call", id: "b", name: "f", input: {} },
        ]),
        { role: "tool", toolCallId: "a", toolName: "f", content: "r1" },
        { role: "system", content: "s" },
        { role: "tool", toolCallId: "b", toolName: "f", content: "r2" },
      ],
    });
    expect((out.messages as unknown[]).slice(2)).toEqual([
      { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "r1" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "b", content: "r2" }] },
    ]);
  });

  test("a text document keeps its filename as the title", () => {
    const out = params({
      messages: [
        user([
          {
            type: "file",
            data: new TextEncoder().encode("x"),
            mediaType: "text/plain",
            filename: "a.txt",
          },
        ]),
      ],
    });
    expect(
      ((out.messages as { content: Record<string, unknown>[] }[])[0]?.content ?? [])[0]?.title,
    ).toBe("a.txt");
  });

  test("body merges key by key across model and call options", () => {
    const out = params(
      { messages: [q], providerOptions: { anthropic: { body: { top_k: 5 } } } },
      { body: { top_k: 1, metadata: { user_id: "u" } } },
    );
    expect(out).toEqual({
      ...base,
      messages: [{ role: "user", content: "q" }],
      top_k: 5,
      metadata: { user_id: "u" },
    });
  });
});

describe("toMessagesParams: security review follow-ups", () => {
  test("null provider metadata is treated as none", () => {
    const out = params({
      messages: [
        q,
        asst([
          { type: "reasoning", text: "r", providerMetadata: null as never },
          { type: "text", text: "t" },
        ]),
      ],
    });
    expect((out.messages as unknown[])[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "t" }],
    });
  });

  test("a data URL must agree with mediaType and carry base64", () => {
    invalid(() =>
      params({
        messages: [
          user([{ type: "image", data: "data:image/png;base64,AAAA", mediaType: "image/gif" }]),
        ],
      }),
    );
    invalid(() =>
      params({ messages: [user([{ type: "image", data: "data:image/png;base64,<script>" }])] }),
    );
    expect(
      ((
        params({
          messages: [
            user([{ type: "image", data: "data:image/png;base64,AA==", mediaType: "image/png" }]),
          ],
        }).messages as { content: { source?: { data: string } }[] }[]
      )[0]?.content ?? [])[0]?.source?.data,
    ).toBe("AA==");
  });

  test("a non-string filename is not sent as the title", () => {
    const out = params({
      messages: [
        user([
          {
            type: "file",
            data: new Uint8Array([1]),
            mediaType: "application/pdf",
            filename: {} as never,
          },
        ]),
      ],
    });
    expect(
      "title" in
        (((out.messages as { content: Record<string, unknown>[] }[])[0]?.content ?? [])[0] ?? {}),
    ).toBe(false);
  });
});
