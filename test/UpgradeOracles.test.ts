import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { checkUpgradeState } from "../src/UpgradeOracles.js";
const migrated = {
  activation: "new",
  root: "root λ",
  facet: { balance: 10, rows: [{ id: 1, value: "facet λ" }] },
  r2: { withoutSlash: "legacy λ", withSlash: null, keys: ["photos"] },
};
it.effect(
  "first-open migration preserves facet SQL, KV and root state without renaming a legacy R2 key",
  () =>
    Effect.gen(function* () {
      yield* checkUpgradeState(migrated, "migrated", "old");
      for (const bad of [
        { ...migrated, activation: "old" },
        { ...migrated, root: null },
        { ...migrated, facet: { error: "SQL error: no such table: entries" } },
        { ...migrated, facet: { ...migrated.facet, balance: null } },
        { ...migrated, facet: { ...migrated.facet, rows: [] } },
        {
          ...migrated,
          r2: {
            ...migrated.r2,
            withoutSlash: null,
            withSlash: "legacy λ",
            keys: ["photos/"],
          },
        },
        { ...migrated, r2: { ...migrated.r2, withSlash: "legacy λ" } },
      ])
        expect(
          (yield* Effect.exit(checkUpgradeState(bad, "migrated", "old")))._tag,
        ).toBe("Failure");
    }),
);
it.effect(
  "a migrated facet must persist new writes through the next restart",
  () =>
    Effect.gen(function* () {
      const advanced = {
        ...migrated,
        facet: {
          balance: 20,
          rows: [...migrated.facet.rows, { id: 2, value: "after migration" }],
        },
      };
      yield* checkUpgradeState(advanced, "advanced", "old");
      expect(
        (yield* Effect.exit(checkUpgradeState(migrated, "advanced", "old")))
          ._tag,
      ).toBe("Failure");
      yield* checkUpgradeState(
        { ...migrated, r2: { ...migrated.r2, withSlash: "legacy λ" } },
        "legacy",
      );
      expect(
        (yield* Effect.exit(checkUpgradeState(migrated, "legacy")))._tag,
      ).toBe("Failure");
    }),
);
