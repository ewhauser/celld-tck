import { endpoint } from "./CoreCases.js";
export const extensionCases = [
  endpoint(
    "wasm.module",
    "/wasm/add",
    { positive: 42, negative: -5, overflow: -2147483648 },
    "https://developers.cloudflare.com/workers/runtime-apis/webassembly/",
  ),
  endpoint(
    "assets.binding",
    "/assets/fetch",
    { status: 200, text: "hello asset λ\n", header: "present", missing: 404 },
    "https://developers.cloudflare.com/workers/static-assets/binding/",
  ),
  endpoint(
    "dynamic.fetch",
    "/dynamic/fetch",
    { status: 200, text: "dynamic λ" },
    "https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/",
  ),
  endpoint(
    "facets.isolation",
    "/facets/isolation",
    { a: { n: 1 }, b: { n: 2 }, c: { n: 1 } },
    "https://celld.dev/docs/cloudflare-compat/#durable-object-facets",
  ),
].map((test) => ({ ...test, fixture: "extensions" as const }));
