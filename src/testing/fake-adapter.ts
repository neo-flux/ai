import {
  type Adapter,
  defineProvider,
  type ModelFactory,
  type ModelRequest,
  type ProviderDefaults,
  type StreamContext,
} from "../adapter.ts";
import type { StreamEvent } from "../events.ts";

export interface FakeTurn {
  /** Yielded in order. Not checked, so misbehaving adapters can be simulated. */
  events?: readonly StreamEvent[] | undefined;
  /** Thrown before the first event, as an SDK call failure would be. */
  throwBefore?: unknown;
  /** Thrown instead of yielding the event at `index`. */
  throwAfter?: { index: number; error: unknown } | undefined;
  /** Wait before each event. Abortable. */
  delayMs?: number | undefined;
}

export type FakeScript =
  | readonly FakeTurn[]
  | ((request: ModelRequest, ctx: StreamContext, call: number) => FakeTurn);

export interface FakeCall {
  modelId: string;
  request: ModelRequest;
  signal: AbortSignal;
}

export interface FakeProvider extends ModelFactory<unknown> {
  /** Every call to `stream`, in order. */
  readonly calls: readonly FakeCall[];
  /** How many streams were closed by the consumer before they finished. */
  readonly closedEarly: number;
}

export interface FakeAdapterOptions extends ProviderDefaults {
  provider?: string | undefined;
}

const abortError = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("This operation was aborted", "AbortError");

const wait = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });

/** A scripted adapter for tests. Returns a model factory, like a real adapter does. */
export function fakeAdapter(script: FakeScript, options: FakeAdapterOptions = {}): FakeProvider {
  const calls: FakeCall[] = [];
  let closedEarly = 0;

  const adapter: Adapter = {
    provider: options.provider ?? "fake",
    async *stream(request, ctx) {
      const call = calls.length;
      calls.push({ modelId: ctx.modelRef.id, request, signal: ctx.signal });
      const turn = typeof script === "function" ? script(request, ctx, call) : script[call];
      if (turn === undefined) throw new Error(`fakeAdapter: no scripted turn for call ${call}`);
      if ("throwBefore" in turn) throw turn.throwBefore;
      let finished = false;
      try {
        for (const [index, event] of (turn.events ?? []).entries()) {
          if (turn.delayMs !== undefined) await wait(turn.delayMs, ctx.signal);
          if (ctx.signal.aborted) throw abortError(ctx.signal);
          if (turn.throwAfter !== undefined && turn.throwAfter.index === index) {
            throw turn.throwAfter.error;
          }
          yield event;
        }
        finished = true;
      } catch (error) {
        finished = true;
        throw error;
      } finally {
        if (!finished) closedEarly++;
      }
    },
  };

  const factory = defineProvider(adapter, options);
  return Object.defineProperties(factory, {
    calls: { get: () => calls },
    closedEarly: { get: () => closedEarly },
  }) as FakeProvider;
}
