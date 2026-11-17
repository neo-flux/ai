// The brief's test of the hook API: metering, budgets and routing must be doable through hooks.
import { describe, expect, test } from "bun:test";
import type { ModelRef } from "../../src/adapter.ts";
import type { Price } from "../../src/cost.ts";
import type { StreamEvent } from "../../src/events.ts";
import { generate } from "../../src/generate.ts";
import type { Hooks } from "../../src/hooks.ts";
import type { Message } from "../../src/messages.ts";
import { fakeAdapter } from "../../src/testing/fake-adapter.ts";

const flags = { inputIncludesCached: true, outputIncludesReasoning: true };
const answer = (inputTokens: number, outputTokens: number) => ({
  events: [
    { type: "text-delta", text: "ok" } as StreamEvent,
    { type: "usage", usage: { ...flags, inputTokens, outputTokens } } as StreamEvent,
    { type: "finish", reason: "stop" } as StreamEvent,
  ],
});
const ask = (content: string): Message[] => [{ role: "user", content }];
const prices: Record<string, Price> = {
  small: { input: 1, output: 2 },
  large: { input: 10, output: 20 },
};
const price = (ref: ModelRef): Price | undefined => prices[ref.id];

describe("hook scenarios", () => {
  test("metering: onUsage plus price totals spend per model, failed attempts included", async () => {
    const fake = fakeAdapter([
      answer(1_000_000, 500_000),
      { events: answer(2_000_000, 0).events, throwAfter: { index: 2, error: { status: 503 } } },
      answer(0, 1_000_000),
    ]);
    const ledger: { model: string; cost: number | undefined }[] = [];
    const hooks: Hooks = {
      onUsage: ({ cost, ctx }) => void ledger.push({ model: ctx.modelRef.id, cost }),
    };
    await generate({ model: fake("small"), messages: ask("a"), price, hooks });
    // Fails after reporting usage: no fallback, the call rejects, and the spend is still metered.
    await expect(
      generate({ model: [fake("large"), fake("small")], messages: ask("b"), price, hooks }),
    ).rejects.toMatchObject({ code: "provider_unavailable" });
    await generate({ model: fake("small"), messages: ask("c"), price, hooks });
    expect(ledger).toEqual([
      { model: "small", cost: 2 },
      { model: "large", cost: 20 },
      { model: "small", cost: 2 },
    ]);
  });

  test("budgets: beforeRequest rejects once onUsage has spent the limit", async () => {
    class OverBudget extends Error {}
    let spent = 0;
    const limit = 3;
    const hooks: Hooks = {
      beforeRequest: () => {
        if (spent >= limit) throw new OverBudget("budget reached");
        return undefined;
      },
      onUsage: ({ cost }) => {
        spent += cost ?? 0;
      },
    };
    const fake = fakeAdapter([
      answer(1_000_000, 500_000),
      answer(1_000_000, 500_000),
      answer(1, 1),
    ]);
    await generate({ model: fake("small"), messages: ask("1"), price, hooks });
    await generate({ model: fake("small"), messages: ask("2"), price, hooks });
    await expect(
      generate({ model: fake("small"), messages: ask("3"), price, hooks }),
    ).rejects.toBeInstanceOf(OverBudget);
    expect(fake.calls).toHaveLength(2);
  });

  test("routing: resolveModel picks a model, beforeRequest adds provider options", async () => {
    const fake = fakeAdapter(() => answer(1, 1));
    const hooks: Hooks = {
      resolveModel: (models) => models.filter((m) => m.id === "large"),
      beforeRequest: (request) => {
        const long = request.messages.some(
          (m) => typeof m.content === "string" && m.content.length > 10,
        );
        return { ...request, providerOptions: { fake: { tier: long ? "priority" : "standard" } } };
      },
    };
    const r = await generate({
      model: [fake("small"), fake("large")],
      messages: ask("a long question here"),
      hooks,
    });
    expect(r.modelRef.id).toBe("large");
    expect(fake.calls.map((c) => c.modelId)).toEqual(["large"]);
    expect(fake.calls[0]?.request.providerOptions).toEqual({ fake: { tier: "priority" } });
  });

  test("routing by allow-list: resolveModel removing every model fails before any call", async () => {
    const fake = fakeAdapter([answer(1, 1)]);
    await expect(
      generate({
        model: [fake("small")],
        messages: ask("x"),
        hooks: { resolveModel: (models) => models.filter((m) => m.provider === "elsewhere") },
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fake.calls).toHaveLength(0);
  });
});
