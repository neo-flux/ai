import { describe, expect, expectTypeOf, test } from "bun:test";
import type * as Upstream from "@standard-schema/spec";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";
import { z } from "zod";
import type {
  InferInput,
  InferOutput,
  StandardJSONSchemaV1,
  StandardJSONSchemaV1Converter,
  StandardJSONSchemaV1Options,
  StandardJSONSchemaV1Props,
  StandardJSONSchemaV1Target,
  StandardSchemaV1,
  StandardSchemaV1FailureResult,
  StandardSchemaV1Issue,
  StandardSchemaV1Options,
  StandardSchemaV1PathSegment,
  StandardSchemaV1Props,
  StandardSchemaV1Result,
  StandardSchemaV1SuccessResult,
  StandardTypedV1,
  StandardTypedV1Props,
  StandardTypedV1Types,
} from "../../src/standard-schema.ts";

// Mutual assignability: the flattened vendored copy must not drift from @standard-schema/spec.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("vendored Standard Schema interfaces", () => {
  test("match @standard-schema/spec 1.1.0", () => {
    expectTypeOf<
      Same<StandardTypedV1<string, number>, Upstream.StandardTypedV1<string, number>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Same<StandardTypedV1Props<string, number>, Upstream.StandardTypedV1.Props<string, number>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Same<StandardTypedV1Types<string, number>, Upstream.StandardTypedV1.Types<string, number>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Same<StandardSchemaV1<string, number>, Upstream.StandardSchemaV1<string, number>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Same<StandardSchemaV1Props<string, number>, Upstream.StandardSchemaV1.Props<string, number>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Same<StandardSchemaV1Result<number>, Upstream.StandardSchemaV1.Result<number>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Same<StandardSchemaV1SuccessResult<number>, Upstream.StandardSchemaV1.SuccessResult<number>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Same<StandardSchemaV1FailureResult, Upstream.StandardSchemaV1.FailureResult>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Same<StandardSchemaV1Issue, Upstream.StandardSchemaV1.Issue>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Same<StandardSchemaV1PathSegment, Upstream.StandardSchemaV1.PathSegment>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Same<StandardSchemaV1Options, Upstream.StandardSchemaV1.Options>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Same<StandardJSONSchemaV1<string, number>, Upstream.StandardJSONSchemaV1<string, number>>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Same<
        StandardJSONSchemaV1Props<string, number>,
        Upstream.StandardJSONSchemaV1.Props<string, number>
      >
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Same<StandardJSONSchemaV1Converter, Upstream.StandardJSONSchemaV1.Converter>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Same<StandardJSONSchemaV1Options, Upstream.StandardJSONSchemaV1.Options>
    >().toEqualTypeOf<true>();
    expectTypeOf<
      Same<StandardJSONSchemaV1Target, Upstream.StandardJSONSchemaV1.Target>
    >().toEqualTypeOf<true>();
    expect(true).toBe(true);
  });

  test("Zod and Valibot schemas are assignable to both interfaces", () => {
    const zod = z.object({ city: z.string(), days: z.number().optional() });
    const valibot = toStandardJsonSchema(v.object({ city: v.string() }));
    expectTypeOf(zod).toExtend<StandardSchemaV1>();
    expectTypeOf(zod).toExtend<StandardJSONSchemaV1>();
    expectTypeOf(valibot).toExtend<StandardJSONSchemaV1>();
    expectTypeOf<InferOutput<typeof zod>>().toEqualTypeOf<z.output<typeof zod>>();
    expectTypeOf<InferInput<typeof zod>>().toEqualTypeOf<z.input<typeof zod>>();
    expectTypeOf<InferOutput<typeof valibot>>().toEqualTypeOf<{ city: string }>();
    expect(zod["~standard"].vendor).toBe("zod");
    expect(valibot["~standard"].vendor).toBe("valibot");
  });
});
