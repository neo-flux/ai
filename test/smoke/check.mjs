// Runs a fakeAdapter call through both entry points. Shared by the packed-tarball smoke test
// and the type-stripping run of src/.
export async function check(root, testing) {
  const fake = testing.fakeAdapter([
    {
      events: [
        { type: "text-delta", text: "hello " },
        { type: "text-delta", text: "world" },
        { type: "finish", reason: "stop" },
      ],
    },
    {
      events: [
        { type: "text-delta", text: '{"ok":true}' },
        { type: "finish", reason: "stop" },
      ],
    },
  ]);
  const messages = [{ role: "user", content: "hi" }];

  const stream = root.streamText({ model: fake("smoke"), messages });
  const types = [];
  for await (const event of testing.checkEventOrder(stream)) types.push(event.type);
  const streamed = await stream.result;
  if (types.join(",") !== "text-delta,text-delta,finish") throw new Error(`events: ${types}`);
  if (streamed.text !== "hello world") throw new Error(`text: ${streamed.text}`);
  if (streamed.finishReason !== "stop") throw new Error(`finish: ${streamed.finishReason}`);

  const generated = await root.generate({ model: fake("smoke"), messages });
  if (generated.text !== '{"ok":true}') throw new Error(`generate: ${generated.text}`);
  if (fake.calls.length !== 2) throw new Error(`calls: ${fake.calls.length}`);

  const fixture = testing.parseFixture(
    [
      {
        kind: "meta",
        format: 1,
        provider: "smoke",
        case: "text",
        api: "messages",
        sdk: "none@0",
        model: "smoke",
        recordedOn: "2026-01-01",
      },
      { kind: "call", index: 0, request: {}, options: {} },
      { kind: "chunk", call: 0, data: { type: "message_stop" } },
      { kind: "end", call: 0, outcome: "completed" },
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
  );
  const replayed = [];
  for await (const item of await testing.replayClient(fixture).messages.create({})) {
    replayed.push(item);
  }
  if (JSON.stringify(replayed) !== '[{"type":"message_stop"}]') throw new Error("replay");

  const error = new root.AIError({ code: "rate_limit" });
  if (!root.isAIError(error) || !error.retryable) throw new Error("AIError");
}
