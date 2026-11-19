# Releasing

For maintainers. Releases are published from GitHub Actions only (`.github/workflows/publish.yml`), with npm trusted publishing and provenance. Nothing is published from a laptop.

## One-time setup

Do these in order. The GitHub side comes first: until the `npm` environment exists with its reviewer, any tag push that reaches the publish job would publish unreviewed.

1. **GitHub environment:** create the `npm` environment with the maintainer as its required reviewer, and limit its deployments to tags matching `v*`. Leave "prevent self-review" off: there is a single maintainer, who both pushes the tag and approves the deployment. GitHub creates a missing environment with no protection on the first run, so do this before anything else.
2. **Tag protection:** release tags are pushed on Forgejo and reach GitHub through the push mirror. Add a tag ruleset for `v*` on GitHub, and give the account that owns the mirror's token a bypass, so the mirror can create tags and nobody else can.
3. **npm:** add a trusted publisher for `@neoflux/ai`: GitHub, repository `neo-flux/ai`, workflow `publish.yml`, environment `npm`. TODO: confirm whether npm lets you add a trusted publisher before the package's first version exists. If it doesn't, the first version has to be published by hand (or as a placeholder) before the workflow can take over.
4. **Vulnerability reports:** turn on GitHub private vulnerability reporting, alongside the address in SECURITY.md (security@neoflux.pk).

Releases are cut from `main` only. The build job fails if the tagged commit isn't on `main`, because GitHub runs the workflow file from the tagged commit itself.

## Each release

1. Update `version` in `package.json` and move the `Unreleased` entries in `CHANGELOG.md` under the new version.
2. Commit on `main`, then tag `v<version>` on Forgejo and push the tag. The push mirror carries it to GitHub.
3. The `build` job checks the tag against `package.json`, runs `bun run check` and `bun run fixtures:check`, builds, packs, and runs publint and attw on the tarball it packed. The tarball's SHA-256 goes to the `publish` job as a job output. That proves the tarball arrived unchanged, not that the build was clean: the build job is the trusted step.
4. After the environment's reviewers approve, the `publish` job checks the downloaded tarball against that hash and runs `npm publish --provenance`.

`bun publish` isn't used, because it can't do OIDC trusted publishing or provenance yet (checked against the Bun docs for 1.4.4). The publish step uses the npm CLI that ships with Node 24 (11.19.1, above the 11.5.1 that trusted publishing needs).

## Not covered in 0.x

- **Forgejo action pins:** Dependabot updates the action SHAs in `.github/workflows/` only. The test suite fails until `.forgejo/workflows/test.yml` uses the same SHAs, so update both in the same pull request.
- **Workers:** there is no Cloudflare Workers smoke test in 0.x, so the README must not claim Workers support. A test in `test/release/docs.test.ts` checks the README and `docs/` for it.

## Provider data terms

What each provider does with API data is set by its own terms. Check them before you send data to a provider:

- OpenAI: [Data controls in the OpenAI platform](https://developers.openai.com/api/docs/guides/your-data)
- Anthropic: [Privacy Center, commercial customers](https://privacy.claude.com/en/collections/10663361-commercial-customers) and [Commercial Terms](https://www.anthropic.com/legal/commercial-terms)
- DeepSeek: [Privacy Policy](https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html) and [Open Platform Terms of Service](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html)
- Alibaba Model Studio (Qwen, planned): [Data retention policy](https://www.alibabacloud.com/help/en/model-studio/data-retention-policy) and [Privacy notice](https://www.alibabacloud.com/help/en/model-studio/privacy-notice)
