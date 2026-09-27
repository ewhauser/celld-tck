import { Effect, Schema } from "effect";
import { decodeAs } from "./Artifacts.js";
import { equal } from "./Oracle.js";
import { TckError } from "./Domain.js";
const UpgradeState = Schema.Struct({
  activation: Schema.NonEmptyString,
  root: Schema.Unknown,
  facet: Schema.Unknown,
  r2: Schema.Unknown,
});
export const checkUpgradeState = (
  value: unknown,
  stage: "legacy" | "migrated" | "advanced",
  previousActivation?: string,
) =>
  Effect.gen(function* () {
    const state = yield* decodeAs(UpgradeState, "assertion")(value);
    if (state.activation === previousActivation)
      return yield* Effect.fail(
        new TckError({
          phase: "assertion",
          message: "Upgrade did not replace the Durable Object activation",
        }),
      );
    yield* equal(state.root, "root λ");
    yield* equal(state.r2, {
      withoutSlash: "legacy λ",
      withSlash: stage === "legacy" ? "legacy λ" : null,
      keys: ["photos"],
    });
    yield* equal(state.facet, {
      balance: stage === "advanced" ? 20 : 10,
      rows: [
        { id: 1, value: "facet λ" },
        ...(stage === "advanced" ? [{ id: 2, value: "after migration" }] : []),
      ],
    });
    return state;
  });
