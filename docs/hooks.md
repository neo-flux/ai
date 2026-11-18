# Hooks

Pass `hooks` to `generate` or `streamText`. Every hook is awaited. If a hook throws, the error reaches you unchanged: it isn't wrapped, it doesn't trigger fallback, and `onError` isn't called for it.

| Hook                            | When                                                                 | Use it to                                                                       |
| ------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `resolveModel(models, ctx)`     | Once per call, before the first attempt                              | Replace the model list (routing). Returning an empty list is `invalid_request`. |
| `beforeRequest(request, ctx)`   | Before every attempt: fallbacks and the structured-output repair too | Return a changed request, or throw to reject the call (budgets)                 |
| `onUsage({ usage, cost, ctx })` | After every attempt that reported usage, failed ones included        | Meter spend                                                                     |
| `onError(error, ctx)`           | After every failed attempt                                           | Log. `ctx.willFallback` says whether the next model will be tried.              |

`ctx` tells you which model the attempt is for (`ctx.modelRef`), its position (`ctx.attempt`, counted across the chain and the repair), whether it's the `"initial"` attempt or the `"repair"`, and its `signal`.

`price(modelRef)` returns a `Price` (per million tokens, in your unit) or `undefined`. Cost is computed only from prices you give. None ship with the library.

## Metering

```ts
let spent = 0;
const hooks = {
  onUsage: ({ cost }) => {
    spent += cost ?? 0;
  },
};
await generate({
  model,
  messages,
  hooks,
  price: () => ({ input: 0.4, output: 1.6, cachedInput: 0.1 }),
});
```

## A budget

```ts
const limit = 5;
const hooks = {
  beforeRequest: () => {
    if (spent >= limit) throw new Error("budget exhausted");
    return undefined;
  },
  onUsage: ({ cost }) => {
    spent += cost ?? 0;
  },
};
```

The thrown error reaches you as it is, so you can tell a budget stop apart from a provider error.

## Routing

```ts
const hooks = {
  resolveModel: (models) => (messages.length > 20 ? [bigModel, ...models] : models),
};
```

To skip one provider for a single call, for example when a per-provider budget runs out, return a shorter list from `resolveModel`.
