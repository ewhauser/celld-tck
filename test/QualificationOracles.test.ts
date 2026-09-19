import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import {
  checkSocketFailover,
  checkWorkflowResult,
  hasStorageFaultEvidence,
} from "../src/QualificationOracles.js";
it.effect(
  "socket failover requires a forced close on every held socket and a fresh activation",
  () =>
    Effect.gen(function* () {
      const socket = {
        received: 1,
        receivedAfterKill: 0,
        closed: true,
        clean: false,
        code: 1006,
      };
      const valid = {
        sockets: [socket, socket, socket],
        beforeActivation: "before",
        afterActivation: "after",
        reconnectCounter: 1,
      };
      yield* checkSocketFailover(valid);
      for (const invalid of [
        // No socket was actually held across the ownership change.
        { ...valid, sockets: [] },
        // A socket that never served a frame proves nothing was connected.
        { ...valid, sockets: [{ ...socket, received: 0 }] },
        // The transport survived the loss of its owner.
        { ...valid, sockets: [{ ...socket, closed: false }] },
        // A clean close would mean the owner handed the socket over.
        { ...valid, sockets: [{ ...socket, clean: true }] },
        // A frame after the kill would mean the killed owner still served.
        { ...valid, sockets: [{ ...socket, receivedAfterKill: 1 }] },
        { ...valid, sockets: [{ ...socket, code: 0 }] },
        // Reconnection landed on the killed activation, not a new one.
        { ...valid, afterActivation: "before" },
        // A resumed counter would mean the old socket's state leaked in.
        { ...valid, reconnectCounter: 2 },
      ])
        expect((yield* Effect.exit(checkSocketFailover(invalid)))._tag).toBe(
          "Failure",
        );
    }),
);
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
