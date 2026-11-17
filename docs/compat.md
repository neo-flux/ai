# OpenAI-compatible servers

`@neoflux/ai/compat` talks to any server that speaks OpenAI Chat Completions: Groq, OpenRouter, vLLM, Ollama and others. You pass in an `openai` client pointed at the server, and the adapter does the rest.

```ts
import OpenAI from "openai";
import { generate } from "@neoflux/ai";
import { openaiCompatible } from "@neoflux/ai/compat";

const local = openaiCompatible({
  client: new OpenAI({ baseURL: process.env.MY_SERVER_URL, apiKey: process.env.MY_SERVER_KEY }),
  provider: "local", // used in errors and to key provider metadata
});
const result = await generate({ model: local("my-model"), messages });
```

The library never builds clients, reads environment variables or sets base URLs. That's your code.

## Options

- `client`: an `openai` client. The adapter calls only `client.chat.completions.create(params, { signal })` and iterates the stream.
- `provider`: default `openai-compatible`. 1 to 64 letters, digits, or `_ . : -`.
- `quirks`: server differences, below.

Model options go in the second argument, `local("my-model", { body: { top_k: 40 } })`, or per call in `providerOptions: { local: { body: { top_k: 40 } } }`. Call options win key by key. `body` may not set a field the adapter derives from the request: `model`, `messages`, `stream`, `stream_options`, `tools`, `tool_choice`, `response_format`, `max_tokens`, `max_completion_tokens`, `temperature` or `n`. Trying is an `invalid_request` error before anything is sent.

## Quirks

**The quirks interface is unstable in 0.x.** Fields may be renamed or removed in a minor release while more providers are added.

| Quirk                         | Default                   | Meaning                                                                                               |
| ----------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------- |
| `reasoningField`              | none                      | The delta and assistant-message field that carries reasoning, e.g. `reasoning_content`                |
| `echoReasoning`               | `false`                   | Send the server's own reasoning back on assistant messages in later turns                             |
| `structuredOutput`            | `{ mode: "json_schema" }` | `json_schema` (with optional `strict`), or `json_object` for servers without it                       |
| `maxTokensField`              | `max_tokens`              | Or `max_completion_tokens`                                                                            |
| `streamUsage`                 | `true`                    | Send `stream_options: { include_usage: true }`                                                        |
| `finishReasons`               | `{}`                      | Extra `finish_reason` values: a normalized reason, or `{ error: { code } }` to raise an error instead |
| `usage(raw)`                  | none                      | Fills usage fields the standard mapping left undefined                                                |
| `classifyError(shape, error)` | none                      | Provider error mapping, consulted first                                                               |
| `options(merged)`             | sends `body`              | Turns model and call options into request fields                                                      |

## How requests are translated

- Text and `data:` URL images are sent as content parts. Image bytes need a `mediaType` and are sent as a base64 data URL. File parts are rejected.
- Assistant tool calls are sent with their arguments as JSON text. An assistant message with tool calls and no text has `content: null`.
- `isError` on a tool message has no Chat Completions field, so it isn't sent. Say so in the tool result's text if the model needs to know.
- A top-level `$schema` key is removed from tool and output schemas.
- With `structuredOutput: { mode: "json_object" }`, a system message with the JSON Schema is added after your system messages, because JSON mode has no schema field.
- Only reasoning parts this provider produced are sent back. Reasoning from another provider in the same history is dropped.

## How streams are translated

- Empty deltas emit nothing. `refusal` text is reported as text.
- Tool calls are keyed by `index`, so parallel calls can interleave. A call the server sent without an id gets `call_<index>`.
- Usage is accepted on the chunk with `finish_reason` or on a later chunk with no choices. `finish` is emitted when the stream ends.
- `stop`, `length`, `tool_calls`, `function_call` and `content_filter` are mapped. Anything else is `other`, unless a quirk maps it.
- A stream that ends with no `finish_reason` is a retryable `provider_unavailable` error.

## Errors

On top of the status mapping in [errors.md](errors.md):

- The SDK's timeout error is `timeout`. Its other connection errors are `provider_unavailable`. Both are retryable and fail over.
- An error inside the stream (no HTTP status, but an error body) is `provider_unavailable`.

The `openai` client retries some errors itself (`maxRetries`, 2 by default) before the adapter sees them. Set it on your client if you want fallback to happen sooner.
