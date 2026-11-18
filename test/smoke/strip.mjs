// Imports src/ directly, so Node's type stripping proves the source is erasable TypeScript.
import * as deepseek from "../../src/deepseek/index.ts";
import * as root from "../../src/index.ts";
import * as openai from "../../src/openai/index.ts";
import * as testing from "../../src/testing/index.ts";
import { check, checkDeepSeek, checkOpenAI } from "./check.mjs";

await check(root, testing);
await checkDeepSeek(root, testing, deepseek);
await checkOpenAI(root, testing, openai);
console.log(`ok node ${process.version} (src, type stripping)`);
