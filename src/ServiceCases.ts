import { Effect } from "effect";
import { endpoint, poll } from "./CoreCases.js";
import { call, define, response } from "./Cases.js";
import { equal } from "./Oracle.js";
import type { TestCase } from "./Domain.js";
const bindingCase = (
  id: string,
  path: string,
  expected: unknown,
  family: string,
) =>
  endpoint(id, path, expected, `https://developers.cloudflare.com/${family}/`);
const workflowMode = (
  mode: "retry" | "event",
  expected: unknown,
): TestCase => ({
  ...define(
    `workflows.${mode}`,
    (target, input) =>
      Effect.gen(function* () {
        yield* equal(
          yield* call(target, input, `/workflows/start?mode=${mode}`),
          response({ sameId: true }),
        );
        if (mode === "event")
          yield* equal(
            yield* call(target, input, "/workflows/send"),
            response({ sent: true }),
          );
        return yield* poll(
          call(target, input, "/workflows/state"),
          (result) =>
            (result.body as { status?: string } | null)?.status === "complete",
        );
      }),
    () => response({ status: "complete", output: expected }),
  ),
  contract: "https://developers.cloudflare.com/workflows/build/workers-api/",
});
export const serviceCases: ReadonlyArray<TestCase> = [
  workflowMode("retry", { attempts: 2 }),
  workflowMode("event", { payload: { value: "λ" }, type: "continue" }),
  bindingCase(
    "rpc.named-service",
    "/services/rpc",
    { greeting: "hello λ" },
    "workers/runtime-apis/bindings/service-bindings/rpc",
  ),
  bindingCase(
    "kv.metadata-list",
    "/kv/round-trip",
    {
      value: { value: { value: "λ" }, metadata: { tag: 7 } },
      names: ["/a"],
      complete: true,
      missing: null,
    },
    "kv",
  ),
  bindingCase(
    "kv.binary-pagination",
    "/kv/binary-pagination",
    { bytes: [0, 128, 255], first: ["/a"], second: ["/b"], complete: true },
    "kv",
  ),
  bindingCase(
    "d1.bindings-results",
    "/d1/query",
    {
      success: true,
      inserted: [{ n: 7, text: "λ'" }],
      first: { n: 7, text: "λ'", bytes: [0, 255] },
      raw: [[7, "λ'"]],
    },
    "d1",
  ),
  bindingCase(
    "d1.batch-rollback",
    "/d1/batch-rollback",
    { rejected: true, value: 1 },
    "d1",
  ),
  bindingCase(
    "r2.metadata-range-delete",
    "/r2/round-trip",
    {
      bytes: [0, 128, 255, 10],
      range: [128, 255],
      size: 4,
      type: "application/test",
      metadata: { label: "λ" },
      sameEtag: true,
      names: ["/a"],
      missing: null,
    },
    "r2",
  ),
  bindingCase(
    "r2.conditional-write",
    "/r2/conditional",
    { rejected: true, accepted: true, value: "second" },
    "r2",
  ),
  bindingCase(
    "r2.multipart",
    "/r2/multipart",
    { part: 1, value: "single final part", aborted: null },
    "r2",
  ),
  {
    ...define(
      "queues.batch-ack-retry",
      (target, input) =>
        Effect.gen(function* () {
          yield* equal(
            yield* call(target, input, "/queues/start"),
            response({ sent: true }),
          );
          return yield* poll(call(target, input, "/queues/state"), (result) => {
            const body = result.body as Record<
              string,
              { attempts: number }
            > | null;
            return (
              body?.single?.attempts === 2 &&
              body["batch-a"] !== undefined &&
              body["batch-b"] !== undefined
            );
          });
        }),
      () =>
        response({
          single: { attempts: 2, retry: true },
          "batch-a": { attempts: 1, retry: false },
          "batch-b": { attempts: 1, retry: false },
        }),
    ),
    contract:
      "https://developers.cloudflare.com/queues/configuration/javascript-apis/",
  },
  {
    ...define(
      "workflows.steps-sleep-result",
      (target, input) =>
        Effect.gen(function* () {
          yield* equal(
            yield* call(target, input, "/workflows/start"),
            response({ sameId: true }),
          );
          return yield* poll(
            call(target, input, "/workflows/state"),
            (result) =>
              (result.body as { status?: string } | null)?.status ===
              "complete",
          );
        }),
      () => response({ status: "complete", output: { result: 41 } }),
    ),
    contract: "https://developers.cloudflare.com/workflows/build/workers-api/",
  },
];
