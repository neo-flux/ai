import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "../../src/standard-schema.ts";
import { type Fixture, parseFixture } from "../../src/testing/fixture.ts";

const ROOT = join(import.meta.dir, "..", "..", "fixtures");

/** A committed, scrubbed fixture. */
export async function loadFixture(provider: string, caseId: string): Promise<Fixture> {
  return parseFixture(await Bun.file(join(ROOT, provider, `${caseId}.jsonl`)).text());
}

/** The case ids recorded for a provider. */
export function recordedCases(provider: string): string[] {
  return readdirSync(join(ROOT, provider))
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length))
    .sort();
}

/** The recorded request of call `index`, as a plain object. */
export function recordedRequest(fixture: Fixture, index: number): Record<string, unknown> {
  const call = fixture.calls[index];
  if (call === undefined) throw new Error(`fixture has no call ${index}`);
  return call.request as Record<string, unknown>;
}

/** A schema whose JSON Schema is exactly `json`, validated as "any object". */
export function rawSchema(json: Record<string, unknown>): StandardJSONSchemaV1 & StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      jsonSchema: { input: () => json, output: () => json },
      validate: (value: unknown) =>
        typeof value === "object" && value !== null
          ? { value }
          : { issues: [{ message: "expected an object" }] },
    },
  } as StandardJSONSchemaV1 & StandardSchemaV1;
}
