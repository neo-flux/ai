import type OpenAI from "openai";
import { defineProvider, type ModelFactory } from "../adapter.ts";
import { compatAdapter } from "./adapter.ts";
import type { CompatModelOptions, CompatQuirks } from "./quirks.ts";

export type { CompatModelOptions, CompatQuirks, FinishReasonError } from "./quirks.ts";

export interface OpenAICompatibleOptions {
  /** An `openai` client you constructed, pointed at the server's base URL. */
  client: OpenAI;
  /** The name used in errors and to key provider metadata. Default `openai-compatible`. */
  provider?: string | undefined;
  /** Server differences. Unstable in 0.x. */
  quirks?: CompatQuirks | undefined;
}

/**
 * A model factory for any server that speaks OpenAI Chat Completions, such as Groq, OpenRouter,
 * vLLM or Ollama. The quirks interface is unstable in 0.x. `Options` types the model options
 * when a `quirks.options` function reads more than `body`.
 */
export function openaiCompatible<Options extends object = CompatModelOptions>(
  options: OpenAICompatibleOptions,
): ModelFactory<Options> {
  const provider = options.provider ?? "openai-compatible";
  return defineProvider<Options>(compatAdapter(options.client, provider, options.quirks));
}
