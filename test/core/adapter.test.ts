import { describe, expect, test } from "bun:test";
import { type Adapter, defineProvider, isModelRef } from "../../src/adapter.ts";
import { isAIError } from "../../src/errors.ts";

const adapter: Adapter = {
  provider: "acme",
  async *stream() {
    yield { type: "finish", reason: "stop" };
  },
};

describe("defineProvider", () => {
  test("returns a factory of frozen model refs", () => {
    const acme = defineProvider<{ effort: string }>(adapter);
    const ref = acme("acme-1", { effort: "high" });
    expect(ref).toEqual({
      provider: "acme",
      id: "acme-1",
      options: { effort: "high" },
      adapter,
      jsonSchemaTarget: "draft-2020-12",
    });
    expect(Object.isFrozen(ref)).toBe(true);
    expect(acme("acme-2").options).toBeUndefined();
  });

  test("uses the provider's JSON Schema target", () => {
    expect(defineProvider(adapter, { jsonSchemaTarget: "draft-07" })("m").jsonSchemaTarget).toBe(
      "draft-07",
    );
  });

  test("rejects an empty model id", () => {
    try {
      defineProvider(adapter)("");
      throw new Error("expected a throw");
    } catch (error) {
      expect(isAIError(error)).toBe(true);
      expect((error as { code: string }).code).toBe("invalid_request");
    }
  });
});

describe("isModelRef", () => {
  test("recognises refs by shape", () => {
    expect(isModelRef(defineProvider(adapter)("m"))).toBe(true);
    expect(isModelRef({ provider: "a", id: "b", jsonSchemaTarget: "draft-07", adapter: {} })).toBe(
      false,
    );
    expect(isModelRef("acme-1")).toBe(false);
    expect(isModelRef(null)).toBe(false);
  });
});
