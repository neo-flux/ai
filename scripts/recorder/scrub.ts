// Turns a raw recording into a committable fixture. Pure, deterministic and idempotent. Bodies
// are scrubbed by denylist plus patterns; headers by allowlist. The result must pass the fixture
// guard, or scrubText refuses.
import {
  type Fixture,
  type FixtureCall,
  parseFixture,
  type RecordedError,
  serializeFixture,
} from "../../src/testing/fixture.ts";
import {
  FIXTURE_ID_PATTERN,
  FORBIDDEN_FIXTURE_KEYS,
  findFixtureLeaks,
  PERSONAL_PATTERNS,
  redactSecrets,
} from "../guards.ts";
import { allowlistHeaders } from "./record.ts";

// Every `*_id` key (call_id, tool_use_id, previous_response_id, ...) is an id too, see value().
const ID_KEYS = new Set(["id", "system_fingerprint"]);
const OPAQUE_KEYS = new Set(["encrypted_content", "signature"]);
// Keys that would change an object's prototype if anything assigned them.
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const TIME_KEYS = new Set(["created", "created_at", "completed_at"]);
export const FIXED_TIME = 1_700_000_000;
export const MAX_STRING = 20_000;

const isPlaceholder = (value: string): boolean => value.includes("fixture");
const number = (n: number): string => String(n).padStart(4, "0");

class Scrubber {
  #ids = new Map<string, string>();
  #opaque = new Map<string, string>();

  // Empty values stay empty: SDK streams use "" for "not yet known", and replay must match.
  id(raw: string): string {
    if (raw === "" || isPlaceholder(raw)) return raw;
    let placeholder = this.#ids.get(raw);
    if (placeholder === undefined) {
      const prefix = /^([A-Za-z]+[_-])/.exec(raw)?.[1] ?? "id_";
      placeholder = `${prefix}fixture${number(this.#ids.size + 1)}`;
      this.#ids.set(raw, placeholder);
    }
    return placeholder;
  }

  opaque(raw: string): string {
    if (raw === "" || isPlaceholder(raw)) return raw;
    let placeholder = this.#opaque.get(raw);
    if (placeholder === undefined) {
      placeholder = `fixture-opaque-${number(this.#opaque.size + 1)}`;
      this.#opaque.set(raw, placeholder);
    }
    return placeholder;
  }

  string(value: string): string {
    if (value.length > MAX_STRING) return `[scrubbed: ${value.length} chars]`;
    // Credentials first: an id pattern (proj-…) can match inside a key and mangle it instead.
    const ids = redactSecrets(value).replace(FIXTURE_ID_PATTERN, (match) => this.id(match));
    return PERSONAL_PATTERNS.reduce((out, [, pattern]) => out.replace(pattern, "[scrubbed]"), ids);
  }

  value(value: unknown, key: string, parent: Record<string, unknown> | undefined): unknown {
    if (FORBIDDEN_FIXTURE_KEYS.includes(key)) return value === undefined ? undefined : null;
    if (key === "headers") return allowlistHeaders(value);
    if (typeof value === "string") {
      // Random padding that normalizes payload sizes; meaningless, and it trips the token guard.
      if (key === "obfuscation") return "";
      if (ID_KEYS.has(key) || key.endsWith("_id")) return this.id(value);
      if (OPAQUE_KEYS.has(key)) return this.opaque(value);
      if (key === "data" && parent?.type === "redacted_thinking") return this.opaque(value);
      return this.string(value);
    }
    if (typeof value === "number" && TIME_KEYS.has(key)) return FIXED_TIME;
    if (Array.isArray(value)) return value.map((item) => this.value(item, key, parent));
    if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(record)
          .filter(([k]) => !DANGEROUS_KEYS.has(k))
          .map(([k, v]) => [k, this.value(v, k, record)]),
      );
    }
    return value;
  }
}

export function scrubFixture(fixture: Fixture): Fixture {
  const s = new Scrubber();
  const calls = fixture.calls.map((call): FixtureCall => {
    const out: FixtureCall = {
      index: call.index,
      request: s.value(call.request, "request", undefined),
      options: { ...call.options },
      chunks: call.chunks.map((chunk) => s.value(chunk, "data", undefined)),
      outcome: call.outcome,
    };
    if (call.error !== undefined) {
      out.error = {
        phase: call.error.phase,
        afterChunks: call.error.afterChunks,
        error: s.value(call.error.error, "error", undefined) as RecordedError,
      };
    }
    return out;
  });
  return { meta: { ...fixture.meta }, calls };
}

/** Parses, scrubs and re-serializes. Throws if the guard still finds anything. */
export function scrubText(text: string): string {
  const out = serializeFixture(scrubFixture(parseFixture(text)));
  const leaks = findFixtureLeaks(out);
  if (leaks.length > 0) {
    throw new Error(`scrubber left ${leaks.length} leak(s):\n${leaks.join("\n")}`);
  }
  return out;
}
