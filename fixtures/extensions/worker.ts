import { Effect } from "effect";
import core, { Probe as BaseProbe } from "../core/worker.js";
import { platform } from "../core/Platform.js";
import wasm from "./add.wasm";
export { Service, TestWorkflow } from "../core/worker.js";
declare const __DYNAMIC_CODE__: string;
const code = () => ({
  compatibilityDate: "2026-07-30",
  mainModule: "worker.js",
  modules: { "worker.js": __DYNAMIC_CODE__ },
});
export class Probe extends BaseProbe {
  fetch(request: Request): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith("/facets/"))
      return super.fetch(request);
    return Effect.runPromise(
      Effect.gen({ self: this }, function* () {
        const env = this.env as ExtensionEnv;
        const worker = env.LOADER.get("counter-v1", code);
        const facet = (name: string) =>
          this.ctx.facets.get(name, () => ({
            class: worker.getDurableObjectClass("Counter"),
          }));
        const a = yield* platform(() =>
          facet("a").fetch("https://fixture.test"),
        );
        const b = yield* platform(() =>
          facet("a").fetch("https://fixture.test"),
        );
        const c = yield* platform(() =>
          facet("b").fetch("https://fixture.test"),
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
              env.LOADER.get("text-v1", code)
                .getEntrypoint()
                .fetch("https://fixture.test"),
            );
            return Response.json({
              status: response.status,
              text: yield* platform(() => response.text()),
            });
          }
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
          default:
            return yield* platform(() => core.fetch(request, env));
        }
      }),
    );
  },
} satisfies ExportedHandler<ExtensionEnv>;
