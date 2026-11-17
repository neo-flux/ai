import { describe, expect, test } from "bun:test";
import { isAIError } from "../../src/errors.ts";
import { contentParts, type Message, validateMessages } from "../../src/messages.ts";

const bytes = new Uint8Array([1, 2, 3]);

const rejects = (messages: unknown, reason: RegExp) => {
  try {
    validateMessages(messages as Message[]);
  } catch (error) {
    expect(isAIError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("invalid_request");
    expect(String((error as { cause: unknown }).cause)).toMatch(reason);
    return;
  }
  throw new Error(`expected rejection matching ${reason}`);
};

const assistantCall: Message = {
  role: "assistant",
  content: [{ type: "tool-call", id: "call_1", name: "weather", input: { city: "x" } }],
};

describe("validateMessages", () => {
  test("accepts a full conversation", () => {
    expect(() =>
      validateMessages([
        { role: "system", content: "be brief" },
        { role: "system", content: "second system" },
        { role: "user", content: "hi" },
        {
          role: "user",
          content: [
            { type: "text", text: "look" },
            { type: "image", data: bytes, mediaType: "image/png" },
            { type: "image", data: "data:image/png;base64,AAAA" },
            { type: "file", data: bytes, mediaType: "application/pdf", filename: "a.pdf" },
          ],
        },
        { role: "assistant", content: "plain" },
        {
          role: "assistant",
          content: [
            { type: "reasoning", text: "thinking", providerMetadata: { fake: { sig: "s" } } },
            { type: "text", text: "calling" },
            { type: "tool-call", id: "call_1", name: "weather", input: {} },
          ],
        },
        { role: "tool", toolCallId: "call_1", toolName: "weather", content: "sunny" },
        { role: "tool", toolCallId: "call_1", toolName: "weather", content: "x", isError: true },
      ]),
    ).not.toThrow();
  });

  test("rejects an empty or non-array list", () => {
    rejects([], /empty/);
    rejects("hi", /array/);
  });

  test("rejects system messages after any other message", () => {
    rejects(
      [
        { role: "user", content: "hi" },
        { role: "system", content: "late" },
      ],
      /messages\[1\].*system/,
    );
  });

  test("rejects unknown roles and malformed content", () => {
    rejects([{ role: "developer", content: "x" }], /role/);
    rejects([{ role: "system", content: ["x"] }], /content/);
    rejects([{ role: "user", content: [] }], /content/);
    rejects([{ role: "user", content: 3 }], /content/);
    rejects([{ role: "user", content: [{ type: "audio" }] }], /part/);
    rejects([{ role: "user", content: [{ type: "text" }] }], /text/);
    rejects([{ role: "assistant", content: [{ type: "image", data: bytes }] }], /part/);
    rejects([{ role: "assistant", content: [] }], /content/);
  });

  test("images are bytes or data URLs only", () => {
    rejects([{ role: "user", content: [{ type: "image", data: "https://x/a.png" }] }], /data: URL/);
    rejects([{ role: "user", content: [{ type: "image", data: new Uint8Array() }] }], /empty/);
    rejects([{ role: "user", content: [{ type: "image", data: 1 }] }], /image/);
  });

  test("files need non-empty bytes and a media type", () => {
    rejects(
      [{ role: "user", content: [{ type: "file", data: new Uint8Array(), mediaType: "a/b" }] }],
      /empty/,
    );
    rejects(
      [{ role: "user", content: [{ type: "file", data: bytes, mediaType: "" }] }],
      /mediaType/,
    );
    rejects([{ role: "user", content: [{ type: "file", data: "x", mediaType: "a/b" }] }], /bytes/);
  });

  test("tool messages need a toolName, images a non-empty mediaType, assistant text a string", () => {
    rejects(
      [assistantCall, { role: "tool", toolCallId: "call_1", toolName: "", content: "x" }],
      /toolName/,
    );
    rejects(
      [{ role: "user", content: [{ type: "image", data: bytes, mediaType: "" }] }],
      /mediaType/,
    );
    rejects([{ role: "assistant", content: [{ type: "text", text: 1 }] }], /text/);
    rejects([{ role: "assistant", content: [{ type: "reasoning" }] }], /text/);
  });

  test("tool calls need an id and a name", () => {
    rejects(
      [{ role: "assistant", content: [{ type: "tool-call", id: "", name: "n", input: {} }] }],
      /id/,
    );
    rejects(
      [{ role: "assistant", content: [{ type: "tool-call", id: "a", name: "", input: {} }] }],
      /name/,
    );
  });

  test("tool messages must answer an earlier tool call", () => {
    rejects(
      [{ role: "tool", toolCallId: "call_1", toolName: "weather", content: "x" }],
      /messages\[0\].*call_1|unknown tool call/,
    );
    rejects(
      [{ role: "tool", toolCallId: "call_1", toolName: "weather", content: "x" }, assistantCall],
      /unknown tool call/,
    );
    rejects(
      [assistantCall, { role: "tool", toolCallId: "call_1", toolName: "weather", content: 1 }],
      /content/,
    );
  });

  test("the error message itself names no content", () => {
    expect.assertions(2);
    try {
      validateMessages([
        { role: "user", content: "SECRET-CONTENT" },
        { role: "system", content: "x" },
      ]);
    } catch (error) {
      expect((error as Error).message).toBe("invalid_request");
      expect(String((error as { cause: unknown }).cause)).not.toContain("SECRET-CONTENT");
    }
  });
});

describe("contentParts", () => {
  test("wraps a string and passes arrays through", () => {
    expect(contentParts("hi")).toEqual([{ type: "text", text: "hi" }]);
    const parts = [{ type: "text" as const, text: "a" }];
    expect(contentParts(parts)).toBe(parts);
  });
});
