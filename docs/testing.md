# Testing

`@neoflux/ai/testing` doesn't depend on any provider SDK.

## `fakeAdapter`

```ts
import { fakeAdapter } from "@neoflux/ai/testing";

const fake = fakeAdapter([
  {
    events: [
      { type: "text-delta", text: "hello" },
      { type: "finish", reason: "stop" },
    ],
  },
  { throwBefore: { status: 429 } }, // the second call fails like a rate-limited request
]);
const model = fake("any-id");
```

- The script is an array with one turn per call, or a function `(request, ctx, callIndex) => turn`.
- A turn has `events`, and optionally `throwBefore` (fail before any event), `throwAfter: { index, error }` (fail after that many events) and `delayMs`.
- `fake.calls` records each call's model id, request and signal.
- Events aren't checked, so you can script a misbehaving adapter on purpose.

## Event order

`checkEventOrder(stream)` passes events through and throws an `EventOrderError` (with the rule that broke) at the first violation. `assertEventOrder(events)` checks an array. Use them in tests for your own adapters. The rules are in [events.md](events.md).

## Replaying recorded streams

`parseFixture(text)` reads a recorded fixture, and `replayClient(fixture)` returns a stand-in SDK client that serves the recorded stream. Cast it to the SDK type and pass it to an adapter:

```ts
import { parseFixture, replayClient } from "@neoflux/ai/testing";

const client = replayClient(parseFixture(await readFile("text.jsonl", "utf8")));
const model = openai({ client: client as unknown as OpenAI })("gpt-5.4-mini");
// client.calls[0].params is the request the adapter sent
```

Replay behaves like the SDKs on abort: the stream ends without an error. Recorded errors are thrown in the SDK's shape. The fixture format is described in [fixtures.md](fixtures.md), and it's unstable in 0.x.
