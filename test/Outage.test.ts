import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { checkOutageState, type WriteOutcome } from "../src/Outage.js";
const outcomes: WriteOutcome[] = [
  { id: 1, acknowledged: true },
  { id: 2, acknowledged: false },
];
const state = (ids: number[]) => ({
  kv: ids.map((id) => [`op:${id}`, `value-${id}`] as const),
  sql: ids.map((id) => ({ id, value: `value-${id}` })),
});
it.effect("uncertain writes may be absent or complete, never partial", () =>
  Effect.gen(function* () {
    yield* checkOutageState(state([1]), outcomes);
    yield* checkOutageState(state([1, 2]), outcomes);
    for (const invalid of [
      state([]),
      state([2]),
      state([1, 2, 3]),
      state([1, 1]),
      { ...state([1]), kv: state([1, 2]).kv },
      { ...state([1]), sql: state([1, 2]).sql },
      { ...state([1]), sql: [{ id: 1, value: "corrupt" }] },
    ])
      expect(
        (yield* Effect.exit(checkOutageState(invalid, outcomes)))._tag,
      ).toBe("Failure");
  }),
);
it.effect("every acknowledged write must survive", () =>
  Effect.gen(function* () {
    expect(
      (yield* Effect.exit(
        checkOutageState(state([1]), [
          { id: 1, acknowledged: true },
          { id: 2, acknowledged: true },
        ]),
      ))._tag,
    ).toBe("Failure");
  }),
);
