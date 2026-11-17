// Vendored from @standard-schema/spec 1.1.0, https://standardschema.dev
// Copyright (c) 2024 Colin McDonnell. MIT License.
// Flattened: upstream's `declare namespace` helper types become prefixed names. The types are
// structural, so schemas from any library implementing the spec are assignable to these.

/** The Standard Typed interface. This is a base type extended by other specs. */
export interface StandardTypedV1<Input = unknown, Output = Input> {
  /** The Standard properties. */
  readonly "~standard": StandardTypedV1Props<Input, Output>;
}

/** The Standard Typed properties interface. */
export interface StandardTypedV1Props<Input = unknown, Output = Input> {
  /** The version number of the standard. */
  readonly version: 1;
  /** The vendor name of the schema library. */
  readonly vendor: string;
  /** Inferred types associated with the schema. */
  readonly types?: StandardTypedV1Types<Input, Output> | undefined;
}

/** The Standard Typed types interface. */
export interface StandardTypedV1Types<Input = unknown, Output = Input> {
  /** The input type of the schema. */
  readonly input: Input;
  /** The output type of the schema. */
  readonly output: Output;
}

/** Infers the input type of a Standard Typed. */
export type InferInput<Schema extends StandardTypedV1> = NonNullable<
  Schema["~standard"]["types"]
>["input"];

/** Infers the output type of a Standard Typed. */
export type InferOutput<Schema extends StandardTypedV1> = NonNullable<
  Schema["~standard"]["types"]
>["output"];

/** The Standard Schema interface. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  /** The Standard Schema properties. */
  readonly "~standard": StandardSchemaV1Props<Input, Output>;
}

/** The Standard Schema properties interface. */
export interface StandardSchemaV1Props<Input = unknown, Output = Input>
  extends StandardTypedV1Props<Input, Output> {
  /** Validates unknown input values. */
  readonly validate: (
    value: unknown,
    options?: StandardSchemaV1Options | undefined,
  ) => StandardSchemaV1Result<Output> | Promise<StandardSchemaV1Result<Output>>;
}

/** The result interface of the validate function. */
export type StandardSchemaV1Result<Output> =
  | StandardSchemaV1SuccessResult<Output>
  | StandardSchemaV1FailureResult;

/** The result interface if validation succeeds. */
export interface StandardSchemaV1SuccessResult<Output> {
  /** The typed output value. */
  readonly value: Output;
  /** A falsy value for `issues` indicates success. */
  readonly issues?: undefined;
}

/** The options for the validate function. */
export interface StandardSchemaV1Options {
  /** Explicit support for additional vendor-specific parameters, if needed. */
  readonly libraryOptions?: Record<string, unknown> | undefined;
}

/** The result interface if validation fails. */
export interface StandardSchemaV1FailureResult {
  /** The issues of failed validation. */
  readonly issues: ReadonlyArray<StandardSchemaV1Issue>;
}

/** The issue interface of the failure output. */
export interface StandardSchemaV1Issue {
  /** The error message of the issue. */
  readonly message: string;
  /** The path of the issue, if any. */
  readonly path?: ReadonlyArray<PropertyKey | StandardSchemaV1PathSegment> | undefined;
}

/** The path segment interface of the issue. */
export interface StandardSchemaV1PathSegment {
  /** The key representing a path segment. */
  readonly key: PropertyKey;
}

/** The Standard JSON Schema interface. */
export interface StandardJSONSchemaV1<Input = unknown, Output = Input> {
  /** The Standard JSON Schema properties. */
  readonly "~standard": StandardJSONSchemaV1Props<Input, Output>;
}

/** The Standard JSON Schema properties interface. */
export interface StandardJSONSchemaV1Props<Input = unknown, Output = Input>
  extends StandardTypedV1Props<Input, Output> {
  /** Methods for generating the input/output JSON Schema. */
  readonly jsonSchema: StandardJSONSchemaV1Converter;
}

/** The Standard JSON Schema converter interface. */
export interface StandardJSONSchemaV1Converter {
  /** Converts the input type to JSON Schema. May throw if conversion is not supported. */
  readonly input: (options: StandardJSONSchemaV1Options) => Record<string, unknown>;
  /** Converts the output type to JSON Schema. May throw if conversion is not supported. */
  readonly output: (options: StandardJSONSchemaV1Options) => Record<string, unknown>;
}

/**
 * The target version of the generated JSON Schema.
 *
 * It is *strongly recommended* that implementers support `"draft-2020-12"` and `"draft-07"`, as
 * they are both in wide use. All other targets can be implemented on a best-effort basis.
 * Libraries should throw if they don't support a specified target.
 *
 * The `"openapi-3.0"` target is intended as a standardized specifier for OpenAPI 3.0 which is a
 * superset of JSON Schema `"draft-04"`.
 */
export type StandardJSONSchemaV1Target =
  | "draft-2020-12"
  | "draft-07"
  | "openapi-3.0"
  // Accepts any string: allows future targets while preserving autocomplete
  | ({} & string);

/** The options for the input/output methods. */
export interface StandardJSONSchemaV1Options {
  /**
   * Specifies the target version of the generated JSON Schema. Support for all versions is on a
   * best-effort basis. If a given version is not supported, the library should throw.
   */
  readonly target: StandardJSONSchemaV1Target;
  /** Explicit support for additional vendor-specific parameters, if needed. */
  readonly libraryOptions?: Record<string, unknown> | undefined;
}
