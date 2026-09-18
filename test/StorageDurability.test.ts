import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  checkSyncedState,
  checkCursorOutput,
  checkSyncRejection,
  checkDeadlineRecovery,
  checkTransactionSync,
  checkCursorSync,
  checkDeadline,
  checkOutageRecovery,
} from "../src/StorageDurability.js";

const verify = (
  check: (value: unknown) => Effect.Effect<unknown, unknown>,
  good: unknown,
  bad: unknown[],
) =>
  Effect.gen(function* () {
    yield* check(good);
    for (const value of bad)
      expect((yield* Effect.exit(check(value)))._tag).toBe("Failure");
  });
it.effect("sync recovery rejects lost SQL or KV writes", () =>
  verify(
    (value) => checkSyncedState(value, true),
    { rows: [{ n: 1 }, { n: 2 }], value: "after" },
    [
      { rows: [{ n: 1 }], value: "after" },
      { rows: [{ n: 1 }, { n: 2 }], value: "before" },
    ],
  ),
);
it.effect("sync in a transaction must reject and rollback", () =>
  verify(checkTransactionSync, { rejected: true, rows: [{ n: 1 }] }, [
    { rejected: false, rows: [{ n: 1 }] },
    { rejected: true, rows: [{ n: 1 }, { n: 99 }] },
  ]),
);
it.effect(
  "an unfinished write cursor must reject sync without losing remaining rows",
  () =>
    verify(
      checkCursorSync,
      { first: { n: 2 }, rejected: true, remaining: [{ n: 3 }] },
      [
        { first: { n: 2 }, rejected: false, remaining: [{ n: 3 }] },
        { first: { n: 2 }, rejected: true, remaining: [] },
      ],
    ),
);
it.effect(
  "transaction and gate deadlines require a timeout, not an arbitrary handler failure",
  () =>
    verify(
      checkDeadline,
      { rejected: true, message: "transaction timed out" },
      [
        { rejected: false, message: "transaction timed out" },
        { rejected: true, message: "unknown route" },
      ],
    ),
);
it.effect(
  "post-timeout recovery rejects an uncommitted transaction write",
  () =>
    verify(
      (value) => checkSyncedState(value, false),
      { rows: [{ n: 1 }], value: "before" },
      [{ rows: [{ n: 1 }, { n: 99 }], value: "before" }],
    ),
);
it.effect(
  "outage recovery allows uncertain writes but never loss or corruption of acknowledged state",
  () =>
    verify(checkOutageRecovery, { rows: [{ n: 1 }], value: "after" }, [
      { rows: [{ n: 1 }, { n: 2 }], value: "after" },
      { rows: [], value: "before" },
      { rows: [{ n: 2 }], value: "after" },
      { rows: [{ n: 1 }, { n: 1 }], value: "after" },
      { rows: [{ n: 1 }], value: "corrupt" },
    ]),
);

it.effect("cursor response and outbound boundaries reject leaked output", () =>
  verify(
    checkCursorOutput,
    {
      status: 500,
      body: { rejected: true, message: "uncommitted write cursor" },
      witness: { count: 1 },
    },
    [
      {
        status: 200,
        body: { rejected: true, message: "uncommitted write cursor" },
        witness: { count: 1 },
      },
      {
        status: 500,
        body: { rejected: true, message: "uncommitted write cursor" },
        witness: { count: 2 },
      },
      {
        status: 500,
        body: { rejected: true, message: "unrelated failure" },
        witness: { count: 1 },
      },
    ],
  ),
);
it.effect(
  "sync outage requires rejection by sync itself, not an output-gate error",
  () =>
    verify(
      checkSyncRejection,
      { rejected: true, message: "tck-sync-rejected: durability timeout" },
      [
        { rejected: true, message: "output gate durability timeout" },
        { rejected: false, message: "tck-sync-rejected: timeout" },
      ],
    ),
);
it.effect(
  "deadlines require the configured wait and a new activation with rolled-back state",
  () => {
    const good = {
      error: { rejected: true, message: "transaction timed out" },
      before: "old",
      after: "new",
      elapsedMs: 30000,
      recovered: { rows: [{ n: 1 }], value: "before" },
    };
    return verify(checkDeadlineRecovery, good, [
      { ...good, after: "old" },
      { ...good, elapsedMs: 10 },
      { ...good, elapsedMs: 46000 },
      { ...good, recovered: { rows: [{ n: 1 }, { n: 99 }], value: "before" } },
    ]);
  },
);
