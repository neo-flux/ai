import type { Classification, ErrorShape } from "../errors.ts";
import type { FinishReason } from "../events.ts";
import type { UsageReport } from "../usage.ts";

/** A provider finish reason that means the answer failed, not that it finished. */
export interface FinishReasonError {
  error: Classification;
}

/**
 * What differs between servers that speak Chat Completions. **Unstable in 0.x**: fields may be
 * renamed or removed in a minor release while more providers are added.
 */
export interface CompatQuirks {
  /** The delta and assistant-message field that carries reasoning text, e.g. `reasoning_content`. */
  reasoningField?: string | undefined;
  /** Send the provider's own reasoning back on assistant messages in later turns. */
  echoReasoning?: boolean | undefined;
  /** How `output` (structured output) is requested. Default `json_schema`. */
  structuredOutput?:
    | { mode: "json_schema"; strict?: boolean | undefined }
    | { mode: "json_object" }
    | undefined;
  /** The request field for `maxOutputTokens`. Default `max_tokens`. */
  maxTokensField?: "max_tokens" | "max_completion_tokens" | undefined;
  /** Send `stream_options: { include_usage: true }`. Default true. */
  streamUsage?: boolean | undefined;
  /** Extra `finish_reason` values: a normalized reason, or an error to raise instead. */
  finishReasons?: Readonly<Record<string, FinishReason | FinishReasonError>> | undefined;
  /** Usage fields the standard mapping left undefined, read from the raw usage object. */
  usage?: ((raw: Record<string, unknown>) => Partial<UsageReport>) | undefined;
  /** Provider error mapping, consulted before the compat and status defaults. */
  classifyError?: ((shape: ErrorShape, error: unknown) => Classification | undefined) | undefined;
  /**
   * Turns the merged model and call options into top-level request fields. The default sends
   * `options.body` as is.
   */
  options?: ((options: Record<string, unknown>) => Record<string, unknown>) | undefined;
}

/** Model and call options for `openaiCompatible`. */
export interface CompatModelOptions {
  /** Extra top-level request fields, for a server's own parameters. */
  body?: Readonly<Record<string, unknown>> | undefined;
}

export interface ResolvedQuirks {
  reasoningField: string | undefined;
  echoReasoning: boolean;
  structuredOutput: { mode: "json_schema"; strict?: boolean | undefined } | { mode: "json_object" };
  maxTokensField: "max_tokens" | "max_completion_tokens";
  streamUsage: boolean;
  finishReasons: Readonly<Record<string, FinishReason | FinishReasonError>>;
  usage: ((raw: Record<string, unknown>) => Partial<UsageReport>) | undefined;
  classifyError: ((shape: ErrorShape, error: unknown) => Classification | undefined) | undefined;
  options: (options: Record<string, unknown>) => Record<string, unknown>;
}

const bodyOnly = (options: Record<string, unknown>): Record<string, unknown> =>
  (options.body as Record<string, unknown> | undefined) ?? {};

export function resolveQuirks(quirks: CompatQuirks = {}): ResolvedQuirks {
  return {
    reasoningField: quirks.reasoningField,
    echoReasoning: quirks.echoReasoning ?? false,
    structuredOutput: quirks.structuredOutput ?? { mode: "json_schema" },
    maxTokensField: quirks.maxTokensField ?? "max_tokens",
    streamUsage: quirks.streamUsage ?? true,
    finishReasons: quirks.finishReasons ?? {},
    usage: quirks.usage,
    classifyError: quirks.classifyError,
    options: quirks.options ?? bodyOnly,
  };
}

/** Request fields the adapter derives from the request. Options may not set them. */
export const RESERVED_KEYS: readonly string[] = [
  "model",
  "messages",
  "stream",
  "stream_options",
  "tools",
  "tool_choice",
  "response_format",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "n",
];
