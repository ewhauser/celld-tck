import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
export class Counter extends DurableObject {
  fetch() {
    return Effect.runPromise(
      Effect.sync(() => {
        this.ctx.storage.sql.exec(
          "CREATE TABLE IF NOT EXISTS counter (n INTEGER)",
        );
        this.ctx.storage.sql.exec(
          "INSERT INTO counter SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM counter)",
        );
        const row = this.ctx.storage.sql
          .exec<{ n: number }>("UPDATE counter SET n = n + 1 RETURNING n")
          .one();
        return Response.json(row);
      }),
    );
  }
}
export default {
  fetch() {
    return Effect.runPromise(Effect.succeed(new Response("dynamic λ")));
  },
};
