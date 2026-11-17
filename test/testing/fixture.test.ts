import { describe, expect, test } from "bun:test";
import { type Fixture, parseFixture, serializeFixture } from "../../src/testing/fixture.ts";

const meta = {
  kind: "meta",
  format: 1,
  provider: "openai",
  case: "tool-round-trip",
  api: "responses",
  sdk: "openai@7.57.0",
  model: "m",
  recordedOn: "2026-11-20",
};
const lines = (...items: unknown[]): string =>
  `${items.map((i) => JSON.stringify(i)).join("\n")}\n`;
const call = (index: number, extra: Record<string, unknown> = {}) => ({
  kind: "call",
  index,
  request: { model: "m" },
  options: {},
  ...extra,
});
const chunk = (n: number, data: unknown) => ({ kind: "chunk", call: n, data });
const end = (n: number, outcome: string) => ({ kind: "end", call: n, outcome });
const error = (n: number, afterChunks: number, phase = "stream") => ({
  kind: "error",
  call: n,
  phase,
  afterChunks,
  error: { name: "APIError", status: null, message: null, error: null, headers: {} },
});

const rejects = (text: string, reason: RegExp) => {
  expect(() => parseFixture(text)).toThrow(reason);
};

describe("parseFixture", () => {
  test("parses a two-call fixture into calls with chunks and outcomes", () => {
    const f = parseFixture(
      lines(
        meta,
        call(0),
        chunk(0, { a: 1 }),
        chunk(0, { a: 2 }),
        end(0, "completed"),
        call(1, { options: { abortAfterChunks: 1 } }),
        chunk(1, { b: 1 }),
        end(1, "returned-after-abort"),
      ),
    );
    expect(f.meta.case).toBe("tool-round-trip");
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]?.chunks).toEqual([{ a: 1 }, { a: 2 }]);
    expect(f.calls[0]?.outcome).toBe("completed");
    expect(f.calls[1]?.options).toEqual({ abortAfterChunks: 1 });
    expect(f.calls[1]?.outcome).toBe("returned-after-abort");
    expect(f.calls[1]?.error).toBeUndefined();
  });

  test("parses an error outcome with its phase and position", () => {
    const f = parseFixture(lines(meta, call(0), chunk(0, {}), error(0, 1), end(0, "threw")));
    expect(f.calls[0]?.error?.afterChunks).toBe(1);
    expect(f.calls[0]?.error?.phase).toBe("stream");
    const atCreate = parseFixture(lines(meta, call(0), error(0, 0, "create"), end(0, "threw")));
    expect(atCreate.calls[0]?.error?.phase).toBe("create");
  });

  test("ignores blank lines", () => {
    expect(parseFixture(`\n${lines(meta, call(0), end(0, "completed"))}\n\n`).calls).toHaveLength(
      1,
    );
  });

  test("rejects a missing or invalid meta line", () => {
    rejects(lines(call(0), end(0, "completed")), /line 1: expected meta/);
    rejects(lines({ ...meta, format: 2 }, call(0), end(0, "completed")), /unsupported format/);
    rejects(lines({ ...meta, api: "completions" }, call(0), end(0, "completed")), /api/);
    rejects(lines({ ...meta, provider: "" }, call(0), end(0, "completed")), /provider/);
    rejects("not json\n", /line 1: invalid JSON/);
    rejects("", /empty/);
  });

  test("rejects structural errors", () => {
    rejects(lines(meta), /no calls/);
    rejects(lines(meta, call(1), end(1, "completed")), /expected call 0/);
    rejects(lines(meta, call(0), chunk(1, {}), end(0, "completed")), /chunk for call 1/);
    rejects(lines(meta, call(0), chunk(0, {})), /call 0 has no end/);
    rejects(lines(meta, call(0), end(0, "done")), /outcome/);
    rejects(lines(meta, call(0), end(0, "threw")), /threw without an error/);
    rejects(lines(meta, call(0), error(0, 0), end(0, "completed")), /error without threw/);
    rejects(
      lines(meta, call(0), chunk(0, {}), error(0, 0), end(0, "threw")),
      /afterChunks 0 but 1/,
    );
    rejects(lines(meta, call(0), error(0, 0, "later"), end(0, "threw")), /phase/);
    rejects(
      lines(meta, call(0), chunk(0, {}), error(0, 1, "create"), end(0, "threw")),
      /create.*chunks/,
    );
    rejects(lines(meta, call(0), end(0, "completed"), chunk(0, {})), /after its end/);
    rejects(lines(meta, call(0), end(0, "completed"), meta), /line 4/);
  });
});

describe("serializeFixture", () => {
  test("round-trips through parseFixture", () => {
    const text = lines(
      meta,
      call(0),
      chunk(0, { a: [1, "x"] }),
      end(0, "completed"),
      call(1),
      error(1, 0, "create"),
      end(1, "threw"),
    );
    const parsed: Fixture = parseFixture(text);
    expect(serializeFixture(parsed)).toBe(text);
    expect(parseFixture(serializeFixture(parsed))).toEqual(parsed);
  });
});
