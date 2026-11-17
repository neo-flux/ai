import { isModelRef, type ModelRef, type ModelRequest, type ToolChoice } from "./adapter.ts";
import { computeCost, type Price } from "./cost.ts";
import { AIError, isAIError, toAIError } from "./errors.ts";
import { EventOrder, EventOrderError, type StreamEvent } from "./events.ts";
import { Fold, type Folded } from "./fold.ts";
import type { AttemptContext, Hooks } from "./hooks.ts";
import { type Message, validateMessages } from "./messages.ts";
import { type Schema, toJsonSchema } from "./schema.ts";
import { prepareTools, type Tools } from "./tools.ts";
import { normalizeUsage, type Usage } from "./usage.ts";

export interface CallOptions<T extends Tools = Tools> {
  /** One model, or a fallback chain tried in order. */
  model: ModelRef | readonly ModelRef[];
  messages: readonly Message[];
  tools?: T | undefined;
  toolChoice?: ToolChoice | undefined;
  maxOutputTokens?: number | undefined;
  temperature?: number | undefined;
  /** Keyed by provider name, passed to that provider's adapter. */
  providerOptions?: Readonly<Record<string, unknown>> | undefined;
  signal?: AbortSignal | undefined;
  hooks?: Hooks | undefined;
  /** Prices for cost reporting. No prices ship with the library. */
  price?: ((modelRef: ModelRef) => Price | undefined) | undefined;
}

export interface RunInternal {
  output?: Schema | undefined;
  kind: "initial" | "repair";
  attemptStart: number;
  /** Use exactly these models and skip `resolveModel`. */
  fixedModels?: readonly ModelRef[] | undefined;
}

export interface Outcome {
  folded: Folded | undefined;
  modelRef: ModelRef | undefined;
  usage: Usage;
  cost: number | undefined;
  error: AIError | undefined;
  attempts: number;
}

const invalid = (reason: string): AIError =>
  new AIError({ code: "invalid_request", cause: new TypeError(reason) });

const asAIError = (error: unknown, provider?: string): AIError =>
  isAIError(error) ? error : new AIError({ code: "unknown", provider, cause: error });

function buildRequest(
  options: CallOptions,
  internal: RunInternal,
  modelRef: ModelRef,
): ModelRequest {
  const tools = prepareTools(options.tools, modelRef.jsonSchemaTarget);
  const choice = options.toolChoice;
  if (typeof choice === "object" && !tools?.some((t) => t.name === choice.name)) {
    throw invalid("toolChoice names a tool that isn't in tools");
  }
  const request: { -readonly [K in keyof ModelRequest]: ModelRequest[K] } = {
    messages: options.messages,
  };
  if (tools !== undefined) request.tools = tools;
  if (choice !== undefined) request.toolChoice = choice;
  if (internal.output !== undefined) {
    request.output = {
      name: "output",
      schema: toJsonSchema(internal.output, modelRef.jsonSchemaTarget),
    };
  }
  if (options.maxOutputTokens !== undefined) request.maxOutputTokens = options.maxOutputTokens;
  if (options.temperature !== undefined) request.temperature = options.temperature;
  if (options.providerOptions !== undefined) request.providerOptions = options.providerOptions;
  return request;
}

function checkRequest(request: unknown): asserts request is ModelRequest {
  if (typeof request !== "object" || request === null) {
    throw invalid("beforeRequest returned a non-object");
  }
  validateMessages((request as ModelRequest).messages);
}

// Races the adapter against the signal, so an adapter that ignores aborts can't hang the call.
function nextOrAbort(
  iterator: AsyncIterator<StreamEvent>,
  signal: AbortSignal,
): Promise<IteratorResult<StreamEvent>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    iterator.next().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

// Resolves when the signal aborts. The listener is removed by `done`.
function aborted(signal: AbortSignal): { promise: Promise<void>; done: () => void } {
  let done = (): void => {};
  const promise = new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    done = () => signal.removeEventListener("abort", onAbort);
  });
  return { promise, done };
}

async function close(iterator: AsyncIterator<StreamEvent>, signal: AbortSignal): Promise<void> {
  try {
    const closing = Promise.resolve(iterator.return?.());
    closing.catch(() => {});
    // An adapter stuck mid-next or in its own cleanup can't hold the call past an abort.
    const abort = aborted(signal);
    try {
      await Promise.race([closing, abort.promise]);
    } finally {
      abort.done();
    }
  } catch {
    // An adapter failing to clean up must not mask the outcome.
  }
}

/**
 * The engine behind `streamText` and `generate`: model resolution, validation, the fallback
 * loop, hooks, order enforcement and abort. Yields events for the caller and returns the outcome.
 * Errors thrown by hooks or `price` propagate unchanged.
 */
export async function* execute(
  options: CallOptions,
  internal: RunInternal,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent, Outcome, undefined> {
  const hooks = options.hooks ?? {};
  let attempt = internal.attemptStart;
  const finish = (error: AIError | undefined, rest: Partial<Outcome> = {}): Outcome => ({
    folded: undefined,
    modelRef: undefined,
    usage: normalizeUsage(undefined),
    cost: undefined,
    ...rest,
    error,
    attempts: attempt - internal.attemptStart,
  });

  let models: readonly ModelRef[] | undefined = internal.fixedModels;
  if (models === undefined) {
    models = Array.isArray(options.model)
      ? (options.model as readonly ModelRef[])
      : [options.model as ModelRef];
    if (hooks.resolveModel !== undefined) models = await hooks.resolveModel(models, { signal });
  }
  let setupError: AIError | undefined;
  if (!Array.isArray(models) || models.length === 0 || !models.every(isModelRef)) {
    setupError = invalid("model must be a model or a non-empty list of models");
  } else if ("output" in options && internal.output === undefined) {
    setupError = invalid("output is only supported by generate");
  } else {
    try {
      validateMessages(options.messages);
    } catch (error) {
      setupError = asAIError(error);
    }
  }
  if (setupError !== undefined) {
    yield { type: "error", error: setupError };
    return finish(setupError);
  }

  let delivered = false;
  for (const [i, modelRef] of (models as readonly ModelRef[]).entries()) {
    const provider = modelRef.provider;
    if (signal.aborted) {
      const error = toAIError(signal.reason, { provider, signal });
      yield { type: "error", error };
      return finish(error);
    }
    const ctx: AttemptContext = { modelRef, attempt: attempt++, kind: internal.kind, signal };

    let request: ModelRequest;
    try {
      request = buildRequest(options, internal, modelRef);
    } catch (error) {
      const e = asAIError(error, provider);
      yield { type: "error", error: e };
      return finish(e);
    }
    if (hooks.beforeRequest !== undefined) {
      const replaced = await hooks.beforeRequest(request, ctx);
      if (replaced !== undefined) {
        try {
          checkRequest(replaced);
        } catch (error) {
          const e = asAIError(error, provider);
          yield { type: "error", error: e };
          return finish(e);
        }
        request = replaced;
      }
    }

    const order = new EventOrder();
    const fold = new Fold();
    let failure: AIError | undefined;
    let held: StreamEvent | undefined;
    let iterator: AsyncIterator<StreamEvent> | undefined;
    let exhausted = false;
    try {
      iterator = modelRef.adapter.stream(request, { signal, modelRef })[Symbol.asyncIterator]();
      while (true) {
        const result = await nextOrAbort(iterator, signal);
        if (result.done === true) {
          exhausted = true;
          break;
        }
        const event = result.value;
        if (typeof event === "object" && event !== null && event.type === "error") {
          throw (event as { error: unknown }).error;
        }
        order.push(event);
        fold.push(event);
        // The terminal event waits until usage, cost and hooks are done, so nothing can follow it.
        if (event.type === "finish") {
          held = event;
          continue;
        }
        delivered = true;
        yield event;
      }
      order.end();
    } catch (error) {
      failure =
        error instanceof EventOrderError
          ? new AIError({ code: "unknown", provider, cause: error })
          : toAIError(error, { provider, classify: modelRef.adapter.classifyError, signal });
    } finally {
      if (!exhausted && iterator !== undefined) await close(iterator, signal);
    }

    const folded = fold.result();
    let usage = normalizeUsage(undefined);
    try {
      usage = normalizeUsage(fold.usage);
    } catch (error) {
      failure ??= asAIError(error, provider);
    }
    let cost: number | undefined;
    if (fold.usage !== undefined) {
      const price = options.price?.(modelRef);
      if (price !== undefined) {
        try {
          cost = computeCost(usage, price);
        } catch (error) {
          failure ??= asAIError(error, provider);
        }
      }
      if (hooks.onUsage !== undefined) await hooks.onUsage({ usage, cost, ctx });
    }

    if (failure === undefined && held !== undefined) {
      yield held;
      return finish(undefined, { folded, modelRef, usage, cost });
    }
    const error = failure ?? new AIError({ code: "unknown", provider });
    // A caller abort needs no check here: it always classifies with `failover: false`.
    const willFallback = error.failover && !delivered && i < (models as ModelRef[]).length - 1;
    if (hooks.onError !== undefined) await hooks.onError(error, { ...ctx, willFallback });
    if (!willFallback) {
      yield { type: "error", error };
      return finish(error, { folded, modelRef, usage, cost });
    }
  }
  // Unreachable: the last model never falls back.
  const error = new AIError({ code: "unknown" });
  yield { type: "error", error };
  return finish(error);
}
