import type Anthropic from "@anthropic-ai/sdk";
import { type Adapter, defineProvider, type ModelFactory } from "../adapter.ts";
import { classifyAnthropicError } from "./errors.ts";
import { PROVIDER, toMessagesParams } from "./request.ts";
import { translateMessages } from "./stream.ts";

export { DEFAULT_MAX_TOKENS } from "./request.ts";

/** Model and call options for Anthropic. Call options (`providerOptions.anthropic`) win field by field. */
export interface AnthropicModelOptions {
  /**
   * Sent as `thinking`, unchanged. Its form depends on the model generation, for example
   * `{ type: "adaptive" }` or `{ type: "enabled", budget_tokens: 1024 }`.
   */
  thinking?: Readonly<Record<string, unknown>> | undefined;
  /** Sent as `output_config.effort`. */
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | (string & {}) | undefined;
  /** `max_tokens` when the call doesn't set `maxOutputTokens`. Default 4096. */
  maxTokens?: number | undefined;
  /** Extra top-level request fields. */
  body?: Readonly<Record<string, unknown>> | undefined;
}

export interface AnthropicOptions {
  /** An `@anthropic-ai/sdk` client you constructed. */
  client: Anthropic;
}

/** Anthropic on the Messages API. */
export function anthropic(options: AnthropicOptions): ModelFactory<AnthropicModelOptions> {
  const client = options.client;
  const create = (client as { messages?: { create?: unknown } } | undefined)?.messages?.create;
  if (typeof create !== "function") {
    throw new TypeError("client must be an @anthropic-ai/sdk client with messages.create");
  }
  const adapter: Adapter = {
    provider: PROVIDER,
    async *stream(request, ctx) {
      // Translation throws invalid_request before anything is sent.
      const params = toMessagesParams(request, ctx.modelRef);
      // Only create() and iteration are used, so a replay client can stand in for the SDK.
      const stream = await client.messages.create(
        params as unknown as Anthropic.MessageCreateParamsStreaming,
        { signal: ctx.signal },
      );
      yield* translateMessages(stream, ctx.signal);
    },
    classifyError: classifyAnthropicError,
  };
  return defineProvider<AnthropicModelOptions>(adapter);
}
