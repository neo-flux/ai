import { AIError } from "./errors.ts";

/** Opaque per-provider data, keyed by provider name. Core never reads or rewrites it. */
export type ProviderMetadata = Readonly<Record<string, unknown>>;

export interface TextPart {
  type: "text";
  text: string;
}

export interface ImagePart {
  type: "image";
  /** Raw bytes, or a `data:` URL. Remote URLs are not supported yet. */
  data: Uint8Array | string;
  mediaType?: string | undefined;
}

export interface FilePart {
  type: "file";
  data: Uint8Array;
  mediaType: string;
  filename?: string | undefined;
}

export interface ReasoningPart {
  type: "reasoning";
  text: string;
  providerMetadata?: ProviderMetadata | undefined;
}

export interface ToolCallPart {
  type: "tool-call";
  id: string;
  name: string;
  input: unknown;
  providerMetadata?: ProviderMetadata | undefined;
}

export type UserPart = TextPart | ImagePart | FilePart;
export type AssistantPart = TextPart | ReasoningPart | ToolCallPart;

export interface SystemMessage {
  role: "system";
  content: string;
}

export interface UserMessage {
  role: "user";
  content: string | readonly UserPart[];
}

export interface AssistantMessage {
  role: "assistant";
  content: string | readonly AssistantPart[];
  providerMetadata?: ProviderMetadata | undefined;
}

export interface ToolMessage {
  role: "tool";
  toolCallId: string;
  toolName: string;
  content: string;
  isError?: boolean | undefined;
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

export function contentParts<P extends UserPart | AssistantPart>(
  content: string | readonly P[],
): readonly (P | TextPart)[] {
  return typeof content === "string" ? [{ type: "text", text: content }] : content;
}

// Reasons name positions and rules only, never content.
const invalid = (reason: string): AIError =>
  new AIError({ code: "invalid_request", cause: new TypeError(reason) });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value !== "";

function checkUserPart(part: unknown, at: string): void {
  if (!isRecord(part)) throw invalid(`${at}: part must be an object`);
  switch (part.type) {
    case "text":
      if (typeof part.text !== "string") throw invalid(`${at}: text must be a string`);
      return;
    case "image":
      if (part.data instanceof Uint8Array) {
        if (part.data.length === 0) throw invalid(`${at}: image bytes are empty`);
      } else if (typeof part.data === "string") {
        if (!part.data.startsWith("data:")) throw invalid(`${at}: image must be a data: URL`);
      } else {
        throw invalid(`${at}: image data must be bytes or a data: URL`);
      }
      if (part.mediaType !== undefined && !nonEmpty(part.mediaType)) {
        throw invalid(`${at}: image mediaType must be non-empty`);
      }
      return;
    case "file":
      if (!(part.data instanceof Uint8Array)) throw invalid(`${at}: file data must be bytes`);
      if (part.data.length === 0) throw invalid(`${at}: file bytes are empty`);
      if (!nonEmpty(part.mediaType)) throw invalid(`${at}: file mediaType must be non-empty`);
      return;
    default:
      throw invalid(`${at}: unsupported user part`);
  }
}

function checkAssistantPart(part: unknown, at: string, calls: Set<string>): void {
  if (!isRecord(part)) throw invalid(`${at}: part must be an object`);
  switch (part.type) {
    case "text":
    case "reasoning":
      if (typeof part.text !== "string") throw invalid(`${at}: text must be a string`);
      return;
    case "tool-call":
      if (!nonEmpty(part.id)) throw invalid(`${at}: tool call id must be non-empty`);
      if (!nonEmpty(part.name)) throw invalid(`${at}: tool call name must be non-empty`);
      calls.add(part.id);
      return;
    default:
      throw invalid(`${at}: unsupported assistant part`);
  }
}

function checkParts(
  content: unknown,
  at: string,
  check: (part: unknown, at: string) => void,
): void {
  if (typeof content === "string") return;
  if (!Array.isArray(content) || content.length === 0) {
    throw invalid(`${at}: content must be a string or a non-empty array of parts`);
  }
  content.forEach((part, i) => {
    check(part, `${at}.content[${i}]`);
  });
}

/** Provider-neutral checks run before any network call. Throws `invalid_request`. */
export function validateMessages(messages: readonly Message[]): void {
  if (!Array.isArray(messages)) throw invalid("messages must be an array");
  if (messages.length === 0) throw invalid("messages is empty");
  const calls = new Set<string>();
  let seenNonSystem = false;
  messages.forEach((message: unknown, i) => {
    const at = `messages[${i}]`;
    if (!isRecord(message)) throw invalid(`${at}: message must be an object`);
    switch (message.role) {
      case "system":
        if (seenNonSystem) throw invalid(`${at}: system message after a non-system message`);
        if (typeof message.content !== "string") throw invalid(`${at}: content must be a string`);
        return;
      case "user":
        seenNonSystem = true;
        checkParts(message.content, at, checkUserPart);
        return;
      case "assistant":
        seenNonSystem = true;
        checkParts(message.content, at, (part, partAt) => {
          checkAssistantPart(part, partAt, calls);
        });
        return;
      case "tool":
        seenNonSystem = true;
        if (!nonEmpty(message.toolCallId) || !calls.has(message.toolCallId)) {
          throw invalid(`${at}: unknown tool call id`);
        }
        if (!nonEmpty(message.toolName)) throw invalid(`${at}: toolName must be non-empty`);
        if (typeof message.content !== "string") throw invalid(`${at}: content must be a string`);
        return;
      default:
        throw invalid(`${at}: unsupported role`);
    }
  });
}
