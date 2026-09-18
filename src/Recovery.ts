import { waitForReady, pollUntil } from "./Polling.js";
import { Effect, Schema } from "effect";
import { provenance } from "./Provenance.js";
import { Artifacts } from "./Artifacts.js";
import { buildFixtureFor } from "./Build.js";
import { Transport, TckError, type Target } from "./Domain.js";
import { acquireLocal } from "./Local.js";
import { equal } from "./Oracle.js";
import { runOutage } from "./Outage.js";
import { makeSuiteExecutor } from "./SuiteExecutor.js";

export const recoveryIds = [
  "recovery.graceful",
  "recovery.crash",
  "recovery.overdue-alarm",
  "recovery.disk-loss",
  "recovery.storage-outage",
] as const;
const Snapshot = Schema.Struct({
  activation: Schema.String,
  retained: Schema.Unknown,
  deleted: Schema.Unknown,
  transaction: Schema.Unknown,
  rows: Schema.Unknown,
  fired: Schema.Boolean,
});
export const checkRecovered = (
  before: string,
  value: typeof Snapshot.Type,
  fired: boolean,
) =>
  Effect.gen(function* () {
    if (before === value.activation)
      return yield* Effect.fail(
        new TckError({
          phase: "assertion",
          message: "Durable Object activation did not change",
        }),
      );
    yield* equal(
      { ...value, activation: undefined },
      {
        activation: undefined,
        retained: "durable λ",
        deleted: null,
        transaction: "committed",
        rows: [{ id: 1, value: "committed" }],
        fired,
      },
    );
  });
export const runRecovery = (options: {
  runId: string;
  profile: string;
  caseId: string;
  seed: number;
}) =>
  Effect.gen(function* () {
    if (options.profile !== "local")
      return yield* Effect.fail(
        new TckError({
          phase: "arguments",
          message: "Recovery requires the local Docker profile",
        }),
      );
    const ids = recoveryIds.filter(
      (id) => !options.caseId || options.caseId === id,
    );
    if (!ids.length)
      return yield* Effect.fail(
        new TckError({ phase: "arguments", message: "Unknown recovery case" }),
      );
    const artifacts = yield* Artifacts;
    const transport = yield* Transport;
    const environment: Record<string, unknown> = {
      suite: "recovery",
      reference: "none; lifecycle invariants",
      localDiskRetained: !ids.includes("recovery.disk-loss"),
    };
    const executor = yield* makeSuiteExecutor({
      ...options,
      profile: "local",
      ids,
      environment,
      timeout: "8 minutes",
    });
    const work = Effect.gen(function* () {
      yield* artifacts.json("run.json", {
        ...options,
        suite: "recovery",
        selected: ids,
      });
      Object.assign(environment, yield* provenance);
      const bundle = yield* buildFixtureFor("recovery");
      environment.fixtureSha256 = bundle.sha256;
      const runtime = yield* acquireLocal({
        runId: `${options.runId}-recovery`,
        bundle,
        cleanupError: executor.cleanupError,
        topology: "single",
      });
      environment.candidate = runtime.metadata;
      const lifecycle = runtime.lifecycle;
      let target: Target = runtime.target;
      const request = (
        path: string,
        name: string,
        method: "GET" | "POST" = "GET",
      ) =>
        transport
          .request(target, { path: `${path}?name=${name}`, method })
          .pipe(
            Effect.tap((value) => equal(value.status, 200)),
            Effect.map((value) => value.body),
          );
      const ready = () =>
        waitForReady(
          transport.request(target, { path: "/ready?name=readiness" }),
          { interval: "500 millis", attempts: 91, timeout: "60 seconds" },
        ).pipe(
          Effect.flatMap((response) => equal(response.body, { ready: true })),
        );
      yield* ready();
      for (const id of ids) {
        const name = `${options.runId}-${id.replaceAll(".", "-")}`;
        const result = yield* executor.runCase(
          id,
          () =>
            Effect.gen(function* () {
              if (id === "recovery.storage-outage") {
                const recovered = yield* runOutage(target, name, lifecycle);
                target = recovered.target;
                return recovered.observations;
              }
              const seeded = yield* request("/seed", name, "POST").pipe(
                Effect.flatMap(
                  Schema.decodeUnknownEffect(
                    Schema.Struct({
                      acknowledged: Schema.Literal(true),
                      activation: Schema.String,
                    }),
                  ),
                ),
              );
              const read = () =>
                request("/state", name).pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(Snapshot)),
                );
              const initial = yield* read();
              // Verify all stored state before the fault without requiring a new activation.
              yield* checkRecovered("not-an-activation", initial, false);
              yield* equal(initial.activation, seeded.activation);
              const diskLoss = id === "recovery.disk-loss";
              const alarm = id === "recovery.overdue-alarm" || diskLoss;
              let deadline = 0;
              if (alarm)
                deadline = (yield* request("/arm", name, "POST").pipe(
                  Effect.flatMap(
                    Schema.decodeUnknownEffect(
                      Schema.Struct({ deadline: Schema.Number }),
                    ),
                  ),
                )).deadline;
              yield* lifecycle.stop(id !== "recovery.graceful");
              if (alarm && Date.now() >= deadline)
                return yield* Effect.fail(
                  new TckError({
                    phase: "lifecycle",
                    message:
                      "Alarm deadline elapsed before the stopped-state proof",
                  }),
                );
              // Default celld lease lifetime is 10 seconds. Wait beyond it before restart.
              yield* Effect.sleep("11 seconds");
              if (diskLoss) yield* lifecycle.discardDisk();
              target = yield* lifecycle.start();
              yield* ready();
              const recovered = alarm
                ? yield* pollUntil(read(), (value) => value.fired, {
                    interval: "500 millis",
                    attempts: 61,
                    timeout: "120 seconds",
                    message: "Waiting for overdue alarm",
                  })
                : yield* read();
              yield* artifacts.json(`${id}-observations.json`, {
                localDiskRetained: !diskLoss,
                seeded,
                initial,
                recovered,
                deadline: alarm ? deadline : null,
              });
              yield* checkRecovered(seeded.activation, recovered, alarm);
              return recovered;
            }),
          {
            timeout:
              id === "recovery.storage-outage" ? "180 seconds" : "120 seconds",
          },
        );
        // A failed lifecycle transition may leave the target down; do not cascade or retry mutations.
        if (result.status !== "pass") break;
      }
    });
    yield* executor.execute(work);
  });
