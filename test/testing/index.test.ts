import { expect, test } from "bun:test";
import * as testing from "../../src/testing/index.ts";

test("@neoflux/ai/testing exports its helpers", () => {
  expect(Object.keys(testing).sort()).toEqual([
    "EventOrderError",
    "assertEventOrder",
    "checkEventOrder",
    "fakeAdapter",
    "parseFixture",
    "replayClient",
    "serializeFixture",
  ]);
});
