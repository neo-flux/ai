import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { casesFor } from "../../scripts/recorder/cases.ts";
import {
  clientOptions,
  formatPlan,
  listQwenModels,
  missingEnv,
  parseRecordArgs,
  plan,
  scrubAll,
  unsafeEnv,
  withParams,
} from "../../scripts/recorder/cli.ts";
import type { ProviderModels } from "../../scripts/recorder/models.ts";
import { serializeFixture } from "../../src/testing/fixture.ts";

describe("parseRecordArgs", () => {
  test("reads providers, cases, opt-ins and dry run", () => {
    expect(
      parseRecordArgs(["--provider", "openai", "--case", "text", "--case", "abort", "--dry-run"]),
    ).toEqual({
      providers: ["openai"],
      cases: ["text", "abort"],
      include: [],
      dryRun: true,
    });
    expect(parseRecordArgs(["--provider", "all", "--include", "error-context"])).toEqual({
      providers: ["openai", "anthropic", "deepseek", "qwen"],
      cases: undefined,
      include: ["error-context"],
      dryRun: false,
    });
  });

  test("rejects unknown flags, providers and opt-ins, and requires a provider", () => {
    expect(() => parseRecordArgs([])).toThrow(/--provider/);
    expect(() => parseRecordArgs(["--provider", "acme"])).toThrow(/unknown provider acme/);
    expect(() => parseRecordArgs(["--provider", "openai", "--fast"])).toThrow(
      /unknown argument --fast/,
    );
    expect(() => parseRecordArgs(["--provider", "openai", "--include", "text"])).toThrow(
      /not an opt-in/,
    );
    expect(() => parseRecordArgs(["--provider"])).toThrow(/needs a value/);
  });
});

describe("missingEnv", () => {
  test("lists the variables each provider needs that are unset or empty", () => {
    expect(missingEnv(["openai", "anthropic"], { OPENAI_API_KEY: "x" })).toEqual([
      "ANTHROPIC_API_KEY",
    ]);
    expect(
      missingEnv(["deepseek"], { DEEPSEEK_API_KEY: "x", NEOFLUX_AI_DEEPSEEK_BASE_URL: "" }),
    ).toEqual(["NEOFLUX_AI_DEEPSEEK_BASE_URL"]);
    expect(missingEnv(["qwen"], {})).toEqual([
      "DASHSCOPE_API_KEY",
      "NEOFLUX_AI_QWEN_BASE_URL",
      "NEOFLUX_AI_QWEN_MODELS_URL",
    ]);
  });
});

describe("plan", () => {
  const models: Record<string, ProviderModels> = {
    openai: { default: { model: "fast" }, cases: { reasoning: { model: "thinker" } } },
    deepseek: { default: { model: "ds" } },
  };

  test("excludes opt-in cases unless included, and resolves each case's model", () => {
    const p = plan({ providers: ["openai"], cases: undefined, include: [], dryRun: true }, models);
    expect(p.map((c) => c.caseId)).toEqual(
      casesFor("openai")
        .map((c) => c.id)
        .filter((id) => id !== "error-context"),
    );
    expect(p.find((c) => c.caseId === "reasoning")?.model.model).toBe("thinker");
    expect(p.find((c) => c.caseId === "text")?.model.model).toBe("fast");
    const withContext = plan(
      { providers: ["openai"], cases: undefined, include: ["error-context"], dryRun: true },
      models,
    );
    expect(withContext.map((c) => c.caseId)).toContain("error-context");
  });

  test("a case's config params reach its request", () => {
    const p = plan(
      { providers: ["openai"], cases: ["text"], include: [], dryRun: true },
      {
        openai: {
          default: { model: "fast" },
          cases: { text: { model: "fast", params: { temperature: 0 } } },
        },
      },
    );
    const request = p[0]?.spec.build({ turn: 0, model: "fast", previous: [] }).params as Record<
      string,
      unknown
    >;
    expect(request.temperature).toBe(0);
  });

  test("a selected case list is honoured, including DeepSeek's extra case", () => {
    const p = plan(
      { providers: ["deepseek"], cases: ["error-reasoning-missing"], include: [], dryRun: true },
      models,
    );
    expect(p.map((c) => [c.provider, c.caseId, c.spec.turns])).toEqual([
      ["deepseek", "error-reasoning-missing", 2],
    ]);
  });

  test("an unknown case is an error", () => {
    expect(() =>
      plan({ providers: ["openai"], cases: ["nope"], include: [], dryRun: true }, models),
    ).toThrow(/openai has no case nope/);
  });

  test("formatPlan lists every case and the request total", () => {
    const p = plan(
      { providers: ["openai"], cases: ["text", "tool-round-trip"], include: [], dryRun: true },
      models,
    );
    expect(formatPlan(p)).toBe(
      "openai text (fast, 1 call)\nopenai tool-round-trip (fast, 2 calls)\n3 requests in total",
    );
  });
});

describe("withParams", () => {
  test("merges the config's params into every turn's request", () => {
    const [spec] = casesFor("anthropic").filter((c) => c.id === "reasoning");
    if (spec === undefined) throw new Error("no spec");
    const merged = withParams(spec, { thinking: { type: "adaptive" } });
    const params = merged.build({ turn: 0, model: "m", previous: [] }).params as Record<
      string,
      unknown
    >;
    expect(params.thinking).toEqual({ type: "adaptive" });
    expect(params.model).toBe("m");
    expect(withParams(spec, undefined)).toBe(spec);
  });
});

describe("listQwenModels", () => {
  test("pages through the native models endpoint with the bearer key", async () => {
    const requests: { url: string; auth: string | null }[] = [];
    const pages = [
      { output: { total: 3, page_no: 1, page_size: 2, models: [{ model: "a" }, { model: "b" }] } },
      { output: { total: 3, page_no: 2, page_size: 2, models: [{ model: "c" }] } },
    ];
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
      return Response.json(pages[requests.length - 1]);
    };
    const ids: string[] = [];
    for await (const id of listQwenModels("https://example.test/api/v1/models", "k", fakeFetch, 2))
      ids.push(id);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(requests.map((r) => r.url)).toEqual([
      "https://example.test/api/v1/models?page_no=1&page_size=2",
      "https://example.test/api/v1/models?page_no=2&page_size=2",
    ]);
    expect(requests[0]?.auth).toBe("Bearer k");
  });

  test("fails on a non-OK response", async () => {
    const fakeFetch = async () => new Response("no", { status: 401 });
    const run = async () => {
      for await (const _ of listQwenModels("https://example.test/m", "k", fakeFetch)) {
        // drain
      }
    };
    await expect(run()).rejects.toThrow(/models list failed: HTTP 401/);
  });
});

describe("scrubAll", () => {
  let root = "";
  afterEach(() => {
    if (root !== "") rmSync(root, { recursive: true, force: true });
  });

  const raw = (id: string) =>
    serializeFixture({
      meta: {
        kind: "meta",
        format: 1,
        provider: "openai",
        case: "text",
        api: "responses",
        sdk: "openai@7.57.0",
        model: "m",
        recordedOn: "2026-11-20",
      },
      calls: [{ index: 0, request: {}, options: {}, chunks: [{ id }], outcome: "completed" }],
    });

  test("writes scrubbed copies and reports files it refuses", () => {
    root = mkdtempSync(join(tmpdir(), "neoflux-ai-scrub-"));
    mkdirSync(join(root, ".raw/openai"), { recursive: true });
    writeFileSync(join(root, ".raw/openai/text.jsonl"), raw("resp_68a1b2c3d4e5f6"));
    writeFileSync(
      join(root, ".raw/openai/abort.jsonl"),
      raw("QmFzZTY0QmxvYjEyMzQ1Njc4OTBhYmNk").replace('"id"', '"blob"'),
    );
    const result = scrubAll(root);
    expect(result.written).toEqual(["openai/text.jsonl"]);
    expect(result.refused.map((r) => r.file)).toEqual(["openai/abort.jsonl"]);
    expect(readFileSync(join(root, "openai/text.jsonl"), "utf8")).toContain("resp_fixture0001");
    expect(existsSync(join(root, "openai/abort.jsonl"))).toBe(false);
  });

  test("an absent raw directory scrubs nothing", () => {
    root = mkdtempSync(join(tmpdir(), "neoflux-ai-scrub-"));
    expect(scrubAll(root)).toEqual({ written: [], refused: [] });
  });
});

describe("unsafeEnv", () => {
  test("refuses SDK variables that redirect requests or add credentials and headers", () => {
    const risky = [
      "OPENAI_BASE_URL",
      "OPENAI_CUSTOM_HEADERS",
      "OPENAI_ORG_ID",
      "OPENAI_PROJECT_ID",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_CUSTOM_HEADERS",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_OPEN_TELEMETRY",
    ];
    for (const name of risky) {
      expect({ name, problems: unsafeEnv(["openai"], { [name]: "x" }) }).toEqual({
        name,
        problems: [`${name} is set; unset it before recording`],
      });
    }
    expect(unsafeEnv(["openai"], { OPENAI_API_KEY: "k", OPENAI_LOG: "debug" })).toEqual([]);
  });

  test("requires https for every configured URL", () => {
    expect(
      unsafeEnv(["deepseek", "qwen"], {
        NEOFLUX_AI_DEEPSEEK_BASE_URL: "http://proxy.example",
        NEOFLUX_AI_QWEN_BASE_URL: "https://ok.example/v1",
        NEOFLUX_AI_QWEN_MODELS_URL: "ftp://x",
      }),
    ).toEqual([
      "NEOFLUX_AI_DEEPSEEK_BASE_URL must be an https URL",
      "NEOFLUX_AI_QWEN_MODELS_URL must be an https URL",
    ]);
    expect(unsafeEnv(["deepseek"], { NEOFLUX_AI_DEEPSEEK_BASE_URL: "not a url" })).toEqual([
      "NEOFLUX_AI_DEEPSEEK_BASE_URL must be an https URL",
    ]);
  });
});

describe("clientOptions", () => {
  test("pins base URLs and switches off every ambient credential and header source", () => {
    expect(clientOptions("openai", "k", {})).toEqual({
      apiKey: "k",
      maxRetries: 0,
      baseURL: "https://api.openai.com/v1",
      organization: null,
      project: null,
    });
    expect(
      clientOptions("deepseek", "k", { NEOFLUX_AI_DEEPSEEK_BASE_URL: "https://d.example" }),
    ).toEqual({
      apiKey: "k",
      maxRetries: 0,
      baseURL: "https://d.example",
      organization: null,
      project: null,
    });
    expect(clientOptions("anthropic", "k", {})).toEqual({
      apiKey: "k",
      maxRetries: 0,
      baseURL: "https://api.anthropic.com",
      authToken: null,
    });
  });
});
