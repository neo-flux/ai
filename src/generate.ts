import { AIError } from "./errors.ts";
import type { Message } from "./messages.ts";
import type { CallOptions, Outcome } from "./run.ts";
import { type Schema, validate } from "./schema.ts";
import type { InferOutput, StandardSchemaV1Issue } from "./standard-schema.ts";
import { Stream, type TextResult, toTextResult } from "./stream-text.ts";
import type { Tools } from "./tools.ts";
import { sumUsage } from "./usage.ts";

export interface GenerateOptions<T extends Tools = Tools, O extends Schema | undefined = undefined>
  extends CallOptions<T> {
  /**
   * Structured output: the answer must be JSON matching this schema. One repair attempt on the
   * same model, then `AIError` `output_validation`. `generate` only.
   */
  output?: O | undefined;
}

export type GenerateResult<
  T extends Tools = Tools,
  O extends Schema | undefined = undefined,
> = TextResult<T> & { output: O extends Schema ? InferOutput<O> : undefined };

type Parsed =
  | { ok: true; value: unknown }
  | { ok: false; issues: readonly StandardSchemaV1Issue[] };

// Some providers wrap JSON in a Markdown fence even when asked not to.
const FENCE = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/;

export async function parseOutput(schema: Schema, text: string): Promise<Parsed> {
  const trimmed = text.trim();
  const body = FENCE.exec(trimmed)?.[1] ?? trimmed;
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, issues: [{ message: "The response is not valid JSON." }] };
  }
  return validate(schema, value);
}

const describePath = (issue: StandardSchemaV1Issue): string =>
  (issue.path ?? [])
    .map((segment) => String(typeof segment === "object" ? segment.key : segment))
    .join(".");

export function repairPrompt(issues: readonly StandardSchemaV1Issue[]): string {
  const problems = issues
    .map((issue) => {
      const path = describePath(issue);
      return path === "" ? `- ${issue.message}` : `- ${path}: ${issue.message}`;
    })
    .join("\n");
  return `Your previous response was not valid JSON matching the required schema. Problems:\n${problems}\nReply with only the corrected JSON.`;
}

const sumCost = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined || b === undefined ? undefined : a + b;

/** Runs one call to completion. A fold over the same stream `streamText` returns. */
export async function generate<T extends Tools = Tools, O extends Schema | undefined = undefined>(
  options: GenerateOptions<T, O>,
): Promise<GenerateResult<T, O>> {
  const { output, ...call } = options;
  const first: Outcome = await new Stream(call, {
    output,
    kind: "initial",
    attemptStart: 0,
  }).outcome;
  const result = await toTextResult(first, call.tools);
  if (output === undefined) return { ...result, output: undefined } as GenerateResult<T, O>;

  const parsed = await parseOutput(output, result.text);
  if (parsed.ok) return { ...result, output: parsed.value } as GenerateResult<T, O>;

  const messages: Message[] = [
    ...call.messages,
    { role: "assistant", content: result.text },
    { role: "user", content: repairPrompt(parsed.issues) },
  ];
  const second: Outcome = await new Stream(
    { ...call, messages },
    { output, kind: "repair", attemptStart: first.attempts, fixedModels: [result.modelRef] },
  ).outcome;
  const repaired = await toTextResult(second, call.tools);
  const usage = sumUsage(result.usage, repaired.usage);
  const cost = sumCost(result.cost, repaired.cost);
  const reparsed = await parseOutput(output, repaired.text);
  if (!reparsed.ok) {
    throw new AIError({
      code: "output_validation",
      provider: repaired.modelRef.provider,
      rawText: repaired.text,
      issues: reparsed.issues,
    });
  }
  return { ...repaired, usage, cost, output: reparsed.value } as GenerateResult<T, O>;
}
