import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyMutant,
  classify,
  loadMutants,
  MUTATING_ENV,
  type Mutant,
  preflight,
  summarize,
  validateMutants,
} from "../scripts/mutate.ts";

const mutant = (find: string, replace: string): Mutant => ({
  id: "T1",
  file: "x.ts",
  description: "test",
  find,
  replace,
});

describe("applyMutant", () => {
  test("replaces exactly one occurrence", () => {
    expect(applyMutant("a === b;\nc;", mutant("===", "!=="))).toBe("a !== b;\nc;");
  });

  test("throws when the find string is absent", () => {
    expect(() => applyMutant("a;", mutant("zz", "yy"))).toThrow("T1: find matches 0 times");
  });

  test("throws when the find string matches more than once", () => {
    expect(() => applyMutant("a; a;", mutant("a;", "b;"))).toThrow("T1: find matches 2 times");
  });

  test("throws when the replacement changes nothing", () => {
    expect(() => applyMutant("a;", mutant("a;", "a;"))).toThrow("T1: replace equals find");
  });
});

describe("validateMutants", () => {
  test("accepts a well-formed list", () => {
    expect(validateMutants([mutant("a", "b")])).toEqual([]);
  });

  test("rejects an empty list", () => {
    expect(validateMutants([])).toEqual(["no mutants"]);
  });

  test("rejects a non-array", () => {
    expect(validateMutants({})).toEqual(["mutants must be an array"]);
  });

  test("rejects duplicate ids", () => {
    expect(validateMutants([mutant("a", "b"), mutant("c", "d")])).toEqual(["duplicate id T1"]);
  });

  test("rejects missing fields", () => {
    expect(validateMutants([{ id: "X", file: "f", find: "a", replace: "b" }])).toEqual([
      "mutant 0: description must be a string",
    ]);
  });
});

describe("classify", () => {
  test("a passing suite means the mutant survived", () => {
    expect(classify(0, false)).toBe("survived");
  });

  test("a failing suite means the mutant was killed", () => {
    expect(classify(1, false)).toBe("killed");
  });

  test("a timeout is reported as such", () => {
    expect(classify(null, true)).toBe("timeout");
  });

  test("a signal without a timeout is an error, not a kill", () => {
    expect(classify(null, false)).toBe("error");
  });
});

describe("preflight", () => {
  test("passes on a clean tree with a green baseline", () => {
    expect(preflight("", 0)).toBeUndefined();
  });

  test("refuses with uncommitted changes", () => {
    expect(preflight(" M scripts/guards.ts\n", 0)).toContain("uncommitted changes");
  });

  test("refuses when the baseline fails", () => {
    expect(preflight("", 1)).toBe("the test suite fails without mutants");
    expect(preflight("", null)).toBe("the test suite fails without mutants");
  });
});

describe("summarize", () => {
  test("succeeds only when every mutant is killed or timed out", () => {
    expect(summarize(["killed", "timeout"])).toBe(0);
  });

  for (const bad of ["survived", "invalid", "error"] as const) {
    test(`fails on ${bad}`, () => {
      expect(summarize(["killed", bad])).toBe(1);
    });
  }

  test("fails on an empty run", () => {
    expect(summarize([])).toBe(1);
  });
});

describe("loadMutants", () => {
  const a = JSON.stringify([mutant("x", "y")]);
  const b = JSON.stringify([{ ...mutant("p", "q"), id: "T2" }]);

  test("concatenates every file", () => {
    const files: Record<string, string> = { "a.json": a, "b.json": b };
    const { mutants, errors } = loadMutants(["a.json", "b.json"], (p) => files[p] as string);
    expect(errors).toEqual([]);
    expect(mutants.map((m) => m.id)).toEqual(["T1", "T2"]);
  });

  test("rejects duplicate ids across files", () => {
    const { errors } = loadMutants(["a.json", "b.json"], () => a);
    expect(errors).toEqual(["duplicate id T1"]);
  });

  test("reports which file is invalid", () => {
    const files: Record<string, string> = { "a.json": a, "bad.json": "[]", "broken.json": "{" };
    const { errors } = loadMutants(
      ["a.json", "bad.json", "broken.json"],
      (p) => files[p] as string,
    );
    expect(errors[0]).toBe("bad.json: no mutants");
    expect(errors[1]).toStartWith("broken.json: ");
    expect(errors).toHaveLength(2);
  });

  test("rejects no files", () => {
    expect(loadMutants([], () => a).errors).toEqual(["no mutants files"]);
  });
});

describe("test/mutants", () => {
  const root = join(import.meta.dir, "..");
  const files = readdirSync(join(root, "test/mutants"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => `test/mutants/${f}`)
    .sort();
  const { mutants, errors } = loadMutants(files, (p) => readFileSync(join(root, p), "utf8"));

  test("every file is valid and ids are unique across files", () => {
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(errors).toEqual([]);
    expect(mutants.length).toBeGreaterThanOrEqual(50);
  });

  test("bun run mutate runs every file", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const args = String(pkg.scripts.mutate)
      .split(/\s+/)
      .filter((a) => a.endsWith(".json"));
    expect(args.sort()).toEqual(files);
  });

  // While a mutant is applied its own find string is gone, which would fail this test and
  // count as a kill for every mutant. So it only runs outside mutation runs.
  test.skipIf(process.env[MUTATING_ENV] === "1")("every mutant applies to the current code", () => {
    for (const m of mutants) {
      expect(() => applyMutant(readFileSync(join(root, m.file), "utf8"), m)).not.toThrow();
    }
  });
});
