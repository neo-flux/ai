# Releasing

For maintainers. Releases are published from GitHub Actions only (`.github/workflows/publish.yml`), with npm trusted publishing and provenance. Nothing is published from a laptop.

## One-time setup

1. **npm:** add a trusted publisher for `@neoflux/ai`: GitHub, repository `neo-flux/ai`, workflow `publish.yml`, environment `npm`. TODO: confirm whether npm lets you add a trusted publisher before the package's first version exists. If it doesn't, the first version has to be published by hand (or as a placeholder) before the workflow can take over.
2. **GitHub environment:** create the `npm` environment with required reviewers. GitHub creates a missing environment with no protection on the first run, so do this before pushing the first tag. TODO: confirm the reviewers.
3. **Tag protection:** add a tag ruleset for `v*` so only maintainers can create release tags. TODO: confirm.

## Each release

1. Update `version` in `package.json` and move the `Unreleased` entries in `CHANGELOG.md` under the new version.
2. Commit, then tag `v<version>` and push the tag.
3. The `build` job checks the tag against `package.json`, runs `bun run check` and `bun run fixtures:check`, builds, packs, and runs publint and attw on the tarball it packed. The tarball's SHA-256 goes to the `publish` job as a job output.
4. After the environment's reviewers approve, the `publish` job checks the downloaded tarball against that hash and runs `npm publish --provenance`.

`bun publish` isn't used, because it can't do OIDC trusted publishing or provenance yet (checked against the Bun docs for 1.4.4). The publish step uses the npm CLI that ships with Node 24 (11.19.1, above the 11.5.1 that trusted publishing needs).

## Not covered yet

- **Workers:** there is no Cloudflare Workers smoke test, so the README makes no Workers claim. Adding one needs the `workerd` package as a dev dependency (a large platform binary). TODO: confirm.
- **Provider data terms:** what DeepSeek and Alibaba Model Studio do with API data (retention, training) is for each user to check in the providers' current terms. The library sends only what you pass to it. TODO: confirm that the docs should link the terms.
