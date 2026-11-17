import { describe, expect, test } from "bun:test";
import {
  type CaseModel,
  checkModels,
  configuredModels,
  MODELS,
  modelFor,
  PROVIDERS,
  type ProviderModels,
} from "../../scripts/recorder/models.ts";

async function* ids(...values: string[]): AsyncGenerator<string> {
  yield* values;
}

const config: ProviderModels = {
  default: { model: "fast" },
  cases: {
    reasoning: { model: "thinker", params: { thinking: { type: "enabled", budget_tokens: 1024 } } },
    "error-context": { model: "cheapest" },
  },
};

describe("models config", () => {
  test("covers every provider with a default model", () => {
    expect(PROVIDERS).toEqual(["openai", "anthropic", "deepseek", "qwen"]);
    for (const provider of PROVIDERS) {
      expect(MODELS[provider].default.model.length).toBeGreaterThan(0);
    }
  });

  test("modelFor uses the per-case override, else the default", () => {
    expect(modelFor(config, "text")).toEqual({ model: "fast" });
    const reasoning: CaseModel = modelFor(config, "reasoning");
    expect(reasoning.model).toBe("thinker");
    expect(reasoning.params).toEqual({ thinking: { type: "enabled", budget_tokens: 1024 } });
    expect(modelFor({ default: { model: "only" } }, "reasoning")).toEqual({ model: "only" });
  });

  test("configuredModels lists the distinct ids the selected cases need", () => {
    expect(configuredModels(config, ["text", "reasoning", "stream-long"])).toEqual([
      "fast",
      "thinker",
    ]);
    expect(configuredModels(config, ["error-context"])).toEqual(["cheapest"]);
  });

  test("the deliberately unknown model of error-model is not checked", () => {
    expect(configuredModels(config, ["error-model", "text"])).toEqual(["fast"]);
    expect(configuredModels(config, ["error-model"])).toEqual([]);
  });

  test("checkModels reports every configured id the provider doesn't list", async () => {
    expect(await checkModels(["a", "b"], ids("b", "c", "a"))).toEqual([]);
    expect(await checkModels(["a", "x", "y"], ids("a", "b"))).toEqual(["x", "y"]);
    expect(await checkModels([], ids())).toEqual([]);
  });

  test("checkModels stops listing once every id is found", async () => {
    let pulled = 0;
    async function* many(): AsyncGenerator<string> {
      for (const id of ["a", "b", "c", "d"]) {
        pulled++;
        yield id;
      }
    }
    expect(await checkModels(["b"], many())).toEqual([]);
    expect(pulled).toBe(2);
  });
});
