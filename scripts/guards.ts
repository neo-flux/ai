import { dirname, join } from "node:path";
import { parseFixture } from "../src/testing/fixture.ts";
import { ALLOWED_HEADERS } from "./recorder/record.ts";

export interface Specifier {
  specifier: string;
  typeOnly: boolean;
}

const REFERENCE = "\u0001ref";
const KEYWORDS_BEFORE_REGEX = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "instanceof",
  "yield",
  "await",
]);
const PUNCTUATION_BEFORE_REGEX = "(,=:[!&|?{};+-*%<>~^";

interface Masked {
  code: string;
  strings: string[];
}

// Strips comments and replaces string, template and regex literal contents so that
// pattern matching only ever sees real code. String contents are kept by index.
function mask(source: string): Masked {
  const strings: string[] = [];
  let i = 0;

  const regexAllowed = (out: string): boolean => {
    const trimmed = out.trimEnd();
    if (trimmed === "") return true;
    const last = trimmed.at(-1) as string;
    if (PUNCTUATION_BEFORE_REGEX.includes(last)) return true;
    const word = /[\w$]+$/.exec(trimmed);
    return word !== null && KEYWORDS_BEFORE_REGEX.has(word[0]);
  };

  const readString = (quote: string): string => {
    let value = "";
    i++;
    while (i < source.length && source[i] !== quote && source[i] !== "\n") {
      if (source[i] === "\\") {
        value += source.slice(i, i + 2);
        i += 2;
      } else {
        value += source[i];
        i++;
      }
    }
    i++;
    return value;
  };

  const readCode = (stopAtBrace: boolean): string => {
    let out = "";
    let depth = 0;
    while (i < source.length) {
      const c = source[i] as string;
      const next = source[i + 1];
      if (stopAtBrace) {
        if (c === "{") depth++;
        if (c === "}") {
          if (depth === 0) return out;
          depth--;
        }
      }
      if (c === "/" && next === "/") {
        const end = source.indexOf("\n", i);
        const comment = source.slice(i, end === -1 ? source.length : end);
        const ref = /^\/\/\/\s*<reference\s+(?:types|path)\s*=\s*["']([^"']+)["']/.exec(comment);
        if (ref) {
          strings.push(ref[1] as string);
          out += `${REFERENCE}"#${strings.length - 1}"`;
        }
        i = end === -1 ? source.length : end;
      } else if (c === "/" && next === "*") {
        const end = source.indexOf("*/", i + 2);
        i = end === -1 ? source.length : end + 2;
        out += " ";
      } else if (c === '"' || c === "'") {
        strings.push(readString(c));
        out += `"#${strings.length - 1}"`;
      } else if (c === "`") {
        i++;
        out += "`";
        while (i < source.length && source[i] !== "`") {
          if (source[i] === "\\") {
            i += 2;
          } else if (source[i] === "$" && source[i + 1] === "{") {
            i += 2;
            out += "${";
            out += readCode(true);
            out += "}";
            i++;
          } else {
            i++;
          }
        }
        i++;
        out += "`";
      } else if (c === "/" && regexAllowed(out)) {
        let j = i + 1;
        let inClass = false;
        while (j < source.length && source[j] !== "\n") {
          if (source[j] === "\\") {
            j += 2;
            continue;
          }
          if (source[j] === "[") inClass = true;
          else if (source[j] === "]") inClass = false;
          else if (source[j] === "/" && !inClass) break;
          j++;
        }
        if (source[j] === "/") {
          i = j + 1;
          while (i < source.length && /[a-z]/i.test(source[i] as string)) i++;
          out += "/R/";
        } else {
          out += c;
          i++;
        }
      } else {
        out += c;
        i++;
      }
    }
    return out;
  };

  return { code: readCode(false), strings };
}

const SPECIFIER_PATTERNS: { pattern: RegExp; statement: boolean }[] = [
  { pattern: /\bfrom\s*"#(\d+)"/g, statement: true },
  { pattern: /\bimport\s*"#(\d+)"/g, statement: false },
  { pattern: /\bimport\s*\(\s*"#(\d+)"\s*\)/g, statement: false },
  { pattern: /\brequire\s*\(\s*"#(\d+)"\s*\)/g, statement: false },
  // declare module "x" augmentations force consumers to resolve x.
  { pattern: /\bmodule\s*"#(\d+)"/g, statement: false },
  { pattern: new RegExp(`${REFERENCE}"#(\\d+)"`, "g"), statement: false },
];

export function scanSpecifiers(source: string): Specifier[] {
  const { code, strings } = mask(source);
  const found: { index: number; spec: Specifier }[] = [];
  for (const { pattern, statement } of SPECIFIER_PATTERNS) {
    for (const match of code.matchAll(pattern)) {
      let typeOnly = false;
      if (statement) {
        const before = code.slice(0, match.index);
        const starts = [...before.matchAll(/\b(?:import|export)\b/g)];
        const start = starts.at(-1);
        if (start !== undefined) {
          typeOnly = /^(?:import|export)\s+type\b(?!\s*(?:,|from\b))/.test(code.slice(start.index));
        }
      }
      const specifier = strings[Number(match[1])] as string;
      found.push({ index: match.index, spec: { specifier, typeOnly } });
    }
  }
  return found.sort((a, b) => a.index - b.index).map((f) => f.spec);
}

const isRelative = (specifier: string): boolean => /^\.\.?\//.test(specifier);

export function bareImports(source: string): string[] {
  return scanSpecifiers(source)
    .map((s) => s.specifier)
    .filter((s) => !isRelative(s));
}

export function checkSourceImports(source: string, typeOnlyPeers: readonly string[]): string[] {
  return scanSpecifiers(source)
    .filter((s) => !isRelative(s.specifier))
    .filter((s) => !(s.typeOnly && typeOnlyPeers.includes(s.specifier)))
    .map((s) => s.specifier);
}

// Matched as whole identifiers anywhere in code, including after "." and as object keys,
// so casts and destructuring cannot reach them. globalThis and self are banned outright
// because they make every other name reachable through a computed key.
const RUNTIME_GLOBALS = [
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
  "globalThis",
  "self",
];

export function findRuntimeGlobals(source: string): string[] {
  const { code } = mask(source);
  const pattern = new RegExp(`(?<![\\w$])(${RUNTIME_GLOBALS.join("|")})(?![\\w$])`, "g");
  return [...code.matchAll(pattern)].map((match) => match[1] as string);
}

export interface GraphViolation {
  file: string;
  specifier: string;
}

const declarationPath = (from: string, specifier: string): string => {
  const target = join(dirname(from), specifier);
  if (target.endsWith(".d.ts")) return target;
  if (target.endsWith(".js")) return `${target.slice(0, -3)}.d.ts`;
  if (target.endsWith(".mjs")) return `${target.slice(0, -4)}.d.mts`;
  // Declaration emit keeps source .ts specifiers, which TypeScript resolves to the .d.ts.
  if (target.endsWith(".ts")) return `${target.slice(0, -3)}.d.ts`;
  if (target.endsWith(".mts")) return `${target.slice(0, -4)}.d.mts`;
  return `${target}.d.ts`;
};

export function checkDtsGraph(
  entry: string,
  read: (path: string) => string | undefined,
  allowedPeers: readonly string[],
): GraphViolation[] {
  const violations: GraphViolation[] = [];
  const seen = new Set<string>([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const source = read(file);
    if (source === undefined) {
      violations.push({ file, specifier: "(missing)" });
      continue;
    }
    for (const { specifier } of scanSpecifiers(source)) {
      if (!isRelative(specifier)) {
        if (!allowedPeers.includes(specifier)) violations.push({ file, specifier });
        continue;
      }
      const target = declarationPath(file, specifier);
      if (read(target) === undefined) {
        violations.push({ file, specifier: `${specifier} (unresolved)` });
      } else if (!seen.has(target)) {
        seen.add(target);
        queue.push(target);
      }
    }
  }
  return violations;
}

const ENTRY_PEERS: Record<string, string[]> = {
  ".": [],
  "./testing": [],
  "./openai": ["openai"],
  "./compat": ["openai"],
  "./deepseek": ["openai"],
  "./qwen": ["openai"],
  "./anthropic": ["@anthropic-ai/sdk"],
};

export function checkEntryPeers(subpath: string): string[] | undefined {
  return ENTRY_PEERS[subpath];
}

const ALLOWED_PEERS = ["openai", "@anthropic-ai/sdk"];
const LIFECYCLE_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "preuninstall",
  "uninstall",
  "postuninstall",
  "preprepare",
  "prepare",
  "postprepare",
  "prepublish",
  "prepublishOnly",
  "prepack",
  "postpack",
  "publish",
  "postpublish",
  "preversion",
  "version",
  "postversion",
  "dependencies",
];
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

export function checkManifest(pkg: Record<string, unknown>): string[] {
  const v: string[] = [];
  for (const key of [
    "dependencies",
    "optionalDependencies",
    "bundleDependencies",
    "bundledDependencies",
  ]) {
    if (key in pkg) v.push(key);
  }

  const peers = record(pkg.peerDependencies);
  const meta = record(pkg.peerDependenciesMeta);
  for (const name of Object.keys(peers)) {
    if (!ALLOWED_PEERS.includes(name)) v.push(`peer not allowed: ${name}`);
    if (record(meta[name]).optional !== true) v.push(`peer not optional: ${name}`);
  }

  const trusted = pkg.trustedDependencies;
  if (!Array.isArray(trusted) || trusted.length > 0) v.push("trustedDependencies must be []");
  if (pkg.type !== "module") v.push("type must be module");
  if (pkg.sideEffects !== false) v.push("sideEffects must be false");
  if (JSON.stringify(pkg.files) !== '["dist"]') v.push('files must be ["dist"]');
  if (record(pkg.engines).node !== ">=22") v.push("engines.node must be >=22");
  if (record(pkg.publishConfig).access !== "public") v.push("publishConfig.access must be public");

  const exportsField = pkg.exports;
  if (typeof exportsField !== "object" || exportsField === null || Array.isArray(exportsField)) {
    v.push("exports must be an object");
  } else {
    for (const [subpath, value] of Object.entries(exportsField)) {
      const entry = record(value);
      const at = `exports[${subpath}]`;
      for (const condition of Object.keys(entry)) {
        if (condition !== "types" && condition !== "default") {
          v.push(`${at}: unexpected condition ${condition}`);
        }
      }
      if (Object.keys(entry)[0] !== "types") v.push(`${at}: types must be the first condition`);
      if (entry.types === undefined) v.push(`${at}: missing types`);
      else if (!/^\.\/dist\/.+\.d\.ts$/.test(String(entry.types))) {
        v.push(`${at}: types must be ./dist/**.d.ts`);
      }
      if (entry.default === undefined) v.push(`${at}: missing default`);
      else if (!/^\.\/dist\/.+\.js$/.test(String(entry.default))) {
        v.push(`${at}: default must be ./dist/**.js`);
      }
    }
  }

  const scripts = record(pkg.scripts);
  for (const name of LIFECYCLE_SCRIPTS) {
    if (name in scripts) v.push(`lifecycle script: ${name}`);
  }

  for (const [name, range] of Object.entries(record(pkg.devDependencies))) {
    if (!EXACT_VERSION.test(String(range))) v.push(`devDependency not exact: ${name}`);
  }
  return v;
}

export function findBannedTerms(text: string, terms: readonly string[]): string[] {
  const lower = text.toLowerCase();
  return terms.filter((term) => lower.includes(term.toLowerCase()));
}

const normalizeWorkflow = (text: string): string =>
  text
    .split("\n")
    .filter((line) => !/^\s*runs-on:/.test(line))
    .map((line) => line.replace(/(uses:\s*)https:\/\/github\.com\//, "$1"))
    .join("\n")
    .trimEnd();

export function workflowsDiffer(a: string, b: string): boolean {
  return normalizeWorkflow(a) !== normalizeWorkflow(b);
}

// Credential shapes that must never be committed. Kept specific to avoid flagging prose.
const SECRET_PATTERNS: [name: string, pattern: RegExp][] = [
  ["anthropic key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai key", /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["npm auth config", /_auth(?:Token)?\s*=/],
  ["github token", /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{22,})\b/],
  ["aws access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["bearer token", /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/],
];

export function findSecrets(text: string): string[] {
  return SECRET_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

// ---------- Recorded fixtures ----------

export const MAX_FIXTURE_BYTES = 2_000_000;

// Account and request identifiers that must be null in a committed fixture.
export const FORBIDDEN_FIXTURE_KEYS: readonly string[] = [
  "user",
  "safety_identifier",
  "prompt_cache_key",
  "conversation",
  "metadata",
  "access_programs",
  "prompt_cache_diagnostics",
  "inference_geo",
  "service_tier",
  "requestID",
  "workspaceID",
  "request_id",
  "organization",
  "openai-organization",
  "openai-project",
  "anthropic-organization-id",
  "x-request-id",
  "request-id",
];

// Provider id shapes. A scrubbed id keeps its prefix and continues with "fixture".
export const FIXTURE_ID_PATTERN: RegExp =
  /\b(?:resp|msg|toolu|srvtoolu|call|fc|rs|req|chatcmpl|wrkspc|org|proj)[_-][A-Za-z0-9]{6,}/g;
const OPAQUE = /^[A-Za-z0-9+/=_-]{24,}$/;
const OPAQUE_EXEMPT_KEYS = new Set(["model", "type", "object", "name", "kind"]);

const isPlaceholder = (value: string): boolean => value.includes("fixture");

function walkFixture(value: unknown, path: string, key: string, hits: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => {
      walkFixture(item, `${path}[${i}]`, key, hits);
    });
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      const at = path === "" ? k : `${path}.${k}`;
      if (FORBIDDEN_FIXTURE_KEYS.includes(k) && v !== null && v !== undefined) {
        hits.push(`forbidden key at ${at}`);
        continue;
      }
      walkFixture(v, at, k, hits);
    }
    return;
  }
  if (typeof value !== "string") return;
  for (const match of value.matchAll(FIXTURE_ID_PATTERN)) {
    if (!isPlaceholder(match[0])) hits.push(`unscrubbed id ${match[0]} at ${path}`);
  }
  if (
    !OPAQUE_EXEMPT_KEYS.has(key) &&
    OPAQUE.test(value) &&
    /\d/.test(value) &&
    /[A-Za-z]/.test(value) &&
    !isPlaceholder(value)
  ) {
    hits.push(`opaque token at ${path}`);
  }
}

/** Everything in a fixture file that looks like a secret, an account field or a raw id. */
export function findFixtureLeaks(text: string): string[] {
  const leaks: string[] = [];
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > MAX_FIXTURE_BYTES) leaks.push(`file is ${bytes} bytes, over ${MAX_FIXTURE_BYTES}`);
  try {
    parseFixture(text);
  } catch (error) {
    leaks.push(`invalid fixture: ${(error as Error).message}`);
  }
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    const at = `line ${i + 1}`;
    for (const name of findSecrets(line)) leaks.push(`${at}: ${name}`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    const hits: string[] = [];
    walkFixture(parsed, "", "", hits);
    const record = parsed as { kind?: unknown; error?: { headers?: unknown } };
    if (record.kind === "error") {
      const headers = record.error?.headers;
      for (const name of Object.keys(
        typeof headers === "object" && headers !== null ? headers : {},
      )) {
        if (!ALLOWED_HEADERS.includes(name)) hits.push(`header not allowlisted: ${name}`);
      }
    }
    for (const hit of hits) leaks.push(`${at}: ${hit}`);
  });
  return leaks;
}

/** Every case has a file in each provider directory present; opt-in cases may be absent. */
export function checkFixtureCoverage(
  present: Readonly<Record<string, readonly string[]>>,
  expected: Readonly<Record<string, readonly string[]>>,
  optIn: readonly string[],
): string[] {
  const problems: string[] = [];
  for (const [provider, files] of Object.entries(present)) {
    const cases = expected[provider];
    if (cases === undefined) {
      problems.push(`unknown provider directory ${provider}`);
      continue;
    }
    for (const id of cases) {
      if (!optIn.includes(id) && !files.includes(`${id}.jsonl`)) {
        problems.push(`${provider}: missing ${id}`);
      }
    }
    for (const name of files) {
      if (!cases.includes(name.replace(/\.jsonl$/, "")) || !name.endsWith(".jsonl")) {
        problems.push(`${provider}: unknown file ${name}`);
      }
    }
  }
  return problems;
}

/** Replaces every credential-shaped substring with `[scrubbed]`. */
export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce(
    (out, [, pattern]) => out.replace(new RegExp(pattern.source, "g"), "[scrubbed]"),
    text,
  );
}
