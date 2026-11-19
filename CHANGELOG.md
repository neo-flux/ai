# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org). Before 1.0, minor versions may contain breaking changes.

## [Unreleased]

## [0.1.0] - 2026-11-19

### Added

- `generate` and `streamText` with one message, event, usage and error model.
- Fallback chains that switch models only before the first event, driven by `AIError.failover`.
- Typed errors (`AIError`, `isAIError`, `getProviderError`) that never contain keys, request bodies or message content.
- Tools with Standard Schema validation, and structured output with one repair attempt.
- Usage normalization and cost from a caller-supplied price table.
- Hooks: `resolveModel`, `beforeRequest`, `onUsage`, `onError`.
- Adapters: `@neoflux/ai/openai` (Responses API), `@neoflux/ai/anthropic` (Messages API), `@neoflux/ai/deepseek`, and `@neoflux/ai/compat` for any OpenAI-compatible server (quirks unstable in 0.x).
- `@neoflux/ai/testing`: `fakeAdapter`, the event-order checker, and fixture replay.
