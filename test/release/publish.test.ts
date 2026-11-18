import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (file: string): string => readFileSync(join(root, file), "utf8");

// The lines of one top-level job in a workflow, found by its two-space indented key.
function job(workflow: string, name: string): string[] {
  const lines = workflow.split("\n");
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start === -1) return [];
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^ {2}[a-z][\w-]*:/.test(l) || /^\S/.test(l));
  return rest.slice(0, end === -1 ? undefined : end);
}

describe("publish workflow", () => {
  const file = ".github/workflows/publish.yml";

  test("exists only on GitHub", () => {
    expect(existsSync(join(root, file))).toBe(true);
    expect(existsSync(join(root, ".forgejo/workflows/publish.yml"))).toBe(false);
  });

  test("runs only on version tags, with no default permissions", () => {
    const w = read(file);
    expect(w).toMatch(/^on:\n {2}push:\n {4}tags:\n {6}- "v\*"\n/m);
    expect(w).not.toMatch(/pull_request|branches:|workflow_dispatch/);
    expect(w).toMatch(/^permissions: \{\}$/m);
  });

  test("only the publish job can mint an OIDC token, behind a protected environment", () => {
    const w = read(file);
    expect(w.match(/id-token: write/g)).toHaveLength(1);
    const publish = job(w, "publish").join("\n");
    expect(publish).toContain("id-token: write");
    expect(publish).toMatch(/environment: npm\b/);
    expect(publish).toMatch(/needs: build\b/);
    expect(job(w, "build").join("\n")).not.toContain("id-token");
  });

  test("pins every action by commit SHA", () => {
    const uses = read(file)
      .split("\n")
      .filter((l) => /^\s*-?\s*uses:/.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) expect(line).toMatch(/uses:\s*[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d/);
  });

  test("the publish job installs nothing and verifies the tarball's checksum", () => {
    const publish = job(read(file), "publish");
    const runs = publish.filter((l) => /^\s*(?:-\s*)?run:|^\s{10,}\S/.test(l)).join("\n");
    expect(runs).not.toMatch(/\b(?:install|bun add|npm i)\b/);
    expect(runs).toContain("sha256sum --check");
    expect(runs).toMatch(/npm publish .*--provenance/);
  });

  test("the build job checks, packs and checks the tag against the version", () => {
    const build = job(read(file), "build").join("\n");
    for (const step of [
      "bun install --frozen-lockfile --ignore-scripts",
      "bun run check",
      "bun run fixtures:check",
      "bun pm pack",
    ]) {
      expect(build).toContain(step);
    }
    expect(build).toContain("no-cache: true");
    expect(build).toContain("GITHUB_REF_NAME");
  });
});
