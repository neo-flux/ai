import { AIError, type Classification, type ErrorShape } from "./errors.ts";
import type { StreamEvent } from "./events.ts";
import type { Message } from "./messages.ts";
import type { StandardJSONSchemaV1Target } from "./standard-schema.ts";
import type { PreparedTool } from "./tools.ts";

export type ToolChoice = "auto" | "none" | "required" | { readonly name: string };

/** The normalized request an adapter translates. Schemas are already JSON Schema. */
export interface ModelRequest {
  readonly messages: readonly Message[];
  readonly tools?: readonly PreparedTool[] | undefined;
  readonly toolChoice?: ToolChoice | undefined;
  /** Structured output: the provider should answer with JSON matching `schema`. */
  readonly output?: { readonly name: string; readonly schema: Record<string, unknown> } | undefined;
  readonly maxOutputTokens?: number | undefined;
  readonly temperature?: number | undefined;
  /** Keyed by provider name. Opaque to core. */
  readonly providerOptions?: Readonly<Record<string, unknown>> | undefined;
}

export interface StreamContext {
  /** Pass to the SDK call. Aborted when the caller aborts or stops reading. */
  readonly signal: AbortSignal;
  readonly modelRef: ModelRef;
}

/**
 * The one thing an adapter implements: translate a request into SDK calls and the SDK's stream
 * into `StreamEvent`s. Report failure by throwing. Everything else is core's job.
 */
export interface Adapter {
  readonly provider: string;
  stream(request: ModelRequest, ctx: StreamContext): AsyncIterable<StreamEvent>;
  /** Provider-specific error mapping, consulted before core's HTTP status defaults. */
  classifyError?: ((shape: ErrorShape, error: unknown) => Classification | undefined) | undefined;
}

export interface ModelRef<Options = unknown> {
  readonly provider: string;
  readonly id: string;
  readonly options: Options | undefined;
  readonly adapter: Adapter;
  /** The JSON Schema target tool and output schemas are converted to. */
  readonly jsonSchemaTarget: StandardJSONSchemaV1Target;
}

export type ModelFactory<Options = unknown> = (id: string, options?: Options) => ModelRef<Options>;

export interface ProviderDefaults {
  jsonSchemaTarget?: StandardJSONSchemaV1Target | undefined;
}

export function defineProvider<Options = unknown>(
  adapter: Adapter,
  defaults: ProviderDefaults = {},
): ModelFactory<Options> {
  return (id, options) => {
    if (typeof id !== "string" || id === "") {
      throw new AIError({
        code: "invalid_request",
        provider: adapter.provider,
        cause: new TypeError("model id must be a non-empty string"),
      });
    }
    return Object.freeze({
      provider: adapter.provider,
      id,
      options,
      adapter,
      jsonSchemaTarget: defaults.jsonSchemaTarget ?? "draft-2020-12",
    });
  };
}

export function isModelRef(value: unknown): value is ModelRef {
  if (typeof value !== "object" || value === null) return false;
  const ref = value as Record<string, unknown>;
  const adapter = ref.adapter as Record<string, unknown> | undefined;
  return (
    typeof ref.provider === "string" &&
    typeof ref.id === "string" &&
    typeof ref.jsonSchemaTarget === "string" &&
    typeof adapter === "object" &&
    adapter !== null &&
    typeof adapter.stream === "function"
  );
}
