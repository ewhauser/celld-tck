import {
  Cause,
  Console,
  Effect,
  Exit,
  FileSystem,
  Schedule,
  Schema,
} from "effect";
import { createRequire } from "node:module";
import { Artifacts } from "./Artifacts.js";
import { buildFixture, sha256 } from "./Build.js";
import { cases } from "./Cases.js";
import {
  Report,
  Transport,
  TckError,
  type CaseResult,
  type Profile,
  type Target,
} from "./Domain.js";
import { acquireLocal } from "./Local.js";
import { equal, evaluate } from "./Oracle.js";
import { acquireReference } from "./Reference.js";
import { junit } from "./Report.js";

export interface RunOptions {
  readonly runId: string;
  readonly profile: Profile;
  readonly seed: number;
  readonly caseId: string;
}
export const selectCases = (caseId: string) =>
  Effect.gen(function* () {
    const selected = caseId
      ? cases.filter((test) => test.id === caseId)
      : cases;
    if (!selected.length)
      return yield* Effect.fail(
        new TckError({
          phase: "arguments",
          message: `Unknown case: ${caseId}`,
        }),
      );
    return selected;
  });
const ready = (target: Target, runId: string) =>
  Effect.gen(function* () {
    const transport = yield* Transport;
    const observation = yield* transport.request(target, {
      path: `/ready?name=${runId}-readiness`,
    });
    yield* equal(observation, {
      status: 200,
      headers: { "content-type": "application/json" },
      body: { value: "ok" },
    });
  }).pipe(
    Effect.retry({ schedule: Schedule.spaced("250 millis"), times: 30 }),
    Effect.timeout("45 seconds"),
  );

export const runSuite = (options: RunOptions) =>
  Effect.gen(function* () {
    const selected = yield* selectCases(options.caseId);
    const artifacts = yield* Artifacts;
    const fs = yield* FileSystem.FileSystem;
    const startedAt = new Date().toISOString();
    const results: CaseResult[] = selected.map((test) => ({
      id: test.id,
      status: "infrastructure-error",
      durationMs: 0,
      error: "Case not reached",
    }));
    const errors: string[] = [];
    const require = createRequire(import.meta.url);
    const environment: Record<string, unknown> = {
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      effect: require("effect/package.json").version,
      platformNode: require("@effect/platform-node/package.json").version,
      esbuild: require("esbuild/package.json").version,
      referenceOnly: options.profile === "reference",
    };
    const cleanupError = (detail: string) =>
      Effect.sync(() => {
        errors.push(`Cleanup: ${detail}`);
      });
    const work = Effect.scoped(
      Effect.gen(function* () {
        const lockfile = yield* fs.readFileString(
          new URL("../pnpm-lock.yaml", import.meta.url).pathname,
        );
        environment.lockfileSha256 = sha256(lockfile);
        yield* artifacts.json("run.json", {
          ...options,
          selected: selected.map((test) => ({
            id: test.id,
            contract: test.contract,
          })),
        });
        yield* Console.log(
          `Building Effect fixtures; profile=${options.profile}, seed=${options.seed}`,
        );
        const bundle = yield* buildFixture;
        environment.fixtureSha256 = bundle.sha256;
        environment.compatibilityDate = bundle.compatibilityDate;
        const reference = yield* acquireReference(
          "reference",
          bundle,
          cleanupError,
        );
        environment.reference = reference.metadata;
        yield* ready(reference.target, options.runId);
        yield* Console.log(
          `Reference ready. Starting ${options.profile === "local" ? "celld + MinIO" : "second isolated workerd"}...`,
        );
        const candidate = yield* options.profile === "local"
          ? acquireLocal(options.runId, bundle, cleanupError)
          : acquireReference("candidate", bundle, cleanupError);
        environment.candidate = candidate.metadata;
        yield* ready(candidate.target, options.runId);
        for (const [index, test] of selected.entries()) {
          const result = yield* evaluate(
            test,
            reference.target,
            candidate.target,
            { namespace: `${options.runId}-${test.id}`, seed: options.seed },
          );
          results[index] = result;
          yield* artifacts.json(`case-${test.id}.json`, result);
          yield* Console.log(`${result.status.toUpperCase()} ${result.id}`);
        }
      }),
    ).pipe(
      Effect.timeout("5 minutes"),
      Effect.andThen(() => {
        if (errors.length || results.some((result) => result.status !== "pass"))
          return Effect.fail(
            new TckError({
              phase: "suite",
              message: "Compatibility run failed; inspect the evidence bundle.",
            }),
          );
        return Effect.void;
      }),
    );
    yield* work.pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          if (Exit.isFailure(exit)) errors.push(Cause.pretty(exit.cause));
          const report = yield* Schema.decodeUnknownEffect(Report)({
            schemaVersion: 1,
            runId: options.runId,
            profile: options.profile,
            seed: options.seed,
            startedAt,
            completedAt: new Date().toISOString(),
            environment,
            cases: results,
            errors,
            success:
              Exit.isSuccess(exit) &&
              errors.length === 0 &&
              results.every((result) => result.status === "pass"),
          });
          yield* artifacts.json("report.json", report);
          yield* artifacts.text("junit.xml", junit(report));
          yield* Console.log(`Evidence: ${artifacts.directory}/report.json`);
        }).pipe(Effect.orDie),
      ),
    );
  });
