import { Effect, Schema } from "effect";
import { TckError } from "./Domain.js";
export const StorageEvent = Schema.Struct({
  mode: Schema.String,
  path: Schema.String,
  method: Schema.String,
  upstreamStatus: Schema.optionalKey(Schema.Int),
  dropped: Schema.optionalKey(Schema.Boolean),
});
export const hasStorageFaultEvidence = (
  events: readonly (typeof StorageEvent.Type)[],
  mode: string,
  cell: string,
) =>
  events.some(
    (event) =>
      event.mode === mode &&
      (event.path.includes(`/cells/Recovery:${cell}/ltx/`) ||
        event.path.includes(`/cells/Recovery%3A${cell}/ltx/`)) &&
      (mode !== "drop-response" ||
        (event.method === "PUT" &&
          event.upstreamStatus === 200 &&
          event.dropped === true)),
  );
export const SocketOutcome = Schema.Struct({
  /** Frames observed before the owner was killed. */
  received: Schema.Int,
  /** Frames observed after the kill; a lost owner cannot keep serving. */
  receivedAfterKill: Schema.Int,
  closed: Schema.Boolean,
  clean: Schema.Boolean,
  code: Schema.Int,
});
/**
 * celld documents that a WebSocket transport cannot move to a new cell owner
 * and that the client must reconnect. Every held socket must therefore end,
 * without a client-initiated close and without serving another frame, and the
 * reconnection must land on a new activation of the same cell.
 */
export const checkSocketFailover = (value: {
  readonly sockets: readonly (typeof SocketOutcome.Type)[];
  readonly beforeActivation: string;
  readonly afterActivation: string;
  readonly reconnectCounter: number;
}) =>
  Effect.gen(function* () {
    if (value.sockets.length === 0)
      return yield* fail("No sockets were held across the ownership change");
    for (const socket of value.sockets) {
      if (socket.received < 1)
        return yield* fail("A held socket never served a frame");
      if (!socket.closed)
        return yield* fail("A held socket survived the loss of its owner");
      if (socket.clean)
        return yield* fail(
          "A held socket reported a clean close after its owner was killed",
        );
      if (socket.receivedAfterKill !== 0)
        return yield* fail("A held socket served a frame after the kill");
      if (socket.code < 1000 || socket.code > 4999)
        return yield* fail(`Invalid close code ${socket.code}`);
    }
    if (value.beforeActivation === value.afterActivation)
      return yield* fail("Reconnection reused the killed activation");
    if (value.reconnectCounter !== 1)
      return yield* fail("Reconnected socket did not start a fresh exchange");
  });
const fail = (message: string) =>
  Effect.fail(
    new TckError({ phase: "qualification", message }),
  ) as Effect.Effect<never, TckError>;
export const checkWorkflowResult = (value: unknown) =>
  Schema.decodeUnknownEffect(
    Schema.Struct({
      status: Schema.Literal("complete"),
      output: Schema.Struct({
        first: Schema.Literal(1),
        last: Schema.Literal(1),
      }),
    }),
  )(value).pipe(Effect.asVoid);
