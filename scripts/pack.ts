// Shared by pack-check and smoke: a clean build, then the tarball exactly as it would publish.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export const root: string = join(import.meta.dir, "..");
export const bin = (name: string): string => join(root, "node_modules/.bin", name);

export function run(cmd: string[], cwd: string = root): string {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const output = `${result.stdout}${result.stderr}`;
  if (result.exitCode !== 0) throw new Error(`$ ${cmd.join(" ")}\n${output}`);
  return output;
}

export function buildAndPack(destination: string): string {
  rmSync(join(root, "dist"), { recursive: true, force: true });
  run([bin("tsc"), "-p", "tsconfig.build.json"]);
  run(["bun", "pm", "pack", "--ignore-scripts", "--quiet", "--destination", destination]);
  const tarball = readdirSync(destination).find((f) => f.endsWith(".tgz"));
  if (tarball === undefined) throw new Error("bun pm pack produced no tarball");
  return join(destination, tarball);
}
