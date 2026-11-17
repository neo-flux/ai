import type OpenAI from "openai";
import type { Adapter } from "../adapter.ts";
import { classifyCompatError } from "./errors.ts";
import { type CompatQuirks, resolveQuirks } from "./quirks.ts";
import { toChatParams } from "./request.ts";
import { translateStream } from "./stream.ts";

// Provider names key metadata and appear in error messages, so they stay short identifiers.
const PROVIDER_NAME = /^[A-Za-z0-9_.:-]{1,64}$/;

/** The Chat Completions adapter shared by `openaiCompatible` and the provider entries. */
export function compatAdapter(
  client: OpenAI,
  provider: string,
  quirks: CompatQuirks = {},
): Adapter {
  const create = (client as { chat?: { completions?: { create?: unknown } } } | undefined)?.chat
    ?.completions?.create;
  if (typeof create !== "function") {
    throw new TypeError("client must be an openai client with chat.completions.create");
  }
  if (!PROVIDER_NAME.test(provider)) {
    throw new TypeError("provider must be 1-64 letters, digits, or _ . : -");
  }
  const resolved = resolveQuirks(quirks);
  return {
    provider,
    async *stream(request, ctx) {
      // Translation throws invalid_request before anything is sent.
      const params = toChatParams(request, ctx.modelRef, resolved, provider);
      // Only create() and iteration are used, so a replay client can stand in for the SDK.
      const stream = await client.chat.completions.create(
        params as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
        { signal: ctx.signal },
      );
      yield* translateStream(stream, resolved, provider, ctx.signal);
    },
    classifyError: classifyCompatError(resolved),
  };
}
