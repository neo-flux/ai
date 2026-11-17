// Applies hand-written mutants one at a time and checks that the test suite catches each.
// Usage: bun scripts/mutate.ts <mutants.json>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface Mutant {
  id: string;
  file: string;
  description: string;
  find: string;
  replace: string;
}

type Result = "killed" | "timeout" | "survived" | "invalid";

export function applyMutant(source: string, mutant: Mutant): string {
  if (mutant.find === mutant.replace) throw new Error(`${mutant.id}: replace equals find`);
  const count = source.split(mutant.find).length - 1;
  if (count !== 1) throw new Error(`${mutant.id}: find matches ${count} times`);
  return source.replace(mutant.find, () => mutant.replace);
}

const TEST_TIMEOUT_MS = 120_000;
const root = join(import.meta.dir, "..");

const runTests = (): { exitCode: number | null; timedOut: boolean } => {
  const result = Bun.spawnSync(["bun", "test"], {
    cwd: root,
    stdout: "ignore",
    stderr: "ignore",
    timeout: TEST_TIMEOUT_MS,
  });
  return { exitCode: result.exitCode, timedOut: result.exitedDueToTimeout === true };
};

function main(path: string): number {
  const mutants = JSON.parse(readFileSync(path, "utf8")) as Mutant[];
  const files = [...new Set(mutants.map((m) => m.file))];

  const dirty = Bun.spawnSync(["git", "status", "--porcelain", "--", ...files], { cwd: root });
  if (dirty.stdout.toString().trim() !== "") {
    console.error(`Refusing to run: uncommitted changes in\n${dirty.stdout}`);
    return 2;
  }

  const baseline = runTests();
  if (baseline.exitCode !== 0) {
    console.error("Refusing to run: the test suite fails without mutants.");
    return 2;
  }

  const originals = new Map(files.map((f) => [f, readFileSync(join(root, f), "utf8")]));
  let active: string | undefined;
  const restore = (): void => {
    if (active !== undefined) writeFileSync(join(root, active), originals.get(active) as string);
    active = undefined;
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      restore();
      process.exit(130);
    });
  }

  const rows: { mutant: Mutant; result: Result; note: string }[] = [];
  for (const mutant of mutants) {
    let mutated: string;
    try {
      mutated = applyMutant(originals.get(mutant.file) as string, mutant);
    } catch (error) {
      rows.push({ mutant, result: "invalid", note: (error as Error).message });
      continue;
    }
    try {
      active = mutant.file;
      writeFileSync(join(root, mutant.file), mutated);
      const { exitCode, timedOut } = runTests();
      const result: Result = timedOut ? "timeout" : exitCode === 0 ? "survived" : "killed";
      rows.push({ mutant, result, note: "" });
    } finally {
      restore();
    }
    console.error(`${mutant.id} ${rows.at(-1)?.result}`);
  }

  const table = [
    "| ID | File | Mutation | Result |",
    "|---|---|---|---|",
    ...rows.map(
      ({ mutant, result, note }) =>
        `| ${mutant.id} | ${mutant.file} | ${mutant.description} | ${result}${note ? ` (${note})` : ""} |`,
    ),
  ].join("\n");
  console.log(table);
  mkdirSync(join(root, "reports"), { recursive: true });
  writeFileSync(join(root, "reports/mutants.md"), `${table}\n`);

  const failed = rows.filter((r) => r.result === "survived" || r.result === "invalid");
  console.log(`\n${rows.length - failed.length}/${rows.length} caught`);
  return failed.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  const path = process.argv[2];
  if (path === undefined) {
    console.error("Usage: bun scripts/mutate.ts <mutants.json>");
    process.exit(2);
  }
  process.exit(main(path));
}
