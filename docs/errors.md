# Errors

Every failure the library reports is an `AIError`. `generate` throws it, and `streamText` delivers it as an `error` event and rejects `result` with the same instance. The one exception is errors thrown by your own hooks (`resolveModel`, `beforeRequest`, `onUsage`, `onError`, `price`): they propagate unchanged, so they keep their type.

## Fields

| Field                          | Meaning                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `code`                         | One of the codes below                                                       |
| `retryable`                    | Whether the same request to the same model may succeed later                 |
| `failover`                     | Whether the next model in a fallback chain may be tried                      |
| `provider`                     | The provider name, when known                                                |
| `status`                       | The HTTP status, when there was one                                          |
| `providerCode`, `providerType` | The provider's own error code and type, only when they are short identifiers |
| `retryAfterMs`                 | How long the provider asked you to wait, see below                           |
| `rawText`                      | `output_validation` only: the model's last answer                            |
| `issues`                       | `output_validation` only: what failed validation                             |

| Code                   | Retryable | Failover | When                                                                        |
| ---------------------- | --------- | -------- | --------------------------------------------------------------------------- |
| `rate_limit`           | yes       | yes      | Too many requests or tokens (HTTP 429)                                      |
| `timeout`              | yes       | yes      | The request timed out. Neither flag is set when your own signal timed out.  |
| `provider_unavailable` | yes       | yes      | The provider failed, is overloaded, or cut the answer short (HTTP 5xx)      |
| `auth`                 | no        | yes      | Bad or missing credentials (HTTP 401, 403)                                  |
| `billing`              | no        | yes      | The account is out of balance or hasn't paid for access                     |
| `context_length`       | no        | no       | The request is too long for the model                                       |
| `content_filter`       | no        | no       | The provider refused the content                                            |
| `invalid_request`      | no        | no       | The request is malformed. Many of these are caught before any network call. |
| `output_validation`    | no        | no       | Structured output failed after one repair attempt                           |
| `aborted`              | never     | never    | You aborted the call                                                        |
| `unknown`              | no        | no       | An adapter bug, or a provider error that couldn't be mapped                 |

These are defaults. An adapter can override `retryable` and `failover` for a specific provider error, except for `aborted`.

Use `isAIError(value)` rather than `instanceof` when your app might load two copies of the package. `instanceof AIError` also works across copies, because both check the same `Symbol.for` brand.

## Fallback

When `model` is a list, the library tries the next model only if the error has `failover: true` and no event has reached you yet. After the first event, a failure is an `error` event and the call ends: it never switches models silently. The structured-output repair always goes to the model that answered, never down the chain.

`retryable` doesn't drive fallback. It's for your own retry logic: a `billing` or `auth` error at one provider says nothing about the next, so it fails over, but sending the same request to the same provider again won't help.

When your own signal aborts or times out, the error has `failover: false`, because the next model can't meet a deadline that has already passed.

## What an AIError never contains

`message` is built only from the code, provider and status, for example `rate_limit (anthropic, HTTP 429)`. It never includes API keys, request bodies, message content or the provider's error text. The same goes for `toString()`, `JSON.stringify` (which uses `toJSON()`), `console.log` and `util.inspect`.

`rawText` and `issues` are non-enumerable, so spreads, `Object.keys` and JSON skip them. Read them directly when you need them. `rawText` is model output, so treat it as user content.

## The raw provider error

The original error from the SDK or the provider isn't stored on the `AIError` at all. It's not even in `cause`, because Node prints `cause` in `console.log` and `util.inspect` even though it is non-enumerable. Provider error messages can echo parts of your request, and SDK errors carry the response headers.

Ask for it explicitly when you need it:

```ts
import { getProviderError, isAIError } from "@neoflux/ai";

try {
  await generate({ model, messages });
} catch (error) {
  if (isAIError(error)) {
    const raw = getProviderError(error); // the SDK's error, or undefined
  }
}
```

`getProviderError` reads from a `WeakMap` inside the package. That has two consequences:

- The raw error is freed together with the `AIError`.
- It's only found by the same copy of the package that created the error. With two copies loaded, call it from the copy that made the call.

`cause` is still used, but only for errors the library makes itself: the reason a request was `invalid_request` (which positions and rules, never content), or the ordering rule an adapter broke. These never contain provider data.

## `retryAfterMs`

Read from the `retry-after-ms` header, or from `retry-after` given as seconds or an HTTP date. The value is clamped to **0 to 3,600,000 ms (one hour)**, and the cap is exported as `MAX_RETRY_AFTER_MS`. Longer waits are reported as one hour, so a provider can't make your retry loop sleep for days. A date in the past gives `0`. Negative, non-finite and unparseable values leave `retryAfterMs` `undefined`. The same bounds apply when you construct an `AIError` yourself.

## For adapter authors

Adapters report failure by throwing whatever the SDK threw. The library maps it by shape (HTTP status, provider error type and code, retry headers, abort and timeout signals), never with `instanceof`. To map provider-specific cases, give the adapter a `classifyError(shape, error)` that returns `{ code, retryable?, failover? }` or `undefined`. If an adapter builds an `AIError` itself, it must pass the SDK error as `providerError`, never as `cause`.
