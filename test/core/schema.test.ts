import { describe, expect, test } from "bun:test";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";
import { z } from "zod";
import { isAIError } from "../../src/errors.ts";
import { isStandardJSONSchema, toJsonSchema, validate } from "../../src/schema.ts";

const spy = (props: Record<string, unknown> = {}) => {
  const targets: string[] = [];
  const schema = {
    "~standard": {
      version: 1,
      vendor: "spy",
      jsonSchema: {
        input: (o: { target: string }) => {
          targets.push(`input:${o.target}`);
          return { type: "object", from: "input" };
        },
        output: (o: { target: string }) => {
          targets.push(`output:${o.target}`);
          return { type: "object", from: "output" };
        },
      },
      ...props,
    },
  };
  return { schema, targets };
};

const expectInvalidRequest = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    expect(isAIError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("invalid_request");
    return error as Error;
  }
  throw new Error("expected invalid_request");
};

describe("isStandardJSONSchema", () => {
  test("detects Zod (prototype-held ~standard), Valibot and plain objects", () => {
    const zod = z.object({ a: z.string() });
    expect(Object.hasOwn(zod, "~standard")).toBe(false);
    expect(isStandardJSONSchema(zod)).toBe(true);
    expect(isStandardJSONSchema(toStandardJsonSchema(v.object({ a: v.string() })))).toBe(true);
    expect(isStandardJSONSchema(spy().schema)).toBe(true);
  });

  test("detects schemas that are functions", () => {
    const fn = Object.assign(() => undefined, { "~standard": spy().schema["~standard"] });
    expect(isStandardJSONSchema(fn)).toBe(true);
  });

  test("rejects values without a converter", () => {
    expect(isStandardJSONSchema(v.object({ a: v.string() }))).toBe(false);
    expect(isStandardJSONSchema({ "~standard": { version: 1, vendor: "x" } })).toBe(false);
    expect(isStandardJSONSchema({ "~standard": { version: 2, vendor: "x", jsonSchema: {} } })).toBe(
      false,
    );
    expect(isStandardJSONSchema(null)).toBe(false);
    expect(isStandardJSONSchema({ type: "object" })).toBe(false);
  });
});

describe("toJsonSchema", () => {
  test("uses the input converter with the requested target", () => {
    const { schema, targets } = spy();
    expect(toJsonSchema(schema, "draft-07")).toEqual({ type: "object", from: "input" });
    expect(targets).toEqual(["input:draft-07"]);
  });

  test("converts Zod and Valibot", () => {
    const zod = toJsonSchema(z.object({ city: z.string() }), "draft-2020-12");
    expect(zod).toMatchObject({ type: "object", properties: { city: { type: "string" } } });
    const valibot = toJsonSchema(
      toStandardJsonSchema(v.object({ city: v.string() })),
      "draft-2020-12",
    );
    expect(valibot).toMatchObject({ type: "object", properties: { city: { type: "string" } } });
  });

  test("a throwing converter is invalid_request with the cause kept", () => {
    const boom = new Error("unsupported");
    const { schema } = spy({
      jsonSchema: {
        input: () => {
          throw boom;
        },
        output: () => ({}),
      },
    });
    const err = expectInvalidRequest(() => toJsonSchema(schema, "draft-07"));
    expect(err.cause).toBe(boom);
  });

  test("an unsupported target from Valibot is invalid_request", () => {
    expectInvalidRequest(() =>
      toJsonSchema(toStandardJsonSchema(v.object({ a: v.string() })), "nope"),
    );
  });

  test("a missing converter or a non-object result is invalid_request", () => {
    expectInvalidRequest(() => toJsonSchema(v.object({ a: v.string() }), "draft-07"));
    for (const result of [null, [], "x", 1]) {
      const { schema } = spy({ jsonSchema: { input: () => result, output: () => ({}) } });
      expectInvalidRequest(() => toJsonSchema(schema, "draft-07"));
    }
  });
});

describe("validate", () => {
  test("returns the validated value on success", async () => {
    expect(await validate(z.object({ n: z.coerce.number() }), { n: "3" })).toEqual({
      ok: true,
      value: { n: 3 },
    });
  });

  test("awaits async validators", async () => {
    const { schema } = spy({
      validate: async (value: unknown) => ({ value: { wrapped: value } }),
    });
    expect(await validate(schema, 1)).toEqual({ ok: true, value: { wrapped: 1 } });
  });

  test("calls validate as a method of ~standard", async () => {
    const standard = {
      version: 1,
      vendor: "this",
      jsonSchema: { input: () => ({}), output: () => ({}) },
      tag: "bound",
      validate(this: { tag: string }, value: unknown) {
        return { value: [this.tag, value] };
      },
    };
    expect(await validate({ "~standard": standard }, 1)).toEqual({ ok: true, value: ["bound", 1] });
  });

  test("returns issues with paths on failure", async () => {
    const result = await validate(z.object({ n: z.number() }), { n: "x" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.path).toEqual(["n"]);
    const vb = await validate(toStandardJsonSchema(v.object({ n: v.number() })), { n: "x" });
    expect(vb.ok).toBe(false);
  });

  test("any truthy issues value is a failure, as the spec says", async () => {
    const { schema } = spy({ validate: () => ({ value: 5, issues: [] }) });
    expect(await validate(schema, 1)).toEqual({ ok: false, issues: [] });
  });

  test("passes the value through when the schema has no validator", async () => {
    const { schema } = spy();
    const value = { a: 1 };
    const result = await validate(schema, value);
    expect(result).toEqual({ ok: true, value });
    expect(result.ok && result.value).toBe(value);
  });
});
