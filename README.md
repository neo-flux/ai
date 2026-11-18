# @neoflux/ai

A provider-neutral TypeScript library for calling LLMs. You get one message format, one streaming event format, and one usage and error model across OpenAI, Anthropic and DeepSeek. There's also an adapter for any OpenAI-compatible server.

- **Zero runtime dependencies.** You bring the official SDK client (`openai` or `@anthropic-ai/sdk`). The library never builds clients, reads environment variables or holds keys.
- **Streaming first.** `streamText` gives you normalized events, and `generate` folds the same stream into a result.
- **Fallback chains** that only switch models before anything has reached you, never in the middle of an answer.
- **Typed errors** that never contain your keys, your messages or the provider's error text.
- **Tools, structured output and reasoning**, with provider reasoning carried across turns.

Status: pre-release (0.x). The API may change between minor versions.

## Install

```sh
bun add @neoflux/ai openai              # OpenAI, DeepSeek, OpenAI-compatible servers
bun add @neoflux/ai @anthropic-ai/sdk   # Anthropic
```

The SDKs are optional peer dependencies. Install the ones you use. ESM only, Node 22 or later, Bun and Deno.

## Providers

```ts
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { generate } from "@neoflux/ai";
import { openai } from "@neoflux/ai/openai";
import { anthropic } from "@neoflux/ai/anthropic";
import { deepseek } from "@neoflux/ai/deepseek";
import { openaiCompatible } from "@neoflux/ai/compat";

// OpenAI, on the Responses API
const gpt = openai({ client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) });

// Anthropic, on the Messages API
const claude = anthropic({ client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) });

// DeepSeek, on its OpenAI-compatible API
const ds = deepseek({
  client: new OpenAI({ baseURL: "https://api.deepseek.com", apiKey: process.env.DEEPSEEK_API_KEY }),
});

// Any OpenAI-compatible server (Groq, OpenRouter, vLLM, Ollama, ...)
const local = openaiCompatible({
  client: new OpenAI({ baseURL: "http://localhost:11434/v1", apiKey: "unused" }),
  provider: "ollama",
});

const result = await generate({
  model: claude("claude-haiku-5-5"),
  messages: [
    { role: "system", content: "You are concise." },
    { role: "user", content: "Name three rivers in Asia." },
  ],
});
console.log(result.text, result.usage);
```

Each provider has its own page: [OpenAI](docs/openai.md), [Anthropic](docs/anthropic.md), [DeepSeek](docs/deepseek.md), [OpenAI-compatible](docs/compat.md). Qwen support is planned. It will be added once its test recordings exist.

## Streaming

```ts
import { streamText } from "@neoflux/ai";

const stream = streamText({ model: gpt("gpt-5.4-mini"), messages });
for await (const event of stream) {
  if (event.type === "text-delta") process.stdout.write(event.text);
  if (event.type === "error") console.error(event.error.code);
}
const { text, finishReason, usage } = await stream.result;
```

Nothing is sent until you start iterating or read `result`. Breaking out of the loop cancels the request. Pass a `signal` to cancel it yourself. The events and their ordering rules are in [docs/events.md](docs/events.md).

## Tools

```ts
import { z } from "zod";

const result = await generate({
  model: claude("claude-haiku-5-5"),
  messages,
  tools: {
    get_weather: {
      description: "Get the current weather for a city.",
      schema: z.object({ city: z.string() }),
    },
  },
});
for (const call of result.toolCalls) {
  if ("error" in call) continue; // unknown tool, invalid JSON or invalid input
  // call.name === "get_weather", call.input is { city: string }
}
```

The library returns tool calls, and you run them. To continue the conversation, append `result.message` and a `{ role: "tool", toolCallId, toolName, content }` message, then call again. `result.message` keeps the provider's reasoning, so it goes back to the same provider on the next turn. Schemas are any [Standard JSON Schema](https://standardschema.dev), for example Zod 4, or Valibot through `toStandardJsonSchema()` from `@valibot/to-json-schema`.

## Structured output

Pass a schema as `output` to `generate` to get a validated object back.

```ts
const { output } = await generate({
  model,
  messages: [{ role: "user", content: "Name a city and its population." }],
  output: z.object({ name: z.string(), population: z.number() }),
});
```

If the answer isn't valid JSON matching the schema, the library asks the same model once to fix it. If that fails too, `generate` throws an `AIError` with code `output_validation`. The model's last raw text is on `error.rawText`, and it's never part of the error's message.

The repair request sends the model's previous answer and the validator's messages back to the same model, never to another one. The list of problems is capped and quoted.

Structured output is available on `generate` only, not `streamText`. A repair attempt is a second request, and streaming it would show you two answers one after the other.

## Fallback and errors

```ts
import { getProviderError, isAIError } from "@neoflux/ai";

try {
  await generate({ model: [claude("claude-haiku-5-5"), gpt("gpt-5.4-mini")], messages });
} catch (error) {
  if (isAIError(error)) console.error(error.code, error.retryable, error.failover);
}
```

`model` can be a list. The next model is tried only if the error has `failover: true` (rate limits, timeouts, outages, auth and billing problems) and nothing has reached you yet. Every model in the list may receive the full request, so list only providers you're willing to send it to. Errors carry a `code`, and their message is built only from the code, provider and HTTP status. The raw SDK error is available through `getProviderError(error)`. Details are in [docs/errors.md](docs/errors.md).

## Hooks

`resolveModel`, `beforeRequest`, `onUsage` and `onError`, plus a `price` function for cost. They're enough for metering, budgets and routing. See [docs/hooks.md](docs/hooks.md).

```ts
await generate({
  model: gpt("gpt-5.4-mini"),
  messages,
  price: () => ({ input: 0.4, output: 1.6 }), // per million tokens, in your currency
  hooks: { onUsage: ({ usage, cost }) => console.log(usage.inputTokens, cost) },
});
```

## Testing

`@neoflux/ai/testing` has a `fakeAdapter` for scripted streams, an event-order checker, and replay helpers for recorded provider streams. See [docs/testing.md](docs/testing.md).

```ts
import { generate } from "@neoflux/ai";
import { fakeAdapter } from "@neoflux/ai/testing";

const fake = fakeAdapter([
  {
    events: [
      { type: "text-delta", text: "hi" },
      { type: "finish", reason: "stop" },
    ],
  },
]);
const { text } = await generate({ model: fake("test-model"), messages });
// text === "hi", fake.calls[0].request is what the adapter received
```

## Recording fixtures

Adapter tests replay recorded provider streams. To re-record them you need provider accounts. See [docs/fixtures.md](docs/fixtures.md). Example values for the base URL variables:

```sh
NEOFLUX_AI_DEEPSEEK_BASE_URL=https://api.deepseek.com
NEOFLUX_AI_QWEN_BASE_URL=https://dashscope-intl.aliyuncs.com/compatible-mode/v1
NEOFLUX_AI_QWEN_MODELS_URL=https://{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com/api/v1/models
```

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md).

## License

Apache 2.0
