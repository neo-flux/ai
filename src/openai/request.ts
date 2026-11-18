import type { ModelRef, ModelRequest, ToolChoice } from "../adapter.ts";
import { base64, invalid, mergedOptions, withoutSchemaKey } from "../compat/request.ts";
import type { AssistantMessage, Message, ProviderMetadata, UserPart } from "../messages.ts";

type Json = Record<string, unknown>;

export const PROVIDER = "openai";

/** Fields derived from the request. `body` may not set them. */
export const RESERVED_KEYS: readonly string[] = [
  "model",
  "input",
  "instructions",
  "stream",
  "tools",
  "tool_choice",
  "text",
  "max_output_tokens",
  "temperature",
];

const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The output item this provider stored on a part, if the part is ours. */
function ownItem(metadata: ProviderMetadata | undefined): Json | undefined {
  if (metadata === undefined || !Object.hasOwn(metadata, PROVIDER)) return undefined;
  const ours = metadata[PROVIDER];
  return isRecord(ours) && isRecord(ours.item) ? ours.item : undefined;
}

function userPart(part: UserPart): Json {
  switch (part.type) {
    case "text":
      return { type: "input_text", text: part.text };
    case "image": {
      if (typeof part.data === "string") {
        return { type: "input_image", image_url: part.data, detail: "auto" };
      }
      if (part.mediaType === undefined || part.mediaType === "") {
        throw invalid(PROVIDER, "image bytes need a mediaType");
      }
      const url = `data:${part.mediaType};base64,${base64(part.data)}`;
      return { type: "input_image", image_url: url, detail: "auto" };
    }
    case "file": {
      const file: Json = {
        type: "input_file",
        file_data: `data:${part.mediaType};base64,${base64(part.data)}`,
      };
      if (part.filename !== undefined) file.filename = part.filename;
      return file;
    }
  }
}

function assistantItems(message: AssistantMessage): Json[] {
  if (typeof message.content === "string") {
    return message.content === "" ? [] : [{ role: "assistant", content: message.content }];
  }
  const items: Json[] = [];
  let text = "";
  const flush = () => {
    if (text !== "") items.push({ role: "assistant", content: text });
    text = "";
  };
  for (const part of message.content) {
    if (part.type === "text") {
      text += part.text;
      continue;
    }
    const item = ownItem(part.providerMetadata);
    if (part.type === "reasoning") {
      // Only OpenAI's own reasoning items can go back; their encrypted content is opaque to us.
      // Dropped reasoning doesn't split the text around it.
      if (item === undefined) continue;
      flush();
      items.push(item);
    } else if (item !== undefined) {
      flush();
      items.push(item);
    } else {
      flush();
      const args = typeof part.input === "string" ? part.input : JSON.stringify(part.input);
      items.push({
        type: "function_call",
        call_id: part.id,
        name: part.name,
        arguments: args ?? "{}",
      });
    }
  }
  flush();
  return items;
}

function inputItems(m: Message): Json[] {
  switch (m.role) {
    case "system":
      return [];
    case "user":
      return [
        {
          role: "user",
          content: typeof m.content === "string" ? m.content : m.content.map(userPart),
        },
      ];
    case "assistant":
      return assistantItems(m);
    case "tool":
      return [{ type: "function_call_output", call_id: m.toolCallId, output: m.content }];
  }
}

function toolChoice(choice: ToolChoice): unknown {
  return typeof choice === "string" ? choice : { type: "function", name: choice.name };
}

/** Translates a normalized request into Responses API create params. Pure. */
export function toResponsesParams(request: ModelRequest, modelRef: ModelRef): Json {
  const options = mergedOptions(request, modelRef, PROVIDER);
  const strict = options.strictSchemas === true;
  const params: Json = { model: modelRef.id };

  const system = request.messages.filter((m) => m.role === "system").map((m) => m.content);
  if (system.length > 0) params.instructions = system.join("\n\n");
  params.input = request.messages.flatMap(inputItems);
  params.stream = true;

  if (request.tools !== undefined && request.tools.length > 0) {
    params.tools = request.tools.map((tool) => {
      const fn: Json = { type: "function", name: tool.name };
      if (tool.description !== undefined) fn.description = tool.description;
      fn.parameters = withoutSchemaKey(tool.inputSchema);
      fn.strict = strict;
      return fn;
    });
  }
  if (request.toolChoice !== undefined) params.tool_choice = toolChoice(request.toolChoice);
  if (request.output !== undefined) {
    const format: Json = {
      type: "json_schema",
      name: request.output.name,
      schema: withoutSchemaKey(request.output.schema),
    };
    if (strict) format.strict = true;
    params.text = { format };
  }
  if (request.maxOutputTokens !== undefined) params.max_output_tokens = request.maxOutputTokens;
  if (request.temperature !== undefined) params.temperature = request.temperature;

  const body = (options.body as Json | undefined) ?? {};
  for (const [key, value] of Object.entries(body)) {
    if (RESERVED_KEYS.includes(key)) throw invalid(PROVIDER, `body may not set "${key}"`);
    if (key === "__proto__" || value === undefined) continue;
    params[key] = value;
  }
  // The typed options below win over the same keys in body. Callers send the whole history every
  // turn, so storing responses on OpenAI's side adds retention and nothing else.
  if (typeof options.store === "boolean") params.store = options.store;
  else params.store ??= false;
  if (options.reasoning !== undefined) params.reasoning = options.reasoning;
  if (Array.isArray(options.include)) {
    params.include = options.include;
  } else if (
    params.include === undefined &&
    options.reasoning !== undefined &&
    params.store === false
  ) {
    // Without storage, reasoning can only go back to the model as its encrypted content.
    params.include = ["reasoning.encrypted_content"];
  }
  return params;
}
