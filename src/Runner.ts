import { Console, Effect, FileSystem, Schedule, Schema } from "effect";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { Artifacts, artifactsLayer } from "./Artifacts.js";
import { buildFixtureFor, sha256 } from "./Build.js";
import { cases, suites, type Suite } from "./Catalog.js";
import { Coverage, validateCoverage } from "./Coverage.js";
import { decodeJson } from "./Artifacts.js";
import {
  ApiEnvironment,
  Transport,
  TckError,
  CaseResult,
  type Profile,
  type Target,
} from "./Domain.js";
import { rejectionConfigs } from "./DeploymentChecks.js";
import { Processes } from "./Processes.js";
import { acquireLocal } from "./Local.js";
import { equal, evaluate } from "./Oracle.js";
import { acquireReference } from "./Reference.js";
import { BugRegistry, validateBugRegistry } from "./KnownBugs.js";
import { makeSuiteExecutor } from "./SuiteExecutor.js";

export interface RunOptions {
  readonly runId: string;
  readonly profile: Profile;
  readonly seed: number;
  readonly caseId: string;
  readonly suite?: Suite;
  readonly knownBugs?: "allow" | "error";
}
export const selectCases = (caseId: string, suite: Suite = "all") =>
  Effect.gen(function* () {
    const selected = caseId
      ? suites[suite].filter((test) => test.id === caseId)
      : suites[suite];
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
    const selected = yield* selectCases(options.caseId, options.suite);
    const artifacts = yield* Artifacts;
    const fs = yield* FileSystem.FileSystem;
    const coverage = yield* decodeJson(
      Coverage,
      yield* fs.readFileString(
        new URL("../docs/coverage.json", import.meta.url).pathname,
      ),
    );
    yield* validateCoverage(cases, coverage);
    const bugs = yield* decodeJson(
      BugRegistry,
      yield* fs.readFileString(
        new URL("../docs/bugs.json", import.meta.url).pathname,
      ),
    );
    yield* validateBugRegistry(bugs, cases);
    yield* artifacts.json("bugs.json", {
      ...bugs,
      policy: options.knownBugs ?? "allow",
    });
    yield* artifacts.json("coverage.json", {
      ...coverage,
      selected: selected.map((test) => test.id),
      notSelected: cases
        .filter((test) => !selected.includes(test))
        .map((test) => test.id),
      divergences: selected
        .filter((test) => test.divergence)
        .map((test) => ({ id: test.id, ...test.divergence, check: undefined })),
    });
    const deploymentIds =
      options.profile === "local" &&
      selected.some((test) => (test.fixture ?? "core") === "core")
        ? [
            "deployment.valid-config",
            ...rejectionConfigs.map((test) => test.id),
          ]
        : [];
    const require = createRequire(import.meta.url);
    const environment: Record<string, unknown> = {
      hostNode: process.version,
      fixtures: {},
      platform: process.platform,
      architecture: process.arch,
      effect: require("effect/package.json").version,
      platformNode: require("@effect/platform-node/package.json").version,
      esbuild: require("esbuild/package.json").version,
      referenceOnly: options.profile === "reference",
    };
    const executor = yield* makeSuiteExecutor({
      ...options,
      ids: [...selected.map((test) => test.id), ...deploymentIds],
      environment,
      policy: "compatibility",
      timeout: "10 minutes",
    });
    const work = Effect.gen(function* () {
      const processes = yield* Processes;
      const revision = yield* processes.run("git", ["rev-parse", "HEAD"]).pipe(
        Effect.map((output) => output.stdout.trim()),
        Effect.catch(() => Effect.succeed("unavailable")),
      );
      environment.sourceRevision = revision;
      environment.dirty = yield* processes
        .run("git", ["status", "--porcelain"])
        .pipe(
          Effect.map((output) => output.stdout.trim().length > 0),
          Effect.catch(() => Effect.succeed(null)),
        );
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
      for (const fixture of ["core", "node", "extensions", "repro"] as const) {
        if (!selected.some((test) => (test.fixture ?? "core") === fixture))
          continue;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const bundle = yield* buildFixtureFor(fixture);
            const groupEnvironment: Record<string, unknown> = {
              fixtureSha256: bundle.sha256,
              compatibilityDate: bundle.compatibilityDate,
              compatibilityFlags: bundle.config.compatibility_flags,
            };
            (environment.fixtures as Record<string, unknown>)[fixture] =
              groupEnvironment;
            const reference = yield* acquireReference(
              "reference",
              bundle,
              executor.cleanupError,
            );
            groupEnvironment.reference = reference.metadata;
            yield* ready(reference.target, options.runId);
            yield* Console.log(
              `Reference ready. Starting ${options.profile === "local" ? "celld + MinIO" : "second isolated workerd"}...`,
            );
            const candidate = yield* options.profile === "local"
              ? acquireLocal(
                  `${options.runId}-${fixture}`,
                  bundle,
                  executor.cleanupError,
                )
              : acquireReference("candidate", bundle, executor.cleanupError);
            groupEnvironment.candidate = candidate.metadata;
            if (options.profile === "local" && fixture === "core") {
              const deploymentResults = yield* Schema.decodeUnknownEffect(
                Schema.Array(CaseResult),
              )(candidate.metadata.deploymentChecks);
              yield* equal(
                deploymentResults.map((result) => result.id),
                deploymentIds,
              );
              for (const result of deploymentResults)
                yield* executor.record(result);
            }
            yield* ready(candidate.target, options.runId);
            for (const test of selected) {
              if ((test.fixture ?? "core") !== fixture) continue;
              const result = yield* evaluate(
                test,
                reference.target,
                candidate.target,
                {
                  namespace: `${options.runId}-${test.id.replaceAll(".", "-")}`,
                  seed: options.seed,
                  compatibilityDate: bundle.compatibilityDate,
                  compatibilityFlags: bundle.config.compatibility_flags,
                },
                bugs.expectations.find((entry) => entry.caseId === test.id),
                options.knownBugs,
              );
              yield* executor.record(result);
            }
          }),
        ).pipe(
          Effect.provide(artifactsLayer(resolve(artifacts.directory, fixture))),
        );
      }
      yield* Schema.decodeUnknownEffect(ApiEnvironment)(environment);
    });
    yield* executor.execute(work);
  });
