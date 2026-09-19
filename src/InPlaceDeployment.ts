import { toTckError } from "./Domain.js";
import { Effect, FileSystem, Schema } from "effect";
import { decodeAs, decodeJson } from "./Artifacts.js";
import { sha256 } from "./Build.js";
import { inspectService } from "./Compose.js";
import { Processes } from "./Processes.js";
import { equal } from "./Oracle.js";
import {
  acknowledgedBatch,
  type QualificationContext,
} from "./QualificationContext.js";
import type { Node } from "./FleetControls.js";

const ProcessIdentity = Schema.Struct({
  Id: Schema.String,
  RestartCount: Schema.Int,
  State: Schema.Struct({
    Running: Schema.Literal(true),
    Pid: Schema.Int,
    StartedAt: Schema.String,
  }),
});
const Revision = Schema.Struct({ revision: Schema.String });
const Reload = Schema.Struct({ status: Schema.Int, body: Schema.String });
export const checkReload = (value: unknown, valid: boolean) =>
  Effect.gen(function* () {
    const result = yield* decodeAs(Reload, "assertion")(value);
    const body = yield* decodeJson(
      Schema.Struct({
        ok: Schema.Boolean,
        outcome: Schema.String,
        error: Schema.optional(Schema.String),
      }),
      result.body,
    ).pipe(Effect.mapError(toTckError("assertion")));
    yield* equal(result.status, valid ? 200 : 422);
    yield* equal(body.ok, valid);
    yield* equal(body.outcome, valid ? "adopted" : "failed");
    if (!valid)
      yield* equal(body.error?.includes("tck-invalid-deployment"), true);
  });
export const checkAdoption = (value: unknown, revision: string) =>
  Effect.gen(function* () {
    const result = yield* decodeAs(
      Schema.Struct({
        before: ProcessIdentity,
        after: ProcessIdentity,
        worker: Revision,
        object: Revision,
        service: Revision,
      }),
      "assertion",
    )(value);
    yield* equal(result.before, result.after);
    yield* equal(result.worker.revision, revision);
    yield* equal(result.object.revision, revision);
    yield* equal(result.service.revision, revision);
  });
const identity = (ctx: QualificationContext, node: Node) =>
  Effect.gen(function* () {
    const processes = yield* Processes;
    const raw = yield* inspectService(
      ctx.runtime.controls.compose,
      processes,
      node,
    );
    const records = yield* decodeJson(Schema.Array(ProcessIdentity), raw);
    yield* equal(records.length, 1);
    return records[0]!;
  });
const reload = (ctx: QualificationContext, node: Node) =>
  Effect.gen(function* () {
    // Node's fetch is confined to this sidecar boundary, which reaches the private listener.
    const output = yield* ctx.runtime.controls.compose([
      "exec",
      "-T",
      "proxy",
      "node",
      "--input-type=module",
      "-e",
      'const r = await fetch("http://" + process.argv[1] + ":8081/reload", { method: "POST", signal: AbortSignal.timeout(60000) }); console.log(JSON.stringify({ status: r.status, body: await r.text() }));',
      node,
    ]);
    return yield* decodeJson(Reload, output.stdout);
  });
const publish = (ctx: QualificationContext, invalid: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = `${ctx.artifacts.directory}/fixture/worker.js`;
    const source = yield* fs.readFileString(path);
    yield* equal(source.includes("qualification-v1"), true);
    const replacement =
      (invalid ? 'throw new Error("tck-invalid-deployment");\n' : "") +
      source.replaceAll("qualification-v1", "qualification-v2");
    yield* ctx.artifacts.json("reload-manifest.json", {
      initialSha256: sha256(source),
      replacementSha256: sha256(replacement),
      invalid,
    });
    yield* Effect.acquireUseRelease(
      fs.writeFileString(path, replacement),
      () =>
        ctx.runtime.controls
          .deploy()
          .pipe(
            Effect.flatMap((result) =>
              ctx.artifacts.text("reload-deployment.json", result.stdout),
            ),
          ),
      () => fs.writeFileString(path, source).pipe(Effect.orDie),
    );
  });
const run = (ctx: QualificationContext, invalid: boolean) =>
  Effect.gen(function* () {
    yield* acknowledgedBatch(ctx, 12);
    const before = yield* Effect.forEach(ctx.nodes, (node) =>
      identity(ctx, node),
    );
    for (const node of ctx.nodes) {
      yield* equal(yield* ctx.json("/deployment/revision", node), {
        revision: "qualification-v1",
      });
      const object = yield* decodeAs(
        Revision,
        "assertion",
      )(yield* ctx.json("/fleet/id", node));
      yield* equal(object.revision, "qualification-v1");
    }
    yield* publish(ctx, invalid);
    // The pointer is published, but no node may adopt before the explicit trigger.
    for (const node of ctx.nodes)
      yield* equal(yield* ctx.json("/deployment/revision", node), {
        revision: "qualification-v1",
      });
    const reloads = [];
    for (const node of ctx.nodes) {
      const response = yield* reload(ctx, node);
      reloads.push({ node, ...response });
      yield* ctx.artifacts.json("reload-responses.json", reloads);
      yield* checkReload(response, !invalid);
    }
    const revision = invalid ? "qualification-v1" : "qualification-v2";
    const observations = [];
    for (const [index, node] of ctx.nodes.entries()) {
      const observation = {
        node,
        before: before[index],
        after: yield* identity(ctx, node),
        worker: yield* ctx.json("/deployment/revision", node),
        object: yield* ctx.json("/fleet/id", node),
        service: yield* ctx.json("/service", node),
      };
      observations.push(observation);
      yield* ctx.artifacts.json("reload-adoption.json", observations);
      yield* checkAdoption(observation, revision);
      yield* ctx.verify(node);
    }
    // Rejection must retain a writable application, not just a cached response.
    yield* acknowledgedBatch(ctx, 6);
    for (const node of ctx.nodes) yield* ctx.verify(node);
    return { reloads, observations, history: yield* ctx.verify() };
  });
export const inPlaceDeploymentCases = [
  {
    id: "faults.reload-adoption",
    manualReload: true,
    run: (ctx: QualificationContext) => run(ctx, false),
  },
  {
    id: "faults.reload-invalid",
    manualReload: true,
    run: (ctx: QualificationContext) => run(ctx, true),
  },
];
