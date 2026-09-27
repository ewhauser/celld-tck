import { Effect } from "effect";
import { platform } from "../shared/Platform.js";
declare const __DYNAMIC_CODE__: string;

// Exactly the same fixture and loader key run before and after the binary swap.
export const upgradeOperation = (
  ctx: DurableObjectState,
  env: QualificationEnv,
  url: URL,
  activation: string,
) =>
  Effect.gen(function* () {
    const ledger = (path: string) =>
      platform(() =>
        ctx.facets
          .get("legacy-ledger", () => ({
            class: env.LOADER.get("legacy-facet-v1", () => ({
              compatibilityDate: "2026-07-30",
              mainModule: "worker.js",
              modules: { "worker.js": __DYNAMIC_CODE__ },
            })).getDurableObjectClass("Ledger"),
          }))
          .fetch(`https://fixture.test${path}`),
      ).pipe(Effect.flatMap((response) => platform(() => response.json())));
    const prefix = `upgrade/${ctx.id.toString()}/`;
    if (url.pathname === "/upgrade/seed") {
      yield* ledger("/seed");
      yield* platform(() => env.BUCKET.put(prefix + "photos/", "legacy λ"));
      ctx.storage.kv.put("root-witness", "root λ");
    }
    const facet = yield* ledger(
      url.pathname === "/upgrade/advance" ? "/advance" : "/state",
    ).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
    // Record the other stores even when the facet is unreadable. The oracle
    // requires exact facet data and never accepts this error observation.
    const read = (key: string) =>
      platform(() => env.BUCKET.get(prefix + key)).pipe(
        Effect.flatMap((value) =>
          value ? platform(() => value.text()) : Effect.succeed(null),
        ),
      );
    return Response.json({
      activation,
      root: ctx.storage.kv.get("root-witness"),
      facet,
      r2: {
        withoutSlash: yield* read("photos"),
        withSlash: yield* read("photos/"),
        keys: (yield* platform(() => env.BUCKET.list({ prefix }))).objects.map(
          (object) => object.key.slice(prefix.length),
        ),
      },
    });
  });
