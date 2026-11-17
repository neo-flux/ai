import type { StandardSchemaV1Issue } from "./standard-schema.ts";

export type AIErrorCode =
  | "rate_limit"
  | "context_length"
  | "auth"
  | "content_filter"
  | "timeout"
  | "provider_unavailable"
  | "invalid_request"
  | "output_validation"
  | "aborted"
  | "unknown";

export interface AIErrorOptions {
  code: AIErrorCode;
  /** Defaults per code: rate_limit, timeout and provider_unavailable are retryable. */
  retryable?: boolean | undefined;
  provider?: string | undefined;
  status?: number | undefined;
  providerCode?: string | undefined;
  providerType?: string | undefined;
  retryAfterMs?: number | undefined;
  /** output_validation only: the model's last raw text. Never part of message or JSON. */
  rawText?: string | undefined;
  issues?: readonly StandardSchemaV1Issue[] | undefined;
  /**
   * The raw error from the provider or SDK. Kept out of the error object entirely, so logging,
   * `util.inspect`, JSON and `toString()` can't print it. Read it with `getProviderError()`.
   */
  providerError?: unknown;
  /** Library-made errors only (rule violations, invalid-request reasons). Never provider data. */
  cause?: unknown;
}

export interface AIErrorJSON {
  name: "AIError";
  code: AIErrorCode;
  retryable: boolean;
  provider?: string;
  status?: number;
  providerCode?: string;
  providerType?: string;
  retryAfterMs?: number;
}

// Shared across duplicate copies of this package, unlike the class itself.
const BRAND: symbol = Symbol.for("neoflux.ai.error");

// Raw provider errors live here, not on the AIError: Node's inspect prints `cause` and other
// non-enumerable properties, so nothing provider-made may be reachable from the object itself.
const providerErrors = new WeakMap<object, unknown>();

/**
 * The raw provider or SDK error behind an `AIError`, if there was one. It may contain anything the
 * provider sent back, including echoes of the request, so log it deliberately.
 */
export function getProviderError(error: AIError): unknown {
  return providerErrors.get(error);
}

const RETRYABLE: Record<AIErrorCode, boolean> = {
  rate_limit: true,
  timeout: true,
  provider_unavailable: true,
  context_length: false,
  auth: false,
  content_filter: false,
  invalid_request: false,
  output_validation: false,
  aborted: false,
  unknown: false,
};

// Provider-supplied identifiers are kept only when they can't carry free text.
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,64}$/;
const identifier = (value: string | undefined): string | undefined =>
  value !== undefined && IDENTIFIER.test(value) ? value : undefined;

export function isAIError(value: unknown): value is AIError {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<symbol, unknown>)[BRAND] === true
  );
}

export class AIError extends Error {
  static override [Symbol.hasInstance](value: unknown): boolean {
    return isAIError(value);
  }

  override readonly name: "AIError" = "AIError";
  readonly code: AIErrorCode;
  readonly retryable: boolean;
  readonly provider: string | undefined;
  readonly status: number | undefined;
  readonly providerCode: string | undefined;
  readonly providerType: string | undefined;
  readonly retryAfterMs: number | undefined;
  declare readonly rawText: string | undefined;
  declare readonly issues: readonly StandardSchemaV1Issue[] | undefined;

  constructor(options: AIErrorOptions) {
    const provider = identifier(options.provider);
    const where = [provider, options.status === undefined ? undefined : `HTTP ${options.status}`]
      .filter((part) => part !== undefined)
      .join(", ");
    super(
      where === "" ? options.code : `${options.code} (${where})`,
      "cause" in options ? { cause: options.cause } : undefined,
    );
    this.code = options.code;
    this.retryable =
      options.code === "aborted" ? false : (options.retryable ?? RETRYABLE[options.code]);
    this.provider = provider;
    this.status = options.status;
    this.providerCode = identifier(options.providerCode);
    this.providerType = identifier(options.providerType);
    this.retryAfterMs = clampRetryAfter(options.retryAfterMs);
    if ("providerError" in options) providerErrors.set(this, options.providerError);
    // Content-bearing fields stay off enumeration so logging and spreading can't leak them.
    Object.defineProperty(this, "rawText", { value: options.rawText, enumerable: false });
    Object.defineProperty(this, "issues", { value: options.issues, enumerable: false });
    Object.defineProperty(this, BRAND, { value: true, enumerable: false });
  }

  toJSON(): AIErrorJSON {
    const json: AIErrorJSON = { name: "AIError", code: this.code, retryable: this.retryable };
    if (this.provider !== undefined) json.provider = this.provider;
    if (this.status !== undefined) json.status = this.status;
    if (this.providerCode !== undefined) json.providerCode = this.providerCode;
    if (this.providerType !== undefined) json.providerType = this.providerType;
    if (this.retryAfterMs !== undefined) json.retryAfterMs = this.retryAfterMs;
    return json;
  }
}

/** A `Headers`-like object, or a plain record of header values. */
export type HeadersLike =
  | { get(name: string): string | null | undefined }
  | Readonly<Record<string, string | readonly string[] | undefined>>;

export function getHeader(headers: unknown, name: string): string | undefined {
  if (typeof headers !== "object" || headers === null) return undefined;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === "function") {
    const value: unknown = get.call(headers, name);
    return typeof value === "string" ? value : undefined;
  }
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  }
  return undefined;
}

const NUMBER = /^\d+(?:\.\d+)?$/;
const INTEGER = /^\d+$/;

/** The largest `retryAfterMs` the library reports: one hour. Longer waits are clamped to it. */
export const MAX_RETRY_AFTER_MS = 3_600_000;

/** Clamps to 0..MAX_RETRY_AFTER_MS. Negative, non-finite and missing values become undefined. */
export function clampRetryAfter(ms: number | undefined): number | undefined {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return undefined;
  return Math.min(Math.round(ms), MAX_RETRY_AFTER_MS);
}

export function parseRetryAfter(headers: unknown, now: number = Date.now()): number | undefined {
  const ms = getHeader(headers, "retry-after-ms")?.trim();
  if (ms !== undefined && NUMBER.test(ms)) return clampRetryAfter(Number(ms));
  const value = getHeader(headers, "retry-after")?.trim();
  if (value === undefined || value === "") return undefined;
  if (INTEGER.test(value)) return clampRetryAfter(Number(value) * 1000);
  if (/^-?\d/.test(value)) return undefined;
  const date = Date.parse(value);
  // A date in the past means the wait is already over: retry now.
  return Number.isNaN(date) ? undefined : clampRetryAfter(Math.max(0, date - now));
}

/** What core extracts from a thrown value, by shape only. */
export interface ErrorShape {
  status: number | undefined;
  type: string | undefined;
  code: string | undefined;
  name: string | undefined;
  headers: unknown;
}

export interface Classification {
  code: AIErrorCode;
  retryable?: boolean | undefined;
}

export interface ToAIErrorOptions {
  provider: string;
  /** Provider-specific mapping, consulted before the status defaults. */
  classify?: ((shape: ErrorShape, error: unknown) => Classification | undefined) | undefined;
  /** The caller's signal. If it is aborted, the error is `aborted` or `timeout`. */
  signal?: AbortSignal | undefined;
  now?: number | undefined;
}

const read = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) ? value : undefined;

export function errorShape(error: unknown): ErrorShape {
  const body = read(error, "error");
  return {
    status: num(read(error, "status")) ?? num(read(error, "statusCode")),
    type: str(read(error, "type")) ?? str(read(body, "type")),
    code: str(read(error, "code")) ?? str(read(body, "code")),
    name: str(read(error, "name")),
    headers: read(error, "headers"),
  };
}

const byStatus = (status: number): AIErrorCode | undefined => {
  if (status === 401 || status === 403) return "auth";
  if (status === 408) return "timeout";
  if (status === 413) return "context_length";
  if (status === 429) return "rate_limit";
  if (status >= 400 && status < 500) return "invalid_request";
  if (status >= 500 && status < 600) return "provider_unavailable";
  return undefined;
};

export function toAIError(error: unknown, options: ToAIErrorOptions): AIError {
  if (isAIError(error)) return error;
  const { provider, signal } = options;
  if (signal?.aborted === true) {
    const timedOut = str(read(signal.reason, "name")) === "TimeoutError";
    return new AIError({
      code: timedOut ? "timeout" : "aborted",
      retryable: false,
      provider,
      providerError: error,
    });
  }
  const shape = errorShape(error);
  const common = {
    provider,
    status: shape.status,
    providerCode: shape.code,
    providerType: shape.type,
    retryAfterMs: parseRetryAfter(shape.headers, options.now),
    providerError: error,
  };
  const classified = options.classify?.(shape, error);
  if (classified !== undefined) return new AIError({ ...common, ...classified });
  const code = shape.status === undefined ? undefined : byStatus(shape.status);
  if (code !== undefined) return new AIError({ ...common, code });
  if (shape.name === "TimeoutError") return new AIError({ ...common, code: "timeout" });
  if (shape.name === "AbortError") return new AIError({ ...common, code: "provider_unavailable" });
  return new AIError({ ...common, code: "unknown" });
}
