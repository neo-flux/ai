// Copied into a scratch project that has the packed tarball in node_modules, then run unchanged
// on Node and Deno. Static imports by package name only, so Deno needs no permissions.
import * as root from "@neoflux/ai";
import * as testing from "@neoflux/ai/testing";
import { check } from "./check.mjs";
import pkg from "./node_modules/@neoflux/ai/package.json" with { type: "json" };

const entries = { ".": root, "./testing": testing };

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
for (const [subpath, namespace] of Object.entries(entries)) {
  if (namespace[Symbol.toStringTag] !== "Module") fail(`${subpath} did not load as a module`);
}
await check(root, testing).catch((error) => fail(error.message));

console.log(`ok ${runtime}`);
