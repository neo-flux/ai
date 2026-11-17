// Records one case by driving an SDK client directly. The client is injected, so this engine is
// tested with fakes; scripts/record.ts builds the real ones.
import type {
  Fixture,
  FixtureApi,
  FixtureCall,
  FixtureError,
  RecordedError,
} from "../../src/testing/fixture.ts";

export interface RequestOptions {
  signal: AbortSignal;
  maxRetries: 0;
  timeout?: number;
}

export interface Connection {
  create(
    api: FixtureApi,
    params: unknown,
    options: RequestOptions,
  ): Promise<AsyncIterable<unknown>>;
}

export type Connect = (options: { invalidKey: boolean }) => Connection;

export interface PlannedCall {
  params: unknown;
  timeoutMs?: number | undefined;
  abortAfterChunks?: number | undefined;
  /** Connect with a key that is obviously fake, for the auth error case. */
  invalidKey?: boolean | undefined;
}

export interface BuildInput {
  turn: number;
  model: string;
  previous: readonly FixtureCall[];
}

export interface CaseSpec {
  id: string;
  api: FixtureApi;
  turns: number;
  build(input: BuildInput): PlannedCall;
}

export interface RecordContext {
  provider: string;
  sdk: string;
  model: string;
  recordedOn: string;
  connect: Connect;
}

// Allowlist, not denylist: anything a provider adds later is dropped by default. Rate-limit
// headers are dropped on purpose because they reveal the account's tier.
export const ALLOWED_HEADERS: readonly string[] = ["content-type", "retry-after", "retry-after-ms"];

export function allowlistHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof headers !== "object" || headers === null) return out;
  const entries: Iterable<[string, unknown]> =
    headers instanceof Headers ? headers.entries() : Object.entries(headers);
  for (const [key, value] of entries) {
    const name = key.toLowerCase();
    if (ALLOWED_HEADERS.includes(name) && typeof value === "string") out[name] = value;
  }
  return out;
}

const clone = (value: unknown): unknown =>
  value === undefined ? null : JSON.parse(JSON.stringify(value));

const OPTIONAL_FIELDS = ["code", "type", "param", "errorCode", "details", "apiMessage"] as const;

/** An SDK error reduced to its shape. Request ids, workspace ids and other headers are dropped. */
export function serializeError(error: unknown): RecordedError {
  const e = typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const recorded: RecordedError = {
    name: typeof e.name === "string" ? e.name : null,
    status: typeof e.status === "number" ? e.status : null,
    message: typeof error === "string" ? error : typeof e.message === "string" ? e.message : null,
    error: clone(e.error),
    headers: {},
  };
  for (const field of OPTIONAL_FIELDS) {
    if (field in e) recorded[field] = clone(e[field]);
  }
  recorded.headers = allowlistHeaders(e.headers);
  return recorded;
}

async function recordCall(
  index: number,
  planned: PlannedCall,
  spec: CaseSpec,
  connect: Connect,
): Promise<FixtureCall> {
  const call: FixtureCall = {
    index,
    request: clone(planned.params),
    options: {},
    chunks: [],
    outcome: "completed",
  };
  if (planned.abortAfterChunks !== undefined)
    call.options.abortAfterChunks = planned.abortAfterChunks;
  if (planned.timeoutMs !== undefined) call.options.timeoutMs = planned.timeoutMs;

  const controller = new AbortController();
  const options: RequestOptions = { signal: controller.signal, maxRetries: 0 };
  if (planned.timeoutMs !== undefined) options.timeout = planned.timeoutMs;
  const client = connect({ invalidKey: planned.invalidKey === true });

  let phase: FixtureError["phase"] = "create";
  try {
    const stream = await client.create(spec.api, planned.params, options);
    phase = "stream";
    for await (const item of stream) {
      call.chunks.push(clone(item));
      if (call.chunks.length === planned.abortAfterChunks) controller.abort();
    }
    if (controller.signal.aborted) call.outcome = "returned-after-abort";
  } catch (error) {
    call.outcome = "threw";
    call.error = { phase, afterChunks: call.chunks.length, error: serializeError(error) };
  }
  return call;
}

export async function recordCase(spec: CaseSpec, ctx: RecordContext): Promise<Fixture> {
  const calls: FixtureCall[] = [];
  for (let turn = 0; turn < spec.turns; turn++) {
    const planned = spec.build({ turn, model: ctx.model, previous: calls });
    const call = await recordCall(turn, planned, spec, ctx.connect);
    calls.push(call);
    if (call.outcome === "threw") break;
  }
  return {
    meta: {
      kind: "meta",
      format: 1,
      provider: ctx.provider,
      case: spec.id,
      api: spec.api,
      sdk: ctx.sdk,
      model: ctx.model,
      recordedOn: ctx.recordedOn,
    },
    calls,
  };
}
