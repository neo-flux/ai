// Imports src/ directly, so Node's type stripping proves the source is erasable TypeScript.
import * as root from "../../src/index.ts";
import * as testing from "../../src/testing/index.ts";
import { check } from "./check.mjs";

await check(root, testing);
console.log(`ok node ${process.version} (src, type stripping)`);
