import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkFixtureCoverage,
  FORBIDDEN_FIXTURE_KEYS,
  findFixtureLeaks,
  MAX_FIXTURE_BYTES,
} from "../scripts/guards.ts";
import { casesFor, OPT_IN } from "../scripts/recorder/cases.ts";
import { PROVIDERS } from "../scripts/recorder/models.ts";

const root = join(import.meta.dir, "..");
// Built at runtime so this file never contains a key-shaped literal.
const fakeKey = (): string => ["sk", "ant", "api03", "A".repeat(32)].join("-");

const meta = {
  kind: "meta",
  format: 1,
  provider: "openai",
  case: "text",
  api: "responses",
  sdk: "openai@7.57.0",
  model: "gpt-5.4-mini-2026-03-17",
  recordedOn: "2026-11-20",
};
const file = (...chunks: unknown[]): string =>
  `${[
    meta,
    { kind: "call", index: 0, request: { model: "m" }, options: {} },
    ...chunks.map((data) => ({ kind: "chunk", call: 0, data })),
    { kind: "end", call: 0, outcome: "completed" },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n")}\n`;

describe("findFixtureLeaks", () => {
  test("a clean, placeholdered fixture passes", () => {
    const clean = file(
      { type: "response.created", response: { id: "resp_fixture0001", created_at: 1700000000 } },
      { type: "response.output_text.delta", delta: "Hello from the fixture." },
      { encrypted_content: "fixture-opaque-0001", user: null, model: "claude-sonnet-4-5-20250929" },
    );
    expect(findFixtureLeaks(clean)).toEqual([]);
  });

  test("flags a credential anywhere, including an unknown field", () => {
    const leaks = findFixtureLeaks(file({ some_new_field: { nested: `key ${fakeKey()}` } }));
    expect(leaks).toContain("line 3: anthropic key");
  });

  test("flags forbidden keys with a value, at their path", () => {
    expect(findFixtureLeaks(file({ response: { safety_identifier: "abc" } }))).toEqual([
      "line 3: forbidden key at data.response.safety_identifier",
    ]);
    for (const key of [
      "workspaceID",
      "requestID",
      "openai-organization",
      "inference_geo",
      "user",
    ]) {
      expect(findFixtureLeaks(file({ [key]: "x" }))).toEqual([
        `line 3: forbidden key at data.${key}`,
      ]);
    }
    expect(findFixtureLeaks(file({ user: null }))).toEqual([]);
  });

  test("the forbidden list names every account field seen in the SDK types", () => {
    const required = [
      "user",
      "safety_identifier",
      "prompt_cache_key",
      "conversation",
      "metadata",
      "access_programs",
      "prompt_cache_diagnostics",
      "inference_geo",
      "service_tier",
      "requestID",
      "workspaceID",
      "request_id",
      "organization",
      "openai-organization",
      "openai-project",
      "anthropic-organization-id",
      "x-request-id",
      "request-id",
    ];
    expect([...FORBIDDEN_FIXTURE_KEYS].sort()).toEqual(required.sort());
  });

  test("flags every forbidden key", () => {
    for (const key of FORBIDDEN_FIXTURE_KEYS) {
      expect({ key, leaks: findFixtureLeaks(file({ [key]: "x" })) }).toEqual({
        key,
        leaks: [`line 3: forbidden key at data.${key}`],
      });
    }
  });

  test("flags request ids and UUIDs embedded in text, but not id-like words", () => {
    expect(
      findFixtureLeaks(file({ message: '401 {"request_id":"req_011CXyz123abcDEF"}' })),
    ).toEqual(["line 3: unscrubbed id req_011CXyz123abcDEF at data.message"]);
    expect(findFixtureLeaks(file({ text: "trace 7d6e2c1a-90b1-4f6e-8a3b-1c2d3e4f5a6b" }))).toEqual([
      "line 3: unscrubbed id 7d6e2c1a-90b1-4f6e-8a3b-1c2d3e4f5a6b at data.text",
    ]);
    expect(findFixtureLeaks(file({ delta: "I will call_weather and msg_board it" }))).toEqual([]);
  });

  test("flags real-looking ids that weren't replaced", () => {
    expect(findFixtureLeaks(file({ id: "resp_68a1b2c3d4e5f6" }))).toEqual([
      "line 3: unscrubbed id resp_68a1b2c3d4e5f6 at data.id",
    ]);
    for (const id of [
      "toolu_01AbCdEfGh",
      "chatcmpl-9xYzAbCdEf",
      "call_abc123xyz",
      "org-AbCdEf123456",
    ]) {
      expect(findFixtureLeaks(file({ text: `see ${id} here` })).length).toBe(1);
    }
    expect(findFixtureLeaks(file({ id: "call_1" }))).toEqual([]);
  });

  test("flags long opaque tokens but not model ids or prose", () => {
    const blob = "QmFzZTY0QmxvYjEyMzQ1Njc4OTBhYmNkZWZnaGlq";
    expect(findFixtureLeaks(file({ signature: blob }))).toEqual([
      "line 3: opaque token at data.signature",
    ]);
    expect(findFixtureLeaks(file({ model: "claude-sonnet-4-5-20250929" }))).toEqual([]);
    expect(
      findFixtureLeaks(file({ delta: "A perfectly ordinary sentence of model output." })),
    ).toEqual([]);
    expect(findFixtureLeaks(file({ delta: "abcdefghijklmnopqrstuvwxyzabcdef" }))).toEqual([]);
  });

  test("flags error headers outside the allowlist", () => {
    const text = `${[
      meta,
      { kind: "call", index: 0, request: {}, options: {} },
      {
        kind: "error",
        call: 0,
        phase: "create",
        afterChunks: 0,
        error: {
          name: "RateLimitError",
          status: 429,
          message: null,
          error: null,
          headers: { "retry-after": "1", "x-ratelimit-remaining-requests": "9" },
        },
      },
      { kind: "end", call: 0, outcome: "threw" },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n")}\n`;
    expect(findFixtureLeaks(text)).toEqual([
      "line 3: header not allowlisted: x-ratelimit-remaining-requests",
    ]);
  });

  test("flags invalid fixtures and oversized files", () => {
    expect(findFixtureLeaks("{nope\n")[0]).toMatch(/^invalid fixture: line 1/);
    const big = file({ delta: "x ".repeat(MAX_FIXTURE_BYTES / 2) });
    expect(findFixtureLeaks(big)).toContain(
      `file is ${big.length} bytes, over ${MAX_FIXTURE_BYTES}`,
    );
  });
});

describe("checkFixtureCoverage", () => {
  const expected = { openai: ["text", "abort", "error-context"] };
  const optIn = ["error-context"];

  test("passes when every case has a file; opt-in cases may be absent", () => {
    expect(
      checkFixtureCoverage({ openai: ["text.jsonl", "abort.jsonl"] }, expected, optIn),
    ).toEqual([]);
    expect(
      checkFixtureCoverage(
        { openai: ["text.jsonl", "abort.jsonl", "error-context.jsonl"] },
        expected,
        optIn,
      ),
    ).toEqual([]);
  });

  test("reports missing cases, unknown files and unknown providers", () => {
    expect(
      checkFixtureCoverage({ openai: ["text.jsonl", "extra.jsonl"] }, expected, optIn),
    ).toEqual(["openai: missing abort", "openai: unknown file extra.jsonl"]);
    expect(checkFixtureCoverage({ mystery: ["text.jsonl"] }, expected, optIn)).toEqual([
      "unknown provider directory mystery",
    ]);
  });
});

describe("fixtures in the repository", () => {
  const listed = (): string[] => {
    const r = Bun.spawnSync(
      ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "fixtures"],
      { cwd: root },
    );
    return r.stdout.toString().split("\0").filter(Boolean);
  };

  test("raw recordings are never tracked", () => {
    const r = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--", "fixtures/.raw"], {
      cwd: root,
    });
    expect(r.stdout.toString()).toBe("");
    const ignored = Bun.spawnSync(["git", "check-ignore", "-q", "fixtures/.raw/x.jsonl"], {
      cwd: root,
    });
    expect(ignored.exitCode).toBe(0);
  });

  test("every fixture file passes the leak guard", () => {
    for (const path of listed().filter((p) => p.endsWith(".jsonl"))) {
      expect({ path, leaks: findFixtureLeaks(readFileSync(join(root, path), "utf8")) }).toEqual({
        path,
        leaks: [],
      });
    }
  });

  test("every provider directory that exists covers every case", () => {
    const present: Record<string, string[]> = {};
    for (const path of listed()) {
      const [, provider, name] = path.split("/");
      if (provider === undefined || name === undefined) continue;
      present[provider] = [...(present[provider] ?? []), name];
    }
    const expected = Object.fromEntries(PROVIDERS.map((p) => [p, casesFor(p).map((c) => c.id)]));
    expect(checkFixtureCoverage(present, expected, OPT_IN)).toEqual([]);
    // Until fixtures are recorded and committed, no provider directory exists at all.
    for (const provider of PROVIDERS) {
      if (present[provider] === undefined) {
        expect(existsSync(join(root, "fixtures", provider))).toBe(false);
      }
    }
  });
});
