// Installs the packed tarball into a scratch project and imports it by package name on every
// supported runtime that isn't Bun, so exports resolution is exercised for real.
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAndPack, root, run } from "./pack.ts";

const work = mkdtempSync(join(tmpdir(), "neoflux-ai-smoke-"));
let ok = true;
try {
  const tgz = buildAndPack(work);
  const pkg = JSON.parse(run(["tar", "-xzOf", tgz, "package/package.json"])) as { version: string };
  run(["tar", "-xzf", tgz], work);
  mkdirSync(join(work, "node_modules/@neoflux"), { recursive: true });
  renameSync(join(work, "package"), join(work, "node_modules/@neoflux/ai"));
  writeFileSync(
    join(work, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies: { "@neoflux/ai": pkg.version } }),
  );
  copyFileSync(join(root, "test/smoke/smoke.mjs"), join(work, "smoke.mjs"));

  const runtimes: [name: string, args: string[]][] = [
    ["node", ["smoke.mjs"]],
    ["deno", ["run", "--no-prompt", "--node-modules-dir=manual", "smoke.mjs"]],
  ];
  for (const [name, args] of runtimes) {
    const path = Bun.which(name);
    if (path === null) {
      console.error(`${name} not found on PATH; install it to run the smoke test`);
      ok = false;
      continue;
    }
    const result = Bun.spawnSync([path, ...args], {
      cwd: work,
      stdout: "inherit",
      stderr: "inherit",
    });
    if (result.exitCode !== 0) {
      console.error(`failed: ${name} ${args.join(" ")}`);
      ok = false;
    }
  }
} catch (error) {
  console.error((error as Error).message);
  ok = false;
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
