import type { ModelRef, ModelRequest, ToolChoice } from "../adapter.ts";
import { base64, invalid, mergedOptions, withoutSchemaKey } from "../compat/request.ts";
import type { AssistantMessage, Message, ProviderMetadata, UserPart } from "../messages.ts";

type Json = Record<string, unknown>;

export const PROVIDER = "anthropic";

/** Used when neither the request nor the model options set an output cap. The API requires one. */
export const DEFAULT_MAX_TOKENS = 4096;

/** Fields derived from the request. `body` may not set them. */
export const RESERVED_KEYS: readonly string[] = [
  "model",
  "messages",
  "system",
  "stream",
  "tools",
  "tool_choice",
  "max_tokens",
  "temperature",
  "output_config",
];

const IMAGE_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function ownMetadata(metadata: ProviderMetadata | undefined): Json | undefined {
  if (metadata === undefined || !Object.hasOwn(metadata, PROVIDER)) return undefined;
  const ours = metadata[PROVIDER];
  return isRecord(ours) ? ours : undefined;
}

function image(mediaType: string | undefined, data: string): Json {
  if (mediaType === undefined || !IMAGE_TYPES.includes(mediaType)) {
    throw invalid(PROVIDER, "images must be JPEG, PNG, GIF or WebP with a mediaType");
  }
  return { type: "image", source: { type: "base64", media_type: mediaType, data } };
}

function userPart(part: UserPart): Json {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image": {
      if (typeof part.data !== "string") return image(part.mediaType, base64(part.data));
      const match = /^data:([^;,]+);base64,(.*)$/s.exec(part.data);
      if (match === null) throw invalid(PROVIDER, "image data URLs must be base64");
      return image(match[1], match[2] as string);
    }
    case "file": {
      let doc: Json;
      if (part.mediaType === "application/pdf") {
        doc = {
          type: "document",
          source: { type: "base64", media_type: "application/pdf", data: base64(part.data) },
        };
      } else if (part.mediaType === "text/plain") {
        const text = new TextDecoder().decode(part.data);
        doc = { type: "document", source: { type: "text", media_type: "text/plain", data: text } };
      } else {
        throw invalid(PROVIDER, "files must be PDF or plain text");
      }
      if (part.filename !== undefined) doc.title = part.filename;
      return doc;
    }
  }
}

function toolInput(input: unknown): unknown {
  if (typeof input !== "string") return isRecord(input) ? input : {};
  try {
    const parsed: unknown = JSON.parse(input);
    return isRecord(parsed) ? parsed : {};
  } catch {
    // Unparseable model output still has to be sent as an object.
    return {};
  }
}

function assistantBlocks(message: AssistantMessage): Json[] | string {
  if (typeof message.content === "string") return message.content;
  const blocks: Json[] = [];
  for (const part of message.content) {
    if (part.type === "text") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "reasoning") {
      // Only Anthropic's own thinking can go back, and only in the shape it was produced in.
      const ours = ownMetadata(part.providerMetadata);
      if (typeof ours?.signature === "string") {
        blocks.push({ type: "thinking", thinking: part.text, signature: ours.signature });
      } else if (typeof ours?.redacted === "string") {
        blocks.push({ type: "redacted_thinking", data: ours.redacted });
      }
    } else {
      blocks.push({ type: "tool_use", id: part.id, name: part.name, input: toolInput(part.input) });
    }
  }
  return blocks;
}

function messages(list: readonly Message[]): Json[] {
  const out: Json[] = [];
  let results: Json[] | undefined;
  for (const m of list) {
    if (m.role === "tool") {
      const result: Json = { type: "tool_result", tool_use_id: m.toolCallId, content: m.content };
      if (m.isError === true) result.is_error = true;
      // Consecutive tool results answer one assistant turn, so they share one user message.
      if (results === undefined) {
        results = [];
        out.push({ role: "user", content: results });
      }
      results.push(result);
      continue;
    }
    results = undefined;
    if (m.role === "system") continue;
    if (m.role === "user") {
      out.push({
        role: "user",
        content: typeof m.content === "string" ? m.content : m.content.map(userPart),
      });
      continue;
    }
    const content = assistantBlocks(m);
    // The API rejects empty assistant turns.
    if (content.length === 0) continue;
    out.push({ role: "assistant", content });
  }
  return out;
}

function toolChoice(choice: ToolChoice): Json {
  if (typeof choice !== "string") return { type: "tool", name: choice.name };
  return { type: choice === "required" ? "any" : choice };
}

/** Translates a normalized request into Messages API create params. Pure. */
export function toMessagesParams(request: ModelRequest, modelRef: ModelRef): Json {
  const options = mergedOptions(request, modelRef, PROVIDER);
  const maxTokens = typeof options.maxTokens === "number" ? options.maxTokens : DEFAULT_MAX_TOKENS;
  const params: Json = { model: modelRef.id, max_tokens: request.maxOutputTokens ?? maxTokens };

  const system = request.messages.filter((m) => m.role === "system").map((m) => m.content);
  if (system.length > 0) params.system = system.join("\n\n");
  params.messages = messages(request.messages);
  params.stream = true;

  if (request.tools !== undefined && request.tools.length > 0) {
    params.tools = request.tools.map((tool) => {
      const out: Json = { name: tool.name };
      if (tool.description !== undefined) out.description = tool.description;
      out.input_schema = withoutSchemaKey(tool.inputSchema);
      return out;
    });
  }
  if (request.toolChoice !== undefined) params.tool_choice = toolChoice(request.toolChoice);
  const outputConfig: Json = {};
  if (options.effort !== undefined) outputConfig.effort = options.effort;
  if (request.output !== undefined) {
    outputConfig.format = { type: "json_schema", schema: withoutSchemaKey(request.output.schema) };
  }
  if (Object.keys(outputConfig).length > 0) params.output_config = outputConfig;
  if (request.temperature !== undefined) params.temperature = request.temperature;

  const body = (options.body as Json | undefined) ?? {};
  for (const [key, value] of Object.entries(body)) {
    if (RESERVED_KEYS.includes(key)) throw invalid(PROVIDER, `body may not set "${key}"`);
    if (key === "__proto__" || value === undefined) continue;
    params[key] = value;
  }
  // The caller's thinking config is passed through; its form depends on the model generation.
  if (options.thinking !== undefined) params.thinking = options.thinking;
  return params;
}
