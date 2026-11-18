import { expect, test } from "bun:test";
import type { StreamEvent } from "../../src/events.ts";
import type { Fixture } from "../../src/testing/fixture.ts";
import { checkEventOrder } from "../../src/testing/index.ts";
import { recordedRequest } from "./fixtures.ts";

type Client = { calls: readonly { params: unknown }[] };

export interface ReplaySuite {
  replayTest: (caseIds: readonly string[], title: string, fn: () => Promise<void>) => void;
  parity: (fixture: Fixture, client: Client, i: number) => void;
  registered: readonly string[];
}

/**
 * Replay test registry for one provider. Cases register when the file loads, so the coverage check
 * doesn't depend on test order or `-t` filters, and each registered case must call `parity`.
 */
export function replaySuite(
  normalize: (params: unknown, fixture: Fixture, index: number) => unknown,
): ReplaySuite {
  const registered: string[] = [];
  let checked = new Set<string>();
  const replayTest = (caseIds: readonly string[], title: string, fn: () => Promise<void>) => {
    registered.push(...caseIds);
    test(`${caseIds.join(", ")}: ${title}`, async () => {
      checked = new Set();
      await fn();
      for (const id of caseIds)
        expect({ id, parity: checked.has(id) }).toEqual({ id, parity: true });
    });
  };
  /** The adapter's request for call `i` equals the recorded one, after `normalize`. */
  const parity = (fixture: Fixture, client: Client, i: number) => {
    expect(client.calls.length).toBeGreaterThan(i);
    expect(normalize(client.calls[i]?.params, fixture, i)).toEqual(
      normalize(recordedRequest(fixture, i), fixture, i),
    );
    checked.add(fixture.meta.case);
  };
  return { replayTest, parity, registered };
}

export const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = [];
  for await (const e of checkEventOrder(it)) out.push(e);
  return out;
};

export const textOf = (events: StreamEvent[]): string =>
  events.map((e) => (e.type === "text-delta" ? e.text : "")).join("");
