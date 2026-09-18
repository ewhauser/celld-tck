import { deepStrictEqual } from "node:assert";
import { Cause, Clock, Effect, Exit } from "effect";
import {
  TckError,
  type CaseInput,
  type CaseResult,
  type Target,
  type TestCase,
} from "./Domain.js";

export const equal = (actual: unknown, expected: unknown) =>
  Effect.try({
    try: () => deepStrictEqual(actual, expected),
    catch: (error) =>
      new TckError({ phase: "assertion", message: String(error) }),
  });

export const evaluate = (
  test: TestCase,
  reference: Target,
  candidate: Target,
  input: CaseInput,
) =>
  Effect.gen(function* () {
    const start = yield* Clock.currentTimeMillis;
    let referenceValue: unknown;
    let candidateValue: unknown;
    let status: CaseResult["status"] = "reference-error";
    const exit = yield* Effect.exit(
      Effect.gen(function* () {
        referenceValue = yield* test
          .run(reference, input)
          .pipe(Effect.timeout("30 seconds"));
        yield* test.check(referenceValue, input);
        status = "fail";
        candidateValue = yield* test
          .run(candidate, input)
          .pipe(Effect.timeout("30 seconds"));
        yield* test.check(candidateValue, input);
        yield* test.compare(referenceValue, candidateValue);
        status = "pass";
      }),
    );
    if (Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause))
      return yield* Effect.failCause(exit.cause);
    return {
      id: test.id,
      status,
      durationMs: (yield* Clock.currentTimeMillis) - start,
      ...(referenceValue === undefined ? {} : { reference: referenceValue }),
      ...(candidateValue === undefined ? {} : { candidate: candidateValue }),
      ...(Exit.isFailure(exit) ? { error: Cause.pretty(exit.cause) } : {}),
    } satisfies CaseResult;
  });
