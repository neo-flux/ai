import { AIError } from "../errors.ts";
import type { FinishReason, StreamEvent } from "../events.ts";
import type { UsageReport } from "../usage.ts";

type Json = Record<string, unknown>;

const PROVIDER = "openai";

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

interface Call {
  callId: string;
  emitted: boolean;
}

/** What `end()` produces: the closing events, and an error to throw after them, if any. */
export interface ResponsesEnd {
  events: StreamEvent[];
  error: AIError | undefined;
}

// Mid-stream failures are rebuilt in the SDK's error shape (no status, the body under `error`), so
// error classification sees the same fields it would for a thrown APIError.
function streamError(body: Json): Error {
  return Object.assign(new Error("response failed"), {
    status: undefined,
    error: body,
    code: typeof body.code === "string" ? body.code : undefined,
    type: typeof body.type === "string" ? body.type : undefined,
    param: body.param,
  });
}

function usageOf(raw: unknown): UsageReport | undefined {
  if (!isRecord(raw)) return undefined;
  const input = isRecord(raw.input_tokens_details) ? raw.input_tokens_details : {};
  const output = isRecord(raw.output_tokens_details) ? raw.output_tokens_details : {};
  return {
    inputTokens: count(raw.input_tokens),
    outputTokens: count(raw.output_tokens),
    cachedInputTokens: count(input.cached_tokens),
    cacheWriteTokens: count(input.cache_write_tokens),
    reasoningTokens: count(output.reasoning_tokens),
    inputIncludesCached: true,
    outputIncludesReasoning: true,
  };
}

const INCOMPLETE: Readonly<Record<string, FinishReason>> = {
  max_output_tokens: "length",
  content_filter: "content-filter",
};

/** Turns Responses API stream events into stream events. */
export class ResponsesTranslator {
  // The reasoning item being streamed, and whether it has produced any text yet.
  #reasoning: { id: string; emitted: boolean; summaryIndex: number | undefined } | undefined;
  // Whether a reasoning block is open in the event stream. Text and tool calls close it.
  #blockOpen = false;
  #calls = new Map<string, Call>();
  #ended = 0;
  // Call ids already started, so a duplicate `done` or a reused call_id can't start a call twice.
  #seen = new Set<string>();
  // "tool-calls" is decided in end(), after calls left open are closed.
  #terminal: { reason: FinishReason | "completed"; usage: UsageReport | undefined } | undefined;

  push(event: unknown): StreamEvent[] {
    if (!isRecord(event)) return [];
    const out: StreamEvent[] = [];
    switch (event.type) {
      case "response.output_text.delta":
      case "response.refusal.delta": {
        const delta = nonEmpty(event.delta);
        if (delta !== undefined) {
          this.#blockOpen = false;
          out.push({ type: "text-delta", text: delta });
        }
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        this.#reasoningDelta(event, out);
        break;
      case "response.output_item.added":
        if (isRecord(event.item)) this.#itemAdded(event.item, out);
        break;
      case "response.function_call_arguments.delta": {
        const call = typeof event.item_id === "string" ? this.#calls.get(event.item_id) : undefined;
        const delta = nonEmpty(event.delta);
        if (call !== undefined && delta !== undefined) {
          call.emitted = true;
          out.push({ type: "tool-call-delta", id: call.callId, inputDelta: delta });
        }
        break;
      }
      case "response.output_item.done":
        if (isRecord(event.item)) this.#itemDone(event.item, out);
        break;
      case "response.completed":
      case "response.incomplete": {
        const response = isRecord(event.response) ? event.response : {};
        const details = isRecord(response.incomplete_details) ? response.incomplete_details : {};
        const reason =
          event.type === "response.completed"
            ? "completed"
            : typeof details.reason === "string" && Object.hasOwn(INCOMPLETE, details.reason)
              ? (INCOMPLETE[details.reason] as FinishReason)
              : "other";
        this.#terminal = { reason, usage: usageOf(response.usage) };
        break;
      }
      case "response.failed": {
        const response = isRecord(event.response) ? event.response : {};
        throw streamError(isRecord(response.error) ? response.error : {});
      }
      case "error": {
        // The event's own `type` is "error"; it isn't the provider's error type.
        const { type: _, ...body } = event;
        throw streamError(body);
      }
    }
    return out;
  }

  end(): ResponsesEnd {
    const events: StreamEvent[] = [];
    if (this.#terminal === undefined) {
      return { events, error: new AIError({ code: "provider_unavailable", provider: PROVIDER }) };
    }
    // A call the server never finished still has to be closed before `finish`.
    for (const call of this.#calls.values()) {
      events.push({ type: "tool-call-end", id: call.callId });
      this.#ended++;
    }
    this.#calls.clear();
    const { usage } = this.#terminal;
    if (usage !== undefined) events.push({ type: "usage", usage });
    const { reason } = this.#terminal;
    events.push({
      type: "finish",
      reason: reason === "completed" ? (this.#ended > 0 ? "tool-calls" : "stop") : reason,
    });
    return { events, error: undefined };
  }

  #reasoningDelta(event: Json, out: StreamEvent[]): void {
    const delta = nonEmpty(event.delta);
    if (delta === undefined) return;
    const id = typeof event.item_id === "string" ? event.item_id : "";
    if (this.#reasoning?.id !== id)
      this.#reasoning = { id, emitted: false, summaryIndex: undefined };
    const index = typeof event.summary_index === "number" ? event.summary_index : undefined;
    const r = this.#reasoning;
    // Summary parts are separate paragraphs.
    const gap = r.emitted && index !== undefined && r.summaryIndex !== index ? "\n\n" : "";
    if (index !== undefined) r.summaryIndex = index;
    r.emitted = true;
    this.#blockOpen = true;
    out.push({ type: "reasoning-delta", text: gap + delta });
  }

  #itemAdded(item: Json, out: StreamEvent[]): void {
    if (item.type === "reasoning" && typeof item.id === "string") {
      this.#reasoning = { id: item.id, emitted: false, summaryIndex: undefined };
    } else if (item.type === "function_call") {
      this.#startCall(item, out);
    }
  }

  #startCall(item: Json, out: StreamEvent[]): Call | undefined {
    const callId = nonEmpty(item.call_id);
    const name = nonEmpty(item.name);
    if (callId === undefined || name === undefined) return undefined;
    // A compatible server may omit the item id; argument deltas can't be routed then, but the
    // call still arrives whole on `done`.
    const itemId = nonEmpty(item.id) ?? callId;
    const existing = this.#calls.get(itemId);
    if (existing !== undefined) return existing;
    if (this.#seen.has(callId)) return undefined;
    this.#seen.add(callId);
    const call = { callId, emitted: false };
    this.#calls.set(itemId, call);
    this.#blockOpen = false;
    out.push({ type: "tool-call-start", id: callId, name });
    return call;
  }

  #itemDone(item: Json, out: StreamEvent[]): void {
    if (item.type === "reasoning") {
      // A reasoning item can arrive with no visible text (an empty summary). It still has to be
      // returned next turn, so it gets an empty delta to open the block that carries it.
      if (!this.#blockOpen || this.#reasoning?.id !== item.id) {
        out.push({ type: "reasoning-delta", text: "" });
      }
      this.#blockOpen = false;
      this.#reasoning = undefined;
      out.push({ type: "reasoning-end", providerMetadata: { [PROVIDER]: { item } } });
      return;
    }
    if (item.type !== "function_call") return;
    const call = this.#startCall(item, out);
    if (call === undefined) return;
    const args = nonEmpty(item.arguments);
    if (!call.emitted && args !== undefined) {
      out.push({ type: "tool-call-delta", id: call.callId, inputDelta: args });
    }
    this.#calls.delete(nonEmpty(item.id) ?? call.callId);
    this.#ended++;
    out.push({
      type: "tool-call-end",
      id: call.callId,
      providerMetadata: { [PROVIDER]: { item } },
    });
  }
}

/** Wraps an SDK stream. Throws after the loop if the caller aborted, since the SDK returns silently. */
export async function* translateResponses(
  source: AsyncIterable<unknown>,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent, void, undefined> {
  const translator = new ResponsesTranslator();
  for await (const event of source) {
    for (const out of translator.push(event)) yield out;
  }
  if (signal.aborted) throw signal.reason;
  const end = translator.end();
  for (const out of end.events) yield out;
  if (end.error !== undefined) throw end.error;
}
