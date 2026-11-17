import { describe, expect, test } from "bun:test";
import { applyMutant } from "../scripts/mutate.ts";

const mutant = (find: string, replace: string) => ({
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
