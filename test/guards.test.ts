import { describe, expect, test } from "bun:test";
import {
  bareImports,
  checkDtsGraph,
  checkEntryPeers,
  checkManifest,
  checkSourceImports,
  findBannedTerms,
  findRuntimeGlobals,
  scanSpecifiers,
  workflowsDiffer,
} from "../scripts/guards.ts";

const specs = (code: string): string[] => scanSpecifiers(code).map((s) => s.specifier);

describe("scanSpecifiers", () => {
  test("finds every static, re-export, side-effect, dynamic and require form", () => {
    const code = [
      'import a from "pkg-a";',
      'import "pkg-side";',
      'export * from "pkg-star";',
      'export { b } from "pkg-named";',
      'export * as ns from "pkg-ns";',
      'const c = await import("pkg-dyn");',
      'const r = require("pkg-req");',
      "import {",
      "  x,",
      "  y,",
      '} from "pkg-multi";',
      "import d from 'pkg-single';",
    ].join("\n");
    expect(specs(code)).toEqual([
      "pkg-a",
      "pkg-side",
      "pkg-star",
      "pkg-named",
      "pkg-ns",
      "pkg-dyn",
      "pkg-req",
      "pkg-multi",
      "pkg-single",
    ]);
  });

  test("finds import() types and triple-slash type references", () => {
    const code = [
      '/// <reference types="bun" />',
      '/// <reference path="./local.d.ts" />',
      'export declare const z: import("openai").OpenAI;',
    ].join("\n");
    expect(specs(code)).toEqual(["bun", "./local.d.ts", "openai"]);
  });

  test("ignores look-alikes in strings, comments, templates and regex literals", () => {
    const code = [
      "const s = \"import x from 'in-string'\";",
      "const t = 'from \"in-single\"';",
      '// import y from "in-comment"',
      '/* export * from "in-block" */',
      'const u = `import z from "in-template"`;',
      'const re = /from "in-regex"/;',
      'const url = "https://example.com"; import ok from "./ok.js";',
    ].join("\n");
    expect(specs(code)).toEqual(["./ok.js"]);
  });

  test("still scans code inside template expressions", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the string is source code under test
    expect(specs('const t = `a${await import("pkg-tpl")}b`;')).toEqual(["pkg-tpl"]);
  });

  test("treats a slash after an expression as division, not a regex", () => {
    expect(specs('const q = a / b; import x from "./after-division.js"; const w = c / d;')).toEqual(
      ["./after-division.js"],
    );
  });

  test("marks type-only imports and re-exports", () => {
    const code = [
      'import type { A } from "openai";',
      'import { type B } from "inline-type";',
      'export type { C } from "type-reexport";',
      'import D from "value";',
    ].join("\n");
    expect(scanSpecifiers(code)).toEqual([
      { specifier: "openai", typeOnly: true },
      { specifier: "inline-type", typeOnly: false },
      { specifier: "type-reexport", typeOnly: true },
      { specifier: "value", typeOnly: false },
    ]);
  });
});

describe("bareImports", () => {
  test("flags every non-relative specifier", () => {
    const code = [
      'import a from "openai";',
      'import "node:fs";',
      'import p from "path";',
      'import q from ".pkg";',
      'import r from "..pkg";',
      'import s from "/abs/path.js";',
      'import t from "https://cdn.example/x.js";',
      'const u = import("pkg-dyn");',
    ].join("\n");
    expect(bareImports(code)).toEqual([
      "openai",
      "node:fs",
      "path",
      ".pkg",
      "..pkg",
      "/abs/path.js",
      "https://cdn.example/x.js",
      "pkg-dyn",
    ]);
  });

  test("allows ./ and ../ specifiers", () => {
    expect(bareImports('import a from "./a.js";\nexport * from "../b/c.js";')).toEqual([]);
  });
});

describe("checkSourceImports", () => {
  const peers = ["openai", "@anthropic-ai/sdk"];

  test("allows relative imports and type-only peer imports", () => {
    const code = 'import type { OpenAI } from "openai";\nimport { x } from "./x.ts";';
    expect(checkSourceImports(code, peers)).toEqual([]);
  });

  test("flags a value import of a peer", () => {
    expect(checkSourceImports('import OpenAI from "openai";', peers)).toEqual(["openai"]);
  });

  test("flags an inline-type import of a peer, which still emits an import", () => {
    expect(checkSourceImports('import { type OpenAI } from "openai";', peers)).toEqual(["openai"]);
  });

  test("flags type-only imports of non-peers", () => {
    expect(checkSourceImports('import type { Stats } from "node:fs";', peers)).toEqual(["node:fs"]);
  });

  test("flags runtime and builtin specifiers", () => {
    const code = 'import "node:fs";\nimport "fs";\nimport "bun:test";\nimport "npm:x";';
    expect(checkSourceImports(code, peers)).toEqual(["node:fs", "fs", "bun:test", "npm:x"]);
  });
});

describe("findRuntimeGlobals", () => {
  test("flags runtime-specific globals", () => {
    const code = [
      "Bun.file('x');",
      "Deno.env.get('x');",
      "process.env.X;",
      "Buffer.from('x');",
      "require('x');",
      "module.exports = 1;",
      "__dirname;",
      "__filename;",
      "setImmediate(f);",
      "clearImmediate(h);",
      "window.fetch;",
      "document.title;",
      "localStorage.x;",
      "sessionStorage.x;",
      "global.x;",
      "self.postMessage;",
    ].join("\n");
    expect(findRuntimeGlobals(code)).toEqual([
      "Bun",
      "Deno",
      "process",
      "Buffer",
      "require",
      "module",
      "exports",
      "__dirname",
      "__filename",
      "setImmediate",
      "clearImmediate",
      "window",
      "document",
      "localStorage",
      "sessionStorage",
      "global",
      "self",
    ]);
  });

  test("flags access through casts, optional chaining, destructuring and computed keys", () => {
    const cases: [string, string[]][] = [
      ["export const env = (globalThis as any).process?.env;", ["globalThis", "process"]],
      ["const { process: proc } = globalThis as unknown as T;", ["process", "globalThis"]],
      ['export const d = Reflect.get(globalThis, "Deno");', ["globalThis"]],
      ["globalThis?.process;", ["globalThis", "process"]],
      ['globalThis["process"];', ["globalThis"]],
      ["obj.process();", ["process"]],
      ["const k = { process: 1 };", ["process"]],
    ];
    for (const [code, expected] of cases) {
      expect({ code, found: findRuntimeGlobals(code) }).toEqual({ code, found: expected });
    }
  });

  test("ignores look-alike identifiers, strings and comments", () => {
    const code = [
      "const processed = 1;",
      "const bunny = 2;",
      "const myBuffer = 3;",
      "const $process = 4;",
      "const process_ = 5;",
      "const globalThisLike = 6;",
      "const selfish = 7;",
      'const s = "process.env";',
      "// Bun.file()",
      "/* Deno.env */",
    ].join("\n");
    expect(findRuntimeGlobals(code)).toEqual([]);
  });
});

describe("checkDtsGraph", () => {
  const files: Record<string, string> = {
    "dist/openai.d.ts":
      'import type { OpenAI } from "openai";\nexport * from "./shared.js";\nexport declare const a: OpenAI;',
    "dist/shared.d.ts": 'export type { Msg } from "./types/msg.js";',
    "dist/types/msg.d.ts": "export type Msg = string;",
    "dist/index.d.ts": 'export * from "./shared.js";',
    "dist/leaky.d.ts": 'export * from "./deep.js";',
    "dist/deep.d.ts": 'import type { X } from "@anthropic-ai/sdk";\nexport declare const x: X;',
    "dist/cycle-a.d.ts": 'export * from "./cycle-b.js";',
    "dist/cycle-b.d.ts": 'export * from "./cycle-a.js";\nimport type { Y } from "zod";',
    "dist/broken.d.ts": 'export * from "./missing.js";',
  };
  const read = (path: string): string | undefined => files[path];

  test("passes when the graph references only the allowed peer", () => {
    expect(checkDtsGraph("dist/openai.d.ts", read, ["openai"])).toEqual([]);
  });

  test("passes for a peer-free graph with no allowed peers", () => {
    expect(checkDtsGraph("dist/index.d.ts", read, [])).toEqual([]);
  });

  test("flags a disallowed peer reached through a relative import", () => {
    expect(checkDtsGraph("dist/leaky.d.ts", read, ["openai"])).toEqual([
      { file: "dist/deep.d.ts", specifier: "@anthropic-ai/sdk" },
    ]);
  });

  test("terminates on cycles and still reports", () => {
    expect(checkDtsGraph("dist/cycle-a.d.ts", read, [])).toEqual([
      { file: "dist/cycle-b.d.ts", specifier: "zod" },
    ]);
  });

  test("reports an unresolvable relative import", () => {
    expect(checkDtsGraph("dist/broken.d.ts", read, [])).toEqual([
      { file: "dist/broken.d.ts", specifier: "./missing.js (unresolved)" },
    ]);
  });
});

describe("checkEntryPeers", () => {
  test("maps each subpath to its peer", () => {
    expect(checkEntryPeers(".")).toEqual([]);
    expect(checkEntryPeers("./testing")).toEqual([]);
    expect(checkEntryPeers("./openai")).toEqual(["openai"]);
    expect(checkEntryPeers("./compat")).toEqual(["openai"]);
    expect(checkEntryPeers("./deepseek")).toEqual(["openai"]);
    expect(checkEntryPeers("./qwen")).toEqual(["openai"]);
    expect(checkEntryPeers("./anthropic")).toEqual(["@anthropic-ai/sdk"]);
  });

  test("returns undefined for an unknown subpath", () => {
    expect(checkEntryPeers("./other")).toBeUndefined();
  });
});

const validManifest = (): Record<string, unknown> => ({
  name: "@neoflux/ai",
  version: "0.0.0",
  type: "module",
  sideEffects: false,
  files: ["dist"],
  exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
  engines: { node: ">=22" },
  publishConfig: { access: "public" },
  scripts: { test: "bun test" },
  peerDependencies: { openai: "^7.0.0", "@anthropic-ai/sdk": "^1.0.0" },
  peerDependenciesMeta: { openai: { optional: true }, "@anthropic-ai/sdk": { optional: true } },
  devDependencies: { typescript: "7.0.2", publint: "0.3.25", x: "1.0.0-rc.1" },
  trustedDependencies: [],
});

describe("checkManifest", () => {
  test("accepts a valid manifest", () => {
    expect(checkManifest(validManifest())).toEqual([]);
  });

  const cases: [string, (m: Record<string, unknown>) => void][] = [
    ["dependencies", (m) => (m.dependencies = { a: "1.0.0" })],
    ["optionalDependencies", (m) => (m.optionalDependencies = { a: "1.0.0" })],
    ["bundleDependencies", (m) => (m.bundleDependencies = ["a"])],
    ["bundledDependencies", (m) => (m.bundledDependencies = ["a"])],
    ["peer not allowed: zod", (m) => ((m.peerDependencies as Record<string, string>).zod = "^4")],
    [
      "peer not optional: openai",
      (m) => ((m.peerDependenciesMeta as Record<string, unknown>).openai = { optional: false }),
    ],
    [
      "peer not optional: @anthropic-ai/sdk",
      (m) => (m.peerDependenciesMeta = { openai: { optional: true } }),
    ],
    ["trustedDependencies must be []", (m) => (m.trustedDependencies = ["workerd"])],
    ["trustedDependencies must be []", (m) => delete m.trustedDependencies],
    ["type must be module", (m) => (m.type = "commonjs")],
    ["sideEffects must be false", (m) => delete m.sideEffects],
    ['files must be ["dist"]', (m) => (m.files = ["dist", "src"])],
    ["engines.node must be >=22", (m) => (m.engines = { node: ">=20" })],
    ["publishConfig.access must be public", (m) => (m.publishConfig = {})],
    ["exports must be an object", (m) => (m.exports = "./dist/index.js")],
    [
      "exports[.]: types must be the first condition",
      (m) => (m.exports = { ".": { default: "./dist/index.js", types: "./dist/index.d.ts" } }),
    ],
    ["exports[.]: missing default", (m) => (m.exports = { ".": { types: "./dist/index.d.ts" } })],
    [
      "exports[.]: types must be ./dist/**.d.ts",
      (m) => (m.exports = { ".": { types: "./src/index.ts", default: "./dist/index.js" } }),
    ],
    [
      "exports[.]: default must be ./dist/**.js",
      (m) => (m.exports = { ".": { types: "./dist/index.d.ts", default: "./src/index.js" } }),
    ],
  ];
  for (const [violation, mutate] of cases) {
    test(`flags: ${violation}`, () => {
      const m = validManifest();
      mutate(m);
      expect(checkManifest(m)).toContain(violation);
    });
  }

  for (const script of [
    "preinstall",
    "install",
    "postinstall",
    "prepare",
    "prepublish",
    "prepublishOnly",
    "prepack",
    "postpack",
    "publish",
    "postpublish",
  ]) {
    test(`flags lifecycle script: ${script}`, () => {
      const m = validManifest();
      m.scripts = { [script]: "echo" };
      expect(checkManifest(m)).toContain(`lifecycle script: ${script}`);
    });
  }

  for (const range of ["^1.0.0", "~1.0.0", ">=1", "1.x", "*", "latest", "1.0", ""]) {
    test(`flags non-exact devDependency: "${range}"`, () => {
      const m = validManifest();
      m.devDependencies = { a: range };
      expect(checkManifest(m)).toContain("devDependency not exact: a");
    });
  }
});

describe("findBannedTerms", () => {
  const terms = ["zzbanned", "qqterm"];

  test("matches case-insensitively anywhere in the text", () => {
    expect(findBannedTerms("const ZZBANNED = 1;", terms)).toEqual(["zzbanned"]);
    expect(findBannedTerms("subZzbannedClient", terms)).toEqual(["zzbanned"]);
    expect(findBannedTerms("my-qqterms_list", terms)).toEqual(["qqterm"]);
  });

  test("returns each matched term once, in list order", () => {
    expect(findBannedTerms("qqterm zzbanned qqterm", terms)).toEqual(["zzbanned", "qqterm"]);
  });

  test("returns nothing for clean text", () => {
    expect(findBannedTerms("zz banned qq term", terms)).toEqual([]);
  });
});

describe("workflowsDiffer", () => {
  const github = [
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-24.04",
    "    steps:",
    "      - uses: actions/checkout@abc # v1",
    "      - run: bun test",
  ].join("\n");
  const forgejo = github
    .replace("runs-on: ubuntu-24.04", "runs-on: docker # TODO: confirm")
    .replace("uses: actions/", "uses: https://github.com/actions/");

  test("treats runs-on and the full GitHub URL prefix as equal", () => {
    expect(workflowsDiffer(github, forgejo)).toBe(false);
  });

  test("detects a different step", () => {
    expect(workflowsDiffer(github, forgejo.replace("bun test", "bun run lint"))).toBe(true);
  });

  test("detects a different action SHA", () => {
    expect(workflowsDiffer(github, forgejo.replace("@abc", "@def"))).toBe(true);
  });

  test("detects a missing line", () => {
    expect(workflowsDiffer(github, forgejo.split("\n").slice(0, -1).join("\n"))).toBe(true);
  });
});
