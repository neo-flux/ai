// Imports src/ directly, so Node's type stripping proves the source is erasable TypeScript.
import * as deepseek from "../../src/deepseek/index.ts";
import * as root from "../../src/index.ts";
import * as testing from "../../src/testing/index.ts";
import { check, checkDeepSeek } from "./check.mjs";

await check(root, testing);
await checkDeepSeek(root, testing, deepseek);
console.log(`ok node ${process.version} (src, type stripping)`);
