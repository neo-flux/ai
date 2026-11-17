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

const FENCE = "```";

// Some providers wrap JSON in a Markdown fence even when asked not to. String operations, not a
// regex: the text is model output and must not be able to make parsing super-linear.
export function stripFence(text: string): string {
  if (text.length < 6 || !text.startsWith(FENCE) || !text.endsWith(FENCE)) return text;
  const newline = text.indexOf("\n");
  if (newline === -1 || newline > text.length - 3) return text;
  const lang = text.slice(3, newline).trim();
  if (lang !== "" && lang !== "json") return text;
  return text.slice(newline + 1, -3);
}

export async function parseOutput(schema: Schema, text: string): Promise<Parsed> {
  let value: unknown;
  try {
    value = JSON.parse(stripFence(text.trim()));
  } catch {
    return { ok: false, issues: [{ message: "The response is not valid JSON." }] };
  }
  try {
    return await validate(schema, value);
  } catch {
    // Hostile output (say, absurdly deep nesting) can make a validator throw. Treat it as invalid.
    return { ok: false, issues: [{ message: "The response could not be validated." }] };
  }
}

// The repair prompt echoes model-derived paths and validator messages back to the same model, so
// it is bounded and paths are quoted rather than spliced in as text.
const MAX_ISSUES = 10;
const MAX_SEGMENTS = 8;
const MAX_TEXT = 200;
const clip = (text: string): string =>
  text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;

const describePath = (issue: StandardSchemaV1Issue): string => {
  const segments = (issue.path ?? []).map((segment) => {
    const key = typeof segment === "object" ? segment.key : segment;
    return typeof key === "number" ? key : clip(String(key));
  });
  if (segments.length === 0) return "";
  const shown =
    segments.length > MAX_SEGMENTS ? [...segments.slice(0, MAX_SEGMENTS), "…"] : segments;
  return JSON.stringify(shown);
};

export function repairPrompt(issues: readonly StandardSchemaV1Issue[]): string {
  const lines = issues.slice(0, MAX_ISSUES).map((issue) => {
    const path = describePath(issue);
    const message = clip(issue.message);
    return path === "" ? `- ${message}` : `- at ${path}: ${message}`;
  });
  if (issues.length > MAX_ISSUES) lines.push(`- and ${issues.length - MAX_ISSUES} more`);
  const problems = lines.join("\n");
  return `Your previous response was not valid JSON matching the required schema. Problems:\n${problems}\nReply with only the corrected JSON.`;
}

const sumCost = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined || b === undefined ? undefined : a + b;

/** Runs one call to completion. A fold over the same stream `streamText` returns. */
export async function generate<T extends Tools = Tools, O extends Schema | undefined = undefined>(
  options: GenerateOptions<T, O>,
): Promise<GenerateResult<T, O>> {
  const { output, ...call } = options;
  const first: Outcome = await new Stream(call, { output, kind: "initial", attemptStart: 0 }, false)
    .outcome;
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
    false,
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
