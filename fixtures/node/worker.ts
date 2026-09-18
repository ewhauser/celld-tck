import { Effect } from "effect";
import { Buffer } from "node:buffer";
import { EventEmitter } from "node:events";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { gzipSync, gunzipSync, deflateSync, inflateSync } from "node:zlib";
import { platform } from "../core/Platform.js";
import core from "../core/worker.js";
export { Probe, Service, TestWorkflow } from "../core/worker.js";
export default {
  ...core,
  fetch(request: Request, env: Env) {
    return Effect.runPromise(
      Effect.gen(function* () {
        switch (new URL(request.url).pathname) {
          case "/node/buffer": {
            const buffer = Buffer.from("λ🌍", "utf8");
            return Response.json({
              hex: buffer.toString("hex"),
              base64: buffer.toString("base64"),
              roundTrip: Buffer.from(
                buffer.toString("base64"),
                "base64",
              ).toString("utf8"),
              slice: [...buffer.subarray(0, 2)],
            });
          }
          case "/node/path-events": {
            const emitter = new EventEmitter();
            const trace: string[] = [];
            emitter.once("event", (value) => trace.push("once:" + value));
            const listener = (value: string) => {
              trace.push("on:" + value);
            };
            emitter.on("event", listener);
            emitter.emit("event", "a");
            emitter.emit("event", "b");
            emitter.off("event", listener);
            emitter.emit("event", "c");
            return Response.json({
              path: posix.normalize("/a/../b/./c"),
              basename: posix.basename("/a/b.txt", ".txt"),
              trace,
              remaining: emitter.listenerCount("event"),
            });
          }
          case "/node/async-context": {
            const storage = new AsyncLocalStorage<string>();
            const inside = yield* platform(() =>
              storage.run("request", () =>
                Effect.runPromise(
                  Effect.gen(function* () {
                    yield* platform(() => Promise.resolve());
                    return storage.getStore();
                  }),
                ),
              ),
            );
            return Response.json({
              inside,
              outsideMissing: storage.getStore() === undefined,
            });
          }
          case "/node/hash-compression": {
            const bytes = Buffer.from("hello λ");
            return Response.json({
              sha256: createHash("sha256").update("abc").digest("hex"),
              gzip: gunzipSync(
                Buffer.from(
                  "1f8b08000000000002ffcb48cdc9c95738b71b00396394ce08000000",
                  "hex",
                ),
              ).toString(),
              gzipBytes: gzipSync(bytes).toString("base64"),
              deflate: inflateSync(
                Buffer.from("789ccb48cdc9c95738b71b000f2203be", "hex"),
              ).toString(),
              deflateBytes: deflateSync(bytes).toString("base64"),
            });
          }
          default:
            return yield* platform(() => core.fetch(request, env));
        }
      }),
    );
  },
} satisfies ExportedHandler<Env>;
