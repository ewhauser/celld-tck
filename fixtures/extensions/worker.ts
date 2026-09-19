import { WorkerEntrypoint } from "cloudflare:workers";
import { Effect } from "effect";
import core, { Probe as BaseProbe } from "../core/worker.js";
import { platform } from "../core/Platform.js";
import wasm from "./add.wasm";
export { Service, TestWorkflow } from "../core/worker.js";
declare const __DYNAMIC_CODE__: string;
const code =
  (extra: Record<string, unknown> = {}) =>
  () => ({
    compatibilityDate: "2026-07-30",
    mainModule: "worker.js",
    modules: { "worker.js": __DYNAMIC_CODE__ },
    ...extra,
  });
const child = (
  env: ExtensionEnv,
  id: string,
  path: string,
  options: {
    readonly extra?: Record<string, unknown>;
    readonly props?: unknown;
  },
) =>
  platform(() =>
    env.LOADER.get(id, code(options.extra))
      .getEntrypoint(
        undefined,
        options.props === undefined ? undefined : { props: options.props },
      )
      .fetch(`https://fixture.test${path}`),
  ).pipe(Effect.flatMap((response) => platform(() => response.json())));
const asset = (env: ExtensionEnv, path: string) =>
  platform(() =>
    env.ASSETS.fetch(
      new Request(`https://fixture.test${path}`, { redirect: "manual" }),
    ),
  ).pipe(
    Effect.flatMap((response) =>
      Effect.gen(function* () {
        const body = yield* platform(() => response.text());
        // The bytes and media type of an error page are presentation, not
        // contract, so only a served asset reports them.
        return {
          status: response.status,
          location: response.headers.get("location"),
          page: response.headers.get("x-tck-page"),
          ...(response.ok
            ? {
                contentType: response.headers.get("content-type"),
                body: body.trim(),
              }
            : { contentType: null, body: null }),
        };
      }),
    ),
  );

// Gateway for the dynamic Worker outbound cases. A loaded Worker reaches it
// either as a service capability in its env or as its globalOutbound Fetcher.
export class Gateway extends WorkerEntrypoint<ExtensionEnv> {
  fetch(request: Request) {
    return Effect.runPromise(
      Effect.sync(
        () => new Response(`gateway ${new URL(request.url).pathname}`),
      ),
    );
  }
}
export class Probe extends BaseProbe {
  fetch(request: Request): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith("/facets/"))
      return super.fetch(request);
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const env = this.env as ExtensionEnv;
        const url = new URL(request.url);
        const worker = env.LOADER.get("counter-v1", code());
        const facet = (name: string, className: string) =>
          this.ctx.facets.get(name, () => ({
            class: worker.getDurableObjectClass(className),
          }));
        if (url.pathname === "/facets/outbound") {
          // The facet needs its own outbound capability, so this loaded Worker
          // carries the gateway in its env.
          const outboundWorker = env.LOADER.get(
            "facet-outbound-v1",
            code({ env: { UPSTREAM: env.GATEWAY } }),
          );
          const ledger = (op: string) =>
            platform(() =>
              this.ctx.facets
                .get("outbound", () => ({
                  class: outboundWorker.getDurableObjectClass("Ledger"),
                }))
                .fetch(`https://fixture.test/?op=${op}`),
            ).pipe(
              Effect.flatMap((response) => platform(() => response.json())),
            );
          const control = yield* ledger("outbound");
          const storage = this.ctx.storage;
          const inTransaction = yield* platform(() =>
            storage.transaction(async (tx) => {
              await tx.put("root", "pending");
              return Effect.runPromise(ledger("outbound"));
            }),
          ).pipe(
            // A refusal is reported as an outcome; its error class is not part
            // of the documented contract.
            Effect.catch(() => Effect.succeed("rejected")),
          );
          return Response.json({
            control,
            inTransaction,
            after: yield* ledger("read"),
          });
        }
        if (url.pathname === "/facets/transaction") {
          const ledger = (op: string) =>
            platform(() =>
              facet("ledger", "Ledger").fetch(`https://fixture.test/?op=${op}`),
            ).pipe(
              Effect.flatMap((response) => platform(() => response.json())),
            );
          return Response.json({
            seeded: yield* ledger("seed"),
            initial: yield* ledger("read"),
            commit: yield* ledger("commit"),
            committed: yield* ledger("read"),
            rollback: yield* ledger("rollback"),
            restored: yield* ledger("read"),
          });
        }
        const a = yield* platform(() =>
          facet("a", "Counter").fetch("https://fixture.test"),
        );
        const b = yield* platform(() =>
          facet("a", "Counter").fetch("https://fixture.test"),
        );
        const c = yield* platform(() =>
          facet("b", "Counter").fetch("https://fixture.test"),
        );
        return Response.json({
          a: yield* platform(() => a.json()),
          b: yield* platform(() => b.json()),
          c: yield* platform(() => c.json()),
        });
      }),
    );
  }
}
export default {
  ...core,
  fetch(request: Request, env: ExtensionEnv) {
    return Effect.runPromise(
      Effect.gen(function* () {
        const url = new URL(request.url);
        switch (url.pathname) {
          case "/wasm/add": {
            const instance = yield* platform(() =>
              WebAssembly.instantiate(wasm),
            );
            const add = instance.exports.add as (
              a: number,
              b: number,
            ) => number;
            return Response.json({
              positive: add(20, 22),
              negative: add(-7, 2),
              overflow: add(2147483647, 1),
            });
          }
          case "/dynamic/fetch": {
            const response = yield* platform(() =>
              env.LOADER.get("text-v1", code())
                .getEntrypoint()
                .fetch("https://fixture.test"),
            );
            return Response.json({
              status: response.status,
              text: yield* platform(() => response.text()),
            });
          }
          case "/dynamic/props":
            return Response.json({
              tenant: yield* child(env, "props-v1", "/props", {
                props: { tenant: "alpha", seed: 7 },
              }),
              other: yield* child(env, "props-v1", "/props", {
                props: { tenant: "beta", seed: 9 },
              }),
            });
          case "/dynamic/bindings":
            return Response.json(
              yield* child(env, "bindings-v1", "/env", {
                extra: {
                  env: {
                    TOKEN: "token λ",
                    COUNT: 3,
                    UPSTREAM: env.GATEWAY,
                  },
                },
              }),
            );
          // Custom resource limits declared in WorkerCode. The pinned workerd
          // does not enforce them locally, so only acceptance and a call that
          // stays inside the declared budget are observed.
          case "/dynamic/limits":
            return Response.json(
              yield* child(env, "limits-v1", "/env", {
                extra: {
                  limits: { cpuMs: 200, subRequests: 5 },
                  env: { TOKEN: "limited λ", COUNT: 1, UPSTREAM: env.GATEWAY },
                },
              }),
            );
          case "/dynamic/outbound":
            return Response.json({
              blocked: yield* child(env, "outbound-blocked-v1", "/outbound", {
                extra: {
                  globalOutbound: null,
                  env: { UPSTREAM: env.GATEWAY },
                },
              }),
              gateway: yield* child(env, "outbound-gateway-v1", "/outbound", {
                extra: {
                  globalOutbound: env.GATEWAY,
                  env: { UPSTREAM: env.GATEWAY },
                },
              }),
            });
          case "/assets/fetch": {
            const response = yield* platform(() =>
              env.ASSETS.fetch("https://fixture.test/hello.txt"),
            );
            const missing = yield* platform(() =>
              env.ASSETS.fetch("https://fixture.test/missing.txt"),
            );
            return Response.json({
              status: response.status,
              text: yield* platform(() => response.text()),
              header: response.headers.get("x-tck-asset"),
              missing: missing.status,
            });
          }
          case "/assets/routing":
            return Response.json({
              page: yield* asset(env, "/page"),
              pageHtml: yield* asset(env, "/page.html"),
              folder: yield* asset(env, "/folder"),
              folderSlash: yield* asset(env, "/folder/"),
              missing: yield* asset(env, "/missing"),
            });
          // Reachable only when static routing sends the path to the Worker:
          // an asset exists at /shadowed.txt and at /asset-first/note.txt.
          case "/shadowed.txt":
          case "/asset-first/note.txt":
            return Response.json({ served: "worker", path: url.pathname });
          case "/assets/redirects":
            return Response.json({
              permanent: yield* asset(env, "/old-page"),
              temporary: yield* asset(env, "/temp-page"),
              unmatched: yield* asset(env, "/other-page"),
            });
          default:
            return yield* platform(() => core.fetch(request, env));
        }
      }),
    );
  },
} satisfies ExportedHandler<ExtensionEnv>;
