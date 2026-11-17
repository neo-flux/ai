// Installs the packed tarball into a scratch project and imports it by package name on every
// supported runtime that isn't Bun, so exports resolution is exercised for real.
import { copyFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripsTypesByDefault } from "./node-version.ts";
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
  for (const file of ["smoke.mjs", "check.mjs"]) {
    copyFileSync(join(root, "test/smoke", file), join(work, file));
  }

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

  // Runs src/ directly on any Node that strips types by default, including the Node 22 CI leg.
  const node = Bun.which("node");
  if (node !== null) {
    const version = run([node, "-p", "process.versions.node"]).trim();
    if (stripsTypesByDefault(version)) {
      const result = Bun.spawnSync([node, "test/smoke/strip.mjs"], {
        cwd: root,
        stdout: "inherit",
        stderr: "inherit",
      });
      if (result.exitCode !== 0) {
        console.error("failed: node test/smoke/strip.mjs");
        ok = false;
      }
    } else {
      console.log(`skip: Node ${version} doesn't strip types by default (needs 22.18+)`);
    }
  }
} catch (error) {
  console.error((error as Error).message);
  ok = false;
} finally {
  rmSync(work, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
