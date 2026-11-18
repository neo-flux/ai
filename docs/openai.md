# OpenAI

`@neoflux/ai/openai` uses OpenAI's Responses API through an `openai` client you construct.

```ts
import OpenAI from "openai";
import { generate } from "@neoflux/ai";
import { openai } from "@neoflux/ai/openai";

const gpt = openai({ client: new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) });
const result = await generate({ model: gpt("gpt-5.4-mini"), messages });
```

The adapter calls only `client.responses.create(params, { signal })` and iterates the stream.

## Options

Pass options to the model, `gpt("id", { ... })`, or per call in `providerOptions: { openai: { ... } }`. Call options win field by field.

| Option          | Default   | Notes                                                                                                           |
| --------------- | --------- | --------------------------------------------------------------------------------------------------------------- |
| `reasoning`     | unset     | Sent as `reasoning`, for example `{ effort: "low", summary: "auto" }`                                           |
| `store`         | `false`   | You send the whole conversation every turn, so OpenAI doesn't need to keep it. Set `true` to opt in to storage. |
| `include`       | see below | Sent as `include`                                                                                               |
| `strictSchemas` | `false`   | Sends tools with `strict: true` and structured output with strict schema validation                             |
| `body`          | none      | Extra top-level fields, for example `{ parallel_tool_calls: true }`                                             |

`store: false` covers stored responses only. OpenAI's prompt cache is retained separately (`prompt_cache_retention`, `"in_memory"` or `"24h"`, with a default that depends on your organization's retention policy). Set it in `body` if that matters to you. Some other `body` keys create or reference state on OpenAI's side whatever `store` says: `conversation`, `previous_response_id`, `background` and `prompt`.

When `reasoning` is set and `store` is false, `include` defaults to `["reasoning.encrypted_content"]`. That's the only way a stateless request can send the model's reasoning back to it on the next turn.

Strict schemas are off by default. Strict mode requires every property to be listed in `required` and `additionalProperties: false`, which many Zod and Valibot schemas don't produce. Turn it on when your schemas meet those rules.

`body` may not set `model`, `input`, `instructions`, `stream`, `tools`, `tool_choice`, `text`, `max_output_tokens` or `temperature`. The typed options above win over the same keys in `body`. A `store` or `include` set only in `body` is kept, rather than replaced by the defaults. Treat `body` as trusted configuration.

The adapter leaves OpenAI's stream obfuscation on. It's a mitigation against a network side channel, and you can turn it off with `body: { stream_options: { include_obfuscation: false } }`.

## Messages

- System messages are joined into `instructions`.
- Images and files are sent as data URLs. Image bytes need a `mediaType`.
- Tool results are `function_call_output` items. That item has no error flag, so `isError` isn't sent. Say so in the result text if the model needs to know.
- Reasoning from an earlier OpenAI turn goes back as the reasoning item OpenAI returned, including its encrypted content. Only the item's own fields are copied, and only if it is a reasoning item. Reasoning from other providers is dropped.
- Tool calls are rebuilt from the tool-call part, so an edit you make to a stored call (for example, redacting its input) is what's sent. Only the item's `id` and `status` come from the stored metadata.

## Reasoning

Reasoning summaries stream as `reasoning-delta` events. A reasoning item with no visible summary still produces an empty `reasoning-delta` and a `reasoning-end`, so the item is kept in the assistant message and goes back on the next turn.

With a forced `toolChoice`, the model may not reason at all, and the turn then has no reasoning part.

## Usage

`input_tokens` includes cached input. `cached_tokens` is `cachedInputTokens`, `cache_write_tokens` is `cacheWriteTokens`, and `reasoning_tokens` is `reasoningTokens`.

## Errors

On top of [errors.md](errors.md):

- HTTP 429 with code `insufficient_quota` is `billing`: not retryable, but it fails over. Other 429s are `rate_limit`.
- HTTP 400 with code `context_length_exceeded` is `context_length`.
- Errors inside the stream (`response.failed`, `error` events) have no HTTP status and are mapped by code: `rate_limit_exceeded`, `context_length_exceeded`, `insufficient_quota`, and anything else is `provider_unavailable`.
- The SDK's timeout is `timeout`, and its connection errors are `provider_unavailable`.
