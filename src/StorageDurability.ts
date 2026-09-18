import { Effect, Schema } from "effect";
import { equal } from "./Oracle.js";
import { decodeAs } from "./Artifacts.js";
import type { QualificationContext } from "./QualificationContext.js";
import {
  hasStorageFaultEvidence,
  StorageEvent,
} from "./QualificationOracles.js";

export const checkSyncedState = (value: unknown, after: boolean) =>
  equal(value, {
    rows: after ? [{ n: 1 }, { n: 2 }] : [{ n: 1 }],
    value: after ? "after" : "before",
  });
export const checkTransactionSync = (value: unknown) =>
  equal(value, { rejected: true, rows: [{ n: 1 }] });
export const checkCursorSync = (value: unknown) =>
  equal(value, { first: { n: 2 }, rejected: true, remaining: [{ n: 3 }] });
export const checkDeadline = (value: unknown) =>
  Effect.gen(function* () {
    const result = yield* decodeAs(
      Schema.Struct({ rejected: Schema.Literal(true), message: Schema.String }),
      "assertion",
    )(value);
    yield* equal(
      /(time.?out|timed out|time limit|too long|30.?second)/i.test(
        result.message,
      ),
      true,
    );
  });
export const checkSyncRejection = (value: unknown) =>
  Effect.gen(function* () {
    const error = yield* decodeAs(
      Schema.Struct({ rejected: Schema.Literal(true), message: Schema.String }),
      "assertion",
    )(value);
    yield* equal(error.message.includes("tck-sync-rejected:"), true);
  });
export const checkDeadlineRecovery = (value: unknown) =>
  Effect.gen(function* () {
    const result = yield* decodeAs(
      Schema.Struct({
        error: Schema.Unknown,
        before: Schema.String,
        after: Schema.String,
        elapsedMs: Schema.Number,
        recovered: Schema.Unknown,
      }),
      "assertion",
    )(value);
    yield* checkDeadline(result.error);
    yield* equal(result.before !== result.after, true);
    yield* equal(result.elapsedMs >= 25000 && result.elapsedMs < 45000, true);
    yield* checkSyncedState(result.recovered, false);
  });
const request = (ctx: QualificationContext, path: string) =>
  ctx.transport.request(ctx.targets.celld, {
    path: `/durability/${path}?name=${ctx.name}`,
    timeoutMs: 50_000,
  });
const json = (ctx: QualificationContext, path: string) =>
  request(ctx, path).pipe(
    Effect.tap((result) => equal(result.status, 200)),
    Effect.map((result) => result.body),
  );
const seed = (ctx: QualificationContext) =>
  json(ctx, "seed").pipe(
    Effect.flatMap((value) => checkSyncedState(value, false)),
  );
const recovery = (ctx: QualificationContext) =>
  Effect.gen(function* () {
    yield* seed(ctx);
    const acknowledgment = yield* json(ctx, "sync");
    yield* checkSyncedState(acknowledgment, true);
    yield* ctx.artifacts.json("sync-acknowledgment.json", acknowledgment);
    yield* ctx.restartAll();
    const recovered = yield* json(ctx, "state");
    yield* checkSyncedState(recovered, true);
    return { acknowledgment, recovered };
  });
const outage = (ctx: QualificationContext) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* seed(ctx);
      yield* Effect.addFinalizer(() =>
        ctx.mode("normal", 0).pipe(Effect.orDie),
      );
      const injection = yield* ctx.transport.request(ctx.proxy, {
        path: `/mode?mode=throttle&ms=14000&pathContains=${encodeURIComponent(ctx.identity.cell)}`,
      });
      yield* equal(injection.status, 200);
      const result = yield* request(ctx, "sync-unconfirmed");
      yield* equal(result.status, 500);
      yield* checkSyncRejection(result.body);
      const stats = yield* ctx.transport.request(ctx.proxy, { path: "/stats" });
      const evidence = yield* decodeAs(
        Schema.Struct({ events: Schema.Array(StorageEvent) }),
        "assertion",
      )(stats.body);
      yield* equal(
        hasStorageFaultEvidence(evidence.events, "throttle", ctx.identity.cell),
        true,
      );
      yield* ctx.artifacts.json("sync-outage.json", {
        result,
        events: evidence.events,
      });
      yield* ctx.mode("normal", 0);
      yield* ctx.restartAll();
      // An unacknowledged write may survive. The pre-fault acknowledged value must not disappear.
      const recovered = yield* json(ctx, "state");
      yield* checkOutageRecovery(recovered);
      return { result, recovered };
    }),
  );
export const checkOutageRecovery = (value: unknown) =>
  Effect.gen(function* () {
    const state = yield* decodeAs(
      Schema.Struct({
        rows: Schema.Array(Schema.Struct({ n: Schema.Int })),
        value: Schema.String,
      }),
      "assertion",
    )(value);
    yield* equal(state.rows, [{ n: 1 }]);
    yield* equal(["before", "after"].includes(state.value), true);
  });
const deadline = (
  path: "transaction-deadline" | "gate-deadline",
  ctx: QualificationContext,
) =>
  Effect.gen(function* () {
    yield* seed(ctx);
    const before = yield* ctx.json("/fleet/id");
    const started = Date.now();
    const result = yield* request(ctx, path);
    const elapsedMs = Date.now() - started;
    yield* equal(result.status, 500);
    yield* checkDeadline(result.body);
    const after = yield* ctx.json("/fleet/id");
    const Activation = Schema.Struct({ activation: Schema.String });
    const old = yield* decodeAs(Activation, "assertion")(before);
    const next = yield* decodeAs(Activation, "assertion")(after);
    yield* equal(old.activation !== next.activation, true);
    const recovered = yield* json(ctx, "state");
    yield* checkSyncedState(recovered, false);
    yield* checkDeadlineRecovery({
      error: result.body,
      before: old.activation,
      after: next.activation,
      elapsedMs,
      recovered,
    });
    return { before, result, after, recovered, elapsedMs };
  });
export const checkCursorOutput = (value: unknown) =>
  Effect.gen(function* () {
    const result = yield* decodeAs(
      Schema.Struct({
        status: Schema.Literal(500),
        body: Schema.Struct({
          rejected: Schema.Literal(true),
          message: Schema.String,
        }),
        witness: Schema.Struct({ count: Schema.Literal(1) }),
      }),
      "assertion",
    )(value);
    yield* equal(
      /(cursor|uncommitted|RETURNING)/i.test(result.body.message),
      true,
    );
  });
const cursorOutput = (
  boundary: "response" | "outbound",
  ctx: QualificationContext,
) =>
  Effect.gen(function* () {
    yield* seed(ctx);
    yield* equal(yield* json(ctx, "consumed-cursor-outbound"), { status: 200 });
    const control = yield* ctx.transport.request(ctx.targets.celld, {
      path: `/durability/witness-read?name=${ctx.name}-witness`,
    });
    yield* equal(control.status, 200);
    yield* equal(control.body, { count: 1 });
    const result = yield* request(ctx, `write-cursor-${boundary}`);
    const witness = yield* ctx.transport.request(ctx.targets.celld, {
      path: `/durability/witness-read?name=${ctx.name}-witness`,
    });
    yield* equal(witness.status, 200);
    const observation = { ...result, witness: witness.body };
    yield* checkCursorOutput(observation);
    return observation;
  });
export const storageDurabilityCases = [
  {
    id: "faults.write-cursor-response",
    run: (ctx: QualificationContext) => cursorOutput("response", ctx),
  },
  {
    id: "faults.write-cursor-outbound",
    run: (ctx: QualificationContext) => cursorOutput("outbound", ctx),
  },
  { id: "faults.sync-recovery", durability: "bucket" as const, run: recovery },
  { id: "faults.sync-outage", durability: "bucket" as const, run: outage },
  {
    id: "faults.sync-transaction",
    run: (ctx: QualificationContext) =>
      Effect.gen(function* () {
        yield* seed(ctx);
        const value = yield* json(ctx, "sync-transaction");
        yield* checkTransactionSync(value);
        return value;
      }),
  },
  {
    id: "faults.write-cursor-sync",
    run: (ctx: QualificationContext) =>
      Effect.gen(function* () {
        yield* seed(ctx);
        const value = yield* json(ctx, "write-cursor-sync");
        yield* checkCursorSync(value);
        return value;
      }),
  },
  {
    id: "faults.transaction-deadline",
    run: (ctx: QualificationContext) => deadline("transaction-deadline", ctx),
  },
  {
    id: "faults.gate-deadline",
    run: (ctx: QualificationContext) => deadline("gate-deadline", ctx),
  },
];
