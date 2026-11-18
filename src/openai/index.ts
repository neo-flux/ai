import type OpenAI from "openai";
import { type Adapter, defineProvider, type ModelFactory } from "../adapter.ts";
import { classifyOpenAIError } from "./errors.ts";
import { PROVIDER, toResponsesParams } from "./request.ts";
import { translateResponses } from "./stream.ts";

/** Model and call options for OpenAI. Call options (`providerOptions.openai`) win field by field. */
export interface OpenAIModelOptions {
  /** Sent as `reasoning`, e.g. `{ effort: "low", summary: "auto" }`. */
  reasoning?: Readonly<Record<string, unknown>> | undefined;
  /** Default `false`: the caller sends the full history every turn. */
  store?: boolean | undefined;
  /** Default: `["reasoning.encrypted_content"]` when `reasoning` is set and `store` is false. */
  include?: readonly string[] | undefined;
  /** Send tools and `text.format` with strict schema validation. Default `false`. */
  strictSchemas?: boolean | undefined;
  /** Extra top-level request fields. */
  body?: Readonly<Record<string, unknown>> | undefined;
}

export interface OpenAIOptions {
  /** An `openai` client you constructed. */
  client: OpenAI;
}

/** OpenAI on the Responses API. */
export function openai(options: OpenAIOptions): ModelFactory<OpenAIModelOptions> {
  const client = options.client;
  const create = (client as { responses?: { create?: unknown } } | undefined)?.responses?.create;
  if (typeof create !== "function") {
    throw new TypeError("client must be an openai client with responses.create");
  }
  const adapter: Adapter = {
    provider: PROVIDER,
    async *stream(request, ctx) {
      // Translation throws invalid_request before anything is sent.
      const params = toResponsesParams(request, ctx.modelRef);
      // Only create() and iteration are used, so a replay client can stand in for the SDK.
      const stream = await client.responses.create(
        params as unknown as OpenAI.Responses.ResponseCreateParamsStreaming,
        { signal: ctx.signal },
      );
      yield* translateResponses(stream, ctx.signal);
    },
    classifyError: classifyOpenAIError,
  };
  return defineProvider<OpenAIModelOptions>(adapter);
}
