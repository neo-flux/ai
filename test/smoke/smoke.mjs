// Runs unchanged on Node and Deno. Static imports only, so Deno needs no permissions.

import * as root from "../../dist/index.js";
import pkg from "../../package.json" with { type: "json" };

const entries = { ".": ["./dist/index.js", root] };

const runtime =
  typeof globalThis.Deno === "undefined"
    ? `node ${globalThis.process.version}`
    : `deno ${globalThis.Deno.version.deno}`;
const fail = (message) => {
  throw new Error(`smoke (${runtime}): ${message}`);
};

const exported = Object.keys(pkg.exports).sort();
const imported = Object.keys(entries).sort();
if (JSON.stringify(exported) !== JSON.stringify(imported)) {
  fail(`package.json exports ${exported.join(", ")} but smoke imports ${imported.join(", ")}`);
}
for (const [subpath, [target, namespace]] of Object.entries(entries)) {
  if (pkg.exports[subpath].default !== target)
    fail(`${subpath} points at ${pkg.exports[subpath].default}`);
  if (namespace[Symbol.toStringTag] !== "Module") fail(`${subpath} did not load as a module`);
}

console.log(`ok ${runtime}`);
