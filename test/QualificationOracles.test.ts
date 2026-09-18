import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  checkWorkflowResult,
  hasStorageFaultEvidence,
} from "../src/QualificationOracles.js";
it.effect(
  "workflow recovery requires the persisted first step's result, not just completion",
  () =>
    Effect.gen(function* () {
      yield* checkWorkflowResult({
        status: "complete",
        output: { first: 1, last: 1 },
      });
      for (const output of [
        null,
        {},
        { first: 2, last: 1 },
        { first: 1, last: 2 },
      ])
        expect(
          (yield* Effect.exit(
            checkWorkflowResult({ status: "complete", output }),
          ))._tag,
        ).toBe("Failure");
    }),
);
it.effect(
  "storage fault evidence must affect this cell's data and prove an actual lost successful response",
  () =>
    Effect.sync(() => {
      const valid = {
        mode: "drop-response",
        method: "PUT",
        path: "/tck/cells/Recovery:cell/ltx/object",
        upstreamStatus: 200,
        dropped: true,
      };
      expect(hasStorageFaultEvidence([valid], "drop-response", "cell")).toBe(
        true,
      );
      for (const invalid of [
        { ...valid, path: "/tck/nodes/cell.json" },
        { ...valid, path: "/tck/cells/Recovery:other/ltx/object" },
        { ...valid, path: "/tck/cells/Recovery:cell-extra/ltx/object" },
        { ...valid, upstreamStatus: 503 },
        { ...valid, dropped: false },
        { ...valid, method: "GET" },
        { ...valid, mode: "normal" },
      ])
        expect(
          hasStorageFaultEvidence([invalid], "drop-response", "cell"),
        ).toBe(false);
    }),
);
