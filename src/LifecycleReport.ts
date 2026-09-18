import { Cause, Console, Effect, Exit } from "effect";
import { Artifacts } from "./Artifacts.js";
import { TckError, type Report } from "./Domain.js";
import { junit } from "./Report.js";

// Install outside resource scopes so cleanup finishes before the report is written.
// onExit runs uninterruptibly and preserves the original failure/cancellation.
export const withLifecycleReport = <A, E, R>(
  work: Effect.Effect<A, E, R>,
  base: Omit<Report, "completedAt" | "success">,
  errors: string[],
) =>
  work.pipe(
    Effect.onExit((exit) =>
      Effect.gen(function* () {
        const artifacts = yield* Artifacts;
        if (Exit.isFailure(exit)) errors.push(Cause.pretty(exit.cause));
        const report: Report = {
          ...base,
          completedAt: new Date().toISOString(),
          errors,
          success:
            Exit.isSuccess(exit) &&
            !errors.length &&
            base.cases.every((result) => result.status === "pass"),
        };
        yield* artifacts.json("report.json", report);
        yield* artifacts.text("junit.xml", junit(report));
        yield* Console.log(`Evidence: ${artifacts.directory}/report.json`);
      }).pipe(Effect.orDie),
    ),
    Effect.tap(() =>
      errors.length || base.cases.some((result) => result.status !== "pass")
        ? Effect.fail(
            new TckError({
              phase: "suite",
              message: "Qualification failed; inspect retained evidence",
            }),
          )
        : Effect.void,
    ),
  );
