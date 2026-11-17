import type { ModelRef } from "./adapter.ts";
import type { FinishReason, StreamEvent } from "./events.ts";
import type { AssistantMessage } from "./messages.ts";
import { type CallOptions, execute, type Outcome, type RunInternal } from "./run.ts";
import { parseToolCall, type ToolCallOf, type Tools } from "./tools.ts";
import type { Usage } from "./usage.ts";

export type StreamTextOptions<T extends Tools = Tools> = CallOptions<T>;

export interface TextResult<T extends Tools = Tools> {
  /** All text parts, joined. */
  text: string;
  /** All reasoning parts, joined, or undefined if the model produced none. */
  reasoning: string | undefined;
  /** Append to the history for the next turn. Carries provider metadata. */
  message: AssistantMessage;
  /** Parsed and validated. Invalid calls carry an `error` instead of throwing. */
  toolCalls: ToolCallOf<T>[];
  finishReason: FinishReason;
  usage: Usage;
  cost: number | undefined;
  /** The model that answered. */
  modelRef: ModelRef;
}

/**
 * Iterate it once for events, await `result` for the folded answer, or both. Nothing is sent
 * until one of those starts.
 */
export interface TextStream<T extends Tools = Tools> extends AsyncIterable<StreamEvent> {
  readonly result: Promise<TextResult<T>>;
}

export async function toTextResult<T extends Tools>(
  outcome: Outcome,
  tools: T | undefined,
): Promise<TextResult<T>> {
  const folded = outcome.folded;
  if (folded === undefined || outcome.modelRef === undefined || folded.finishReason === undefined) {
    throw outcome.error;
  }
  const message: AssistantMessage = { role: "assistant", content: folded.content };
  if (folded.providerMetadata !== undefined) message.providerMetadata = folded.providerMetadata;
  return {
    text: folded.text,
    reasoning: folded.reasoning,
    message,
    toolCalls: await Promise.all(
      folded.toolCalls.map((c) =>
        parseToolCall(tools, c.id, c.name, c.rawInput, c.providerMetadata),
      ),
    ),
    finishReason: folded.finishReason,
    usage: outcome.usage,
    cost: outcome.cost,
    modelRef: outcome.modelRef,
  };
}

interface Started {
  outcome: Promise<Outcome>;
}

/** Runs the engine once, buffering events so the iterator and `result` share one request. */
export class Stream<T extends Tools = Tools> implements TextStream<T> {
  readonly #options: CallOptions<T>;
  readonly #internal: RunInternal;
  readonly #controller = new AbortController();
  readonly #events: StreamEvent[] = [];
  #started: Started | undefined;
  #done = false;
  #failure: { value: unknown } | undefined;
  #wake: (() => void) | undefined;
  #iterated = false;
  #result: Promise<TextResult<T>> | undefined;

  constructor(options: CallOptions<T>, internal: RunInternal) {
    this.#options = options;
    this.#internal = internal;
  }

  /** The engine's outcome. Starts the request on first access. */
  get outcome(): Promise<Outcome> {
    return this.#start().outcome;
  }

  get result(): Promise<TextResult<T>> {
    this.#result ??= this.outcome.then((outcome) => toTextResult(outcome, this.#options.tools));
    return this.#result;
  }

  #start(): Started {
    if (this.#started !== undefined) return this.#started;
    const caller = this.#options.signal;
    const signal =
      caller === undefined
        ? this.#controller.signal
        : AbortSignal.any([caller, this.#controller.signal]);
    const outcome = this.#pump(signal);
    // Nobody may ever read `result`; a failed call must not become an unhandled rejection.
    outcome.catch(() => {});
    this.#started = { outcome };
    return this.#started;
  }

  async #pump(signal: AbortSignal): Promise<Outcome> {
    const engine = execute(this.#options, this.#internal, signal);
    try {
      while (true) {
        const step = await engine.next();
        if (step.done === true) return step.value;
        this.#events.push(step.value);
        this.#notify();
      }
    } catch (error) {
      this.#failure = { value: error };
      throw error;
    } finally {
      this.#done = true;
      this.#notify();
    }
  }

  #notify(): void {
    const wake = this.#wake;
    this.#wake = undefined;
    wake?.();
  }

  [Symbol.asyncIterator](): AsyncIterator<StreamEvent> {
    if (this.#iterated) throw new TypeError("a streamText result can only be iterated once");
    this.#iterated = true;
    let index = 0;
    let closed = false;
    let thrown = false;
    const next = async (): Promise<IteratorResult<StreamEvent>> => {
      this.#start();
      while (!closed) {
        const event = this.#events[index];
        if (event !== undefined) {
          index++;
          return { done: false, value: event };
        }
        if (this.#done) {
          if (this.#failure !== undefined && !thrown) {
            thrown = true;
            throw this.#failure.value;
          }
          break;
        }
        await new Promise<void>((resolve) => {
          this.#wake = resolve;
        });
      }
      return { done: true, value: undefined };
    };
    const stop = async (): Promise<IteratorResult<StreamEvent>> => {
      closed = true;
      if (this.#started !== undefined && !this.#done) {
        this.#controller.abort();
        await this.#started.outcome.catch(() => {});
      }
      return { done: true, value: undefined };
    };
    return { next, return: stop };
  }
}

/** Streams one call. See `docs/events.md` for the events and their order. */
export function streamText<T extends Tools = Tools>(options: StreamTextOptions<T>): TextStream<T> {
  return new Stream(options, { kind: "initial", attemptStart: 0 });
}
