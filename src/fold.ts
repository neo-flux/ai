import type { AIError } from "./errors.ts";
import type { FinishReason, StreamEvent } from "./events.ts";
import type {
  AssistantPart,
  ProviderMetadata,
  ReasoningPart,
  TextPart,
  ToolCallPart,
} from "./messages.ts";
import { parseArguments } from "./tools.ts";
import { mergeUsage, type UsageReport } from "./usage.ts";

export interface FoldedToolCall {
  id: string;
  name: string;
  rawInput: string;
  providerMetadata?: ProviderMetadata | undefined;
}

export interface Folded {
  content: AssistantPart[];
  text: string;
  reasoning: string | undefined;
  toolCalls: FoldedToolCall[];
  finishReason: FinishReason | undefined;
  providerMetadata: ProviderMetadata | undefined;
  usage: UsageReport | undefined;
  error: AIError | undefined;
}

/**
 * Builds the assistant message from events as they arrive. Assumes valid order: the caller runs
 * `EventOrder` alongside. Provider metadata is attached by reference, never copied.
 */
export class Fold {
  #content: AssistantPart[] = [];
  #reasoning: ReasoningPart | undefined;
  #calls = new Map<string, { part: ToolCallPart; call: FoldedToolCall }>();
  #finishReason: FinishReason | undefined;
  #providerMetadata: ProviderMetadata | undefined;
  #usage: UsageReport | undefined;
  #error: AIError | undefined;

  push(event: StreamEvent): void {
    switch (event.type) {
      case "text-delta": {
        this.#reasoning = undefined;
        if (event.text === "") return;
        const last = this.#content.at(-1);
        if (last?.type === "text") last.text += event.text;
        else this.#content.push({ type: "text", text: event.text } satisfies TextPart);
        return;
      }
      case "reasoning-delta":
        if (this.#reasoning === undefined) {
          this.#reasoning = { type: "reasoning", text: "" };
          this.#content.push(this.#reasoning);
        }
        this.#reasoning.text += event.text;
        return;
      case "reasoning-end":
        if (this.#reasoning !== undefined && event.providerMetadata !== undefined) {
          this.#reasoning.providerMetadata = event.providerMetadata;
        }
        this.#reasoning = undefined;
        return;
      case "tool-call-start": {
        this.#reasoning = undefined;
        const part: ToolCallPart = { type: "tool-call", id: event.id, name: event.name, input: {} };
        this.#content.push(part);
        this.#calls.set(event.id, { part, call: { id: event.id, name: event.name, rawInput: "" } });
        return;
      }
      case "tool-call-delta": {
        const entry = this.#calls.get(event.id);
        if (entry !== undefined) entry.call.rawInput += event.inputDelta;
        return;
      }
      case "tool-call-end": {
        const entry = this.#calls.get(event.id);
        if (entry === undefined) return;
        const parsed = parseArguments(entry.call.rawInput);
        entry.part.input = parsed.ok ? parsed.value : entry.call.rawInput;
        if (event.providerMetadata !== undefined) {
          entry.part.providerMetadata = event.providerMetadata;
          entry.call.providerMetadata = event.providerMetadata;
        }
        return;
      }
      case "usage":
        this.#usage = mergeUsage(this.#usage, event.usage);
        return;
      case "finish":
        this.#reasoning = undefined;
        this.#finishReason = event.reason;
        this.#providerMetadata = event.providerMetadata;
        return;
      case "error":
        this.#reasoning = undefined;
        this.#error = event.error;
        return;
    }
  }

  get usage(): UsageReport | undefined {
    return this.#usage;
  }

  result(): Folded {
    const content = this.#content.map((part) => ({ ...part }));
    const join = (type: "text" | "reasoning"): string =>
      content
        .filter((p): p is TextPart | ReasoningPart => p.type === type)
        .map((p) => p.text)
        .join("");
    const hasReasoning = content.some((p) => p.type === "reasoning");
    return {
      content,
      text: join("text"),
      reasoning: hasReasoning ? join("reasoning") : undefined,
      toolCalls: [...this.#calls.values()].map(({ call }) => ({ ...call })),
      finishReason: this.#finishReason,
      providerMetadata: this.#providerMetadata,
      usage: this.#usage,
      error: this.#error,
    };
  }
}

export function fold(events: Iterable<StreamEvent>): Folded {
  const f = new Fold();
  for (const event of events) f.push(event);
  return f.result();
}
