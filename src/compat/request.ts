import type { ModelRef, ModelRequest, ToolChoice } from "../adapter.ts";
import { AIError } from "../errors.ts";
import type { AssistantMessage, Message, UserPart } from "../messages.ts";
import { RESERVED_KEYS, type ResolvedQuirks } from "./quirks.ts";

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Reasons name rules only, never content.
export const invalid = (provider: string, reason: string): AIError =>
  new AIError({ code: "invalid_request", provider, cause: new TypeError(reason) });

// Chunked so large images don't overflow the argument limit of String.fromCharCode.
export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

// Servers aren't required to accept a `$schema` key at the top of a parameters object.
export function withoutSchemaKey(schema: Json): Json {
  const { $schema: _, ...rest } = schema;
  return rest;
}

function userPart(part: UserPart, provider: string): Json {
  switch (part.type) {
    case "text":
      return { type: "text", text: part.text };
    case "image": {
      if (typeof part.data === "string") {
        return { type: "image_url", image_url: { url: part.data } };
      }
      if (part.mediaType === undefined || part.mediaType === "") {
        throw invalid(provider, "image bytes need a mediaType");
      }
      const url = `data:${part.mediaType};base64,${base64(part.data)}`;
      return { type: "image_url", image_url: { url } };
    }
    case "file":
      throw invalid(provider, "file parts are not supported by this adapter");
  }
}

function assistant(message: AssistantMessage, quirks: ResolvedQuirks, provider: string): Json {
  if (typeof message.content === "string") return { role: "assistant", content: message.content };
  let text = "";
  const reasoning: string[] = [];
  const toolCalls: Json[] = [];
  for (const part of message.content) {
    if (part.type === "text") text += part.text;
    else if (part.type === "reasoning") {
      // Only this provider's own reasoning goes back; another model's thinking doesn't belong here.
      const meta = part.providerMetadata;
      if (meta !== undefined && Object.hasOwn(meta, provider)) reasoning.push(part.text);
    } else {
      const args = typeof part.input === "string" ? part.input : JSON.stringify(part.input);
      toolCalls.push({
        id: part.id,
        type: "function",
        function: { name: part.name, arguments: args ?? "{}" },
      });
    }
  }
  const out: Json = {
    role: "assistant",
    content: text !== "" ? text : toolCalls.length > 0 ? null : "",
  };
  if (quirks.echoReasoning && quirks.reasoningField !== undefined && reasoning.length > 0) {
    out[quirks.reasoningField] = reasoning.join("");
  }
  if (toolCalls.length > 0) out.tool_calls = toolCalls;
  return out;
}

function message(m: Message, quirks: ResolvedQuirks, provider: string): Json {
  switch (m.role) {
    case "system":
      return { role: "system", content: m.content };
    case "user":
      return {
        role: "user",
        content:
          typeof m.content === "string" ? m.content : m.content.map((p) => userPart(p, provider)),
      };
    case "assistant":
      return assistant(m, quirks, provider);
    case "tool":
      return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  }
}

function toolChoice(choice: ToolChoice): unknown {
  return typeof choice === "string"
    ? choice
    : { type: "function", function: { name: choice.name } };
}

function optionsOf(value: unknown, provider: string, where: string): Json {
  if (value === undefined) return {};
  if (!isRecord(value)) throw invalid(provider, `${where} must be an object`);
  if (value.body !== undefined && !isRecord(value.body)) {
    throw invalid(provider, `${where}.body must be an object`);
  }
  return value;
}

/** Model options, then call options, field by field. `body` merges key by key. */
export function mergedOptions(request: ModelRequest, modelRef: ModelRef, provider: string): Json {
  const fromModel = optionsOf(modelRef.options, provider, "model options");
  const callOptions = request.providerOptions;
  const fromCall = optionsOf(
    callOptions !== undefined && Object.hasOwn(callOptions, provider)
      ? callOptions[provider]
      : undefined,
    provider,
    "providerOptions",
  );
  const merged: Json = { ...fromModel, ...fromCall };
  if (fromModel.body !== undefined || fromCall.body !== undefined) {
    merged.body = { ...(fromModel.body as Json), ...(fromCall.body as Json) };
  }
  return merged;
}

/** Translates a normalized request into Chat Completions create params. Pure. */
export function toChatParams(
  request: ModelRequest,
  modelRef: ModelRef,
  quirks: ResolvedQuirks,
  provider: string,
): Json {
  const messages = request.messages.map((m) => message(m, quirks, provider));
  const params: Json = { model: modelRef.id, messages, stream: true };
  if (quirks.streamUsage) params.stream_options = { include_usage: true };

  if (request.tools !== undefined && request.tools.length > 0) {
    params.tools = request.tools.map((tool) => {
      const fn: Json = { name: tool.name };
      if (tool.description !== undefined) fn.description = tool.description;
      fn.parameters = withoutSchemaKey(tool.inputSchema);
      return { type: "function", function: fn };
    });
  }
  if (request.toolChoice !== undefined) params.tool_choice = toolChoice(request.toolChoice);

  if (request.output !== undefined) {
    const schema = withoutSchemaKey(request.output.schema);
    const mode = quirks.structuredOutput;
    if (mode.mode === "json_schema") {
      const jsonSchema: Json = { name: request.output.name, schema };
      if (mode.strict !== undefined) jsonSchema.strict = mode.strict;
      params.response_format = { type: "json_schema", json_schema: jsonSchema };
    } else {
      params.response_format = { type: "json_object" };
      // JSON mode needs the word "json" in the prompt and benefits from the schema itself.
      const at = request.messages.findIndex((m) => m.role !== "system");
      messages.splice(at === -1 ? messages.length : at, 0, {
        role: "system",
        content: `Reply only with JSON matching this JSON Schema: ${JSON.stringify(schema)}`,
      });
    }
  }
  if (request.maxOutputTokens !== undefined) {
    params[quirks.maxTokensField] = request.maxOutputTokens;
  }
  if (request.temperature !== undefined) params.temperature = request.temperature;

  const extra = quirks.options(mergedOptions(request, modelRef, provider));
  for (const [key, value] of Object.entries(extra)) {
    if (RESERVED_KEYS.includes(key)) throw invalid(provider, `options may not set "${key}"`);
    if (key === "__proto__" || value === undefined) continue;
    params[key] = value;
  }
  return params;
}
