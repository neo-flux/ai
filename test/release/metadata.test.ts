import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const read = (file: string): string => readFileSync(join(root, file), "utf8");
const pkg = JSON.parse(read("package.json")) as Record<string, unknown>;

describe("package metadata", () => {
  test("points at the public GitHub mirror", () => {
    expect(pkg.repository).toEqual({ type: "git", url: "git+https://github.com/neo-flux/ai.git" });
    expect(pkg.homepage).toBe("https://github.com/neo-flux/ai#readme");
    expect(pkg.bugs).toEqual({ url: "https://github.com/neo-flux/ai/issues" });
  });
});
