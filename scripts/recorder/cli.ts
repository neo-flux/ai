// The testable part of the record and scrub commands: argument parsing, the plan, environment
// checks, the Qwen models list and directory scrubbing. scripts/record.ts adds the real clients.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { casesFor, OPT_IN } from "./cases.ts";
import {
  type CaseModel,
  modelFor,
  PROVIDERS,
  type Provider,
  type ProviderModels,
} from "./models.ts";
import type { CaseSpec } from "./record.ts";
import { scrubText } from "./scrub.ts";

export interface RecordArgs {
  providers: Provider[];
  cases: string[] | undefined;
  include: string[];
  dryRun: boolean;
}

export function parseRecordArgs(argv: readonly string[]): RecordArgs {
  const providers = new Set<Provider>();
  const cases: string[] = [];
  const include: string[] = [];
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--provider") {
      const p = value();
      if (p === "all") for (const all of PROVIDERS) providers.add(all);
      else if ((PROVIDERS as readonly string[]).includes(p)) providers.add(p as Provider);
      else throw new Error(`unknown provider ${p}`);
    } else if (arg === "--case") cases.push(value());
    else if (arg === "--include") {
      const id = value();
      if (!OPT_IN.includes(id)) throw new Error(`${id} is not an opt-in case`);
      include.push(id);
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (providers.size === 0)
    throw new Error("--provider <openai|anthropic|deepseek|qwen|all> is required");
  return {
    providers: PROVIDERS.filter((p) => providers.has(p)),
    cases: cases.length > 0 ? cases : undefined,
    include,
    dryRun,
  };
}

// Keys and URLs only ever come from the environment; base URLs have no defaults in code.
export const ENV: Record<Provider, readonly string[]> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  deepseek: ["DEEPSEEK_API_KEY", "NEOFLUX_AI_DEEPSEEK_BASE_URL"],
  qwen: ["DASHSCOPE_API_KEY", "NEOFLUX_AI_QWEN_BASE_URL", "NEOFLUX_AI_QWEN_MODELS_URL"],
};

export function missingEnv(
  providers: readonly Provider[],
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return providers.flatMap((p) => ENV[p]).filter((name) => (env[name] ?? "") === "");
}

/** Merges a config entry's params into every request of a case. */
export function withParams(spec: CaseSpec, params: Record<string, unknown> | undefined): CaseSpec {
  if (params === undefined) return spec;
  return {
    ...spec,
    build: (input) => {
      const planned = spec.build(input);
      return { ...planned, params: { ...(planned.params as Record<string, unknown>), ...params } };
    },
  };
}

export interface PlannedCase {
  provider: Provider;
  caseId: string;
  model: CaseModel;
  spec: CaseSpec;
}

export function plan(
  args: RecordArgs,
  models: Readonly<Record<string, ProviderModels>>,
): PlannedCase[] {
  return args.providers.flatMap((provider) => {
    const specs = casesFor(provider);
    const config = models[provider];
    if (config === undefined) throw new Error(`no model config for ${provider}`);
    const ids =
      args.cases ??
      specs.map((s) => s.id).filter((id) => !OPT_IN.includes(id) || args.include.includes(id));
    return ids.map((caseId) => {
      const spec = specs.find((s) => s.id === caseId);
      if (spec === undefined) throw new Error(`${provider} has no case ${caseId}`);
      const model = modelFor(config, caseId);
      return { provider, caseId, model, spec: withParams(spec, model.params) };
    });
  });
}

export function formatPlan(planned: readonly PlannedCase[]): string {
  const lines = planned.map(
    (p) =>
      `${p.provider} ${p.caseId} (${p.model.model}, ${p.spec.turns} call${p.spec.turns === 1 ? "" : "s"})`,
  );
  const total = planned.reduce((sum, p) => sum + p.spec.turns, 0);
  return [...lines, `${total} requests in total`].join("\n");
}

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Model ids from Model Studio's native list endpoint (`output.models[].model`), page by page. */
export async function* listQwenModels(
  url: string,
  key: string,
  fetchImpl: Fetch = fetch,
  pageSize = 100,
): AsyncGenerator<string> {
  for (let page = 1; ; page++) {
    const target = new URL(url);
    target.searchParams.set("page_no", String(page));
    target.searchParams.set("page_size", String(pageSize));
    const response = await fetchImpl(target.toString(), {
      headers: { Authorization: `Bearer ${key}` },
    });
    if (!response.ok) throw new Error(`Qwen models list failed: HTTP ${response.status}`);
    const body = (await response.json()) as {
      output?: { total?: number; models?: { model?: string }[] };
    };
    const models = body.output?.models ?? [];
    for (const m of models) if (typeof m.model === "string") yield m.model;
    if (models.length === 0 || page * pageSize >= (body.output?.total ?? 0)) return;
  }
}

export interface ScrubResult {
  written: string[];
  refused: { file: string; error: string }[];
}

/** Scrubs `<fixtures>/.raw/<provider>/*.jsonl` into `<fixtures>/<provider>/`. Refused files are not written. */
export function scrubAll(fixtures: string): ScrubResult {
  const result: ScrubResult = { written: [], refused: [] };
  const raw = join(fixtures, ".raw");
  if (!existsSync(raw)) return result;
  for (const provider of readdirSync(raw).sort()) {
    for (const name of readdirSync(join(raw, provider)).sort()) {
      if (!name.endsWith(".jsonl")) continue;
      const file = `${provider}/${name}`;
      try {
        const out = scrubText(readFileSync(join(raw, file), "utf8"));
        mkdirSync(join(fixtures, provider), { recursive: true });
        writeFileSync(join(fixtures, file), out);
        result.written.push(file);
      } catch (error) {
        result.refused.push({ file, error: (error as Error).message });
      }
    }
  }
  return result;
}
