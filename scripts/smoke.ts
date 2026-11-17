// Builds dist/ and runs the same smoke file on every supported runtime that isn't Bun.
import { rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const smoke = "test/smoke/smoke.mjs";

const run = (cmd: string[]): boolean => {
  const result = Bun.spawnSync(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (result.exitCode !== 0) console.error(`failed: ${cmd.join(" ")}`);
  return result.exitCode === 0;
};

rmSync(join(root, "dist"), { recursive: true, force: true });
if (!run([join(root, "node_modules/.bin/tsc"), "-p", "tsconfig.build.json"])) process.exit(1);

const runtimes: [name: string, cmd: string[]][] = [
  ["node", [smoke]],
  ["deno", ["run", "--no-prompt", "--no-config", smoke]],
];
let ok = true;
for (const [name, args] of runtimes) {
  const path = Bun.which(name);
  if (path === null) {
    console.error(`${name} not found on PATH; install it to run the smoke test`);
    ok = false;
    continue;
  }
  ok = run([path, ...args]) && ok;
}
process.exit(ok ? 0 : 1);
