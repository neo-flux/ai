import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
// A minimal environment: no keys, no base URLs, so nothing can reach a provider.
const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
const run = (...args: string[]) => {
  const r = Bun.spawnSync(["bun", "scripts/record.ts", ...args], { cwd: root, env });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
};

describe("bun scripts/record.ts", () => {
  test("--dry-run prints the plan for every provider and exits without keys", () => {
    const r = run("--provider", "all", "--dry-run");
    expect(r.code).toBe(0);
    expect(r.out).toContain("openai text (");
    expect(r.out).toContain("deepseek error-reasoning-missing (");
    expect(r.out).not.toContain("error-context");
    expect(r.out.trim().split("\n").at(-1)).toBe("62 requests in total");
  });

  test("--include error-context adds one request per provider", () => {
    expect(run("--provider", "all", "--dry-run", "--include", "error-context").out).toContain(
      "66 requests in total",
    );
  });

  test("a real run refuses before sending anything when variables are missing", () => {
    const r = run("--provider", "deepseek");
    expect(r.code).toBe(2);
    expect(r.err).toContain(
      "missing environment variables: DEEPSEEK_API_KEY, NEOFLUX_AI_DEEPSEEK_BASE_URL",
    );
  });

  test("bad arguments exit 2 with the reason", () => {
    const r = run("--provider", "acme");
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown provider acme");
  });
});
