// Scrubs fixtures/.raw/<provider>/*.jsonl into fixtures/<provider>/. See docs/fixtures.md.
import { join } from "node:path";
import { scrubAll } from "./recorder/cli.ts";

const result = scrubAll(join(import.meta.dir, "..", "fixtures"));
for (const file of result.written) console.log(`scrubbed ${file}`);
for (const { file, error } of result.refused) console.error(`refused ${file}:\n${error}`);
console.log(`${result.written.length} written, ${result.refused.length} refused`);
process.exit(result.refused.length > 0 ? 1 : 0);
