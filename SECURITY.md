# Security policy

## Reporting a vulnerability

Email **security@neoflux.pk** with a description and, if you can, a way to reproduce it. Please don't open a public issue for a vulnerability.

We'll acknowledge your report, keep you updated, and credit you in the release notes if you'd like.

## In scope

- API keys, request bodies, message content or provider error text appearing in an `AIError`'s message, `toString()`, JSON or `util.inspect` output.
- Data from one provider being sent to another in a way the docs don't describe.
- Credentials or account data in committed fixtures.
- Anything that lets a hostile provider stream or a stored conversation history crash a caller or inject content into a request.

## Supported versions

Only the latest 0.x release gets fixes.
