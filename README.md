# @neoflux/ai

Provider-neutral TypeScript library for calling LLMs. One message format, one streaming event format, one usage and error model across OpenAI, Anthropic, DeepSeek and Qwen.

Status: pre-release, not yet published.

## Structured output

Pass a schema as `output` to `generate` to get a validated object back. Any schema that implements [Standard JSON Schema](https://standardschema.dev) works, for example Zod 4 or Valibot through `toStandardJsonSchema()` from `@valibot/to-json-schema`.

```ts
import { generate } from "@neoflux/ai";
import { z } from "zod";

const { output } = await generate({
  model,
  messages: [{ role: "user", content: "Name a city and its population." }],
  output: z.object({ name: z.string(), population: z.number() }),
});
```

If the answer isn't valid JSON matching the schema, the library asks the same model once to fix it. If that fails too, `generate` throws an `AIError` with code `output_validation`. The model's last raw text is on `error.rawText`, and it is never part of the error's message.

Structured output is available on `generate` only, not `streamText`. A repair attempt is a second request, and streaming it would show you two answers one after the other.

## License

Apache 2.0
