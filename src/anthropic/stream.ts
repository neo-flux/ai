import { AIError } from "../errors.ts";
import type { FinishReason, StreamEvent } from "../events.ts";
import type { UsageReport } from "../usage.ts";

type Json = Record<string, unknown>;

const PROVIDER = "anthropic";

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const STOP: Readonly<Record<string, FinishReason>> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  model_context_window_exceeded: "length",
  refusal: "content-filter",
  tool_use: "tool-calls",
};

type Block =
  | { kind: "text" }
  | { kind: "thinking"; signature: string; emitted: boolean }
  | { kind: "tool"; id: string };

export interface MessagesEnd {
  events: StreamEvent[];
  error: AIError | undefined;
}

// SSE error events are rebuilt in the SDK's shape: no status, the whole body under `error`, and
// the inner error type as `type`, so classification sees what it would for a thrown APIError.
function streamError(body: Json): Error {
  const inner = isRecord(body.error) ? body.error : {};
  return Object.assign(new Error("stream error"), {
    status: undefined,
    error: { type: "error", error: inner },
    type: typeof inner.type === "string" ? inner.type : undefined,
  });
}

/** Turns Messages API stream events into stream events. */
export class MessagesTranslator {
  #blocks = new Map<number, Block>();
  #started = new Set<string>();
  #ended = 0;
  #usage: UsageReport | undefined;
  #stopReason: string | undefined;
  #stopped = false;

  push(event: unknown): StreamEvent[] {
    if (!isRecord(event)) return [];
    const out: StreamEvent[] = [];
    const index = typeof event.index === "number" ? event.index : -1;
    switch (event.type) {
      case "message_start":
        if (isRecord(event.message)) this.#readUsage(event.message.usage);
        break;
      case "content_block_start":
        if (isRecord(event.content_block)) this.#blockStart(index, event.content_block, out);
        break;
      case "content_block_delta":
        if (isRecord(event.delta)) this.#blockDelta(index, event.delta, out);
        break;
      case "content_block_stop":
        this.#blockStop(index, out);
        break;
      case "message_delta":
        if (isRecord(event.delta) && typeof event.delta.stop_reason === "string") {
          this.#stopReason = event.delta.stop_reason;
        }
        this.#readUsage(event.usage);
        break;
      case "message_stop":
        this.#stopped = true;
        break;
      case "error":
        throw streamError(event);
    }
    return out;
  }

  end(): MessagesEnd {
    const events: StreamEvent[] = [];
    if (!this.#stopped) {
      return { events, error: new AIError({ code: "provider_unavailable", provider: PROVIDER }) };
    }
    for (const index of [...this.#blocks.keys()]) this.#blockStop(index, events);
    if (this.#usage !== undefined) events.push({ type: "usage", usage: this.#usage });
    const reason = this.#stopReason;
    const mapped =
      reason !== undefined && Object.hasOwn(STOP, reason)
        ? (STOP[reason] as FinishReason)
        : "other";
    // "tool-calls" without a call would break the ordering rules.
    events.push({
      type: "finish",
      reason: mapped === "tool-calls" && this.#ended === 0 ? "other" : mapped,
    });
    return { events, error: undefined };
  }

  #blockStart(index: number, block: Json, out: StreamEvent[]): void {
    switch (block.type) {
      case "text":
        this.#blocks.set(index, { kind: "text" });
        return;
      case "thinking": {
        const thinking: Block = {
          kind: "thinking",
          signature: typeof block.signature === "string" ? block.signature : "",
          emitted: false,
        };
        this.#blocks.set(index, thinking);
        const text = nonEmpty(block.thinking);
        if (text !== undefined) {
          thinking.emitted = true;
          out.push({ type: "reasoning-delta", text });
        }
        return;
      }
      case "redacted_thinking":
        if (typeof block.data !== "string") return;
        out.push({ type: "reasoning-delta", text: "" });
        out.push({
          type: "reasoning-end",
          providerMetadata: { [PROVIDER]: { redacted: block.data } },
        });
        return;
      case "tool_use": {
        const id = nonEmpty(block.id);
        const name = nonEmpty(block.name);
        if (id === undefined || name === undefined || this.#started.has(id)) return;
        this.#started.add(id);
        this.#blocks.set(index, { kind: "tool", id });
        out.push({ type: "tool-call-start", id, name });
        return;
      }
    }
  }

  #blockDelta(index: number, delta: Json, out: StreamEvent[]): void {
    const block = this.#blocks.get(index);
    if (block === undefined) return;
    if (block.kind === "text" && delta.type === "text_delta") {
      const text = nonEmpty(delta.text);
      if (text !== undefined) out.push({ type: "text-delta", text });
    } else if (block.kind === "thinking" && delta.type === "thinking_delta") {
      const text = nonEmpty(delta.thinking);
      if (text === undefined) return;
      block.emitted = true;
      out.push({ type: "reasoning-delta", text });
    } else if (block.kind === "thinking" && delta.type === "signature_delta") {
      if (typeof delta.signature === "string") block.signature += delta.signature;
    } else if (block.kind === "tool" && delta.type === "input_json_delta") {
      const json = nonEmpty(delta.partial_json);
      if (json !== undefined) out.push({ type: "tool-call-delta", id: block.id, inputDelta: json });
    }
  }

  #blockStop(index: number, out: StreamEvent[]): void {
    const block = this.#blocks.get(index);
    if (block === undefined) return;
    this.#blocks.delete(index);
    if (block.kind === "thinking") {
      // Omitted thinking streams no text, only a signature, and still has to go back next turn.
      if (!block.emitted) out.push({ type: "reasoning-delta", text: "" });
      out.push({
        type: "reasoning-end",
        providerMetadata: { [PROVIDER]: { signature: block.signature } },
      });
    } else if (block.kind === "tool") {
      this.#ended++;
      out.push({ type: "tool-call-end", id: block.id });
    }
  }

  #readUsage(raw: unknown): void {
    if (!isRecord(raw)) return;
    const output = isRecord(raw.output_tokens_details) ? raw.output_tokens_details : {};
    const next: Partial<UsageReport> = {
      inputTokens: count(raw.input_tokens),
      outputTokens: count(raw.output_tokens),
      cachedInputTokens: count(raw.cache_read_input_tokens),
      cacheWriteTokens: count(raw.cache_creation_input_tokens),
      reasoningTokens: count(output.thinking_tokens),
    };
    // input_tokens excludes cache reads and writes; core adds them back.
    const merged: UsageReport = {
      ...this.#usage,
      inputIncludesCached: false,
      outputIncludesReasoning: true,
    };
    for (const [key, value] of Object.entries(next) as [keyof UsageReport, number | undefined][]) {
      // message_delta repeats some fields as null; undefined never erases a value.
      if (value !== undefined) (merged as unknown as Record<string, number>)[key] = value;
    }
    this.#usage = merged;
  }
}

/** Wraps an SDK stream. Throws after the loop if the caller aborted, since the SDK returns silently. */
export async function* translateMessages(
  source: AsyncIterable<unknown>,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent, void, undefined> {
  const translator = new MessagesTranslator();
  for await (const event of source) {
    for (const out of translator.push(event)) yield out;
  }
  if (signal.aborted) throw signal.reason;
  const done = translator.end();
  for (const out of done.events) yield out;
  if (done.error !== undefined) throw done.error;
}
