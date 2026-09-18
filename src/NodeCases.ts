import { endpoint } from "./CoreCases.js";
export const nodeCases = [
  endpoint(
    "node.buffer",
    "/node/buffer",
    {
      hex: "cebbf09f8c8d",
      base64: "zrvwn4yN",
      roundTrip: "λ🌍",
      slice: [206, 187],
    },
    "https://developers.cloudflare.com/workers/runtime-apis/nodejs/buffer/",
  ),
  endpoint(
    "node.path-events",
    "/node/path-events",
    {
      path: "/b/c",
      basename: "b",
      trace: ["once:a", "on:a", "on:b"],
      remaining: 0,
    },
    "https://nodejs.org/api/events.html",
  ),
  endpoint(
    "node.async-context",
    "/node/async-context",
    { inside: "request", outsideMissing: true },
    "https://developers.cloudflare.com/workers/runtime-apis/nodejs/asynclocalstorage/",
  ),
  endpoint(
    "node.hash-compression",
    "/node/hash-compression",
    {
      sha256:
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      gzip: "hello λ",
      deflate: "hello λ",
    },
    "https://celld.dev/docs/cloudflare-compat/#nodejs-compatibility",
  ),
].map((test) => ({ ...test, fixture: "node" as const }));
