import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
interface RecoveryEnv {
  PROBE: DurableObjectNamespace<Recovery>;
}
const platform = <A>(f: () => PromiseLike<A>) =>
  Effect.tryPromise({ try: () => Promise.resolve(f()), catch: (e) => e });
export class Recovery extends DurableObject<RecoveryEnv> {
  private readonly activation = crypto.randomUUID();
  alarm() {
    return Effect.runPromise(
      platform(() => this.ctx.storage.put("fired", true)),
    );
  }
  fetch(request: Request) {
    const storage = this.ctx.storage;
    const activation = this.activation;
    return Effect.runPromise(
      Effect.gen(function* () {
        const path = new URL(request.url).pathname;
        if (path === "/ready") return Response.json({ ready: true });
        if (path === "/seed") {
          yield* platform(() =>
            storage.put({
              retained: "durable λ",
              deleted: "remove",
              fired: false,
            }),
          );
          yield* platform(() => storage.delete("deleted"));
          yield* Effect.sync(() => {
            storage.sql.exec(
              "CREATE TABLE IF NOT EXISTS records (id INTEGER PRIMARY KEY, value TEXT)",
            );
            storage.transactionSync(() => {
              storage.sql.exec("INSERT INTO records VALUES (1, 'committed')");
              storage.kv.put("transaction", "committed");
            });
          });
          // Roll back both stores in one transaction, then check again after restart.
          yield* Effect.try({
            try: () =>
              storage.transactionSync(() => {
                storage.sql.exec("INSERT INTO records VALUES (2, 'rollback')");
                storage.kv.put("transaction", "rollback");
                throw new Error("intentional rollback");
              }),
            catch: (e) => e,
          }).pipe(
            Effect.catch((e) =>
              e instanceof Error && e.message === "intentional rollback"
                ? Effect.void
                : Effect.fail(e),
            ),
          );
          return Response.json({ acknowledged: true, activation });
        }
        if (path === "/arm") {
          const deadline = Date.now() + 5000;
          yield* platform(() => storage.setAlarm(deadline));
          return Response.json({ deadline });
        }
        return Response.json({
          activation,
          retained: (yield* platform(() => storage.get("retained"))) ?? null,
          deleted: (yield* platform(() => storage.get("deleted"))) ?? null,
          transaction:
            (yield* platform(() => storage.get("transaction"))) ?? null,
          rows: storage.sql.exec("SELECT * FROM records ORDER BY id").toArray(),
          fired: (yield* platform(() => storage.get("fired"))) ?? false,
        });
      }),
    );
  }
}
export default {
  fetch(request: Request, env: RecoveryEnv) {
    return Effect.runPromise(
      platform(() =>
        env.PROBE.getByName(
          new URL(request.url).searchParams.get("name") ?? "ready",
        ).fetch(request),
      ),
    );
  },
} satisfies ExportedHandler<RecoveryEnv>;
