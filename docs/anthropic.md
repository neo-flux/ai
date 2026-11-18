# Anthropic

`@neoflux/ai/anthropic` uses Anthropic's Messages API through an `@anthropic-ai/sdk` client you construct.

```ts
import Anthropic from "@anthropic-ai/sdk";
import { generate } from "@neoflux/ai";
import { anthropic } from "@neoflux/ai/anthropic";

const claude = anthropic({ client: new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) });
const result = await generate({ model: claude("claude-haiku-5-5"), messages });
```

The adapter calls only `client.messages.create(params, { signal })` and iterates the stream.

## Options

Pass options to the model, `claude("id", { ... })`, or per call in `providerOptions: { anthropic: { ... } }`. Call options win field by field.

| Option      | Sent as                | Notes                                                                                                                                                                     |
| ----------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `thinking`  | `thinking`, unchanged  | Its form depends on the model: `{ type: "adaptive", display? }` on newer models, `{ type: "enabled", budget_tokens }` on older ones. The adapter never picks one for you. |
| `effort`    | `output_config.effort` | `low`, `medium`, `high`, `xhigh` or `max`                                                                                                                                 |
| `maxTokens` | `max_tokens`           | Used when the call doesn't set `maxOutputTokens`                                                                                                                          |
| `body`      | top-level fields       | Anything else the API accepts                                                                                                                                             |

**`max_tokens` defaults to 4096.** The API requires it. The adapter uses the call's `maxOutputTokens`, then the `maxTokens` option, then 4096 (`DEFAULT_MAX_TOKENS`).

`body` may not set `model`, `messages`, `system`, `stream`, `tools`, `tool_choice`, `max_tokens`, `temperature` or `output_config`. The typed options win over the same keys in `body`. Treat `body` as trusted configuration. It can set fields like `metadata` and `mcp_servers`, which carry credentials, so never build it from end-user input.

Some models reject a forced `toolChoice` (`"required"` or `{ name }`) or certain thinking settings with HTTP 400. That arrives as `invalid_request`, without falling back.

## Messages

- System messages are joined into `system`.
- Images must be JPEG, PNG, GIF or WebP, as bytes with a `mediaType` or as a base64 data URL.
- Files must be PDF, sent as a base64 document, or plain text, sent as a text document.
- Consecutive tool results are sent together in one user message, with `is_error` when you set `isError`.
- An assistant message with nothing to send is skipped, because the API rejects empty turns.

## Thinking

Thinking streams as `reasoning-delta` events. Each thinking block ends with a `reasoning-end` that carries its signature. With `display: "omitted"`, a block has no text, only a signature. You still get an empty `reasoning-delta` and the `reasoning-end`, so the block is kept. Redacted thinking is kept the same way.

When you send the assistant message back, each thinking block is rebuilt from the stored reasoning part, its text and the signature in its metadata, as the API requires. The library doesn't verify them, so keep stored history unedited. The API rejects a changed thinking block. Signatures and redacted thinking are opaque blobs from Anthropic, kept in your history like any other message data. A thinking block that arrives without a signature can't be sent back, so it carries no metadata. Reasoning from other providers is never sent to Anthropic.

## Not supported yet

- **Server tools.** Blocks for tools Anthropic runs itself (`server_tool_use`, `web_search_tool_result`, `web_fetch_tool_result`, code execution and similar) are skipped. Their text isn't part of the answer, and a `pause_turn` stop finishes as `other`, so such a turn can't be continued through this library yet.
- **Citations.** `citations_delta` events are ignored, and the cited text still arrives as ordinary text.

## Usage

Anthropic's `input_tokens` doesn't include cached input. The library adds `cache_read_input_tokens` and `cache_creation_input_tokens` to it, so `inputTokens` is the total. `cachedInputTokens` is the cache reads, `cacheWriteTokens` the cache writes, and `reasoningTokens` is `output_tokens_details.thinking_tokens` where it's reported.

Anthropic bills cache writes at different rates for a 5-minute and a 1-hour cache lifetime. `Price` has a single `cacheWrite` rate, so a request that writes to both lifetimes is priced at that one rate.

## Errors

On top of [errors.md](errors.md), errors are mapped by Anthropic's error type, with or without an HTTP status. Errors inside a stream have no status.

| Type                                       | Code                   |
| ------------------------------------------ | ---------------------- |
| `invalid_request_error`, `not_found_error` | `invalid_request`      |
| `authentication_error`, `permission_error` | `auth`                 |
| `billing_error`                            | `billing`              |
| `rate_limit_error`                         | `rate_limit`           |
| `api_error`, `overloaded_error`            | `provider_unavailable` |
| `timeout_error`                            | `timeout`              |

A context-window error arrives as `invalid_request_error`, so it's `invalid_request`. Stop reason `max_tokens` and `model_context_window_exceeded` finish as `length`, and `refusal` as `content-filter`.
