import { describe, expect, test } from "bun:test";
import { FORBIDDEN_FIXTURE_KEYS, findFixtureLeaks, findSecrets } from "../../scripts/guards.ts";
import { scrubFixture, scrubText } from "../../scripts/recorder/scrub.ts";
import { type Fixture, serializeFixture } from "../../src/testing/fixture.ts";

// Built at runtime: the repository's credential scan reads test files too.
const openaiKey = (): string => ["sk", "proj", "Q".repeat(40)].join("-");
const bearer = (): string => `${"Bear"}er ${"t".repeat(30)}`;

const fixture = (calls: Partial<Fixture["calls"][number]>[]): Fixture => ({
  meta: {
    kind: "meta",
    format: 1,
    provider: "openai",
    case: "tool-round-trip",
    api: "responses",
    sdk: "openai@7.57.0",
    model: "gpt-5.4-mini",
    recordedOn: "2026-11-20",
  },
  calls: calls.map((c, index) => ({
    index,
    request: {},
    options: {},
    chunks: [],
    outcome: "completed",
    ...c,
  })),
});

const turn1 = {
  type: "response.completed",
  sequence_number: 9,
  response: {
    id: "resp_68a1b2c3d4e5f6a7",
    created_at: 1763380000,
    completed_at: 1763380002,
    user: "someone",
    safety_identifier: "sid-123",
    prompt_cache_key: "pck",
    metadata: {},
    service_tier: "default",
    model: "gpt-5.4-mini-2026-03-17",
    output: [
      {
        type: "reasoning",
        id: "rs_0aa11bb22cc33dd44",
        summary: [],
        encrypted_content: "gAAAAABpZ1234567890abcdefXYZ",
      },
      {
        type: "function_call",
        id: "fc_0aa11bb22cc33dd44",
        call_id: "call_Ab12Cd34Ef56Gh78",
        name: "get_weather",
        arguments: '{"city":"Lahore"}',
      },
    ],
    usage: { input_tokens: 42, output_tokens: 7, output_tokens_details: { reasoning_tokens: 3 } },
  },
};

const turn2Request = {
  model: "gpt-5.4-mini",
  input: [
    { role: "user", content: "What is the weather in Lahore right now?" },
    {
      type: "function_call",
      call_id: "call_Ab12Cd34Ef56Gh78",
      name: "get_weather",
      arguments: "{}",
    },
    { type: "function_call_output", call_id: "call_Ab12Cd34Ef56Gh78", output: "{}" },
  ],
};

const chunk = (f: Fixture, call: number): unknown => {
  const c = f.calls[call];
  if (c === undefined) throw new Error(`no call ${call}`);
  return c.chunks[0];
};
const request = (f: Fixture, call: number): unknown => {
  const c = f.calls[call];
  if (c === undefined) throw new Error(`no call ${call}`);
  return c.request;
};

const scrubbedTwoTurn = (): Fixture =>
  scrubFixture(
    fixture([
      { chunks: [turn1] },
      { request: turn2Request, chunks: [{ type: "x", item_id: "fc_0aa11bb22cc33dd44" }] },
    ]),
  );

describe("scrubFixture", () => {
  test("replaces ids with prefix-keeping placeholders", () => {
    const out = scrubbedTwoTurn();
    const response = (chunk(out, 0) as typeof turn1).response;
    expect(response.id).toBe("resp_fixture0001");
    expect(response.output[0]?.id).toBe("rs_fixture0002");
    expect((response.output[1] as { id: string }).id).toBe("fc_fixture0003");
    expect((response.output[1] as { call_id: string }).call_id).toBe("call_fixture0004");
  });

  test("maps the same raw id to the same placeholder across calls", () => {
    const out = scrubbedTwoTurn();
    const input = (request(out, 1) as typeof turn2Request).input;
    expect(input[1]).toMatchObject({ call_id: "call_fixture0004" });
    expect(input[2]).toMatchObject({ call_id: "call_fixture0004" });
    expect(out.calls[1]?.chunks[0]).toEqual({ type: "x", item_id: "fc_fixture0003" });
  });

  test("replaces ids appearing inside strings too", () => {
    const out = scrubFixture(
      fixture([{ chunks: [{ text: "see call_Ab12Cd34Ef56Gh78 and resp_zz99yy88xx77" }] }]),
    );
    expect(out.calls[0]?.chunks[0]).toEqual({ text: "see call_fixture0001 and resp_fixture0002" });
  });

  test("id keys are scrubbed even when the value doesn't match an id pattern", () => {
    const out = scrubFixture(
      fixture([{ request: { messages: [{ role: "tool", tool_call_id: "call_00_AbCdEf123" }] } }]),
    );
    expect(out.calls[0]?.request).toEqual({
      messages: [{ role: "tool", tool_call_id: "call_fixture0001" }],
    });
    const call = scrubFixture(fixture([{ chunks: [{ call_id: "call_00_AbCdEf123" }] }]));
    expect(call.calls[0]?.chunks[0]).toEqual({ call_id: "call_fixture0001" });
  });

  test("existing placeholders are kept as they are", () => {
    const out = scrubFixture(
      fixture([{ chunks: [{ id: "resp_fixture0007" }, { id: "resp_raw0000001" }] }]),
    );
    expect(out.calls[0]?.chunks).toEqual([{ id: "resp_fixture0007" }, { id: "resp_fixture0001" }]);
  });

  test("ids without a known prefix keep a generic prefix", () => {
    const out = scrubFixture(
      fixture([{ chunks: [{ id: "7d6e2c1a-90b1-4f6e-8a3b-1c2d3e4f5a6b" }] }]),
    );
    expect(out.calls[0]?.chunks[0]).toEqual({ id: "id_fixture0001" });
  });

  test("replaces opaque blobs consistently", () => {
    const out = scrubFixture(
      fixture([
        {
          chunks: [
            { delta: { type: "signature_delta", signature: "EqQBCkgIARABGAIiQL5h" } },
            { content_block: { type: "redacted_thinking", data: "EmwKAhgBEgy3va3pzix" } },
            { encrypted_content: "EqQBCkgIARABGAIiQL5h" },
          ],
        },
      ]),
    );
    expect(out.calls[0]?.chunks).toEqual([
      { delta: { type: "signature_delta", signature: "fixture-opaque-0001" } },
      { content_block: { type: "redacted_thinking", data: "fixture-opaque-0002" } },
      { encrypted_content: "fixture-opaque-0001" },
    ]);
  });

  test("leaves data on other block types alone", () => {
    const out = scrubFixture(fixture([{ chunks: [{ type: "image", data: "short" }] }]));
    expect(out.calls[0]?.chunks[0]).toEqual({ type: "image", data: "short" });
  });

  test("nulls account fields and pins timestamps", () => {
    const response = (chunk(scrubbedTwoTurn(), 0) as typeof turn1).response;
    expect(response.user).toBeNull();
    expect(response.safety_identifier).toBeNull();
    expect(response.prompt_cache_key).toBeNull();
    expect(response.metadata).toBeNull();
    expect(response.service_tier).toBeNull();
    expect(response.created_at).toBe(1700000000);
    expect(response.completed_at).toBe(1700000000);
  });

  test("keeps model text, usage, event types and the model id", () => {
    const response = (chunk(scrubbedTwoTurn(), 0) as typeof turn1).response;
    expect(response.model).toBe("gpt-5.4-mini-2026-03-17");
    expect(response.usage).toEqual(turn1.response.usage);
    expect(response.output[1]).toMatchObject({
      name: "get_weather",
      arguments: '{"city":"Lahore"}',
    });
    expect((chunk(scrubbedTwoTurn(), 0) as { sequence_number: number }).sequence_number).toBe(9);
  });

  test("redacts credentials anywhere, including fields no rule names", () => {
    const out = scrubFixture(
      fixture([
        {
          chunks: [{ totally_new_field: { deep: [`token ${openaiKey()} end`] } }],
          request: { note: bearer() },
        },
      ]),
    );
    const text = serializeFixture(out);
    expect(findSecrets(text)).toEqual([]);
    expect(out.calls[0]?.chunks[0]).toEqual({
      totally_new_field: { deep: ["token [scrubbed] end"] },
    });
    expect(out.calls[0]?.request).toEqual({ note: "[scrubbed]" });
  });

  test("allowlists error headers and drops request and workspace ids", () => {
    const out = scrubFixture(
      fixture([
        {
          outcome: "threw",
          error: {
            phase: "create",
            afterChunks: 0,
            error: {
              name: "AuthenticationError",
              status: 401,
              message: "401 invalid x-api-key",
              error: {
                type: "error",
                error: { type: "authentication_error", message: "invalid x-api-key" },
              },
              requestID: "req_011CXyz123abc",
              workspaceID: "wrkspc_01AbCdEf",
              headers: {
                "content-type": "application/json",
                "x-ratelimit-limit": "50",
                "request-id": "r",
              },
            } as never,
          },
        },
      ]),
    );
    const error = out.calls[0]?.error?.error as unknown as Record<string, unknown>;
    expect(error.headers).toEqual({ "content-type": "application/json" });
    expect(error.requestID).toBeNull();
    expect(error.workspaceID).toBeNull();
    expect(error.status).toBe(401);
  });

  test("truncates huge strings such as the context-length filler", () => {
    const out = scrubFixture(fixture([{ request: { input: "fixture ".repeat(10_000) } }]));
    expect(out.calls[0]?.request).toEqual({ input: "[scrubbed: 80000 chars]" });
  });

  test("leaves meta alone and doesn't mutate its input", () => {
    const input = fixture([{ chunks: [turn1] }]);
    const before = JSON.stringify(input);
    const out = scrubFixture(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(out.meta).toEqual(input.meta);
  });

  test("is idempotent", () => {
    const once = scrubbedTwoTurn();
    expect(scrubFixture(once)).toEqual(once);
  });

  test("its output passes the fixture guard", () => {
    expect(findFixtureLeaks(serializeFixture(scrubbedTwoTurn()))).toEqual([]);
  });
});

describe("scrubText", () => {
  test("scrubs a serialized fixture", () => {
    const out = scrubText(serializeFixture(fixture([{ chunks: [turn1] }])));
    expect(out).toContain("resp_fixture0001");
    expect(out).not.toContain("resp_68a1b2c3d4e5f6a7");
  });

  test("refuses when the guard still finds something no rule covers", () => {
    const leaky = serializeFixture(
      fixture([{ chunks: [{ new_blob_field: "QmFzZTY0QmxvYjEyMzQ1Njc4OTBhYmNk" }] }]),
    );
    expect(() => scrubText(leaky)).toThrow(
      /scrubber left 1 leak\(s\):\nline 3: opaque token at data.new_blob_field/,
    );
  });
});

describe("scrubFixture: audit follow-ups", () => {
  const one = (data: unknown) => scrubFixture(fixture([{ chunks: [data] }])).calls[0]?.chunks[0];

  test("every forbidden account field is nulled", () => {
    for (const key of FORBIDDEN_FIXTURE_KEYS) {
      expect({ key, out: one({ [key]: "value" }) }).toEqual({ key, out: { [key]: null } });
    }
  });

  test("Chat Completions created timestamps are pinned", () => {
    expect(one({ id: "chatcmpl-AbC123dEf456", created: 1763380000 })).toEqual({
      id: "chatcmpl-fixture0001",
      created: 1700000000,
    });
  });

  test("a request id inside an SDK error message is replaced", () => {
    const message = `401 ${JSON.stringify({ type: "error", error: { type: "authentication_error" }, request_id: "req_011CXyz123abcDEF" })}`;
    const out = scrubFixture(
      fixture([
        {
          outcome: "threw",
          error: {
            phase: "create",
            afterChunks: 0,
            error: { name: "AuthenticationError", status: 401, message, error: null, headers: {} },
          },
        },
      ]),
    );
    expect(out.calls[0]?.error?.error.message).toContain("req_fixture0001");
    expect(out.calls[0]?.error?.error.message).not.toContain("req_011CXyz123abcDEF");
  });

  test("UUIDs in text are replaced", () => {
    expect(one({ text: "trace 7d6e2c1a-90b1-4f6e-8a3b-1c2d3e4f5a6b done" })).toEqual({
      text: "trace id_fixture0001 done",
    });
  });

  test("id-like words in model text are left alone", () => {
    expect(one({ delta: "I will call_weather now and resp_onsibly msg_board it" })).toEqual({
      delta: "I will call_weather now and resp_onsibly msg_board it",
    });
  });

  test("empty strings stay empty under id and opaque keys", () => {
    expect(one({ id: "", signature: "", system_fingerprint: "", call_id: "" })).toEqual({
      id: "",
      signature: "",
      system_fingerprint: "",
      call_id: "",
    });
  });

  test("OpenAI stream obfuscation padding is blanked", () => {
    expect(
      one({
        type: "response.output_text.delta",
        delta: "Hi",
        obfuscation: "Zx9QmK2pLr7TtV4wYb8NcE",
      }),
    ).toEqual({
      type: "response.output_text.delta",
      delta: "Hi",
      obfuscation: "",
    });
  });
});

describe("scrubFixture: security review follow-ups", () => {
  const one = (data: unknown) => scrubFixture(fixture([{ chunks: [data] }])).calls[0]?.chunks[0];

  test("redacts emails, IP addresses and masked key tails", () => {
    expect(one({ message: "owner@example.com from 203.0.113.57 with sk-proj-****Ab1x" })).toEqual({
      message: "[scrubbed] from [scrubbed] with sk-proj-[scrubbed]",
    });
  });

  test("treats any *_id key as an id", () => {
    expect(one({ file_id: "file_AbC123", comparison_response_id: "x9y8z7" })).toEqual({
      file_id: "file_fixture0001",
      comparison_response_id: "id_fixture0002",
    });
  });

  test("replaces digit-free organization ids", () => {
    expect(one({ message: "organization org-AbCdEfGhIjKlMnOp" })).toEqual({
      message: "organization org-fixture0001",
    });
  });

  test("drops prototype-changing keys", () => {
    const out = one(
      JSON.parse('{"a":1,"__proto__":{"polluted":true},"constructor":{"x":1}}'),
    ) as object;
    expect(Object.keys(out)).toEqual(["a"]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });

  test("leaves rate-limit errors for the guard to refuse", () => {
    const raw = serializeFixture(
      fixture([
        {
          outcome: "threw",
          error: {
            phase: "create",
            afterChunks: 0,
            error: {
              name: "RateLimitError",
              status: 429,
              message: "429 Rate limit reached for requests per min (RPM): Limit 500",
              error: null,
              headers: {},
            },
          },
        },
      ]),
    );
    expect(() => scrubText(raw)).toThrow(/rate-limit/);
  });
});
