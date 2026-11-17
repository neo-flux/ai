import { describe, expect, test } from "bun:test";
import type { ModelRequest } from "../../src/adapter.ts";
import type { StreamEvent } from "../../src/events.ts";
import { fakeAdapter } from "../../src/testing/fake-adapter.ts";

const request: ModelRequest = { messages: [{ role: "user", content: "hi" }] };
const finish: StreamEvent = { type: "finish", reason: "stop" };
const text = (t: string): StreamEvent => ({ type: "text-delta", text: t });

const drain = async (iterable: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
};

const run = (fake: ReturnType<typeof fakeAdapter>, id = "m", signal?: AbortSignal) => {
  const modelRef = fake(id);
  return modelRef.adapter.stream(request, {
    signal: signal ?? new AbortController().signal,
    modelRef,
  });
};

describe("fakeAdapter", () => {
  test("is a model factory for the fake provider", () => {
    const fake = fakeAdapter([{ events: [finish] }]);
    const ref = fake("m1");
    expect(ref.provider).toBe("fake");
    expect(ref.id).toBe("m1");
    expect(fakeAdapter([], { provider: "other" })("m").provider).toBe("other");
    expect(fakeAdapter([], { jsonSchemaTarget: "draft-07" })("m").jsonSchemaTarget).toBe(
      "draft-07",
    );
  });

  test("plays scripted turns in order and records calls", async () => {
    const fake = fakeAdapter([{ events: [text("a"), finish] }, { events: [text("b"), finish] }]);
    expect(await drain(run(fake, "x"))).toEqual([text("a"), finish]);
    expect(await drain(run(fake, "y"))).toEqual([text("b"), finish]);
    expect(fake.calls.map((c) => c.modelId)).toEqual(["x", "y"]);
    expect(fake.calls[0]?.request).toBe(request);
  });

  test("runs out of script with an error", async () => {
    const fake = fakeAdapter([]);
    await expect(drain(run(fake))).rejects.toThrow("no scripted turn for call 0");
  });

  test("accepts a function script", async () => {
    const fake = fakeAdapter((req, ctx, call) => ({
      events: [text(`${ctx.modelRef.id}:${call}:${req.messages.length}`), finish],
    }));
    expect(await drain(run(fake, "m"))).toEqual([text("m:0:1"), finish]);
  });

  test("throws before the first event or after a given index", async () => {
    const boom = { status: 429 };
    const before = fakeAdapter([{ throwBefore: boom }]);
    await expect(drain(run(before))).rejects.toBe(boom);
    expect(before.calls).toHaveLength(1);

    const seen: StreamEvent[] = [];
    const after = fakeAdapter([
      { events: [text("a"), text("b"), finish], throwAfter: { index: 1, error: boom } },
    ]);
    const consume = async () => {
      for await (const e of run(after)) seen.push(e);
    };
    await expect(consume()).rejects.toBe(boom);
    expect(seen).toEqual([text("a")]);
  });

  test("honours the signal between events", async () => {
    const controller = new AbortController();
    const fake = fakeAdapter([{ events: [text("a"), text("b"), finish] }]);
    const seen: StreamEvent[] = [];
    const consume = async () => {
      for await (const e of run(fake, "m", controller.signal)) {
        seen.push(e);
        controller.abort();
      }
    };
    await expect(consume()).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).toEqual([text("a")]);
  });

  test("delays are abortable", async () => {
    const controller = new AbortController();
    const fake = fakeAdapter([{ events: [text("a"), finish], delayMs: 10_000 }]);
    const started = Date.now();
    setTimeout(() => controller.abort(), 10);
    await expect(drain(run(fake, "m", controller.signal))).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("counts streams closed early", async () => {
    const fake = fakeAdapter([{ events: [text("a"), text("b"), finish] }, { events: [finish] }]);
    for await (const _ of run(fake)) break;
    await drain(run(fake));
    expect(fake.closedEarly).toBe(1);
  });
});
