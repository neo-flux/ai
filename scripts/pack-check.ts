// Builds, packs, and checks the tarball exactly as it would be published.
// TODO: confirm the public repository URL (GitHub mirror org and repo), then add `repository` to package.json.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const root = join(import.meta.dir, "..");
const bin = (name: string): string => join(root, "node_modules/.bin", name);

const run = (cmd: string[]): string => {
  const result = Bun.spawnSync(cmd, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const output = `${result.stdout}${result.stderr}`;
  if (result.exitCode !== 0) {
    console.error(`$ ${cmd.join(" ")}\n${output}`);
    process.exit(1);
  }
  return output;
};

rmSync(join(root, "dist"), { recursive: true, force: true });
run([bin("tsc"), "-p", "tsconfig.build.json"]);

const out = mkdtempSync(join(tmpdir(), "neoflux-ai-pack-"));
try {
  run(["bun", "pm", "pack", "--ignore-scripts", "--quiet", "--destination", out]);
  const tarball = readdirSync(out).find((f) => f.endsWith(".tgz"));
  if (tarball === undefined) throw new Error("bun pm pack produced no tarball");
  const tgz = join(out, tarball);

  const packed = run(["tar", "-tzf", tgz])
    .split("\n")
    .filter((line) => line !== "" && !line.endsWith("/"))
    .sort();
  const dist = readdirSync(join(root, "dist"), { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => `package/${relative(root, join(e.parentPath, e.name))}`);
  const expected = ["package/LICENSE", "package/README.md", "package/package.json", ...dist].sort();
  if (JSON.stringify(packed) !== JSON.stringify(expected)) {
    console.error(
      `Tarball contents differ.\nExpected:\n${expected.join("\n")}\nGot:\n${packed.join("\n")}`,
    );
    process.exit(1);
  }
  console.log(`tarball: ${packed.length} files ok`);

  console.log(run([bin("publint"), "run", tgz, "--strict"]).trim());
  console.log(run([bin("attw"), tgz, "--profile", "esm-only"]).trim());
} finally {
  rmSync(out, { recursive: true, force: true });
}
