import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { checkRecovered } from "../src/Recovery.js";
const state = {
  activation: "new",
  retained: "durable λ",
  deleted: null,
  transaction: "committed",
  rows: [{ id: 1, value: "committed" }],
  fired: false,
};
it.effect(
  "recovery requires a new activation and exact acknowledged state",
  () =>
    Effect.gen(function* () {
      yield* checkRecovered("old", state, false);
      for (const corrupt of [
        { ...state, activation: "old" },
        { ...state, retained: null },
        { ...state, deleted: "remove" },
        { ...state, transaction: "rollback" },
        { ...state, rows: [...state.rows, { id: 2, value: "rollback" }] },
        { ...state, rows: [] },
        { ...state, fired: true },
      ])
        expect(
          (yield* Effect.exit(checkRecovered("old", corrupt, false)))._tag,
        ).toBe("Failure");
      expect(
        (yield* Effect.exit(checkRecovered("old", state, true)))._tag,
      ).toBe("Failure");
      yield* checkRecovered("old", { ...state, fired: true }, true);
    }),
);
