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
    // No Workers claim until a Workers smoke test exists.
    expect(readme).not.toMatch(/workers/i);
  });
});
