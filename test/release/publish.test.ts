import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (file: string): string => readFileSync(join(root, file), "utf8");
const file = ".github/workflows/publish.yml";

// No YAML parser is a dependency, so the workflow is read as lines with comments removed. That
// keeps a commented-out line from satisfying a check, and keeps a column-0 comment from ending a
// job early.
const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((l) => l.replace(/\s+#.*$/, ""))
    .filter((l) => l.trim() !== "" && !/^\s*#/.test(l));

function job(workflow: string, name: string): string[] {
  const all = lines(workflow);
  const start = all.findIndex((l) => l === `  ${name}:`);
  if (start === -1) return [];
  const rest = all.slice(start + 1);
  const end = rest.findIndex((l) => /^ {0,2}\S/.test(l));
  return rest.slice(0, end === -1 ? undefined : end);
}

// Every shell command a job runs, single-line `run:` values and `run: |` blocks alike.
function runs(jobLines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < jobLines.length; i++) {
    const m = /^(\s*)(?:- )?run: (.*)$/.exec(jobLines[i] as string);
    if (m === null) continue;
    if (m[2] !== "|") {
      out.push(m[2] as string);
      continue;
    }
    const indent = (m[1] as string).length;
    while (
      i + 1 < jobLines.length &&
      (/^(\s*)/.exec(jobLines[i + 1] as string)?.[1]?.length ?? 0) > indent
    ) {
      out.push((jobLines[++i] as string).trim());
    }
  }
  return out;
}

const uses = (jobLines: string[]): string[] =>
  jobLines.map((l) => /uses:\s*(\S+)/.exec(l)?.[1]).filter((u): u is string => u !== undefined);

describe("publish workflow", () => {
  test("exists only on GitHub", () => {
    expect(existsSync(join(root, file))).toBe(true);
    expect(existsSync(join(root, ".forgejo/workflows/publish.yml"))).toBe(false);
  });

  test("runs only on version tags, with no default permissions", () => {
    const all = lines(read(file));
    const on = all.indexOf("on:");
    expect(all.slice(on, on + 4)).toEqual(["on:", "  push:", "    tags:", '      - "v*"']);
    expect(all[on + 4]).toBe("permissions: {}");
    expect(all.filter((l) => /^\S/.test(l))).toEqual([
      "name: publish",
      "on:",
      "permissions: {}",
      "jobs:",
    ]);
    expect(all.filter((l) => /^ {2}\S/.test(l) && all.indexOf(l) > all.indexOf("jobs:"))).toEqual([
      "  build:",
      "  publish:",
    ]);
  });

  test("each job declares exactly its permissions, and only publish can mint an OIDC token", () => {
    const w = read(file);
    const perms = (name: string) => {
      const j = job(w, name);
      const at = j.indexOf("    permissions:");
      const out: string[] = [];
      for (let i = at + 1; i < j.length && /^ {6}\S/.test(j[i] as string); i++)
        out.push((j[i] as string).trim());
      return { declared: at !== -1, out };
    };
    expect(perms("build")).toEqual({ declared: true, out: ["contents: read"] });
    expect(perms("publish")).toEqual({
      declared: true,
      out: ["contents: read", "id-token: write"],
    });
    expect(job(w, "publish")).toContain("    environment: npm");
    expect(job(w, "publish")).toContain("    needs: build");
  });

  test("pins every action by commit SHA", () => {
    const all = uses(lines(read(file)));
    expect(all.length).toBeGreaterThan(0);
    for (const u of all) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
  });

  test("the build job runs exactly the checks, the build and the pack", () => {
    const build = job(read(file), "build");
    expect(runs(build)).toEqual([
      "bun install --frozen-lockfile --ignore-scripts",
      `version="$(bun -e 'console.log(require("./package.json").version)')"`,
      'if [ "$GITHUB_REF_NAME" != "v$version" ]; then',
      'echo "tag $GITHUB_REF_NAME does not match package.json version $version" >&2',
      "exit 1",
      "fi",
      "bun run check",
      "bun run fixtures:check",
      "rm -rf dist out && bun run build",
      "mkdir out && bun pm pack --destination out",
      "tar -tzf out/*.tgz | grep -qx package/dist/index.js",
      "bunx publint run out/*.tgz --strict",
      "bunx attw out/*.tgz --profile esm-only",
      'echo "sha256=$(sha256sum out/*.tgz | cut -d " " -f 1)" >> "$GITHUB_OUTPUT"',
    ]);
    expect(build).toContain("          no-cache: true");
    expect(build).toContain("    outputs:");
  });

  test("the publish job installs nothing and checks the hash from the build job's output", () => {
    const publish = job(read(file), "publish");
    expect(runs(publish)).toEqual([
      'echo "${{ needs.build.outputs.sha256 }}  $(ls out/*.tgz)" | sha256sum --check --strict',
      'npm_version="$(npm --version)"',
      'if [ "$(printf \'%s\\n\' 11.5.1 "$npm_version" | sort -V | head -n1)" != "11.5.1" ]; then',
      'echo "npm $npm_version is older than 11.5.1, which trusted publishing needs" >&2',
      "exit 1",
      "fi",
      "npm publish out/*.tgz --access public --provenance",
    ]);
    expect(uses(publish).map((u) => u.split("@")[0])).toEqual([
      "actions/download-artifact",
      "actions/setup-node",
    ]);
  });
});
