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

// Runs the DeepSeek adapter on an inline Chat Completions replay: the compat translation and the
// peer-free runtime of `/deepseek` on each runtime.
export async function checkDeepSeek(root, testing, deepseek) {
  const lines = [
    {
      kind: "meta",
      format: 1,
      provider: "deepseek",
      case: "text",
      api: "chat.completions",
      sdk: "none@0",
      model: "smoke",
      recordedOn: "2026-01-01",
    },
    { kind: "call", index: 0, request: {}, options: {} },
    {
      kind: "chunk",
      call: 0,
      data: { choices: [{ index: 0, delta: { reasoning_content: "think" }, finish_reason: null }] },
    },
    {
      kind: "chunk",
      call: 0,
      data: {
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 3, completion_tokens: 2 },
      },
    },
    { kind: "end", call: 0, outcome: "completed" },
  ];
  const fixture = testing.parseFixture(lines.map((line) => JSON.stringify(line)).join("\n"));
  const client = testing.replayClient(fixture);
  const model = deepseek.deepseek({ client })("smoke");
  const stream = root.streamText({ model, messages: [{ role: "user", content: "hi" }] });
  const types = [];
  for await (const event of testing.checkEventOrder(stream)) types.push(event.type);
  if (types.join(",") !== "reasoning-delta,reasoning-end,text-delta,usage,finish") {
    throw new Error(`deepseek events: ${types}`);
  }
  const result = await stream.result;
  if (result.text !== "hi" || result.usage.inputTokens !== 3) throw new Error("deepseek result");
  if (client.calls[0]?.params.model !== "smoke") throw new Error("deepseek request");
}

// Runs the OpenAI adapter on an inline Responses API replay.
export async function checkOpenAI(root, testing, openai) {
  const lines = [
    {
      kind: "meta",
      format: 1,
      provider: "openai",
      case: "text",
      api: "responses",
      sdk: "none@0",
      model: "smoke",
      recordedOn: "2026-01-01",
    },
    { kind: "call", index: 0, request: {}, options: {} },
    {
      kind: "chunk",
      call: 0,
      data: { type: "response.output_text.delta", item_id: "m", delta: "hi" },
    },
    {
      kind: "chunk",
      call: 0,
      data: {
        type: "response.completed",
        response: { usage: { input_tokens: 3, output_tokens: 1 } },
      },
    },
    { kind: "end", call: 0, outcome: "completed" },
  ];
  const fixture = testing.parseFixture(lines.map((line) => JSON.stringify(line)).join("\n"));
  const client = testing.replayClient(fixture);
  const stream = root.streamText({
    model: openai.openai({ client })("smoke"),
    messages: [{ role: "user", content: "hi" }],
  });
  const types = [];
  for await (const event of testing.checkEventOrder(stream)) types.push(event.type);
  if (types.join(",") !== "text-delta,usage,finish") throw new Error(`openai events: ${types}`);
  const result = await stream.result;
  if (result.text !== "hi" || result.usage.inputTokens !== 3) throw new Error("openai result");
  if (client.calls[0]?.params.store !== false) throw new Error("openai request");
}

// Runs the Anthropic adapter on an inline Messages API replay.
export async function checkAnthropic(root, testing, anthropic) {
  const chunk = (data) => ({ kind: "chunk", call: 0, data });
  const lines = [
    {
      kind: "meta",
      format: 1,
      provider: "anthropic",
      case: "text",
      api: "messages",
      sdk: "none@0",
      model: "smoke",
      recordedOn: "2026-01-01",
    },
    { kind: "call", index: 0, request: {}, options: {} },
    chunk({ type: "message_start", message: { usage: { input_tokens: 3, output_tokens: 1 } } }),
    chunk({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    chunk({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
    chunk({ type: "content_block_stop", index: 0 }),
    chunk({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 2 },
    }),
    chunk({ type: "message_stop" }),
    { kind: "end", call: 0, outcome: "completed" },
  ];
  const fixture = testing.parseFixture(lines.map((line) => JSON.stringify(line)).join("\n"));
  const client = testing.replayClient(fixture);
  const stream = root.streamText({
    model: anthropic.anthropic({ client })("smoke"),
    messages: [{ role: "user", content: "hi" }],
  });
  const types = [];
  for await (const event of testing.checkEventOrder(stream)) types.push(event.type);
  if (types.join(",") !== "text-delta,usage,finish") throw new Error(`anthropic events: ${types}`);
  const result = await stream.result;
  if (result.text !== "hi" || result.usage.outputTokens !== 2) throw new Error("anthropic result");
  if (client.calls[0]?.params.max_tokens !== 4096) throw new Error("anthropic request");
}
