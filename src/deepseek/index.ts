import type OpenAI from "openai";
import { defineProvider, type ModelFactory } from "../adapter.ts";
import { compatAdapter } from "../compat/adapter.ts";
import type { CompatQuirks } from "../compat/quirks.ts";

/** Model and call options for DeepSeek. Unset fields aren't sent, so DeepSeek's defaults apply. */
export interface DeepSeekModelOptions {
  /** Sent as `thinking: { type }`. DeepSeek enables thinking when this is unset. */
  thinking?: "enabled" | "disabled" | undefined;
  /** Sent as `reasoning_effort`. */
  reasoningEffort?: "none" | "low" | "high" | "max" | (string & {}) | undefined;
  /** Extra top-level request fields. */
  body?: Readonly<Record<string, unknown>> | undefined;
}

export interface DeepSeekOptions {
  /** An `openai` client you constructed with DeepSeek's base URL and your key. */
  client: OpenAI;
}

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

// https://api-docs.deepseek.com (checked 2026-11-17).
const QUIRKS: CompatQuirks = {
  reasoningField: "reasoning_content",
  // The docs require reasoning_content back on later turns when tools are used, and say it is
  // ignored otherwise. A recording without it still succeeded, so it is sent whenever we have it
  // and never required.
  echoReasoning: true,
  // No json_schema response format, only json_object.
  structuredOutput: { mode: "json_object" },
  maxTokensField: "max_tokens",
  finishReasons: {
    insufficient_system_resource: { error: { code: "provider_unavailable" } },
    aborted: { error: { code: "provider_unavailable" } },
  },
  // prompt_tokens_details.cached_tokens is preferred; this only fills it when it's missing.
  usage: (raw) => ({ cachedInputTokens: count(raw.prompt_cache_hit_tokens) }),
  classifyError: (shape) => (shape.status === 402 ? { code: "billing" } : undefined),
  options: (options) => {
    const fields: Record<string, unknown> = {};
    if (options.thinking !== undefined) fields.thinking = { type: options.thinking };
    if (options.reasoningEffort !== undefined) fields.reasoning_effort = options.reasoningEffort;
    // The typed options win over the same keys in `body`.
    return { ...(options.body as Record<string, unknown> | undefined), ...fields };
  },
};

/** DeepSeek on its OpenAI-compatible Chat Completions API. */
export function deepseek(options: DeepSeekOptions): ModelFactory<DeepSeekModelOptions> {
  return defineProvider<DeepSeekModelOptions>(compatAdapter(options.client, "deepseek", QUIRKS));
}
