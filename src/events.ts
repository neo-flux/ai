import { type AIError, isAIError } from "./errors.ts";
import type { ProviderMetadata } from "./messages.ts";
import { USAGE_FIELDS, type UsageReport } from "./usage.ts";

export type FinishReason = "stop" | "length" | "tool-calls" | "content-filter" | "other";

export interface TextDeltaEvent {
  type: "text-delta";
  text: string;
}
export interface ReasoningDeltaEvent {
  type: "reasoning-delta";
  text: string;
}
/** Closes the open reasoning block and carries that block's provider metadata. */
export interface ReasoningEndEvent {
  type: "reasoning-end";
  providerMetadata?: ProviderMetadata | undefined;
}
export interface ToolCallStartEvent {
  type: "tool-call-start";
  id: string;
  name: string;
}
/** A raw fragment of the tool call's JSON arguments. */
export interface ToolCallDeltaEvent {
  type: "tool-call-delta";
  id: string;
  inputDelta: string;
}
export interface ToolCallEndEvent {
  type: "tool-call-end";
  id: string;
  providerMetadata?: ProviderMetadata | undefined;
}
/** Cumulative usage so far for the request. */
export interface UsageEvent {
  type: "usage";
  usage: UsageReport;
}
export interface FinishEvent {
  type: "finish";
  reason: FinishReason;
  providerMetadata?: ProviderMetadata | undefined;
}
export interface ErrorEvent {
  type: "error";
  error: AIError;
}

export type StreamEvent =
  | TextDeltaEvent
  | ReasoningDeltaEvent
  | ReasoningEndEvent
  | ToolCallStartEvent
  | ToolCallDeltaEvent
  | ToolCallEndEvent
  | UsageEvent
  | FinishEvent
  | ErrorEvent;

/** The ordering rules from docs/events.md. O4 permits interleaving and so is never violated. */
export type OrderRule = "O0" | "O1" | "O2" | "O3" | "O5" | "O6" | "O7" | "O8";

export class EventOrderError extends Error {
  override readonly name: "EventOrderError" = "EventOrderError";
  readonly rule: OrderRule;
  readonly index: number;
  readonly eventType: string | undefined;

  constructor(rule: OrderRule, index: number, eventType: string | undefined) {
    super(`event ${index}${eventType === undefined ? "" : ` (${eventType})`} breaks ${rule}`);
    this.rule = rule;
    this.index = index;
    this.eventType = eventType;
  }
}

const FINISH_REASONS: readonly string[] = [
  "stop",
  "length",
  "tool-calls",
  "content-filter",
  "other",
];
const KNOWN_TYPES: readonly string[] = [
  "text-delta",
  "reasoning-delta",
  "reasoning-end",
  "tool-call-start",
  "tool-call-delta",
  "tool-call-end",
  "usage",
  "finish",
  "error",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const nonEmpty = (value: unknown): boolean => typeof value === "string" && value !== "";

function wellFormed(event: Record<string, unknown>): boolean {
  switch (event.type) {
    case "text-delta":
    case "reasoning-delta":
      return typeof event.text === "string";
    case "tool-call-start":
      return nonEmpty(event.id) && nonEmpty(event.name);
    case "tool-call-delta":
      return nonEmpty(event.id) && typeof event.inputDelta === "string";
    case "tool-call-end":
      return nonEmpty(event.id);
    case "finish":
      return typeof event.reason === "string" && FINISH_REASONS.includes(event.reason);
    case "error":
      return isAIError(event.error);
    default:
      return KNOWN_TYPES.includes(String(event.type));
  }
}

function validUsage(usage: unknown): boolean {
  if (!isRecord(usage)) return false;
  if (typeof usage.inputIncludesCached !== "boolean") return false;
  if (typeof usage.outputIncludesReasoning !== "boolean") return false;
  return USAGE_FIELDS.every((field) => {
    const value = usage[field];
    return value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0);
  });
}

/** The ordering state machine. Core's fold and the `/testing` checker both drive it. */
export class EventOrder {
  #index = 0;
  #terminated = false;
  #reasoningOpen = false;
  #seen = new Set<string>();
  #open = new Set<string>();
  #ended = 0;

  get terminated(): boolean {
    return this.#terminated;
  }

  /** Accepts the next event or throws the rule it breaks. */
  push(event: unknown): void {
    const index = this.#index++;
    const type = isRecord(event) && typeof event.type === "string" ? event.type : undefined;
    const fail = (rule: OrderRule): EventOrderError => new EventOrderError(rule, index, type);
    if (this.#terminated) throw fail("O1");
    if (!isRecord(event) || !wellFormed(event)) throw fail("O0");
    const e = event as unknown as StreamEvent;
    switch (e.type) {
      case "text-delta":
        this.#reasoningOpen = false;
        return;
      case "reasoning-delta":
        this.#reasoningOpen = true;
        return;
      case "reasoning-end":
        if (!this.#reasoningOpen) throw fail("O6");
        this.#reasoningOpen = false;
        return;
      case "tool-call-start":
        if (this.#seen.has(e.id)) throw fail("O2");
        this.#reasoningOpen = false;
        this.#seen.add(e.id);
        this.#open.add(e.id);
        return;
      case "tool-call-delta":
        if (!this.#open.has(e.id)) throw fail("O3");
        return;
      case "tool-call-end":
        if (!this.#open.has(e.id)) throw fail("O3");
        this.#open.delete(e.id);
        this.#ended++;
        return;
      case "usage":
        if (!validUsage(e.usage)) throw fail("O8");
        return;
      case "finish":
        if (this.#open.size > 0) throw fail("O5");
        if (e.reason === "tool-calls" && this.#ended === 0) throw fail("O7");
        this.#terminated = true;
        return;
      case "error":
        this.#terminated = true;
        return;
    }
  }

  /** Call when the source is exhausted. Throws O1 if no terminal event came. */
  end(): void {
    if (!this.#terminated) throw new EventOrderError("O1", this.#index, undefined);
  }
}

export function assertEventOrder(events: readonly StreamEvent[]): void {
  const order = new EventOrder();
  for (const event of events) order.push(event);
  order.end();
}

/** Passes events through unchanged and throws `EventOrderError` at the first violation. */
export async function* checkEventOrder(
  source: AsyncIterable<StreamEvent>,
): AsyncGenerator<StreamEvent, void, undefined> {
  const order = new EventOrder();
  for await (const event of source) {
    order.push(event);
    yield event;
  }
  order.end();
}
