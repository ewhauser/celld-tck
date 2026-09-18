import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber } from "effect";
import { Artifacts } from "../src/Artifacts.js";
import { withLifecycleReport } from "../src/LifecycleReport.js";
import { owned } from "../src/Resources.js";
import type { CaseResult, Report } from "../src/Domain.js";

const harness = () => {
  const files = new Map<string, unknown>();
  const errors: string[] = [];
  const cases: CaseResult[] = [
    {
      id: "test",
      status: "infrastructure-error",
      durationMs: 0,
      error: "Case not reached",
    },
  ];
  const base = {
    schemaVersion: 1 as const,
    runId: "test",
    profile: "local" as const,
    seed: 42,
    startedAt: "now",
    environment: {},
    cases,
    errors,
  };
  const artifacts = {
    directory: "unused",
    json: (name: string, value: unknown) =>
      Effect.sync(() => {
        files.set(name, value);
      }),
    text: (name: string, value: string) =>
      Effect.sync(() => {
        files.set(name, value);
      }),
  };
  return { files, errors, cases, base, artifacts };
};

for (const phase of ["setup", "execution"] as const)
  it.effect("writes reports after cancellation during " + phase, () =>
    Effect.gen(function* () {
      const h = harness();
      let cleaned = false;
      const work = Effect.scoped(
        Effect.gen(function* () {
          yield* owned(
            phase === "setup" ? Effect.never : Effect.void,
            Effect.sync(() => {
              cleaned = true;
            }),
            () => Effect.void,
          );
          yield* Effect.never;
        }),
      );
      const fiber = yield* withLifecycleReport(work, h.base, h.errors).pipe(
        Effect.provideService(Artifacts, h.artifacts),
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);
      expect(cleaned).toBe(true);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(
        true,
      );
      const report = h.files.get("report.json") as Report;
      expect(report.success).toBe(false);
      expect(report.cases[0]?.status).toBe("infrastructure-error");
      expect(report.errors.join(" ")).toContain("interrupt");
      expect(h.files.get("junit.xml")).toContain("test");
    }),
  );
it.effect(
  "retains original failure and cleanup errors in the terminal report",
  () =>
    Effect.gen(function* () {
      const h = harness();
      const failure = new Error("original failure");
      const work = Effect.scoped(
        owned(Effect.fail(failure), Effect.fail("cleanup failure"), (error) =>
          Effect.sync(() => {
            h.errors.push(error);
          }),
        ),
      );
      const exit = yield* Effect.exit(
        withLifecycleReport(work, h.base, h.errors).pipe(
          Effect.provideService(Artifacts, h.artifacts),
        ),
      );
      expect(Exit.isFailure(exit) && Cause.pretty(exit.cause)).toContain(
        "original failure",
      );
      const report = h.files.get("report.json") as Report;
      expect(report.success).toBe(false);
      expect(report.errors.join(" ")).toContain("cleanup failure");
      expect(report.errors.join(" ")).toContain("original failure");
    }),
);
it.effect("cleanup failure makes otherwise passing work fail", () =>
  Effect.gen(function* () {
    const h = harness();
    h.cases[0] = { id: "test", status: "pass", durationMs: 1 };
    const work = Effect.scoped(
      owned(Effect.void, Effect.fail("cleanup failure"), (error) =>
        Effect.sync(() => {
          h.errors.push(error);
        }),
      ),
    );
    expect(
      (yield* Effect.exit(
        withLifecycleReport(work, h.base, h.errors).pipe(
          Effect.provideService(Artifacts, h.artifacts),
        ),
      ))._tag,
    ).toBe("Failure");
    expect((h.files.get("report.json") as Report).success).toBe(false);
  }),
);

it.effect("reports normal success only with all cases passing", () =>
  Effect.gen(function* () {
    const h = harness();
    h.cases[0] = { id: "test", status: "pass", durationMs: 1 };
    yield* withLifecycleReport(Effect.void, h.base, h.errors).pipe(
      Effect.provideService(Artifacts, h.artifacts),
    );
    expect((h.files.get("report.json") as Report).success).toBe(true);
    h.cases[0] = {
      id: "test",
      status: "fail",
      durationMs: 1,
      error: "bad observation",
    };
    expect(
      (yield* Effect.exit(
        withLifecycleReport(Effect.void, h.base, h.errors).pipe(
          Effect.provideService(Artifacts, h.artifacts),
        ),
      ))._tag,
    ).toBe("Failure");
    expect((h.files.get("report.json") as Report).success).toBe(false);
    expect(h.files.get("junit.xml")).toContain("bad observation");
  }),
);
