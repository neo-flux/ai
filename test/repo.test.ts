import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  bareImports,
  checkDtsGraph,
  checkEntryPeers,
  checkManifest,
  checkSourceImports,
  findBannedTerms,
  findRuntimeGlobals,
  findSecrets,
  workflowsDiffer,
} from "../scripts/guards.ts";

// The library must not know who uses it. This file is the only one allowed to name these.
const BANNED_TERMS = ["dastaan", "khatt", "tenant", "tenancy"];
const BANNED_TERMS_FILE = "test/repo.test.ts";
const PEERS = ["openai", "@anthropic-ai/sdk"];

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, unknown>;
const exportsMap = pkg.exports as Record<string, { types: string; default: string }>;

const walk = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));

const git = (...args: string[]): string[] => {
  const result = Bun.spawnSync(["git", ...args], { cwd: root });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().split("\0").filter(Boolean);
};

describe("build output", () => {
  let out = "";

  beforeAll(() => {
    out = mkdtempSync(join(tmpdir(), "neoflux-ai-build-"));
    const tsc = Bun.spawnSync(
      [join(root, "node_modules/.bin/tsc"), "-p", "tsconfig.build.json", "--outDir", out],
      { cwd: root },
    );
    if (tsc.exitCode !== 0) throw new Error(`build failed:\n${tsc.stdout}${tsc.stderr}`);
  });

  afterAll(() => {
    if (out) rmSync(out, { recursive: true, force: true });
  });

  const built = (target: string): string => join(out, target.replace(/^\.\/dist\//, ""));

  test("contains only .js and .d.ts files, each .js with a sibling .d.ts", () => {
    const files = walk(out).map((f) => relative(out, f));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(file).toMatch(/\.(?:js|d\.ts)$/);
    for (const file of files.filter((f) => f.endsWith(".js"))) {
      expect(files).toContain(file.replace(/\.js$/, ".d.ts"));
    }
  });

  test("every exports target is built", () => {
    for (const { types, default: js } of Object.values(exportsMap)) {
      expect(existsSync(built(types))).toBe(true);
      expect(existsSync(built(js))).toBe(true);
    }
  });

  test("no .js file has a bare import specifier", () => {
    const transpiler = new Bun.Transpiler({ loader: "js" });
    for (const file of walk(out).filter((f) => f.endsWith(".js"))) {
      const code = readFileSync(file, "utf8");
      expect({ file, bare: bareImports(code) }).toEqual({ file, bare: [] });
      // Second opinion from Bun's own parser.
      const bunBare = transpiler.scanImports(code).filter((i) => !/^\.\.?\//.test(i.path));
      expect({ file, bare: bunBare }).toEqual({ file, bare: [] });
    }
  });

  test("each entry point's .d.ts graph references only its own peer", () => {
    const read = (path: string): string | undefined =>
      existsSync(path) ? readFileSync(path, "utf8") : undefined;
    for (const [subpath, { types }] of Object.entries(exportsMap)) {
      const allowed = checkEntryPeers(subpath);
      expect({ subpath, known: allowed !== undefined }).toEqual({ subpath, known: true });
      const violations = checkDtsGraph(built(types), read, allowed ?? []).map((v) => ({
        ...v,
        file: relative(out, v.file),
      }));
      expect({ subpath, violations }).toEqual({ subpath, violations: [] });
    }
  });
});

describe("src", () => {
  const sources = walk(join(root, "src")).filter((f) => f.endsWith(".ts"));

  test("has source files", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  test("imports only relative files and type-only peers", () => {
    for (const file of sources) {
      const bad = checkSourceImports(readFileSync(file, "utf8"), PEERS);
      expect({ file: relative(root, file), bad }).toEqual({ file: relative(root, file), bad: [] });
    }
  });

  test("uses no runtime-specific globals", () => {
    for (const file of sources) {
      const bad = findRuntimeGlobals(readFileSync(file, "utf8"));
      expect({ file: relative(root, file), bad }).toEqual({ file: relative(root, file), bad: [] });
    }
  });
});

describe("package.json", () => {
  test("passes the manifest guard", () => {
    expect(checkManifest(pkg)).toEqual([]);
  });
});

describe("repository", () => {
  test("no file names a banned term", () => {
    const all = git("ls-files", "-z", "--cached", "--others", "--exclude-standard").filter((f) =>
      existsSync(join(root, f)),
    );
    const files = all.filter((f) => f !== BANNED_TERMS_FILE);
    expect(all.filter((f) => !files.includes(f))).toEqual([BANNED_TERMS_FILE]);
    for (const file of files) {
      const found = findBannedTerms(
        `${file}\n${readFileSync(join(root, file), "utf8")}`,
        BANNED_TERMS,
      );
      expect({ file, found }).toEqual({ file, found: [] });
    }
  });

  test("no file contains a credential", () => {
    const files = git("ls-files", "-z", "--cached", "--others", "--exclude-standard").filter((f) =>
      existsSync(join(root, f)),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const found = findSecrets(readFileSync(join(root, file), "utf8"));
      expect({ file, found }).toEqual({ file, found: [] });
    }
  });

  test("no commit message or branch name names a banned term", () => {
    const messages = git("log", "-z", "--format=%B");
    const branches = git("for-each-ref", "--format=%(refname:short)%00", "refs/heads", "refs/tags");
    expect(messages.length).toBeGreaterThan(0);
    for (const text of [...messages, ...branches]) {
      expect({ text, found: findBannedTerms(text, BANNED_TERMS) }).toEqual({ text, found: [] });
    }
  });

  test("Forgejo and GitHub test workflows match", () => {
    const github = readFileSync(join(root, ".github/workflows/test.yml"), "utf8");
    const forgejo = readFileSync(join(root, ".forgejo/workflows/test.yml"), "utf8");
    expect(workflowsDiffer(github, forgejo)).toBe(false);
    // Forgejo must not depend on the instance's default actions source.
    const uses = forgejo.split("\n").filter((line) => /^\s*-?\s*uses:/.test(line));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses)
      expect(line).toMatch(/uses:\s*https:\/\/github\.com\/[^@\s]+@[0-9a-f]{40}\b/);
  });

  test("no AI tooling files are tracked", () => {
    const tracked = git("ls-files", "-z", "--cached");
    const ai = tracked.filter((f) => /^(?:\.ai\/|\.claude\/|CLAUDE(?:\.local)?\.md$)/.test(f));
    expect(ai).toEqual([]);
  });
});
