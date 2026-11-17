// Records fixtures from the real providers into fixtures/.raw/ (gitignored). See docs/fixtures.md.
// Usage: bun scripts/record.ts --provider <openai|anthropic|deepseek|qwen|all> [--case <id>]...
//        [--include error-context] [--dry-run]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { serializeFixture } from "../src/testing/fixture.ts";
import { INVALID_KEY } from "./recorder/cases.ts";
import {
  clientOptions,
  formatPlan,
  listQwenModels,
  missingEnv,
  parseRecordArgs,
  plan,
  unsafeEnv,
} from "./recorder/cli.ts";
import { checkModels, configuredModels, MODELS, type Provider } from "./recorder/models.ts";
import { type Connect, recordCase } from "./recorder/record.ts";

const root = join(import.meta.dir, "..");
const env = process.env;

const sdkVersion = (name: string): string => {
  const pkg = JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8"));
  return `${name}@${pkg.version}`;
};

const KEY: Record<Provider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  qwen: "DASHSCOPE_API_KEY",
};
const openai = (provider: Provider, apiKey: string): OpenAI =>
  new OpenAI(clientOptions(provider, apiKey, env) as ConstructorParameters<typeof OpenAI>[0]);
const anthropic = (apiKey: string): Anthropic =>
  new Anthropic(
    clientOptions("anthropic", apiKey, env) as ConstructorParameters<typeof Anthropic>[0],
  );

function connectFor(provider: Provider): Connect {
  return ({ invalidKey }) => {
    const apiKey = invalidKey ? INVALID_KEY : (env[KEY[provider]] as string);
    if (provider === "anthropic") {
      const client = anthropic(apiKey);
      return {
        create: (_api, params, options) =>
          client.messages.create(params as Anthropic.MessageCreateParamsStreaming, options),
      };
    }
    const client = openai(provider, apiKey);
    return {
      create: (api, params, options) =>
        api === "responses"
          ? client.responses.create(
              params as OpenAI.Responses.ResponseCreateParamsStreaming,
              options,
            )
          : client.chat.completions.create(
              params as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
              options,
            ),
    };
  };
}

async function* modelIds(provider: Provider): AsyncGenerator<string> {
  const apiKey = env[KEY[provider]] as string;
  if (provider === "qwen") {
    yield* listQwenModels(env.NEOFLUX_AI_QWEN_MODELS_URL as string, apiKey);
  } else if (provider === "anthropic") {
    for await (const m of anthropic(apiKey).models.list()) yield m.id;
  } else {
    for await (const m of openai(provider, apiKey).models.list()) yield m.id;
  }
}

async function main(): Promise<number> {
  let args: ReturnType<typeof parseRecordArgs>;
  let planned: ReturnType<typeof plan>;
  try {
    args = parseRecordArgs(process.argv.slice(2));
    planned = plan(args, MODELS);
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  console.log(formatPlan(planned));
  if (args.dryRun) return 0;

  const missing = missingEnv(args.providers, env);
  if (missing.length > 0) {
    console.error(`missing environment variables: ${missing.join(", ")}`);
    return 2;
  }
  const unsafe = unsafeEnv(args.providers, env);
  if (unsafe.length > 0) {
    console.error(unsafe.join("\n"));
    return 2;
  }

  // Every configured model must exist before anything is recorded, for every provider.
  for (const provider of args.providers) {
    const ids = configuredModels(
      MODELS[provider],
      planned.filter((p) => p.provider === provider).map((p) => p.caseId),
    );
    const absent = await checkModels(ids, modelIds(provider));
    if (absent.length > 0) {
      console.error(
        `${provider}: configured models not listed by the provider: ${absent.join(", ")}`,
      );
      return 2;
    }
  }

  const recordedOn = new Date().toISOString().slice(0, 10);
  for (const p of planned) {
    const fixture = await recordCase(p.spec, {
      provider: p.provider,
      sdk: sdkVersion(p.provider === "anthropic" ? "@anthropic-ai/sdk" : "openai"),
      model: p.model.model,
      recordedOn,
      connect: connectFor(p.provider),
    });
    const dir = join(root, "fixtures/.raw", p.provider);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${p.caseId}.jsonl`), serializeFixture(fixture));
    const outcomes = fixture.calls.map((c) => c.outcome).join(", ");
    console.log(`recorded ${p.provider}/${p.caseId}: ${outcomes}`);
  }
  return 0;
}

process.exit(await main());
