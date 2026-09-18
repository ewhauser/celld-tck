import { Cause, Console, Effect, Exit, Schedule, Schema } from "effect";
import { Artifacts } from "./Artifacts.js";
import { buildFixtureFor } from "./Build.js";
import { Transport, TckError, type CaseResult, type Report } from "./Domain.js";
import { acquireLocal } from "./Local.js";
import { equal } from "./Oracle.js";
import { OutageState, checkOutageState } from "./Outage.js";
import { type Node, type Owner } from "./FleetControls.js";
import { junit } from "./Report.js";
export const checkHandoff = (
  before: typeof Owner.Type,
  after: typeof Owner.Type,
  successor: Node,
) =>
  Effect.gen(function* () {
    yield* equal(after.node, successor);
    if (after.node === before.node || after.epoch <= before.epoch)
      return yield* Effect.fail(
        new TckError({
          phase: "assertion",
          message: "Ownership did not advance to a new node and epoch",
        }),
      );
  });
const ids = [
  "multinode.routing",
  "multinode.owner-failover",
  "multinode.owner-rejoin",
  "multinode.storage-partition",
];
export const runMultinode = (options: {
  runId: string;
  profile: string;
  seed: number;
  caseId: string;
}) =>
  Effect.gen(function* () {
    if (options.profile !== "local" || options.caseId)
      return yield* Effect.fail(
        new TckError({
          phase: "arguments",
          message:
            "Multinode requires local profile and the complete scenario; omit --case",
        }),
      );
    const artifacts = yield* Artifacts;
    const transport = yield* Transport;
    const startedAt = new Date().toISOString();
    const results: CaseResult[] = ids.map((id) => ({
      id,
      status: "infrastructure-error",
      durationMs: 0,
      error: "Stage not reached",
    }));
    const errors: string[] = [];
    const environment: Record<string, unknown> = {
      suite: "multinode",
      durability: "bucket",
    };
    yield* artifacts.json("run.json", {
      ...options,
      suite: "multinode",
      selected: ids,
    });
    const exit = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* () {
          const bundle = yield* buildFixtureFor("recovery");
          const runtime = yield* acquireLocal(
            `${options.runId}-multinode`,
            bundle,
            (detail) =>
              Effect.sync(() => {
                errors.push(detail);
              }),
            true,
          );
          environment.candidate = runtime.metadata;
          environment.fixtureSha256 = bundle.sha256;
          const fleet = runtime.fleet;
          const targets = {
            celld: yield* fleet.target("celld"),
            celld2: yield* fleet.target("celld2"),
          };
          const name = `${options.runId}-shared`;
          const acknowledged: number[] = [];
          const request = (
            node: Node,
            path: string,
            method: "GET" | "POST" = "GET",
          ) =>
            transport.request(targets[node], {
              path: `${path}${path.includes("?") ? "&" : "?"}name=${name}`,
              method,
            });
          const ready = (node: Node) =>
            transport
              .request(targets[node], { path: "/.well-known/celld/health" })
              .pipe(
                Effect.flatMap((value) => equal(value.status, 200)),
                Effect.retry({
                  schedule: Schedule.spaced("500 millis"),
                  times: 90,
                }),
                Effect.timeout("60 seconds"),
              );
          const read = (node: Node) =>
            request(node, "/outage/state").pipe(
              Effect.tap((value) => equal(value.status, 200)),
              Effect.flatMap((value) =>
                Schema.decodeUnknownEffect(OutageState)(value.body),
              ),
            );
          const check = (node: Node) =>
            Effect.gen(function* () {
              const state = yield* read(node);
              yield* artifacts.json(
                `state-${node}-${acknowledged.length}.json`,
                state,
              );
              yield* checkOutageState(
                state,
                [...acknowledged]
                  .sort((a, b) => a - b)
                  .map((id) => ({ id, acknowledged: true })),
              );
            });
          const write = (node: Node, id: number) =>
            Effect.gen(function* () {
              const result = yield* request(
                node,
                `/outage/write?id=${id}`,
                "POST",
              );
              yield* artifacts.json(`write-${id}.json`, { node, result });
              yield* equal(result.status, 200);
              yield* equal(result.body, { acknowledged: id });
              acknowledged.push(id);
            });
          const stage = (index: number, work: Effect.Effect<void, unknown>) =>
            Effect.gen(function* () {
              const start = Date.now();
              const result = yield* Effect.exit(
                work.pipe(Effect.timeout("150 seconds")),
              );
              results[index] = {
                id: ids[index]!,
                status: Exit.isSuccess(result) ? "pass" : "fail",
                durationMs: Date.now() - start,
                ...(Exit.isFailure(result)
                  ? { error: Cause.pretty(result.cause) }
                  : {}),
              };
              yield* artifacts.json(`case-${ids[index]}.json`, results[index]);
              yield* Console.log(
                `${results[index]!.status.toUpperCase()} ${ids[index]}`,
              );
              if (Exit.isFailure(result))
                return yield* Effect.failCause(result.cause);
            });
          yield* ready("celld");
          yield* ready("celld2");
          let cell = "";
          let owner: Node = "celld";
          let survivor: Node = "celld2";
          let original: typeof Owner.Type = { node: owner, epoch: 0 };
          yield* stage(
            0,
            Effect.gen(function* () {
              yield* Effect.all([write("celld", 1), write("celld2", 2)], {
                concurrency: 2,
              });
              yield* check("celld");
              yield* check("celld2");
              const identity = yield* request("celld", "/fleet/id");
              yield* equal(identity.status, 200);
              cell = (yield* Schema.decodeUnknownEffect(
                Schema.Struct({ cell: Schema.String }),
              )(identity.body)).cell;
              original = yield* fleet.owner(cell);
              owner = original.node;
              survivor = owner === "celld" ? "celld2" : "celld";
            }),
          );
          yield* stage(
            1,
            Effect.gen(function* () {
              yield* fleet.kill(owner);
              yield* Effect.sleep("11 seconds");
              // Cold activation can take time; retry read transport/setup only, then assert data once.
              yield* read(survivor).pipe(
                Effect.retry({
                  schedule: Schedule.spaced("500 millis"),
                  times: 20,
                }),
                Effect.timeout("45 seconds"),
              );
              yield* check(survivor);
              yield* checkHandoff(original, yield* fleet.owner(cell), survivor);
              yield* write(survivor, 3);
            }),
          );
          yield* stage(
            2,
            Effect.gen(function* () {
              targets[owner] = yield* fleet.start(owner);
              yield* ready(owner);
              yield* check(owner);
              yield* check(survivor);
              yield* write(owner, 4);
              yield* check(survivor);
            }),
          );
          yield* stage(
            3,
            Effect.gen(function* () {
              const prior = yield* fleet.owner(cell);
              const isolated = prior.node;
              const healthy = isolated === "celld" ? "celld2" : "celld";
              yield* fleet.partition(isolated);
              yield* Effect.gen(function* () {
                const state = yield* fleet.inspect(isolated);
                if (state.State.Running)
                  return yield* Effect.fail(
                    new TckError({
                      phase: "fence-pending",
                      message: "Waiting for lease fence",
                    }),
                  );
                yield* equal(state.State.ExitCode, 3);
              }).pipe(
                Effect.retry({
                  while: (error) =>
                    error instanceof TckError &&
                    error.phase === "fence-pending",
                  schedule: Schedule.spaced("1 second"),
                  times: 30,
                }),
                Effect.timeout("40 seconds"),
              );
              const logs = yield* fleet.logs(isolated);
              yield* artifacts.text("partition-node.log", logs);
              yield* equal(logs.includes("node_lease_watchdog_fence"), true);
              const refused = yield* request(
                isolated,
                "/outage/write?id=5",
                "POST",
              ).pipe(
                Effect.map((response) => ({ response })),
                Effect.catch((error) =>
                  error.phase === "http"
                    ? Effect.succeed({ error: error.message })
                    : Effect.fail(error),
                ),
              );
              yield* artifacts.json("partition-refused-write.json", refused);
              if ("response" in refused)
                yield* equal(
                  refused.response.status >= 200 &&
                    refused.response.status < 300,
                  false,
                );
              yield* read(healthy).pipe(
                Effect.retry({
                  schedule: Schedule.spaced("500 millis"),
                  times: 20,
                }),
                Effect.timeout("45 seconds"),
              );
              yield* check(healthy);
              yield* checkHandoff(prior, yield* fleet.owner(cell), healthy);
              yield* write(healthy, 6);
              yield* fleet.reconnect(isolated);
              targets[isolated] = yield* fleet.start(isolated);
              yield* ready(isolated);
              yield* check(isolated);
              yield* write(isolated, 7);
              yield* check(healthy);
              yield* check(isolated);
            }),
          );
        }),
      ).pipe(Effect.timeout("8 minutes")),
    );
    if (Exit.isFailure(exit)) errors.push(Cause.pretty(exit.cause));
    const success =
      Exit.isSuccess(exit) &&
      !errors.length &&
      results.every((result) => result.status === "pass");
    const report: Report = {
      schemaVersion: 1,
      runId: options.runId,
      profile: "local",
      seed: options.seed,
      startedAt,
      completedAt: new Date().toISOString(),
      environment,
      cases: results,
      errors,
      success,
    };
    yield* artifacts.json("report.json", report);
    yield* artifacts.text("junit.xml", junit(report));
    yield* Console.log(`Evidence: ${artifacts.directory}/report.json`);
    if (!success)
      return yield* Effect.fail(
        new TckError({
          phase: "suite",
          message: "Multinode run failed; inspect evidence",
        }),
      );
  });
