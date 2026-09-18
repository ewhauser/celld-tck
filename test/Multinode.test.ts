import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { checkHandoff } from "../src/Multinode.js";
it.effect("failover requires the successor and a strictly newer epoch", () =>
  Effect.gen(function* () {
    const before = { node: "celld" as const, epoch: 3 };
    yield* checkHandoff(before, { node: "celld2", epoch: 4 }, "celld2");
    for (const after of [
      { node: "celld" as const, epoch: 4 },
      { node: "celld2" as const, epoch: 3 },
      { node: "celld2" as const, epoch: 2 },
    ])
      expect(
        (yield* Effect.exit(checkHandoff(before, after, "celld2")))._tag,
      ).toBe("Failure");
  }),
);
