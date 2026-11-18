# Contributing

Thanks for helping. This is a small library with strict rules, so please read this first.

Issues and pull requests: https://github.com/neo-flux/ai (the GitHub mirror). TODO: confirm

## Setup

This project uses [Bun](https://bun.com) only. Please don't use npm, pnpm or yarn to install.

```sh
bun install --frozen-lockfile
bun run check            # typecheck, lint, tests, pack check, smoke (Node and Deno)
bun run fixtures:check   # scans recorded fixtures for secrets
bun run mutate           # hand-written mutation tests, slow
```

`bun run check` must pass before a pull request is merged. Deno is needed locally for the smoke test.

## Rules for code

- Zero runtime dependencies. Provider SDKs are optional peer dependencies, imported with `import type` only.
- `src/` uses web standards only: `fetch`, Web Streams, `AbortSignal`, `TextEncoder`/`TextDecoder`. No `node:` imports, no `Bun`, `process` or `Buffer`. A guard test enforces this.
- Erasable TypeScript only: no enums, namespaces or parameter properties.
- Adapters only translate. Fallback, hooks, usage, cost, structured output and event ordering live in core.
- Errors never include keys, request bodies, message content or provider error text.
- Write the test first. For logic, add a mutant to `test/mutants/` that your test kills.

## Fixtures

Adapter tests replay recorded provider streams from `fixtures/`. Recording needs your own provider accounts. See [docs/fixtures.md](docs/fixtures.md). Never commit anything from `fixtures/.raw/`. Only scrubbed fixtures that pass `bun run fixtures:check` belong in the repo.

## Commits

Small commits, one concern each, with a short message and no body.

## Security

Please report vulnerabilities privately, as described in [SECURITY.md](SECURITY.md), not in public issues.
