import { describe, expect, test } from "bun:test";
import {
  allowlistHeaders,
  type CaseSpec,
  type Connection,
  type RecordContext,
  type RequestOptions,
  recordCase,
  serializeError,
} from "../../scripts/recorder/record.ts";

type Script = (params: unknown, options: RequestOptions) => Promise<AsyncIterable<unknown>>;

const connection = (...scripts: Script[]) => {
  const seen: { api: string; params: unknown; options: RequestOptions; invalidKey: boolean }[] = [];
  let i = 0;
  const connect = ({ invalidKey }: { invalidKey: boolean }): Connection => ({
    create: (api, params, options) => {
      seen.push({ api, params, options, invalidKey });
      const script = scripts[i++];
      if (script === undefined) throw new Error("no script");
      return script(params, options);
    },
  });
  return { connect, seen };
};

const stream =
  (items: unknown[], fail?: { after: number; error: unknown }): Script =>
  async (_params, options) => ({
    async *[Symbol.asyncIterator]() {
      for (const [n, item] of items.entries()) {
        if (fail !== undefined && fail.after === n) throw fail.error;
        // Mirrors both SDKs: an aborted request ends the iteration silently.
        if (options.signal.aborted) return;
        yield item;
      }
      if (fail !== undefined && fail.after === items.length) throw fail.error;
    },
  });

const sdkError = (status: number | undefined, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`${status} bad`), {
    name: status === 401 ? "AuthenticationError" : "APIError",
    status,
    error: { type: "invalid_request_error", message: "bad" },
    code: "invalid_api_key",
    type: "invalid_request_error",
    param: null,
    requestID: "req_secretish",
    workspaceID: "wrkspc_secretish",
    headers: new Headers({
      "content-type": "application/json",
      "retry-after": "3",
      "retry-after-ms": "3000",
      "x-request-id": "req_123",
      "x-ratelimit-limit-requests": "10000",
      "openai-organization": "org-abc",
      "x-should-retry": "false",
    }),
    ...extra,
  });

const single = (build: CaseSpec["build"], turns = 1): CaseSpec => ({
  id: "case",
  api: "responses",
  turns,
  build,
});

const ctx = (connect: RecordContext["connect"]): RecordContext => ({
  provider: "openai",
  sdk: "openai@7.57.0",
  model: "m-1",
  recordedOn: "2026-11-20",
  connect,
});

describe("recordCase", () => {
  test("records meta, the request and each chunk as a JSON clone, in order", async () => {
    const item = { type: "delta", nested: { at: new Date(0) } };
    const { connect, seen } = connection(stream([item, { type: "done" }]));
    const fixture = await recordCase(
      single(({ model }) => ({ params: { model, input: "hi" } })),
      ctx(connect),
    );
    expect(fixture.meta).toEqual({
      kind: "meta",
      format: 1,
      provider: "openai",
      case: "case",
      api: "responses",
      sdk: "openai@7.57.0",
      model: "m-1",
      recordedOn: "2026-11-20",
    });
    expect(fixture.calls).toHaveLength(1);
    const call = fixture.calls[0];
    expect(call?.request).toEqual({ model: "m-1", input: "hi" });
    expect(call?.chunks).toEqual([
      { type: "delta", nested: { at: "1970-01-01T00:00:00.000Z" } },
      { type: "done" },
    ]);
    expect(call?.chunks[0]).not.toBe(item);
    expect(call?.outcome).toBe("completed");
    expect(seen[0]?.api).toBe("responses");
  });

  test("never retries and passes the timeout through", async () => {
    const { connect, seen } = connection(stream([]), stream([]));
    await recordCase(
      single(() => ({ params: {} })),
      ctx(connect),
    );
    await recordCase(
      single(() => ({ params: {}, timeoutMs: 1 })),
      ctx(connect),
    );
    expect(seen[0]?.options.maxRetries).toBe(0);
    expect(seen[0]?.options.timeout).toBeUndefined();
    expect(seen[1]?.options.timeout).toBe(1);
    expect(seen[1]?.options.signal).toBeInstanceOf(AbortSignal);
  });

  test("records options in the fixture", async () => {
    const { connect } = connection(stream([1, 2, 3, 4]));
    const f = await recordCase(
      single(() => ({ params: {}, abortAfterChunks: 2, timeoutMs: 5000 })),
      ctx(connect),
    );
    expect(f.calls[0]?.options).toEqual({ abortAfterChunks: 2, timeoutMs: 5000 });
  });

  test("aborts after exactly N chunks and records what the SDK does next", async () => {
    const { connect, seen } = connection(stream([1, 2, 3, 4, 5]));
    const f = await recordCase(
      single(() => ({ params: {}, abortAfterChunks: 3 })),
      ctx(connect),
    );
    expect(seen[0]?.options.signal.aborted).toBe(true);
    expect(f.calls[0]?.chunks).toEqual([1, 2, 3]);
    expect(f.calls[0]?.outcome).toBe("returned-after-abort");
  });

  test("a stream that ends before the planned abort is completed, not aborted", async () => {
    const { connect, seen } = connection(stream([1, 2]));
    const f = await recordCase(
      single(() => ({ params: {}, abortAfterChunks: 5 })),
      ctx(connect),
    );
    expect(seen[0]?.options.signal.aborted).toBe(false);
    expect(f.calls[0]?.outcome).toBe("completed");
  });

  test("an SDK that throws on abort is recorded as threw", async () => {
    const throwing: Script = async (_p, options) => ({
      async *[Symbol.asyncIterator]() {
        yield 1;
        if (options.signal.aborted)
          throw Object.assign(new Error("aborted"), { name: "APIUserAbortError" });
      },
    });
    const { connect } = connection(throwing);
    const f = await recordCase(
      single(() => ({ params: {}, abortAfterChunks: 1 })),
      ctx(connect),
    );
    expect(f.calls[0]?.outcome).toBe("threw");
    expect(f.calls[0]?.error?.error.name).toBe("APIUserAbortError");
    expect(f.calls[0]?.error?.afterChunks).toBe(1);
  });

  test("a rejected create is recorded at phase create with no chunks", async () => {
    const { connect } = connection(async () => {
      throw sdkError(401);
    });
    const f = await recordCase(
      single(() => ({ params: {}, invalidKey: true })),
      ctx(connect),
    );
    expect(f.calls[0]?.outcome).toBe("threw");
    expect(f.calls[0]?.error?.phase).toBe("create");
    expect(f.calls[0]?.error?.afterChunks).toBe(0);
    expect(f.calls[0]?.error?.error.status).toBe(401);
  });

  test("a mid-stream error is recorded at phase stream after the chunks it followed", async () => {
    const { connect } = connection(stream([1, 2], { after: 2, error: sdkError(undefined) }));
    const f = await recordCase(
      single(() => ({ params: {} })),
      ctx(connect),
    );
    expect(f.calls[0]?.chunks).toEqual([1, 2]);
    expect(f.calls[0]?.error?.phase).toBe("stream");
    expect(f.calls[0]?.error?.afterChunks).toBe(2);
    expect(f.calls[0]?.error?.error.status).toBeNull();
  });

  test("connects with the invalid key only when the call asks for it", async () => {
    const { connect, seen } = connection(stream([]), stream([]));
    await recordCase(
      single(() => ({ params: {} })),
      ctx(connect),
    );
    await recordCase(
      single(() => ({ params: {}, invalidKey: true })),
      ctx(connect),
    );
    expect(seen.map((s) => s.invalidKey)).toEqual([false, true]);
  });

  test("a two-turn case builds turn 2 from turn 1's recorded call", async () => {
    const { connect, seen } = connection(stream([{ id: "call_1" }]), stream([{ ok: true }]));
    const turns: unknown[] = [];
    const f = await recordCase(
      single(({ turn, previous }) => {
        turns.push({ turn, previous: previous.map((p) => p.chunks) });
        return { params: { turn, from: previous[0]?.chunks[0] ?? null } };
      }, 2),
      ctx(connect),
    );
    expect(turns).toEqual([
      { turn: 0, previous: [] },
      { turn: 1, previous: [[{ id: "call_1" }]] },
    ]);
    expect(seen[1]?.params).toEqual({ turn: 1, from: { id: "call_1" } });
    expect(f.calls.map((c) => c.index)).toEqual([0, 1]);
  });

  test("stops after a turn that threw", async () => {
    const { connect, seen } = connection(async () => {
      throw sdkError(400);
    });
    const f = await recordCase(
      single(() => ({ params: {} }), 2),
      ctx(connect),
    );
    expect(f.calls).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });
});

describe("serializeError", () => {
  test("keeps the SDK's shape and only allowlisted headers", () => {
    const e = serializeError(sdkError(429, { errorCode: "x", details: { a: 1 }, apiMessage: "m" }));
    expect(e).toEqual({
      name: "APIError",
      status: 429,
      message: "429 bad",
      error: { type: "invalid_request_error", message: "bad" },
      code: "invalid_api_key",
      type: "invalid_request_error",
      param: null,
      errorCode: "x",
      details: { a: 1 },
      apiMessage: "m",
      headers: {
        "content-type": "application/json",
        "retry-after": "3",
        "retry-after-ms": "3000",
      },
    });
    expect(JSON.stringify(e)).not.toContain("secretish");
  });

  test("handles non-Error values and missing fields", () => {
    expect(serializeError("boom")).toEqual({
      name: null,
      status: null,
      message: "boom",
      error: null,
      headers: {},
    });
    expect(serializeError(new TypeError("t"))).toMatchObject({ name: "TypeError", message: "t" });
  });
});

describe("allowlistHeaders", () => {
  test("keeps only content-type, retry-after and retry-after-ms, from Headers or records", () => {
    expect(
      allowlistHeaders({ "Retry-After": "1", "X-RateLimit-Remaining": "5", "set-cookie": "a" }),
    ).toEqual({
      "retry-after": "1",
    });
    expect(
      allowlistHeaders(new Headers({ "content-type": "text/plain", "request-id": "r" })),
    ).toEqual({
      "content-type": "text/plain",
    });
    expect(allowlistHeaders(undefined)).toEqual({});
    expect(allowlistHeaders({ "retry-after": 5 })).toEqual({});
  });
});
