import { describe, expect, test } from "bun:test";
import { stripsTypesByDefault } from "../scripts/node-version.ts";

describe("stripsTypesByDefault", () => {
  test("Node 22.18 and later strip types without a flag", () => {
    expect(stripsTypesByDefault("22.18.0")).toBe(true);
    expect(stripsTypesByDefault("22.23.5")).toBe(true);
    expect(stripsTypesByDefault("23.6.0")).toBe(true);
    expect(stripsTypesByDefault("24.0.0")).toBe(true);
    expect(stripsTypesByDefault("26.2.0")).toBe(true);
  });

  test("older releases don't", () => {
    expect(stripsTypesByDefault("22.17.1")).toBe(false);
    expect(stripsTypesByDefault("22.0.0")).toBe(false);
    expect(stripsTypesByDefault("23.5.9")).toBe(false);
    expect(stripsTypesByDefault("20.19.0")).toBe(false);
  });

  test("tolerates a leading v and rejects garbage", () => {
    expect(stripsTypesByDefault("v22.18.0")).toBe(true);
    expect(stripsTypesByDefault("")).toBe(false);
    expect(stripsTypesByDefault("x.y.z")).toBe(false);
  });
});
