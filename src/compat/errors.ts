import type { Classification, ErrorShape } from "../errors.ts";
import type { ResolvedQuirks } from "./quirks.ts";

// openai/core/error.js: the fixed default message of APIConnectionTimeoutError. Timeout and
// connection errors share every other field, so this constant is the only thing that tells them
// apart. A test pins it to the SDK, and both outcomes fail over, so a mislabel can't change
// behaviour.
const SDK_TIMEOUT_MESSAGE = "Request timed out.";

const read = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

// The SDK's APIError always defines `status` and `error`, even when both are undefined.
const sdkShaped = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "status" in error && "error" in error;

/** Chat Completions error mapping: the quirk first, then the SDK's status-less shapes. */
export function classifyCompatError(
  quirks: ResolvedQuirks,
): (shape: ErrorShape, error: unknown) => Classification | undefined {
  return (shape, error) => {
    const custom = quirks.classifyError?.(shape, error);
    if (custom !== undefined) return custom;
    if (shape.status !== undefined || !sdkShaped(error)) return undefined;
    const body = read(error, "error");
    if (body === undefined || body === null) {
      // No status and no body: the request never got an HTTP response.
      return {
        code: read(error, "message") === SDK_TIMEOUT_MESSAGE ? "timeout" : "provider_unavailable",
      };
    }
    // A body without a status is an error event inside the stream.
    return { code: "provider_unavailable" };
  };
}
