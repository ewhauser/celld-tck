import { Effect } from "effect";
import { TckError, toTckError } from "./Domain.js";
// A single bounded protocol conversation with an owned native socket.
export const converse = (
  url: string,
  record: (name: string, value: unknown) => Effect.Effect<void, TckError>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const socket = yield* Effect.acquireRelease(
        Effect.sync(() => new WebSocket(url)),
        (socket) => Effect.sync(() => socket.close()),
      );
      const events: unknown[] = [];
      yield* Effect.callback<void, TckError>((resume) => {
        socket.binaryType = "arraybuffer";
        let step = 0;
        socket.onopen = () => {
          events.push({ type: "open" });
          socket.send("hello λ");
        };
        socket.onmessage = (event) => {
          events.push({
            type: "message",
            value:
              event.data instanceof ArrayBuffer
                ? [...new Uint8Array(event.data)]
                : event.data,
          });
          if (step++ === 0) socket.send(new Uint8Array([0, 128, 255]));
          else if (step === 2) socket.send("attachment");
          else socket.send("close");
        };
        socket.onerror = () =>
          resume(
            Effect.fail(
              new TckError({
                phase: "websocket",
                message: "WebSocket transport error",
              }),
            ),
          );
        socket.onclose = (event) => {
          events.push({
            type: "close",
            code: event.code,
            reason: event.reason,
            clean: event.wasClean,
          });
          resume(Effect.void);
        };
        return Effect.sync(() => {
          socket.onopen = null;
          socket.onmessage = null;
          socket.onerror = null;
          socket.onclose = null;
        });
      }).pipe(
        Effect.timeout("10 seconds"),
        Effect.ensuring(
          record(`websocket-${crypto.randomUUID()}.json`, { url, events }).pipe(
            Effect.orDie,
          ),
        ),
      );
      return events;
    }),
  ).pipe(Effect.mapError(toTckError("websocket")));
