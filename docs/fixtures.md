# Recorded fixtures

Adapter tests replay real provider streams instead of calling the providers. Each fixture is a file of SDK-level stream items: exactly what `for await` over the SDK's stream yields, recorded once from the real API and scrubbed of anything account-specific. Adapters consume SDK objects, so the fixtures record SDK objects, not raw server-sent events.

## Layout

```
fixtures/
  .raw/<provider>/<case>.jsonl   raw recordings, gitignored, never committed
  <provider>/<case>.jsonl        scrubbed, committed
```

Providers are `openai` (Responses API), `anthropic` (Messages API), `deepseek` and `qwen` (both Chat Completions through the `openai` SDK).

## Format

One JSON object per line. The format is unstable while the package is 0.x.

```jsonl
{"kind":"meta","format":1,"provider":"openai","case":"tool-round-trip","api":"responses","sdk":"openai@7.57.0","model":"…","recordedOn":"2026-11-20"}
{"kind":"call","index":0,"request":{…},"options":{}}
{"kind":"chunk","call":0,"data":{…}}
{"kind":"end","call":0,"outcome":"completed"}
{"kind":"call","index":1,"request":{…},"options":{}}
{"kind":"error","call":1,"phase":"create","afterChunks":0,"error":{…}}
{"kind":"end","call":1,"outcome":"threw"}
```

- `call` holds the request exactly as sent (scrubbed) and the options that matter: `timeoutMs`, and `abortAfterChunks` when the recorder aborted.
- `outcome` is one of:
  - `completed`.
  - `returned-after-abort`: what both SDKs do when the caller aborts. The iteration ends without throwing.
  - `threw`, which is always preceded by an `error` line.
- `error.phase` is `create` when the SDK call itself rejected, which is how HTTP errors arrive. It is `stream` when iteration threw after `afterChunks` items, which is how errors sent mid-stream arrive. Those carry no HTTP status.
- `error.error` keeps the SDK error's shape: `name`, `status`, `message`, the SDK's `.error` value, and `code`, `type`, `param`, `errorCode`, `details` and `apiMessage` when the SDK has them. Headers are reduced to the allowlist below.

`@neoflux/ai/testing` exports `parseFixture`, `serializeFixture` and `replayClient`. `replayClient(fixture)` is a stand-in for the SDK client with only the recorded API's `create` method. It serves the recorded calls in order and honours `signal` the way the SDKs do. It throws recorded errors as `Error`s with the same fields, and `headers` as a `Headers`. A signal that is already aborted when `create()` is called rejects with `APIUserAbortError`, as both SDKs do. Chunks are served in microtasks, so an abort scheduled with a timer can't land mid-stream. Pass `replayClient(fixture, { chunkDelayMs })` when a test needs that.

## Cases

Every provider records the same cases with the same synthetic prompts:

| Case                                                        | What it covers                                                                                                                                |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `text`, `stream-long`, `length`                             | Plain replies, many deltas, an output cap                                                                                                     |
| `tool-round-trip`, `tool-parallel`                          | A forced tool call answered in a second turn, and two calls in one turn                                                                       |
| `structured`                                                | Native structured output (JSON mode plus the schema in the prompt on DeepSeek)                                                                |
| `reasoning`, `reasoning-tool-round-trip`                    | Reasoning output, and reasoning data passed back on the next turn                                                                             |
| `abort`                                                     | The recorder aborts after the third item                                                                                                      |
| `error-auth`, `error-model`, `error-param`, `error-timeout` | A fake key, an unknown model, an output cap of 0, a 1 ms client timeout                                                                       |
| `error-context`                                             | Opt-in: one input larger than the model's context window                                                                                      |
| `error-reasoning-missing`                                   | DeepSeek only: a tool turn sent without its `reasoning_content`. The docs say this is a 400, but the 2026-11-17 recording completed normally. |

Rate limits, server errors, content filtering and empty balances can't be triggered safely, so they aren't recorded. Adapter tests build those shapes by hand from the provider docs.

## Recording

Recording calls the real APIs and spends credit, so it never runs in CI.

1. Fill in `scripts/recorder/models.ts` with the cheapest model that supports each case. Use per-case overrides where one provider needs a fast model and a reasoning model.
2. Set the variables, for example in a `.env` file (gitignored; Bun loads it automatically):

   | Variable                                                                      | For       |
   | ----------------------------------------------------------------------------- | --------- |
   | `OPENAI_API_KEY`                                                              | OpenAI    |
   | `ANTHROPIC_API_KEY`                                                           | Anthropic |
   | `DEEPSEEK_API_KEY`, `NEOFLUX_AI_DEEPSEEK_BASE_URL`                            | DeepSeek  |
   | `DASHSCOPE_API_KEY`, `NEOFLUX_AI_QWEN_BASE_URL`, `NEOFLUX_AI_QWEN_MODELS_URL` | Qwen      |

   The base URLs have no defaults in the code. See the README for example values.

   The three `NEOFLUX_AI_*` URLs must be `https`. The recorder refuses to start while any SDK variable is set that could redirect a request, add headers or attach an account: `OPENAI_BASE_URL`, `OPENAI_CUSTOM_HEADERS`, `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, `ANTHROPIC_AUTH_TOKEN` or `ANTHROPIC_OPEN_TELEMETRY*`. Its clients pin the official base URLs and switch off organization, project and auth-token lookups, so only the configured key is sent, and only to the configured host.
3. Check the plan. This sends nothing:

   ```sh
   bun run record --provider all --dry-run
   ```

4. Record. Before sending any request, the recorder checks every configured model against each provider's models list and stops if one is missing. Clients are built with `maxRetries: 0`, so recorded errors are the first response.

   ```sh
   bun run record --provider all
   bun run record --provider openai --case reasoning --case abort   # a subset
   bun run record --provider all --include error-context            # the opt-in case
   ```

5. Scrub, then run the guard:

   ```sh
   bun run scrub
   bun run fixtures:check
   ```

## What the scrubber does

Bodies are scrubbed with a denylist plus patterns. Headers are reduced to an allowlist, so a header a provider adds later is dropped by default.

- **Headers:** only `content-type`, `retry-after` and `retry-after-ms` are kept. Rate-limit headers are dropped too, because they reveal the account's tier.
- **Ids:** these become placeholders that keep the prefix (`resp_fixture0001`), with the same placeholder for the same id throughout a file, so turn 2 still refers to turn 1:
  - The values of `id`, `call_id`, `item_id`, `response_id`, `previous_response_id`, `tool_use_id`, `tool_call_id` and `system_fingerprint`.
  - Any string that looks like a provider id.
- **Opaque blobs:** `encrypted_content`, `signature` and redacted-thinking `data` become `fixture-opaque-0001`, again consistently within a file.
- **Account fields** become `null`: `user`, `safety_identifier`, `prompt_cache_key`, `conversation`, `metadata`, `inference_geo`, `service_tier`, `requestID`, `workspaceID` and similar.
- **Timestamps** (`created`, `created_at`, `completed_at`) become `1700000000`.
- **Credentials:** any credential-shaped string, in any field, becomes `[scrubbed]`.
- **Long strings:** strings over 20,000 characters (the `error-context` input) become `[scrubbed: N chars]`.

The scrubber then runs the fixture guard on its own output and refuses to write a file it still finds something in. That covers secrets, account fields, unreplaced ids, long opaque tokens, unlisted headers, invalid structure and files over 2 MB. Emails, IP addresses and masked key tails (`****Ab1x`) are redacted. A few things make the guard refuse the file outright instead, because no safe rewrite exists:

- rate-limit details or any 429, which reveal the account's tier;
- HTML error pages;
- URLs with a query string;
- `__proto__`-style keys.

If `error-context` comes back as a 429, the filler went over a per-minute token limit before it reached the context window. Don't commit that recording.

A refusal for anything else means the scrubber needs a new rule, not that the file should be edited by hand. Refusal messages quote the offending values, so don't paste them anywhere public. The guard can also refuse opaque-looking strings it can't tell apart from tokens, such as base64 or hex in model output. The synthetic prompts are chosen to avoid those. The same guard runs over every committed fixture in `bun test`.
