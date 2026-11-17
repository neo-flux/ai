# Stream events

Every adapter turns a provider's stream into the same sequence of `StreamEvent`s. `streamText` passes them on to you, and `generate` folds them into a result. This page is for adapter authors and for anyone consuming `streamText` directly.

## Events

| Event             | Fields                        | Meaning                                                                                                                                    |
| ----------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `text-delta`      | `text`                        | Next piece of visible text                                                                                                                 |
| `reasoning-delta` | `text`                        | Next piece of the model's reasoning, where the provider exposes it                                                                         |
| `reasoning-end`   | `providerMetadata?`           | Closes the current reasoning block. Carries that block's provider data (for example a signature the provider needs back on the next turn). |
| `tool-call-start` | `id`, `name`                  | A tool call begins                                                                                                                         |
| `tool-call-delta` | `id`, `inputDelta`            | Next raw fragment of the call's JSON arguments                                                                                             |
| `tool-call-end`   | `id`, `providerMetadata?`     | The call's arguments are complete                                                                                                          |
| `usage`           | `usage`                       | Token usage so far for this request (cumulative, see below)                                                                                |
| `finish`          | `reason`, `providerMetadata?` | The response ended normally. `reason` is `stop`, `length`, `tool-calls`, `content-filter` or `other`.                                      |
| `error`           | `error`                       | The response failed. `error` is an `AIError`.                                                                                              |

A typical stream with reasoning and one tool call:

```json
{ "type": "reasoning-delta", "text": "The user wants the weather, " }
{ "type": "reasoning-delta", "text": "so I'll call the tool." }
{ "type": "reasoning-end", "providerMetadata": { "example": { "signature": "…" } } }
{ "type": "text-delta", "text": "Let me check." }
{ "type": "tool-call-start", "id": "call_1", "name": "weather" }
{ "type": "tool-call-delta", "id": "call_1", "inputDelta": "{\"city\":" }
{ "type": "tool-call-delta", "id": "call_1", "inputDelta": "\"Lahore\"}" }
{ "type": "tool-call-end", "id": "call_1" }
{ "type": "usage", "usage": { "inputTokens": 120, "outputTokens": 41, "inputIncludesCached": true, "outputIncludesReasoning": true } }
{ "type": "finish", "reason": "tool-calls" }
```

## Ordering rules

These are checked by a state machine. `checkEventOrder` and `assertEventOrder` from `@neoflux/ai/testing` throw an `EventOrderError` naming the rule. The library runs the same state machine over every adapter's output. If an adapter breaks a rule in production, you get an `error` event with code `unknown` instead of a corrupted result.

- **O0. Events are well formed.** The type is one of the above, text fields are strings, tool call ids and names are non-empty, `reason` is one of the five values, and `error` is an `AIError`.
- **O1. Exactly one terminal event.** A stream ends with exactly one `finish` or `error`, and nothing comes after it. A stream that just stops is a violation.
- **O2. Tool call ids are unique** within a stream, including ids of calls that have already ended.
- **O3. Deltas and ends need an open call.** `tool-call-delta` and `tool-call-end` are valid only between `tool-call-start` and `tool-call-end` for that id.
- **O4. Tool calls may interleave.** Several calls can be open at once, and their deltas can arrive in any order. Some providers stream parallel calls this way.
- **O5. Every open call ends before `finish`.** This isn't required before `error`, because a failed stream may stop mid-call.
- **O6. `reasoning-end` needs an open reasoning block.** A block opens with `reasoning-delta`. It closes at `reasoning-end`, at the next `text-delta` or `tool-call-start`, or at the terminal event. Emit `reasoning-end` whenever the block has metadata to carry. A block with no visible text (for example, redacted reasoning) is a `reasoning-delta` with `text: ""` followed by `reasoning-end`.
- **O7. `finish` with reason `tool-calls` needs at least one ended tool call.**
- **O8. Usage is well formed.** Each token count is `undefined` or a non-negative safe integer. `inputIncludesCached` and `outputIncludesReasoning` are booleans.

## Usage events

Usage values are cumulative for the request. Send as many `usage` events as the provider gives you. For each field, the library keeps the latest defined value, and a later `undefined` never erases an earlier value. The two flags tell the library how to normalize:

- `inputIncludesCached`: whether `inputTokens` already counts cache reads and cache writes. If not, the library adds them.
- `outputIncludesReasoning`: whether `outputTokens` already counts reasoning tokens. If not, the library adds them.

After normalization, `inputTokens` and `outputTokens` are always totals, and the other fields are subsets of them. A field the provider doesn't report stays `undefined`, never `0`.

## Provider metadata

Some providers need opaque data from one turn sent back on the next: reasoning signatures, encrypted reasoning items, item ids. Adapters attach it to `reasoning-end`, `tool-call-end` or `finish`, keyed by provider name. The library copies it untouched onto the matching part of the assistant message (`reasoning`, `tool-call`) or onto the message itself (`finish`). When you send that message back in the next request, the adapter finds the metadata where it left it.

## Errors and fallback

An adapter reports failure by throwing from its iterator. Yielding an `error` event is handled the same way. The library classifies the thrown value and decides whether to fall back to the next model. It falls back only when the error has `failover: true` and no event has reached the caller yet (see `docs/errors.md`). Otherwise it emits the `error` event itself. A fallback chain means the same request may be sent to every provider on it, in order, so list only providers you're willing to send that request to.
