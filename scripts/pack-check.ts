// Builds, packs, and checks the tarball exactly as it would be published.
// TODO: confirm the public repository URL (GitHub mirror org and repo), then add `repository` to package.json.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { checkManifest } from "./guards.ts";
import { bin, buildAndPack, root, run } from "./pack.ts";

const out = mkdtempSync(join(tmpdir(), "neoflux-ai-pack-"));
try {
  const tgz = buildAndPack(out);

  const packed = run(["tar", "-tzf", tgz])
    .split("\n")
    .filter((line) => line !== "" && !line.endsWith("/"))
    .sort();
  const dist = readdirSync(join(root, "dist"), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => `package/${relative(root, join(e.parentPath, e.name))}`);
  const expected = ["package/LICENSE", "package/README.md", "package/package.json", ...dist].sort();
  if (JSON.stringify(packed) !== JSON.stringify(expected)) {
    throw new Error(
      `Tarball contents differ.\nExpected:\n${expected.join("\n")}\nGot:\n${packed.join("\n")}`,
    );
  }
  console.log(`tarball: ${packed.length} files ok`);

  // The manifest that ships can differ from the one in the repo, so check it too.
  const violations = checkManifest(JSON.parse(run(["tar", "-xzOf", tgz, "package/package.json"])));
  if (violations.length > 0) throw new Error(`Packed package.json:\n${violations.join("\n")}`);
  console.log("packed package.json ok");

  console.log(run([bin("publint"), "run", tgz, "--strict"]).trim());
  console.log(run([bin("attw"), tgz, "--profile", "esm-only"]).trim());
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
