import { Effect } from "effect";
import { operation, platform, rejection } from "../core/Platform.js";

// Fixture operations only. The driver checks rejection, state, and recovery.
export const durabilityOperation = (
  ctx: DurableObjectState,
  path: string,
  retain: (cursor: ReturnType<SqlStorage["exec"]>) => void,
  witness: () => Promise<Response>,
) =>
  Effect.gen(function* () {
    if (!path.startsWith("/durability/")) return undefined;
    const storage = ctx.storage;
    if (path === "/durability/witness-write") {
      storage.kv.put("witness", (storage.kv.get<number>("witness") ?? 0) + 1);
      return Response.json({ recorded: true });
    }
    if (path === "/durability/witness-read")
      return Response.json({ count: storage.kv.get<number>("witness") ?? 0 });
    const rows = () =>
      storage.sql.exec("SELECT n FROM durability ORDER BY n").toArray();
    if (path === "/durability/seed") {
      storage.sql.exec("CREATE TABLE IF NOT EXISTS durability (n INTEGER)");
      storage.sql.exec("DELETE FROM durability").toArray();
      storage.sql.exec("INSERT INTO durability VALUES (1)").toArray();
      yield* platform(() =>
        storage.put("durable", "before", { allowUnconfirmed: true }),
      );
      yield* platform(() => storage.sync());
      return Response.json({ rows: rows(), value: storage.kv.get("durable") });
    }
    if (path === "/durability/state")
      return Response.json({ rows: rows(), value: storage.kv.get("durable") });
    if (path === "/durability/sync-unconfirmed") {
      yield* platform(() =>
        storage.put("durable", "after", { allowUnconfirmed: true }),
      );
      // Isolate the explicit barrier: an ordinary SQL write would close the
      // output gate and could hide a sync() implementation that resolves early.
      yield* platform(() => storage.sync()).pipe(
        Effect.mapError(
          (error) =>
            new Error(
              `tck-sync-rejected: ${error instanceof Error ? error.message : String(error)}`,
            ),
        ),
      );
      return Response.json({ synced: true });
    }
    // Leaves an explicit durability barrier outstanding for the driver's fault
    // window. Observation only: the driver classifies the outcome.
    if (path === "/durability/pending-sync") {
      const started = Date.now();
      yield* platform(() =>
        storage.put("durable", "pending", { allowUnconfirmed: true }),
      );
      const error = yield* rejection(platform(() => storage.sync()));
      return Response.json({
        revision: "qualification-v1",
        rejected: error !== "accepted",
        outcome: error,
        elapsedMs: Date.now() - started,
        value: storage.kv.get("durable"),
      });
    }
    if (path === "/durability/sync") {
      yield* platform(() =>
        storage.put("durable", "after", { allowUnconfirmed: true }),
      );
      storage.sql.exec("INSERT INTO durability VALUES (2)").toArray();
      yield* platform(() => storage.sync());
      return Response.json({ rows: rows(), value: storage.kv.get("durable") });
    }
    if (path === "/durability/sync-transaction") {
      const result = yield* platform(() =>
        storage.transaction((tx) =>
          // oxlint-disable-next-line effect/effect-run-in-body -- Durable Object transaction callbacks require a Promise.
          Effect.runPromise(
            Effect.gen(function* () {
              storage.sql.exec("INSERT INTO durability VALUES (99)").toArray();
              const error = yield* rejection(platform(() => storage.sync()));
              tx.rollback();
              return error;
            }),
          ),
        ),
      );
      return Response.json({ rejected: result !== "accepted", rows: rows() });
    }
    if (path === "/durability/transaction-deadline") {
      yield* platform(() =>
        storage.transaction(() =>
          // oxlint-disable-next-line effect/effect-run-in-body -- Durable Object transaction callbacks require a Promise.
          Effect.runPromise(
            Effect.gen(function* () {
              storage.sql.exec("INSERT INTO durability VALUES (99)").toArray();
              yield* Effect.sleep("40 seconds");
            }),
          ),
        ),
      );
      return Response.json({ unexpectedSuccess: true });
    }
    if (path === "/durability/gate-deadline") {
      yield* platform(() =>
        ctx.blockConcurrencyWhile(() =>
          // oxlint-disable-next-line effect/effect-run-in-body -- Platform gate callback requires a Promise.
          Effect.runPromise(Effect.sleep("40 seconds")),
        ),
      );
      return Response.json({ unexpectedSuccess: true });
    }
    if (
      path === "/durability/write-cursor-response" ||
      path === "/durability/write-cursor-outbound"
    ) {
      const cursor = storage.sql.exec(
        "INSERT INTO durability VALUES (2), (3) RETURNING n",
      );
      const first = cursor.next().value;
      retain(cursor);
      if (path.endsWith("outbound")) yield* platform(witness);
      return Response.json({ unexpectedSuccess: true, first });
    }
    if (path === "/durability/consumed-cursor-outbound") {
      storage.sql.exec("UPDATE durability SET n = n RETURNING n").toArray();
      const response = yield* platform(witness);
      return Response.json({ status: response.status });
    }
    if (path === "/durability/write-cursor-sync") {
      const cursor = storage.sql.exec(
        "INSERT INTO durability VALUES (2), (3) RETURNING n",
      );
      const first = cursor.next().value;
      const error = yield* rejection(platform(() => storage.sync()));
      // Retain the cursor across the barrier; a finalized cursor is not this case.
      const remaining = yield* operation(() => cursor.toArray());
      return Response.json({
        first,
        rejected: error !== "accepted",
        remaining,
      });
    }
    return new Response("Unknown durability operation", { status: 404 });
  });
