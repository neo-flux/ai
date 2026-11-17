import { describe, expect, expectTypeOf, test } from "bun:test";
import { toStandardJsonSchema } from "@valibot/to-json-schema";
import * as v from "valibot";
import { z } from "zod";
import { isAIError } from "../../src/errors.ts";
import { parseToolCall, prepareTools, type ToolCallOf } from "../../src/tools.ts";

const tools = {
  weather: { description: "Get the weather", schema: z.object({ city: z.string() }) },
  ping: { schema: toStandardJsonSchema(v.object({})) },
  count: { schema: z.object({ n: z.coerce.number() }) },
};

describe("prepareTools", () => {
  test("converts each tool's input schema with the target", () => {
    const prepared = prepareTools(tools, "draft-2020-12");
    expect(prepared?.map((t) => [t.name, t.description])).toEqual([
      ["weather", "Get the weather"],
      ["ping", undefined],
      ["count", undefined],
    ]);
    expect(prepared?.[0]?.inputSchema).toMatchObject({
      type: "object",
      properties: { city: { type: "string" } },
    });
  });

  test("no tools means undefined, not an empty list", () => {
    expect(prepareTools(undefined, "draft-07")).toBeUndefined();
    expect(prepareTools({}, "draft-07")).toBeUndefined();
  });

  test("rejects empty names and non-schemas as invalid_request", () => {
    for (const bad of [{ "": tools.weather }, { x: { schema: { type: "object" } } }, { x: null }]) {
      try {
        prepareTools(bad as never, "draft-07");
        throw new Error("expected a throw");
      } catch (error) {
        expect(isAIError(error)).toBe(true);
        expect((error as { code: string }).code).toBe("invalid_request");
      }
    }
  });
});

describe("parseToolCall", () => {
  test("parses and validates input, keeping the raw text", async () => {
    const call = await parseToolCall(tools, "c1", "count", '{"n":"4"}', { fake: 1 });
    expect(call).toEqual({
      id: "c1",
      name: "count",
      input: { n: 4 },
      rawInput: '{"n":"4"}',
      providerMetadata: { fake: 1 },
    });
  });

  test("empty or whitespace arguments mean {}", async () => {
    expect((await parseToolCall(tools, "c1", "ping", "", undefined)).input).toEqual({});
    expect((await parseToolCall(tools, "c1", "ping", "  \n", undefined)).input).toEqual({});
  });

  test("broken JSON is invalid_json, with the raw text as input", async () => {
    const call = await parseToolCall(tools, "c1", "weather", '{"city":', undefined);
    expect(call.error).toEqual({ kind: "invalid_json" });
    expect(call.input).toBe('{"city":');
  });

  test("schema failure is invalid_input with issues, input left as parsed", async () => {
    const call = await parseToolCall(tools, "c1", "weather", '{"city":3}', undefined);
    expect(call.error?.kind).toBe("invalid_input");
    expect(call.error?.issues?.[0]?.path).toEqual(["city"]);
    expect(call.input).toEqual({ city: 3 });
  });

  test("an unknown tool is unknown_tool", async () => {
    const call = await parseToolCall(tools, "c1", "nope", "{}", undefined);
    expect(call.error).toEqual({ kind: "unknown_tool" });
    expect(call.input).toEqual({});
  });

  test("inherited object keys are not tools", async () => {
    const call = await parseToolCall(tools, "c1", "toString", "{}", undefined);
    expect(call.error).toEqual({ kind: "unknown_tool" });
  });

  test("never throws, even when a validator does", async () => {
    const throwing = {
      bad: {
        schema: {
          "~standard": {
            version: 1 as const,
            vendor: "x",
            jsonSchema: { input: () => ({}), output: () => ({}) },
            validate: () => {
              throw new Error("boom");
            },
          },
        },
      },
    };
    const call = await parseToolCall(throwing, "c1", "bad", "{}", undefined);
    expect(call.error?.kind).toBe("invalid_input");
  });

  test("ToolCallOf narrows input by name once error is ruled out", () => {
    const call = {} as ToolCallOf<typeof tools>;
    if (call.error === undefined && call.name === "weather") {
      expectTypeOf(call.input).toEqualTypeOf<{ city: string }>();
    }
    if (call.error === undefined && call.name === "count") {
      expectTypeOf(call.input).toEqualTypeOf<{ n: number }>();
    }
    if (call.error !== undefined) expectTypeOf(call.input).toEqualTypeOf<unknown>();
    expect(true).toBe(true);
  });
});
