import { Deferred, Effect, Exit, Fiber, Schema } from "effect";
import { TckError } from "./Domain.js";
import { equal } from "./Oracle.js";
import type { QualificationContext } from "./Qualification.js";
const platform = <A>(f: (signal: AbortSignal) => PromiseLike<A>) =>
  Effect.tryPromise({
    try: (signal) => Promise.resolve(f(signal)),
    catch: (error) => new TckError({ phase: "stream", message: String(error) }),
  });
const Line = Schema.Struct({
  seq: Schema.Int,
  id: Schema.String,
  payload: Schema.String,
});
const readStream = (
  ctx: QualificationContext,
  after: number,
  limit: number,
  slow: boolean,
  padding = 0,
  onFirst?: Effect.Effect<void>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const controller = yield* Effect.acquireRelease(
        Effect.sync(() => new AbortController()),
        (controller) => Effect.sync(() => controller.abort()),
      );
      const response = yield* platform(() =>
        fetch(
          `${ctx.targets.celld.baseUrl}/stream?name=${ctx.name}&after=${after}&padding=${padding}`,
          { signal: controller.signal },
        ),
      );
      yield* equal(response.status, 200);
      const reader = yield* Effect.acquireRelease(
        Effect.sync(() => response.body!.getReader()),
        (reader) => platform(() => reader.cancel()).pipe(Effect.orDie),
      );
      const rows: Array<typeof Line.Type> = [];
      let pending = "";
      const decoder = new TextDecoder();
      while (rows.length < limit) {
        if (slow) yield* Effect.sleep("100 millis");
        const chunk = yield* platform(() => reader.read());
        if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        if (pending.length > 1024 * 1024)
          return yield* Effect.fail(
            new TckError({
              phase: "stream",
              message: "Unbounded stream buffer",
            }),
          );
        for (;;) {
          const newline = pending.indexOf("\n");
          if (newline < 0) break;
          const line = pending.slice(0, newline);
          pending = pending.slice(newline + 1);
          const decoded = yield* Schema.decodeUnknownEffect(
            Schema.fromJsonString(
              Schema.Struct({ ...Line.fields, padding: Schema.String }),
            ),
          )(line);
          yield* equal(decoded.padding, "x".repeat(padding));
          const { padding: _, ...row } = decoded;
          rows.push(row);
          if (rows.length === 1 && onFirst) yield* onFirst;
          if (rows.length === limit) return rows;
        }
      }
      return rows;
    }),
  ).pipe(Effect.timeout("45 seconds"));
export const runSocketOrStream = (id: string, ctx: QualificationContext) =>
  Effect.scoped(
    Effect.gen(function* () {
      if (id === "dependencies.hibernation") {
        const socket = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new WebSocket(
                `${ctx.targets.celld.baseUrl.replace("http:", "ws:")}/socket?name=${ctx.name}`,
              ),
          ),
          (socket) => Effect.sync(() => socket.close()),
        );
        yield* Effect.callback<void, TckError>((resume) => {
          socket.onopen = () => resume(Effect.void);
          socket.onerror = () =>
            resume(
              Effect.fail(
                new TckError({
                  phase: "websocket",
                  message: "Connection failed",
                }),
              ),
            );
        }).pipe(Effect.timeout("10 seconds"));
        const exchange = () =>
          Effect.callback<unknown, TckError>((resume) => {
            socket.onmessage = (event) =>
              resume(
                Schema.decodeUnknownEffect(
                  Schema.fromJsonString(Schema.Unknown),
                )(String(event.data)).pipe(
                  Effect.mapError(
                    (e) =>
                      new TckError({ phase: "decode", message: String(e) }),
                  ),
                ),
              );
            socket.onerror = () =>
              resume(
                Effect.fail(
                  new TckError({
                    phase: "websocket",
                    message: "Socket failed",
                  }),
                ),
              );
            socket.onclose = () =>
              resume(
                Effect.fail(
                  new TckError({
                    phase: "websocket",
                    message: "Socket closed during hibernation",
                  }),
                ),
              );
            socket.send("probe");
            return Effect.sync(() => {
              socket.onmessage = null;
              socket.onclose = null;
              socket.onerror = null;
            });
          }).pipe(
            Effect.timeout("10 seconds"),
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({
                  counter: Schema.Int,
                  activation: Schema.String,
                  message: Schema.String,
                }),
              ),
            ),
          );
        const before = yield* exchange();
        const owner = (yield* ctx.owner()).node;
        const evicted = yield* ctx.runtime.controls.evict(
          owner,
          ctx.identity.cell,
        );
        yield* ctx.artifacts.text("hibernation-evict.json", evicted.stdout);
        const after = yield* exchange();
        yield* equal(before.counter, 1);
        yield* equal(after.counter, 2);
        yield* equal(after.message, "probe");
        yield* equal(before.activation !== after.activation, true);
        yield* equal(socket.readyState, WebSocket.OPEN);
        return {
          before,
          after,
          remainedConnected: socket.readyState === WebSocket.OPEN,
        };
      }
      yield* equal(
        id === "dependencies.stream-reconnect" ||
          id === "capacity.slow-consumer",
        true,
      );
      for (let i = 0; i < 128; i++)
        yield* ctx.write().pipe(Effect.flatMap((ack) => equal(ack, true)));
      const expected = (yield* ctx.state()).map(({ kv: _, ...row }) => row);
      if (id === "capacity.slow-consumer") {
        const started = Date.now();
        const readers = yield* Effect.forEach(
          [0, 1, 2, 3],
          () => readStream(ctx, 0, 128, true, 65536),
          { concurrency: 4 },
        );
        for (const rows of readers) yield* equal(rows, expected);
        return {
          readers: readers.length,
          rows: expected.length,
          elapsedMs: Date.now() - started,
        };
      }
      const first = yield* readStream(ctx, 0, 16, true);
      const owner = (yield* ctx.owner()).node;
      // Keep an additional consumer live while killing the owner; retained cursor
      // only advances for fully parsed records from the first consumer.
      const entered = yield* Deferred.make<void>();
      const inFlight = yield* readStream(
        ctx,
        16,
        112,
        true,
        0,
        Deferred.succeed(entered, undefined).pipe(Effect.asVoid),
      ).pipe(Effect.exit, Effect.forkScoped);
      yield* Deferred.await(entered).pipe(Effect.timeout("10 seconds"));
      yield* ctx.crash(owner);
      const interrupted = yield* Fiber.join(inFlight);
      yield* equal(
        Exit.isFailure(interrupted) || interrupted.value.length < 112,
        true,
      );
      const rest = yield* readStream(ctx, first.at(-1)!.seq, 128, false);
      yield* equal([...first, ...rest], expected);
      yield* ctx.verify();
      return {
        beforeCrash: first.length,
        afterReconnect: rest.length,
        total: expected.length,
      };
    }),
  );
