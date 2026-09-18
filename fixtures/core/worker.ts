import { DurableObject } from "cloudflare:workers";
import { Effect, Schema } from "effect";

const platform = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause) => cause });
const operation = <A>(body: () => A) =>
  Effect.try({ try: body, catch: (cause) => cause });

export class Probe extends DurableObject<Env> {
  fetch(request: Request): Promise<Response> {
    return Effect.runPromise(this.handle(request));
  }
  private handle(request: Request) {
    const storage = this.ctx.storage;
    return Effect.gen(function* () {
      const url = new URL(request.url);
      const key = url.searchParams.get("key") ?? "value";
      switch (url.pathname) {
        case "/ready": {
          yield* platform(() => storage.put("ready", "ok"));
          return Response.json({
            value: yield* platform(() => storage.get("ready")),
          });
        }
        case "/storage/put": {
          const body = yield* platform(() => request.json());
          yield* platform(() => storage.put(key, body));
          return Response.json({ stored: true });
        }
        case "/storage/get": {
          const value = yield* platform(() => storage.get(key));
          return Response.json(
            value === undefined ? { present: false } : { present: true, value },
          );
        }
        case "/storage/list":
          return Response.json([
            ...(yield* platform(() => storage.list({ prefix: "item:" }))),
          ]);
        case "/storage/delete":
          return Response.json({
            deleted: yield* platform(() => storage.delete(key)),
          });
        case "/storage/rollback": {
          // This platform callback requires a Promise; the transaction itself is Effect-based.
          const error = yield* platform(() =>
            storage.transaction((tx) =>
              Effect.runPromise(
                Effect.gen(function* () {
                  yield* platform(() => tx.put("balance", 999));
                  yield* platform(() => tx.put("uncommitted", true));
                  return yield* Effect.fail(
                    new Error("tck intentional rollback"),
                  );
                }),
              ),
            ),
          ).pipe(
            Effect.as(null as string | null),
            Effect.catch((cause) =>
              Effect.succeed(
                cause instanceof Error ? cause.message : String(cause),
              ),
            ),
          );
          return Response.json({ error });
        }
        case "/sql/prepare":
          yield* operation(() => {
            storage.sql.exec(
              "CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
            );
            storage.sql.exec(
              "INSERT INTO ledger VALUES (?, ?)",
              1,
              "committed",
            );
          });
          return Response.json({ prepared: true });
        case "/sql/rollback": {
          // SQLite's synchronous callback cannot yield or run Promise-based effects.
          const error = yield* operation(() =>
            storage.transactionSync(() => {
              storage.sql.exec(
                "UPDATE ledger SET value = ? WHERE id = ?",
                "overwritten",
                1,
              );
              storage.sql.exec(
                "INSERT INTO ledger VALUES (?, ?)",
                2,
                "uncommitted",
              );
              throw new Error("tck intentional rollback");
            }),
          ).pipe(
            Effect.as(null as string | null),
            Effect.catch((cause) =>
              Effect.succeed(
                cause instanceof Error ? cause.message : String(cause),
              ),
            ),
          );
          return Response.json({ error });
        }
        case "/sql/read":
          return Response.json(
            yield* operation(() =>
              storage.sql
                .exec("SELECT id, value FROM ledger ORDER BY id")
                .toArray(),
            ),
          );
        default:
          return new Response("Unknown operation", { status: 404 });
      }
    });
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return Effect.runPromise(
      Effect.gen(function* () {
        const url = new URL(request.url);
        if (url.pathname === "/http/echo") {
          return Response.json(
            {
              method: request.method,
              query: url.searchParams.getAll("q"),
              header: request.headers.get("x-tck-value"),
              body: yield* platform(() => request.text()),
            },
            { status: 201, headers: { "x-tck-response": "echo" } },
          );
        }
        const name = yield* Schema.decodeUnknownEffect(Schema.String)(
          url.searchParams.get("name"),
        );
        if (name.length === 0 || name.length > 200)
          return new Response("Invalid object name", { status: 400 });
        return yield* platform(() => env.PROBE.getByName(name).fetch(request));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
