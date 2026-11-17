// Recorded provider streams, one JSONL file per case. See docs/fixtures.md. Unstable in 0.x.

export type FixtureApi = "responses" | "chat.completions" | "messages";
export type FixtureOutcome = "completed" | "returned-after-abort" | "threw";

export interface FixtureMeta {
  kind: "meta";
  format: 1;
  provider: string;
  case: string;
  api: FixtureApi;
  /** The SDK and version that recorded it, e.g. `openai@7.57.0`. */
  sdk: string;
  model: string;
  recordedOn: string;
}

export interface FixtureCallOptions {
  timeoutMs?: number | undefined;
  abortAfterChunks?: number | null | undefined;
}

/** An SDK error reduced to its shape. Headers are allowlisted. */
export interface RecordedError {
  name: string | null;
  status: number | null;
  message: string | null;
  /** The SDK's `.error` value as it stored it. */
  error: unknown;
  code?: unknown;
  type?: unknown;
  param?: unknown;
  errorCode?: unknown;
  details?: unknown;
  apiMessage?: unknown;
  headers: Record<string, string>;
}

export interface FixtureError {
  /** `create`: the SDK call rejected. `stream`: iteration threw after `afterChunks` items. */
  phase: "create" | "stream";
  afterChunks: number;
  error: RecordedError;
}

export interface FixtureCall {
  index: number;
  request: unknown;
  options: FixtureCallOptions;
  chunks: unknown[];
  outcome: FixtureOutcome;
  error?: FixtureError | undefined;
}

export interface Fixture {
  meta: FixtureMeta;
  calls: FixtureCall[];
}

const APIS: readonly string[] = ["responses", "chat.completions", "messages"];
const OUTCOMES: readonly string[] = ["completed", "returned-after-abort", "threw"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";

function checkMeta(line: unknown, at: string): FixtureMeta {
  if (!isRecord(line) || line.kind !== "meta") throw new TypeError(`${at}: expected meta`);
  if (line.format !== 1) throw new TypeError(`${at}: unsupported format ${String(line.format)}`);
  for (const key of ["provider", "case", "sdk", "model", "recordedOn"]) {
    if (!nonEmpty(line[key])) throw new TypeError(`${at}: ${key} must be a non-empty string`);
  }
  if (!APIS.includes(String(line.api))) throw new TypeError(`${at}: unknown api`);
  return line as unknown as FixtureMeta;
}

/** Parses and validates a fixture. Throws a TypeError naming the line on any problem. */
export function parseFixture(text: string): Fixture {
  const raw = text.split("\n").map((line, i) => ({ line, at: `line ${i + 1}` }));
  const items = raw.filter(({ line }) => line.trim() !== "");
  if (items.length === 0) throw new TypeError("fixture is empty");
  const parsed = items.map(({ line, at }) => {
    try {
      return { value: JSON.parse(line) as unknown, at };
    } catch {
      throw new TypeError(`${at}: invalid JSON`);
    }
  });

  const [first, ...rest] = parsed as [
    { value: unknown; at: string },
    ...{ value: unknown; at: string }[],
  ];
  const meta = checkMeta(first.value, first.at);
  const calls: FixtureCall[] = [];
  let open: FixtureCall | undefined;

  for (const { value, at } of rest) {
    if (!isRecord(value)) throw new TypeError(`${at}: expected an object`);
    if (value.kind === "call") {
      if (open !== undefined) throw new TypeError(`${at}: call ${open.index} has no end`);
      if (value.index !== calls.length) throw new TypeError(`${at}: expected call ${calls.length}`);
      open = {
        index: calls.length,
        request: value.request,
        options: isRecord(value.options) ? (value.options as FixtureCallOptions) : {},
        chunks: [],
        outcome: "completed",
      };
      continue;
    }
    const target = value.call;
    if (open === undefined || target !== open.index) {
      const ended = calls.some((c) => c.index === target);
      throw new TypeError(
        ended
          ? `${at}: ${String(value.kind)} for call ${String(target)} after its end`
          : `${at}: ${String(value.kind)} for call ${String(target)} with no open call`,
      );
    }
    if (value.kind === "chunk") {
      if (open.error !== undefined) throw new TypeError(`${at}: chunk after the error`);
      open.chunks.push(value.data);
    } else if (value.kind === "error") {
      if (open.error !== undefined)
        throw new TypeError(`${at}: second error for call ${open.index}`);
      if (value.phase !== "create" && value.phase !== "stream") {
        throw new TypeError(`${at}: phase must be create or stream`);
      }
      if (value.afterChunks !== open.chunks.length) {
        throw new TypeError(
          `${at}: afterChunks ${String(value.afterChunks)} but ${open.chunks.length} chunks`,
        );
      }
      if (value.phase === "create" && open.chunks.length > 0) {
        throw new TypeError(`${at}: a create error can't follow chunks`);
      }
      open.error = {
        phase: value.phase,
        afterChunks: value.afterChunks as number,
        error: value.error as RecordedError,
      };
    } else if (value.kind === "end") {
      if (!OUTCOMES.includes(String(value.outcome))) throw new TypeError(`${at}: unknown outcome`);
      open.outcome = value.outcome as FixtureOutcome;
      if (open.outcome === "threw" && open.error === undefined) {
        throw new TypeError(`${at}: threw without an error line`);
      }
      if (open.outcome !== "threw" && open.error !== undefined) {
        throw new TypeError(`${at}: error without threw`);
      }
      calls.push(open);
      open = undefined;
    } else {
      throw new TypeError(`${at}: unknown kind`);
    }
  }
  if (open !== undefined) throw new TypeError(`call ${open.index} has no end`);
  if (calls.length === 0) throw new TypeError("fixture has no calls");
  return { meta, calls };
}

export function serializeFixture(fixture: Fixture): string {
  const out: unknown[] = [fixture.meta];
  for (const c of fixture.calls) {
    out.push({ kind: "call", index: c.index, request: c.request, options: c.options });
    for (const data of c.chunks) out.push({ kind: "chunk", call: c.index, data });
    if (c.error !== undefined) {
      out.push({
        kind: "error",
        call: c.index,
        phase: c.error.phase,
        afterChunks: c.error.afterChunks,
        error: c.error.error,
      });
    }
    out.push({ kind: "end", call: c.index, outcome: c.outcome });
  }
  return `${out.map((line) => JSON.stringify(line)).join("\n")}\n`;
}
