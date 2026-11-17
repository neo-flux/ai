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

export type Result = "killed" | "timeout" | "survived" | "invalid" | "error";

// Set while a mutant is applied, so tests that check the mutants themselves can step aside.
export const MUTATING_ENV = "NEOFLUX_AI_MUTATING";

export function applyMutant(source: string, mutant: Mutant): string {
  if (mutant.find === mutant.replace) throw new Error(`${mutant.id}: replace equals find`);
  const count = source.split(mutant.find).length - 1;
  if (count !== 1) throw new Error(`${mutant.id}: find matches ${count} times`);
  return source.replace(mutant.find, () => mutant.replace);
}

export function validateMutants(mutants: unknown): string[] {
  if (!Array.isArray(mutants)) return ["mutants must be an array"];
  if (mutants.length === 0) return ["no mutants"];
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const [i, m] of mutants.entries()) {
    for (const key of ["id", "file", "description", "find", "replace"]) {
      if (typeof (m as Record<string, unknown>)?.[key] !== "string") {
        errors.push(`mutant ${i}: ${key} must be a string`);
      }
    }
    const id = (m as Record<string, unknown>)?.id;
    if (typeof id === "string") {
      if (ids.has(id)) errors.push(`duplicate id ${id}`);
      ids.add(id);
    }
  }
  return errors;
}

export function classify(exitCode: number | null, timedOut: boolean): Result {
  if (timedOut) return "timeout";
  if (exitCode === null) return "error";
  return exitCode === 0 ? "survived" : "killed";
}

export function preflight(
  dirtyStatus: string,
  baselineExitCode: number | null,
): string | undefined {
  if (dirtyStatus.trim() !== "") return `uncommitted changes in\n${dirtyStatus}`;
  if (baselineExitCode !== 0) return "the test suite fails without mutants";
  return undefined;
}

export function summarize(results: readonly Result[]): number {
  if (results.length === 0) return 1;
  return results.every((r) => r === "killed" || r === "timeout") ? 0 : 1;
}

const TEST_TIMEOUT_MS = 120_000;
const root = join(import.meta.dir, "..");

const runTests = (
  env: Record<string, string> = {},
): { exitCode: number | null; timedOut: boolean } => {
  const result = Bun.spawnSync(["bun", "test"], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "ignore",
    stderr: "ignore",
    timeout: TEST_TIMEOUT_MS,
  });
  return { exitCode: result.exitCode, timedOut: result.exitedDueToTimeout === true };
};

function main(path: string): number {
  const mutants = JSON.parse(readFileSync(path, "utf8")) as Mutant[];
  const errors = validateMutants(mutants);
  if (errors.length > 0) {
    console.error(`Invalid mutants file:\n${errors.join("\n")}`);
    return 2;
  }
  const files = [...new Set(mutants.map((m) => m.file))];

  const dirty = Bun.spawnSync(["git", "status", "--porcelain", "--", ...files], { cwd: root });
  const refusal = preflight(dirty.stdout.toString(), runTests().exitCode);
  if (refusal !== undefined) {
    console.error(`Refusing to run: ${refusal}`);
    return 2;
  }

  const originals = new Map(files.map((f) => [f, readFileSync(join(root, f), "utf8")]));
  let active: string | undefined;
  const restore = (): void => {
    if (active !== undefined) writeFileSync(join(root, active), originals.get(active) as string);
    active = undefined;
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"] as const) {
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
      const { exitCode, timedOut } = runTests({ [MUTATING_ENV]: "1" });
      rows.push({ mutant, result: classify(exitCode, timedOut), note: "" });
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

  const exitCode = summarize(rows.map((r) => r.result));
  const caught = rows.filter((r) => r.result === "killed" || r.result === "timeout").length;
  console.log(`\n${caught}/${rows.length} caught`);
  return exitCode;
}

if (import.meta.main) {
  const path = process.argv[2];
  if (path === undefined) {
    console.error("Usage: bun scripts/mutate.ts <mutants.json>");
    process.exit(2);
  }
  process.exit(main(path));
}
