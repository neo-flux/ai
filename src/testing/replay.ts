import type { Fixture, RecordedError } from "./fixture.ts";

export interface ReplayCall {
  params: unknown;
  options: unknown;
}

type Create = (params: unknown, options?: unknown) => Promise<AsyncIterable<unknown>>;

/**
 * A structural stand-in for an SDK client, serving a fixture's calls in order. It has only the
 * recorded API's `create` method. Cast it to the SDK type in adapter tests.
 */
export interface ReplayClient {
  readonly calls: readonly ReplayCall[];
  readonly responses?: { create: Create };
  readonly chat?: { completions: { create: Create } };
  readonly messages?: { create: Create };
}

// Rebuilt as an Error with the SDK's fields, so mapping by shape sees what it would see live.
function rebuild(recorded: RecordedError): Error {
  const { name, status, message, headers, ...fields } = recorded;
  const error = Object.assign(new Error(message ?? ""), fields, {
    status: status ?? undefined,
    headers: new Headers(headers),
  });
  if (name !== null) error.name = name;
  return error;
}

function signalOf(options: unknown): AbortSignal | undefined {
  if (typeof options !== "object" || options === null) return undefined;
  const signal = (options as { signal?: unknown }).signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

export function replayClient(fixture: Fixture): ReplayClient {
  const calls: ReplayCall[] = [];

  const create: Create = async (params, options) => {
    const index = calls.length;
    calls.push({ params, options });
    const recorded = fixture.calls[index];
    if (recorded === undefined) {
      throw new Error(
        `replay: fixture has ${fixture.calls.length} call(s), call ${index + 1} requested`,
      );
    }
    const error = recorded.error;
    if (error?.phase === "create") throw rebuild(error.error);
    const signal = signalOf(options);
    const chunks = recorded.chunks.map((chunk) => structuredClone(chunk));
    return {
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) {
          // Both SDKs end the iteration without throwing when the caller aborts.
          if (signal?.aborted === true) return;
          yield chunk;
        }
        if (signal?.aborted === true) return;
        if (error !== undefined) throw rebuild(error.error);
      },
    };
  };

  const base = {
    get calls(): readonly ReplayCall[] {
      return calls;
    },
  };
  switch (fixture.meta.api) {
    case "responses":
      return Object.defineProperty(base, "responses", { value: { create }, enumerable: true });
    case "chat.completions":
      return Object.defineProperty(base, "chat", {
        value: { completions: { create } },
        enumerable: true,
      });
    case "messages":
      return Object.defineProperty(base, "messages", { value: { create }, enumerable: true });
  }
}
