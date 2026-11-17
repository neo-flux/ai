import { describe, expect, test } from "bun:test";
import { getProviderError, toAIError } from "../../src/errors.ts";
import type { Fixture, FixtureApi, FixtureCall } from "../../src/testing/fixture.ts";
import { replayClient } from "../../src/testing/replay.ts";

const fixture = (api: FixtureApi, calls: Partial<FixtureCall>[]): Fixture => ({
  meta: {
    kind: "meta",
    format: 1,
    provider: "p",
    case: "c",
    api,
    sdk: "sdk@1",
    model: "m",
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

const recordedError = {
  name: "RateLimitError",
  status: 429,
  message: "429 slow down",
  error: { type: "rate_limit_error", code: "rate_limit_exceeded", message: "slow down" },
  code: "rate_limit_exceeded",
  type: "rate_limit_error",
  param: null,
  headers: { "retry-after": "2", "content-type": "application/json" },
};

const drain = async (iterable: AsyncIterable<unknown>): Promise<unknown[]> => {
  const out: unknown[] = [];
  for await (const item of iterable) out.push(item);
  return out;
};

type Create = (params: unknown, options?: unknown) => Promise<AsyncIterable<unknown>>;
// biome-ignore lint/suspicious/noExplicitAny: test helper reaching into the structural client
const method = (client: any, path: string): Create => {
  const parts = path.split(".");
  const name = parts.pop() as string;
  const owner = parts.reduce((o, p) => o[p], client);
  return (params, options) => owner[name](params, options);
};

describe("replayClient", () => {
  test("exposes exactly the recorded API's create method", () => {
    const responses = replayClient(fixture("responses", [{}])) as unknown as Record<
      string,
      unknown
    >;
    expect(Object.keys(responses).sort()).toEqual(["calls", "responses"]);
    const chat = replayClient(fixture("chat.completions", [{}])) as unknown as Record<
      string,
      unknown
    >;
    expect(Object.keys(chat).sort()).toEqual(["calls", "chat"]);
    expect(Object.keys(chat.chat as object)).toEqual(["completions"]);
    const messages = replayClient(fixture("messages", [{}])) as unknown as Record<string, unknown>;
    expect(Object.keys(messages).sort()).toEqual(["calls", "messages"]);
  });

  test("serves each call's chunks in order and records what it was given", async () => {
    const client = replayClient(
      fixture("messages", [{ chunks: [{ n: 1 }, { n: 2 }] }, { chunks: [{ n: 3 }] }]),
    );
    const create = method(client, "messages.create");
    const signal = new AbortController().signal;
    expect(await drain(await create({ turn: 1 }, { signal }))).toEqual([{ n: 1 }, { n: 2 }]);
    expect(await drain(await create({ turn: 2 }))).toEqual([{ n: 3 }]);
    expect(client.calls).toEqual([
      { params: { turn: 1 }, options: { signal } },
      { params: { turn: 2 }, options: undefined },
    ]);
  });

  test("serves copies, so a consumer can't corrupt the fixture", async () => {
    const f = fixture("responses", [{ chunks: [{ n: 1 }] }, { chunks: [{ n: 1 }] }]);
    const create = method(replayClient(f), "responses.create");
    const [first] = (await drain(await create({}))) as { n: number }[];
    (first as { n: number }).n = 99;
    expect(f.calls[0]?.chunks[0]).toEqual({ n: 1 });
  });

  test("a create-phase error rejects the call itself", async () => {
    const create = method(
      replayClient(
        fixture("responses", [
          { outcome: "threw", error: { phase: "create", afterChunks: 0, error: recordedError } },
        ]),
      ),
      "responses.create",
    );
    const thrown = await create({}).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).toMatchObject({ name: "RateLimitError", status: 429, type: "rate_limit_error" });
    expect((thrown as { headers: Headers }).headers).toBeInstanceOf(Headers);
    expect((thrown as { headers: Headers }).headers.get("retry-after")).toBe("2");
    const mapped = toAIError(thrown, { provider: "p" });
    expect(mapped.code).toBe("rate_limit");
    expect(mapped.retryAfterMs).toBe(2000);
    expect(getProviderError(mapped)).toBe(thrown);
  });

  test("a stream-phase error throws after the recorded chunks", async () => {
    const create = method(
      replayClient(
        fixture("chat.completions", [
          {
            chunks: [{ n: 1 }, { n: 2 }],
            outcome: "threw",
            error: { phase: "stream", afterChunks: 2, error: { ...recordedError, status: null } },
          },
        ]),
      ),
      "chat.completions.create",
    );
    const stream = await create({});
    const seen: unknown[] = [];
    const run = async () => {
      for await (const item of stream) seen.push(item);
    };
    const thrown = await run().catch((e: unknown) => e);
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
    expect((thrown as { status: unknown }).status).toBeUndefined();
    expect((thrown as { message: string }).message).toBe("429 slow down");
  });

  test("stops silently once the signal aborts, like the SDKs", async () => {
    const controller = new AbortController();
    const create = method(
      replayClient(fixture("messages", [{ chunks: [{ n: 1 }, { n: 2 }, { n: 3 }] }])),
      "messages.create",
    );
    const seen: unknown[] = [];
    for await (const item of await create({}, { signal: controller.signal })) {
      seen.push(item);
      controller.abort();
    }
    expect(seen).toEqual([{ n: 1 }]);
  });

  test("replays a recorded abort as a silent end", async () => {
    const create = method(
      replayClient(fixture("responses", [{ chunks: [{ n: 1 }], outcome: "returned-after-abort" }])),
      "responses.create",
    );
    expect(await drain(await create({}))).toEqual([{ n: 1 }]);
  });

  test("more calls than recorded is an error", async () => {
    const create = method(replayClient(fixture("responses", [{}])), "responses.create");
    await create({});
    await expect(create({})).rejects.toThrow("replay: fixture has 1 call(s), call 2 requested");
  });
});

describe("replayClient: audit follow-ups", () => {
  test("an already-aborted signal rejects create() like the SDKs do", async () => {
    const controller = new AbortController();
    controller.abort();
    // openai's error classes never set `name`; @anthropic-ai/sdk sets the class name.
    const cases: [FixtureApi, string, string][] = [
      ["responses", "responses.create", "Error"],
      ["chat.completions", "chat.completions.create", "Error"],
      ["messages", "messages.create", "APIUserAbortError"],
    ];
    for (const [api, path, name] of cases) {
      const create = method(replayClient(fixture(api, [{ chunks: [{ n: 1 }] }])), path);
      const thrown = await create({}, { signal: controller.signal }).catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).toMatchObject({ name, message: "Request was aborted." });
      expect((thrown as { status?: unknown }).status).toBeUndefined();
    }
  });

  test("an abort just before a recorded stream error ends silently", async () => {
    const controller = new AbortController();
    const create = method(
      replayClient(
        fixture("messages", [
          {
            chunks: [{ n: 1 }],
            outcome: "threw",
            error: { phase: "stream", afterChunks: 1, error: recordedError },
          },
        ]),
      ),
      "messages.create",
    );
    const seen: unknown[] = [];
    for await (const item of await create({}, { signal: controller.signal })) {
      seen.push(item);
      controller.abort();
    }
    expect(seen).toEqual([{ n: 1 }]);
  });

  test("the rebuilt error keeps every recorded field", async () => {
    const create = method(
      replayClient(
        fixture("responses", [
          {
            outcome: "threw",
            error: {
              phase: "create",
              afterChunks: 0,
              error: { ...recordedError, errorCode: "ec", details: { d: 1 }, apiMessage: "am" },
            },
          },
        ]),
      ),
      "responses.create",
    );
    const thrown = (await create({}).catch((e: unknown) => e)) as Record<string, unknown>;
    expect(thrown.error).toEqual(recordedError.error);
    expect(thrown.code).toBe("rate_limit_exceeded");
    expect(thrown.param).toBeNull();
    expect(thrown.errorCode).toBe("ec");
    expect(thrown.details).toEqual({ d: 1 });
    expect(thrown.apiMessage).toBe("am");
  });

  test("chunkDelayMs spaces chunks out so a timed abort can land mid-stream", async () => {
    const controller = new AbortController();
    const create = method(
      replayClient(fixture("messages", [{ chunks: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }] }]), {
        chunkDelayMs: 40,
      }),
      "messages.create",
    );
    setTimeout(() => controller.abort(), 60);
    const started = Date.now();
    const seen = await drain(await create({}, { signal: controller.signal }));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.length).toBeLessThan(4);
    expect(Date.now() - started).toBeLessThan(150);
  });

  test("without chunkDelayMs every chunk is served without timers", async () => {
    const create = method(
      replayClient(fixture("messages", [{ chunks: [{ n: 1 }, { n: 2 }] }])),
      "messages.create",
    );
    expect(await drain(await create({}))).toEqual([{ n: 1 }, { n: 2 }]);
  });
});

describe("replayClient: security review follow-ups", () => {
  test("a __proto__ key in a recorded error can't replace the error's prototype", async () => {
    const hostile = JSON.parse(
      JSON.stringify({ ...recordedError, extra: 1 }).replace(
        '"extra":1',
        '"__proto__":{"polluted":"yes"}',
      ),
    );
    const create = method(
      replayClient(
        fixture("responses", [
          { outcome: "threw", error: { phase: "create", afterChunks: 0, error: hostile } },
        ]),
      ),
      "responses.create",
    );
    const thrown = (await create({}).catch((e: unknown) => e)) as Record<string, unknown>;
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown.polluted).toBeUndefined();
    expect(thrown.code).toBe("rate_limit_exceeded");
  });
});
