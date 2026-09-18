import { Cause, Console, Effect, Exit, Schedule, Schema } from "effect";
import { Artifacts } from "./Artifacts.js";
import { buildFixtureFor } from "./Build.js";
import {
  Transport,
  TckError,
  type CaseResult,
  type Report,
  type Target,
} from "./Domain.js";
import { acquireLocal } from "./Local.js";
import { equal } from "./Oracle.js";
import { junit } from "./Report.js";

export const recoveryIds = [
  "recovery.graceful",
  "recovery.crash",
  "recovery.overdue-alarm",
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
    const startedAt = new Date().toISOString();
    const results: CaseResult[] = ids.map((id) => ({
      id,
      status: "infrastructure-error",
      durationMs: 0,
      error: "Case not reached",
    }));
    const errors: string[] = [];
    const environment: Record<string, unknown> = {
      suite: "recovery",
      reference: "none; lifecycle invariants",
      localDiskRetained: true,
    };
    yield* artifacts.json("run.json", {
      ...options,
      suite: "recovery",
      selected: ids,
    });
    const exit = yield* Effect.exit(
      Effect.scoped(
        Effect.gen(function* () {
          const bundle = yield* buildFixtureFor("recovery");
          environment.fixtureSha256 = bundle.sha256;
          const runtime = yield* acquireLocal(
            `${options.runId}-recovery`,
            bundle,
            (detail) =>
              Effect.sync(() => {
                errors.push(detail);
              }),
          );
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
            request("/ready", "readiness").pipe(
              Effect.flatMap((value) => equal(value, { ready: true })),
              Effect.retry({
                schedule: Schedule.spaced("500 millis"),
                times: 90,
              }),
              Effect.timeout("60 seconds"),
            );
          yield* ready();
          for (const [index, id] of ids.entries()) {
            const start = Date.now();
            const name = `${options.runId}-${id.replaceAll(".", "-")}`;
            const attempt = yield* Effect.exit(
              Effect.gen(function* () {
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
                const alarm = id === "recovery.overdue-alarm";
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
                target = yield* lifecycle.start();
                yield* ready();
                const recovered = alarm
                  ? yield* read().pipe(
                      Effect.flatMap((value) =>
                        value.fired
                          ? Effect.succeed(value)
                          : Effect.fail(
                              new TckError({
                                phase: "alarm-pending",
                                message: "Waiting for overdue alarm",
                              }),
                            ),
                      ),
                      Effect.retry({
                        while: (error) =>
                          error instanceof TckError &&
                          error.phase === "alarm-pending",
                        schedule: Schedule.spaced("500 millis"),
                        times: 60,
                      }),
                    )
                  : yield* read();
                yield* artifacts.json(`${id}-observations.json`, {
                  seeded,
                  initial,
                  recovered,
                  deadline: alarm ? deadline : null,
                });
                yield* checkRecovered(seeded.activation, recovered, alarm);
                return recovered;
              }).pipe(Effect.timeout("120 seconds")),
            );
            if (Exit.isFailure(attempt) && Cause.hasInterrupts(attempt.cause))
              return yield* Effect.failCause(attempt.cause);
            const result: CaseResult = {
              id,
              status: Exit.isSuccess(attempt) ? "pass" : "fail",
              durationMs: Date.now() - start,
              ...(Exit.isSuccess(attempt)
                ? { candidate: attempt.value }
                : { error: Cause.pretty(attempt.cause) }),
            };
            results[index] = result;
            yield* artifacts.json(`case-${id}.json`, result);
            yield* Console.log(`${result.status.toUpperCase()} ${id}`);
            // A failed lifecycle transition may leave the target down; do not cascade or retry mutations.
            if (Exit.isFailure(attempt)) break;
          }
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
    if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))
      return yield* Effect.failCause(exit.cause);
    if (!success)
      return yield* Effect.fail(
        new TckError({
          phase: "suite",
          message: "Recovery run failed; inspect evidence",
        }),
      );
  });
