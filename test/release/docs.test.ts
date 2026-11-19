import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (file: string): string => readFileSync(join(root, file), "utf8");
const pkg = JSON.parse(read("package.json")) as Record<string, unknown>;

describe("repository documents", () => {
  test("security policy names the disclosure address", () => {
    expect(read("SECURITY.md")).toContain("security@neoflux.pk");
  });

  test("contributing guide has the one line that says where issues live", () => {
    expect(read("CONTRIBUTING.md").match(/^Issues and pull requests: .+$/m)).not.toBeNull();
  });

  test("code of conduct, changelog and issue templates exist", () => {
    expect(read("CODE_OF_CONDUCT.md")).toContain("Contributor Covenant");
    expect(read("CHANGELOG.md")).toContain("## [Unreleased]");
    for (const f of ["bug_report.md", "feature_request.md", "config.yml"]) {
      expect(existsSync(join(root, ".github/ISSUE_TEMPLATE", f))).toBe(true);
    }
    expect(read(".github/ISSUE_TEMPLATE/config.yml")).toContain("blank_issues_enabled: false");
    expect(read(".github/ISSUE_TEMPLATE/bug_report.md")).toContain("How to reproduce");
    expect(read(".github/ISSUE_TEMPLATE/feature_request.md")).toContain("What you're trying to do");
  });

  test("the release guide marks every open release decision", () => {
    const guide = read("docs/releasing.md");
    for (const topic of [
      "trusted publisher",
      "required reviewer",
      "tag ruleset",
      "bypass",
      "private vulnerability reporting",
      "Workers",
      "data terms",
    ]) {
      expect({ topic, present: guide.includes(topic) }).toEqual({ topic, present: true });
    }
    // Still open: whether npm accepts a trusted publisher before the first version exists.
    expect(guide.match(/TODO: confirm/g)).toHaveLength(1);
    // Each provider's terms are linked, not summarized.
    for (const host of [
      "developers.openai.com",
      "privacy.claude.com",
      "cdn.deepseek.com",
      "www.alibabacloud.com",
    ]) {
      expect({ host, linked: guide.includes(`https://${host}`) }).toEqual({ host, linked: true });
    }
  });

  test("dependabot watches actions and bun dev dependencies", () => {
    const d = read(".github/dependabot.yml");
    expect(d).toContain('package-ecosystem: "github-actions"');
    expect(d).toContain('package-ecosystem: "bun"');
  });

  test("the README covers every entry point", () => {
    const readme = read("README.md");
    for (const subpath of Object.keys(pkg.exports as object)) {
      const name = subpath === "." ? "@neoflux/ai" : `@neoflux/ai/${subpath.slice(2)}`;
      expect({ name, mentioned: readme.includes(`"${name}"`) }).toEqual({ name, mentioned: true });
    }
    // No Workers claim until a Workers smoke test exists. docs/releasing.md says why there is none.
    expect(readme).not.toMatch(/workers/i);
    for (const doc of [
      "compat",
      "deepseek",
      "openai",
      "anthropic",
      "errors",
      "events",
      "hooks",
      "testing",
      "fixtures",
    ]) {
      expect({ doc, workers: /workers/i.test(read(`docs/${doc}.md`)) }).toEqual({
        doc,
        workers: false,
      });
    }
  });
});
