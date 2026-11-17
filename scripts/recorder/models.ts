// Which model records which case. Filled in by whoever records, at recording time; the recorder
// checks every id against the provider's models list before sending anything. Prefer the cheapest
// model that supports each case.

export const PROVIDERS = ["openai", "anthropic", "deepseek", "qwen"] as const;
export type Provider = (typeof PROVIDERS)[number];

export interface CaseModel {
  model: string;
  /** Merged into the request's top level, for settings that depend on the model. */
  params?: Record<string, unknown> | undefined;
}

export interface ProviderModels {
  default: CaseModel;
  cases?: Readonly<Record<string, CaseModel>> | undefined;
}

// TODO: confirm every model id and override below at recording time. These are suggestions from
// the SDK enums, not checked for price or for reasoning support.
export const MODELS: Record<Provider, ProviderModels> = {
  openai: {
    default: { model: "gpt-5.4-mini" },
    cases: {
      "error-context": { model: "gpt-5.4-nano" },
    },
  },
  anthropic: {
    default: { model: "claude-haiku-5-5" },
    cases: {
      reasoning: {
        model: "claude-haiku-5-5",
        params: { thinking: { type: "enabled", budget_tokens: 1024 } },
      },
      "reasoning-tool-round-trip": {
        model: "claude-haiku-5-5",
        params: { thinking: { type: "enabled", budget_tokens: 1024 } },
      },
    },
  },
  deepseek: {
    default: { model: "deepseek-flash" },
  },
  qwen: {
    default: { model: "qwen3.8-flash" },
  },
};

/** The error-model case sends this id on purpose, so it is never checked against the list. */
export const MISSING_MODEL = "neoflux-fixture-no-such-model";

export function modelFor(config: ProviderModels, caseId: string): CaseModel {
  const override = config.cases?.[caseId];
  return override ?? config.default;
}

export function configuredModels(config: ProviderModels, caseIds: readonly string[]): string[] {
  const ids = caseIds.filter((id) => id !== "error-model").map((id) => modelFor(config, id).model);
  return [...new Set(ids)];
}

/** The configured ids the provider doesn't list. Stops reading the list once all are found. */
export async function checkModels(
  configured: readonly string[],
  available: AsyncIterable<string>,
): Promise<string[]> {
  const missing = new Set(configured);
  if (missing.size === 0) return [];
  for await (const id of available) {
    missing.delete(id);
    if (missing.size === 0) break;
  }
  return configured.filter((id) => missing.has(id));
}
