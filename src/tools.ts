import { AIError } from "./errors.ts";
import type { ProviderMetadata } from "./messages.ts";
import { type Schema, toJsonSchema, validate } from "./schema.ts";
import type {
  InferOutput,
  StandardJSONSchemaV1Target,
  StandardSchemaV1Issue,
} from "./standard-schema.ts";

export interface Tool<S extends Schema = Schema> {
  description?: string | undefined;
  /** Converted to JSON Schema for the provider, and used to validate the call's input. */
  schema: S;
}

/** Tools keyed by name. */
export type Tools = Readonly<Record<string, Tool>>;

/** A tool as adapters receive it. */
export interface PreparedTool {
  name: string;
  description: string | undefined;
  inputSchema: Record<string, unknown>;
}

export type ToolInputErrorKind = "unknown_tool" | "invalid_json" | "invalid_input";

export interface ToolInputError {
  kind: ToolInputErrorKind;
  issues?: readonly StandardSchemaV1Issue[] | undefined;
}

interface ToolCallBase {
  id: string;
  /** The arguments exactly as the model sent them. */
  rawInput: string;
  providerMetadata?: ProviderMetadata | undefined;
}

export interface ValidToolCall<Name extends string = string, Input = unknown> extends ToolCallBase {
  name: Name;
  input: Input;
  error?: undefined;
}

/** A call the library couldn't match or validate. Send the model an error tool message. */
export interface InvalidToolCall extends ToolCallBase {
  name: string;
  /** The parsed arguments, or the raw text if they weren't valid JSON. */
  input: unknown;
  error: ToolInputError;
}

export type ToolCallOf<T extends Tools> =
  | { [K in keyof T & string]: ValidToolCall<K, InferOutput<T[K]["schema"]>> }[keyof T & string]
  | InvalidToolCall;

const invalid = (reason: string): AIError =>
  new AIError({ code: "invalid_request", cause: new TypeError(reason) });

export function prepareTools(
  tools: Tools | undefined,
  target: StandardJSONSchemaV1Target,
): PreparedTool[] | undefined {
  if (tools === undefined) return undefined;
  const entries = Object.entries(tools);
  if (entries.length === 0) return undefined;
  return entries.map(([name, tool]) => {
    if (name === "") throw invalid("tool names must be non-empty");
    if (typeof tool !== "object" || tool === null) throw invalid("each tool must be an object");
    return { name, description: tool.description, inputSchema: toJsonSchema(tool.schema, target) };
  });
}

/** Parses JSON. An empty argument string means no arguments. */
export function parseArguments(raw: string): { ok: true; value: unknown } | { ok: false } {
  if (raw.trim() === "") return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

/** Never throws: problems are reported on the returned call. */
export async function parseToolCall<T extends Tools>(
  tools: T | undefined,
  id: string,
  name: string,
  rawInput: string,
  providerMetadata: ProviderMetadata | undefined,
): Promise<ToolCallOf<T>> {
  const base = { id, name, rawInput, ...(providerMetadata && { providerMetadata }) };
  const parsed = parseArguments(rawInput);
  const input = parsed.ok ? parsed.value : rawInput;
  const tool = tools !== undefined && Object.hasOwn(tools, name) ? tools[name] : undefined;
  if (tool === undefined) return { ...base, input, error: { kind: "unknown_tool" } };
  if (!parsed.ok) return { ...base, input, error: { kind: "invalid_json" } };
  let result: Awaited<ReturnType<typeof validate>>;
  try {
    result = await validate(tool.schema, parsed.value);
  } catch {
    return { ...base, input, error: { kind: "invalid_input" } };
  }
  if (!result.ok)
    return { ...base, input, error: { kind: "invalid_input", issues: result.issues } };
  return { ...base, input: result.value } as ToolCallOf<T>;
}
