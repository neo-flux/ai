# DeepSeek

`@neoflux/ai/deepseek` uses DeepSeek's OpenAI-compatible Chat Completions API through an `openai` client you construct with DeepSeek's base URL and your key.

```ts
import OpenAI from "openai";
import { generate } from "@neoflux/ai";
import { deepseek } from "@neoflux/ai/deepseek";

const ds = deepseek({
  client: new OpenAI({ baseURL: "<DeepSeek base URL>", apiKey: process.env.DEEPSEEK_API_KEY }),
});
const result = await generate({ model: ds("deepseek-flash", { thinking: "disabled" }), messages });
```

## Options

| Option                              | Sent as              | Notes                                                    |
| ----------------------------------- | -------------------- | -------------------------------------------------------- |
| `thinking: "enabled" \| "disabled"` | `thinking: { type }` | Unset means DeepSeek's default, which is **thinking on** |
| `reasoningEffort`                   | `reasoning_effort`   | `none`, `low`, `high` or `max`                           |
| `body`                              | top-level fields     | Anything else DeepSeek accepts                           |

Options left unset aren't sent. The adapter never picks a thinking mode for you.

**Thinking and forced tools don't mix.** In thinking mode DeepSeek rejects `tool_choice: "required"` and a named tool with HTTP 400, which you get as `invalid_request`. Since thinking is on by default, pass `thinking: "disabled"` when you use `toolChoice: "required"` or `{ name }`.

In thinking mode DeepSeek ignores `temperature`.

## Reasoning

Reasoning streams as `reasoning-delta` events and ends with `reasoning-end`, whose metadata marks the part as DeepSeek's. When you send the assistant message back in the next turn, the adapter returns that text as `reasoning_content`.

DeepSeek's docs say `reasoning_content` must be passed back in every later request when tools are used, or the request fails with 400. Without tools they say it's ignored. A recording on 2026-11-17 sent a tool turn without it and DeepSeek answered normally. So the adapter sends DeepSeek's reasoning back whenever the history has it, and never requires it. A history from another provider, for example after a fallback, works without it. Reasoning from other providers is never sent to DeepSeek.

## Structured output

DeepSeek has JSON mode (`response_format: { type: "json_object" }`) but no JSON Schema format. The adapter uses JSON mode and adds a system message with your schema. The library validates the answer and repairs it once if it doesn't match. DeepSeek's docs warn that JSON mode can return blank content. That fails validation and goes through the same repair.

## Usage

`prompt_tokens_details.cached_tokens` gives cached input. When it's missing, `prompt_cache_hit_tokens` is used. `reasoningTokens` is `undefined` when DeepSeek doesn't report it, which happens with thinking off.

## Errors and finish reasons

- HTTP 402 (insufficient balance) is `billing`: not retryable, but it fails over to the next model.
- The finish reasons `insufficient_system_resource` and `aborted` mean DeepSeek cut the answer off. They're reported as a retryable `provider_unavailable` error, not as a finished answer. Because they arrive after text has streamed, you get an `error` event, never a silent switch to another model.
- Context-length errors haven't been recorded. If DeepSeek sends them as HTTP 400, they arrive as `invalid_request`.
