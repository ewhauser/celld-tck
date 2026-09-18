import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TckError, Transport, type TestCase } from "../src/Domain.js";
import { equal, evaluate } from "../src/Oracle.js";

const reference = { name: "reference", baseUrl: "http://unused.invalid" };
const candidate = { name: "candidate", baseUrl: "http://unused.invalid" };
const input = { namespace: "test", seed: 42 };
const testCase = (a: unknown, b: unknown): TestCase => ({
  id: "oracle.self-check",
  contract: "test",
  run: (target) => Effect.succeed(target.name === "reference" ? a : b),
  check: (value) => equal(value, { value: 42 }),
  compare: equal,
});
const run = (test: TestCase) =>
  evaluate(test, reference, candidate, input).pipe(
    Effect.provideService(Transport, {
      websocket: () => Effect.die("No sockets in unit tests"),
      request: () => Effect.die("Oracle unit tests must not perform HTTP"),
    }),
  );

it.effect("accepts two independently correct observations", () =>
  Effect.gen(function* () {
    expect((yield* run(testCase({ value: 42 }, { value: 42 }))).status).toBe(
      "pass",
    );
  }),
);
it.effect("never accepts matching wrong observations", () =>
  Effect.gen(function* () {
    expect((yield* run(testCase({ value: 0 }, { value: 0 }))).status).toBe(
      "reference-error",
    );
  }),
);
it.effect("preserves the deliberately corrupted candidate in a failure", () =>
  Effect.gen(function* () {
    const result = yield* run(testCase({ value: 42 }, { value: 43 }));
    expect(result.status).toBe("fail");
    expect(result.candidate).toEqual({ value: 43 });
    expect(result.reference).toEqual({ value: 42 });
  }),
);
it.effect("uses the differential comparator even with a weak invariant", () =>
  Effect.gen(function* () {
    const result = yield* run({ ...testCase(1, 2), check: () => Effect.void });
    expect(result.status).toBe("fail");
  }),
);
it.effect(
  "keeps transport failure separate from a successful empty response",
  () =>
    Effect.gen(function* () {
      const result = yield* run({
        ...testCase(1, 2),
        run: () =>
          Effect.fail(
            new TckError({ phase: "http", message: "connection reset" }),
          ),
      });
      expect(result.status).toBe("reference-error");
      expect(result.error).toContain("connection reset");
    }),
);

const divergent = {
  ...testCase({ value: 42 }, { value: 0 }),
  divergence: {
    celldVersion: "0.5.0",
    source: "https://example.test/contract",
    reason: "test divergence",
    reviewDate: "2026-09-18",
    owner: "celld-tck maintainers",
    check: (value: unknown) => equal(value, { value: 0 }),
  },
};
const celld = { ...candidate, engine: "celld" as const, version: "0.5.0" };
it.effect("accepts only a version-scoped exact documented divergence", () =>
  Effect.gen(function* () {
    expect((yield* evaluate(divergent, reference, celld, input)).status).toBe(
      "divergence",
    );
    expect(
      (yield* evaluate(
        divergent,
        reference,
        { ...celld, version: "0.6.0" },
        input,
      )).status,
    ).toBe("fail");
    expect(
      (yield* evaluate(
        {
          ...divergent,
          run: (target) =>
            Effect.succeed(
              target.name === "reference" ? { value: 42 } : { value: -1 },
            ),
        },
        reference,
        celld,
        input,
      )).status,
    ).toBe("fail");
  }).pipe(
    Effect.provideService(Transport, {
      request: () => Effect.die("unused"),
      websocket: () => Effect.die("unused"),
    }),
  ),
);
it.effect(
  "requires review when a documented divergence unexpectedly conforms",
  () =>
    Effect.gen(function* () {
      const result = yield* evaluate(
        { ...divergent, run: () => Effect.succeed({ value: 42 }) },
        reference,
        celld,
        input,
      );
      expect(result.status).toBe("fail");
      expect(result.error).toContain("Unexpected compatibility pass");
    }).pipe(
      Effect.provideService(Transport, {
        request: () => Effect.die("unused"),
        websocket: () => Effect.die("unused"),
      }),
    ),
);
