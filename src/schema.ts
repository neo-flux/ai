import { AIError } from "./errors.ts";
import type {
  StandardJSONSchemaV1,
  StandardJSONSchemaV1Target,
  StandardSchemaV1Issue,
  StandardSchemaV1Result,
} from "./standard-schema.ts";

/** A schema the library can turn into JSON Schema, and validate with if it can. */
export type Schema<Input = unknown, Output = Input> = StandardJSONSchemaV1<Input, Output>;

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: readonly StandardSchemaV1Issue[] };

// Property reads, not own-property checks: Zod keeps `~standard` on the prototype.
const props = (value: unknown): Record<string, unknown> | undefined => {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }
  const standard = (value as Record<string, unknown>)["~standard"];
  return typeof standard === "object" && standard !== null
    ? (standard as Record<string, unknown>)
    : undefined;
};

export function isStandardJSONSchema(value: unknown): value is Schema {
  const p = props(value);
  if (p === undefined || p.version !== 1) return false;
  const converter = p.jsonSchema as Record<string, unknown> | undefined;
  return (
    typeof converter === "object" && converter !== null && typeof converter.input === "function"
  );
}

export function toJsonSchema(
  schema: unknown,
  target: StandardJSONSchemaV1Target,
): Record<string, unknown> {
  if (!isStandardJSONSchema(schema)) {
    throw new AIError({
      code: "invalid_request",
      cause: new TypeError("not a Standard JSON Schema"),
    });
  }
  let result: unknown;
  try {
    result = schema["~standard"].jsonSchema.input({ target });
  } catch (cause) {
    throw new AIError({ code: "invalid_request", cause });
  }
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new AIError({
      code: "invalid_request",
      cause: new TypeError("JSON Schema converter returned a non-object"),
    });
  }
  return result as Record<string, unknown>;
}

/** Validates through Standard Schema when the schema implements it, else passes the value through. */
export async function validate<T = unknown>(
  schema: unknown,
  value: unknown,
): Promise<ValidationResult<T>> {
  const p = props(schema);
  if (p === undefined || typeof p.validate !== "function") return { ok: true, value: value as T };
  // Called as a method: some libraries read `this` inside validate.
  const result = (await (p.validate as (value: unknown) => unknown).call(
    p,
    value,
  )) as StandardSchemaV1Result<T>;
  if (result.issues) return { ok: false, issues: result.issues };
  return { ok: true, value: result.value };
}
