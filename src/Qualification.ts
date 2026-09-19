import { Processes } from "./Processes.js";
import { Effect, type FileSystem } from "effect";
import { Artifacts, artifactsLayer } from "./Artifacts.js";
import { buildFixtureFor } from "./Build.js";
import { Transport, TckError, type Profile } from "./Domain.js";
import type { QualificationSuite } from "./Suites.js";
import { acquireLocal } from "./Local.js";
import { provenance } from "./Provenance.js";
import { makeSuiteExecutor } from "./SuiteExecutor.js";
import {
  makeContext,
  type QualificationContext,
} from "./QualificationContext.js";
import { trafficCases } from "./QualificationTraffic.js";
import { dependencyCases } from "./QualificationDependencies.js";
import { faultCases } from "./QualificationFaults.js";
import { capacityCases } from "./QualificationCapacity.js";
interface QualificationCase {
  readonly manualReload: boolean;
  readonly id: string;
  readonly durability: "bucket" | "fleet";
  readonly run: (
    ctx: QualificationContext,
  ) => Effect.Effect<
    unknown,
    unknown,
    FileSystem.FileSystem | Artifacts | Transport | Processes
  >;
}
export const qualificationCases = [
  ...trafficCases,
  ...dependencyCases,
  ...faultCases,
  ...capacityCases,
].map((test) => ({
  manualReload: false,
  durability: "fleet" as const,
  ...test,
})) satisfies readonly QualificationCase[];
export const qualificationIds = qualificationCases.map((test) => test.id);
export const runQualification = (options: {
  runId: string;
  profile: Profile;
  suite: QualificationSuite;
  caseId: string;
  seed: number;
}) =>
  Effect.gen(function* () {
    if (options.profile !== "local")
      return yield* Effect.fail(
        new TckError({
          phase: "arguments",
          message: "Qualification faults require the local Docker profile",
        }),
      );
    const selected = qualificationCases.filter(
      ({ id }) =>
        (!options.caseId || id === options.caseId) &&
        (options.suite === "qualification" ||
          id.startsWith(options.suite + ".")),
    );
    const ids = selected.map((test) => test.id);
    if (!ids.length)
      return yield* Effect.fail(
        new TckError({
          phase: "arguments",
          message: "No qualification cases selected",
        }),
      );
    const artifacts = yield* Artifacts;
    const environment = {
      suite: options.suite,
      reference: "none; fault invariants",
      candidates: [] as unknown[],
    };
    const executor = yield* makeSuiteExecutor({
      ...options,
      profile: "local",
      ids,
      environment,
    });
    const work = Effect.gen(function* () {
      Object.assign(environment, yield* provenance);
      yield* artifacts.json("run.json", { ...options, selected: ids });
      for (const scenario of selected) {
        const { id } = scenario;
        yield* executor.runCase(
          id,
          (test) =>
            Effect.gen(function* () {
              const bundle = yield* buildFixtureFor("qualification");
              const runtime = yield* acquireLocal({
                runId: `${options.runId}-${id.replaceAll(".", "-")}`,
                bundle,
                cleanupError: executor.cleanupError,
                topology: "cluster",
                durability: scenario.durability,
                nodeCount: 3,
                qualification: true,
                manualReload: scenario.manualReload,
              });
              environment.candidates.push(runtime.metadata);
              const ctx = yield* makeContext(
                runtime,
                id.replaceAll(".", "-") + "-" + options.runId.slice(4, 12),
                options.seed,
              );
              yield* test.ready;
              return yield* scenario.run(ctx);
            }).pipe(
              Effect.provide(artifactsLayer(`${artifacts.directory}/${id}`)),
            ),
          { timeout: "8 minutes", includesSetup: true },
        );
      }
    });
    yield* executor.execute(work);
  });
