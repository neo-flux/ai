import type { ModelRef, ModelRequest } from "./adapter.ts";
import type { AIError } from "./errors.ts";
import type { Usage } from "./usage.ts";

export interface CallContext {
  readonly signal: AbortSignal;
}

export interface AttemptContext {
  readonly modelRef: ModelRef;
  /** 0-based, counted across the fallback chain and the repair attempt. */
  readonly attempt: number;
  readonly kind: "initial" | "repair";
  readonly signal: AbortSignal;
}

export interface UsageInfo {
  readonly usage: Usage;
  readonly cost: number | undefined;
  readonly ctx: AttemptContext;
}

export interface ErrorContext extends AttemptContext {
  /** Whether the next model in the chain will be tried. */
  readonly willFallback: boolean;
}

/**
 * All hooks are awaited. Anything a hook throws propagates unchanged: it is not wrapped, it does
 * not trigger fallback, and `onError` is not called for it.
 */
export interface Hooks {
  /** Replaces the model list once per call, before the first attempt. */
  resolveModel?:
    | ((
        models: readonly ModelRef[],
        ctx: CallContext,
      ) => readonly ModelRef[] | Promise<readonly ModelRef[]>)
    | undefined;
  /** Runs before every attempt. Return a request to replace it, or throw to reject the call. */
  beforeRequest?:
    | ((
        request: ModelRequest,
        ctx: AttemptContext,
      ) => ModelRequest | undefined | Promise<ModelRequest | undefined>)
    | undefined;
  /** Runs after every attempt that reported usage, including failed ones. */
  onUsage?: ((info: UsageInfo) => void | Promise<void>) | undefined;
  /** Runs after every failed attempt. */
  onError?: ((error: AIError, ctx: ErrorContext) => void | Promise<void>) | undefined;
}
