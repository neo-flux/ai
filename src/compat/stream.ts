import { AIError } from "../errors.ts";
import type { FinishReason, StreamEvent } from "../events.ts";
import type { UsageReport } from "../usage.ts";
import type { ResolvedQuirks } from "./quirks.ts";

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === "object" && value !== null;
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;
const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

const STANDARD: Readonly<Record<string, FinishReason>> = {
  stop: "stop",
  length: "length",
  tool_calls: "tool-calls",
  function_call: "tool-calls",
  content_filter: "content-filter",
};

const USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const;

interface ToolCall {
  id: string | undefined;
  name: string | undefined;
  started: boolean;
  pending: string;
}

/** What `end()` produces: the closing events, and an error to throw after them, if any. */
export interface TranslatorEnd {
  events: StreamEvent[];
  error: AIError | undefined;
}

/**
 * Turns Chat Completions chunks into stream events. `finish` is held until `end()`, because usage
 * may arrive in a chunk after the one that carries `finish_reason`.
 */
export class ChunkTranslator {
  readonly #quirks: ResolvedQuirks;
  readonly #provider: string;
  #reasoningOpen = false;
  #calls = new Map<number, ToolCall>();
  #finish: string | undefined;
  #usage: UsageReport | undefined;

  constructor(quirks: ResolvedQuirks, provider: string) {
    this.#quirks = quirks;
    this.#provider = provider;
  }

  push(chunk: unknown): StreamEvent[] {
    if (!isRecord(chunk)) return [];
    const out: StreamEvent[] = [];
    if (isRecord(chunk.usage)) this.#readUsage(chunk.usage);
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    // The adapter never asks for more than one choice.
    const choice = choices.find((c) => isRecord(c) && (c.index === 0 || c.index === undefined));
    if (!isRecord(choice)) return out;
    const delta = isRecord(choice.delta) ? choice.delta : {};

    const field = this.#quirks.reasoningField;
    const reasoning = field === undefined ? undefined : text(delta[field]);
    if (reasoning !== undefined) {
      this.#reasoningOpen = true;
      out.push({ type: "reasoning-delta", text: reasoning });
    }
    for (const value of [delta.content, delta.refusal]) {
      const t = text(value);
      if (t === undefined) continue;
      this.#closeReasoning(out);
      out.push({ type: "text-delta", text: t });
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) if (isRecord(tc)) this.#toolDelta(tc, out);
    }
    if (typeof choice.finish_reason === "string" && choice.finish_reason !== "") {
      this.#finish = choice.finish_reason;
    }
    return out;
  }

  end(): TranslatorEnd {
    const events: StreamEvent[] = [];
    this.#closeReasoning(events);
    const done = (error: AIError | undefined): TranslatorEnd => {
      if (this.#usage !== undefined) events.push({ type: "usage", usage: this.#usage });
      return { events, error };
    };
    if (this.#finish === undefined) return done(this.#error(undefined));

    const calls = [...this.#calls.entries()].sort(([a], [b]) => a - b);
    for (const [index, call] of calls) {
      if (call.started) continue;
      if (call.name === undefined) return done(this.#error(undefined));
      // Some servers omit tool call ids; the replacement only has to be unique in this turn.
      call.id ??= `call_${index}`;
      this.#start(call, events);
    }
    for (const [, call] of calls) events.push({ type: "tool-call-end", id: call.id as string });

    const mapped = this.#quirks.finishReasons[this.#finish] ?? STANDARD[this.#finish] ?? "other";
    if (typeof mapped !== "string") return done(this.#error(this.#finish, mapped.error));
    // "tool-calls" without a call would break the ordering rules; report it as "other".
    const reason = mapped === "tool-calls" && calls.length === 0 ? "other" : mapped;
    const ended = done(undefined);
    ended.events.push({ type: "finish", reason });
    return ended;
  }

  #error(
    finishReason: string | undefined,
    classification: { code: AIError["code"]; retryable?: boolean | undefined } = {
      code: "provider_unavailable",
    },
  ): AIError {
    return new AIError({ ...classification, provider: this.#provider, providerCode: finishReason });
  }

  #closeReasoning(out: StreamEvent[]): void {
    if (!this.#reasoningOpen) return;
    this.#reasoningOpen = false;
    const field = this.#quirks.reasoningField as string;
    out.push({
      type: "reasoning-end",
      providerMetadata: { [this.#provider]: { reasoningField: field } },
    });
  }

  #start(call: ToolCall, out: StreamEvent[]): void {
    this.#closeReasoning(out);
    call.started = true;
    out.push({ type: "tool-call-start", id: call.id as string, name: call.name as string });
    if (call.pending !== "") {
      out.push({ type: "tool-call-delta", id: call.id as string, inputDelta: call.pending });
      call.pending = "";
    }
  }

  #toolDelta(tc: Json, out: StreamEvent[]): void {
    const index = typeof tc.index === "number" ? tc.index : 0;
    let call = this.#calls.get(index);
    if (call === undefined) {
      call = { id: undefined, name: undefined, started: false, pending: "" };
      this.#calls.set(index, call);
    }
    const fn = isRecord(tc.function) ? tc.function : {};
    // Continuation chunks may repeat the id and name, or send "": the first real value wins.
    call.id ??= text(tc.id);
    call.name ??= text(fn.name);
    const args = text(fn.arguments);
    if (call.started) {
      if (args !== undefined)
        out.push({ type: "tool-call-delta", id: call.id as string, inputDelta: args });
      return;
    }
    if (call.id === undefined || call.name === undefined) {
      if (args !== undefined) call.pending += args;
      return;
    }
    this.#start(call, out);
    if (args !== undefined) out.push({ type: "tool-call-delta", id: call.id, inputDelta: args });
  }

  #readUsage(raw: Json): void {
    const prompt = isRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : {};
    const completion = isRecord(raw.completion_tokens_details) ? raw.completion_tokens_details : {};
    const next: UsageReport = {
      inputTokens: count(raw.prompt_tokens),
      outputTokens: count(raw.completion_tokens),
      cachedInputTokens: count(prompt.cached_tokens),
      cacheWriteTokens: undefined,
      reasoningTokens: count(completion.reasoning_tokens),
      inputIncludesCached: true,
      outputIncludesReasoning: true,
    };
    const extra = this.#quirks.usage?.(raw) ?? {};
    const merged: UsageReport = {
      ...(this.#usage ?? next),
      inputIncludesCached: true,
      outputIncludesReasoning: true,
    };
    for (const key of USAGE_KEYS) {
      // The standard field wins; the quirk only fills gaps. Undefined never erases a value.
      const value = next[key] ?? count(extra[key]);
      if (value !== undefined) merged[key] = value;
    }
    this.#usage = merged;
  }
}

/** Wraps an SDK stream. Throws after the loop if the caller aborted, since the SDK returns silently. */
export async function* translateStream(
  source: AsyncIterable<unknown>,
  quirks: ResolvedQuirks,
  provider: string,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent, void, undefined> {
  const translator = new ChunkTranslator(quirks, provider);
  for await (const chunk of source) {
    for (const event of translator.push(chunk)) yield event;
  }
  if (signal.aborted) throw signal.reason;
  const end = translator.end();
  for (const event of end.events) yield event;
  if (end.error !== undefined) throw end.error;
}
