import { Effect, Exit, Fiber, FileSystem, Schedule, Schema } from "effect";
import { Artifacts, artifactsLayer } from "./Artifacts.js";
import { buildFixtureFor, sha256 } from "./Build.js";
import { Transport, TckError, type Target } from "./Domain.js";
import { acquireLocal } from "./Local.js";
import { equal } from "./Oracle.js";
import { Processes } from "./Processes.js";
import { provenance } from "./Provenance.js";
import { auditLedger } from "./Audit.js";
import {
  checkWorkflowResult,
  hasStorageFaultEvidence,
  StorageEvent,
} from "./QualificationOracles.js";
import { makeSuiteExecutor } from "./SuiteExecutor.js";
import {
  checkFencedReceipts,
  checkHistory,
  checkHistoryKv,
  HistoryKv,
  HistoryRow,
  makeLedger,
  Receipt,
} from "./History.js";
import type { Node } from "./FleetControls.js";

export const qualificationIds = [
  "traffic.crash-ledger",
  "traffic.paused-owner",
  "traffic.restart-races",
  "dependencies.queue-acceptance",
  "dependencies.queue-redelivery",
  "dependencies.workflow-recovery",
  "dependencies.stream-reconnect",
  "dependencies.hibernation",
  "faults.storage-latency",
  "faults.storage-throttle",
  "faults.storage-timeout",
  "faults.storage-ambiguous",
  "faults.peer-partition",
  "faults.rolling-deployment",
  "capacity.large-restore",
  "capacity.memory-pressure",
  "capacity.slow-consumer",
  "capacity.queue-load",
  "capacity.insufficient-spare",
] as const;
export type QualificationContext = Effect.Success<
  ReturnType<typeof makeContext>
>;
const makeContext = (
  runtime: Effect.Success<ReturnType<typeof acquireLocal>>,
  name: string,
  seed: number,
) =>
  Effect.gen(function* () {
    const transport = yield* Transport;
    const artifacts = yield* Artifacts;
    const fleet = runtime.fleet;
    const nodes: Node[] = ["celld", "celld2", "celld3"];
    const targets: Record<Node, Target> = {
      celld: yield* fleet.target("celld"),
      celld2: yield* fleet.target("celld2"),
      celld3: yield* fleet.target("celld3"),
    };
    const request = (
      path: string,
      node: Node = "celld",
      method: "GET" | "POST" = "GET",
      body?: string,
    ) =>
      transport.request(targets[node], {
        path: `${path}${path.includes("?") ? "&" : "?"}name=${name}`,
        method,
        ...(body === undefined
          ? {}
          : { body, headers: { "content-type": "application/json" } }),
      });
    const json = (
      path: string,
      node: Node = "celld",
      method: "GET" | "POST" = "GET",
    ) =>
      request(path, node, method).pipe(
        Effect.tap((r) => equal(r.status, 200)),
        Effect.map((r) => r.body),
      );
    const ready = (node: Node) =>
      transport
        .request(targets[node], { path: "/.well-known/celld/health" })
        .pipe(
          Effect.flatMap((r) => equal(r.status, 200)),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
          Effect.timeout("45 seconds"),
        );
    for (const node of nodes) yield* ready(node);
    const identity = yield* json("/fleet/id").pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Struct({
            cell: Schema.String,
            activation: Schema.String,
            revision: Schema.String,
          }),
        ),
      ),
    );
    const owner = () => fleet.owner(identity.cell);
    const ledger = yield* makeLedger(name);
    let nextId = 0;
    const write = (node: Node = "celld") =>
      Effect.gen(function* () {
        const id = `${name}-${++nextId}`;
        const payload = `payload:${seed}:${id}:λ`;
        yield* ledger.append({
          kind: "intent",
          id,
          payload,
          at: Date.now(),
          node,
        });
        const result = yield* request(
          "/history/write",
          node,
          "POST",
          JSON.stringify({ id, payload }),
        ).pipe(
          Effect.map((response) => ({ response })),
          Effect.catch((error) =>
            error.phase === "http"
              ? Effect.succeed({ error: error.message })
              : Effect.fail(error),
          ),
        );
        if (
          "response" in result &&
          result.response.status >= 200 &&
          result.response.status < 300
        ) {
          yield* equal(result.response.status, 200);
          const receipt = yield* Schema.decodeUnknownEffect(Receipt)(
            result.response.body,
          );
          yield* equal(
            { id: receipt.id, payload: receipt.payload },
            { id, payload },
          );
          yield* ledger.append({
            kind: "ack",
            ...receipt,
            at: Date.now(),
            node,
          });
          return true;
        }
        yield* ledger.append({
          kind: "uncertain",
          id,
          payload,
          at: Date.now(),
          node,
        });
        return false;
      });
    const state = (node: Node = "celld") =>
      Effect.gen(function* () {
        const rows: Array<typeof HistoryRow.Type> = [];
        for (let page = 0; page < 100; page++) {
          const next = yield* json(
            `/history/state?after=${rows.at(-1)?.seq ?? 0}`,
            node,
          ).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(Schema.Array(HistoryRow)),
            ),
          );
          rows.push(...next);
          if (next.length < 128) return rows;
        }
        return yield* Effect.fail(
          new TckError({
            phase: "history",
            message: "History exceeded 12800 rows",
          }),
        );
      });
    const verify = (node: Node = "celld") =>
      Effect.gen(function* () {
        // Reopen and parse persisted evidence instead of trusting the in-memory writer.
        const events = yield* ledger.read();
        const rows = yield* state(node);
        const counts = yield* checkHistory(events, rows);
        // Persist read evidence before returning: uncertainty ends once a write is observed.
        yield* Effect.forEach(
          rows,
          (row) =>
            ledger.append({
              kind: "observed",
              id: row.id,
              payload: row.payload,
              seq: row.seq,
              at: Date.now(),
              node,
            }),
          { discard: true },
        ).pipe(Effect.uninterruptible);
        const kv = yield* json("/history/kv", node).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(HistoryKv)),
        );
        yield* checkHistoryKv(rows, kv);
        const intents = new Map(
          events.filter((e) => e.kind === "intent").map((e) => [e.id, e]),
        );
        const latencies = events
          .filter((e) => e.kind === "ack")
          .map((e) => e.at - intents.get(e.id)!.at)
          .sort((a, b) => a - b);
        const summary = {
          ...counts,
          latencyMs: {
            p50: latencies[Math.floor(latencies.length * 0.5)] ?? null,
            p95: latencies[Math.floor(latencies.length * 0.95)] ?? null,
            max: latencies.at(-1) ?? null,
          },
          durationMs: events.length ? events.at(-1)!.at - events[0]!.at : 0,
        };
        yield* artifacts.json(`${name}-${node}-history.json`, {
          summary,
          rows,
          kv,
        });
        return summary;
      });
    const start = (node: Node) =>
      Effect.gen(function* () {
        targets[node] = yield* fleet.start(node);
        yield* ready(node);
      });
    const crash = (node: Node) =>
      Effect.gen(function* () {
        yield* fleet.kill(node);
        yield* Effect.sleep("11 seconds");
        yield* start(node);
      });
    const poll = <A>(
      effect: Effect.Effect<A, unknown>,
      done: (a: A) => boolean,
    ) =>
      effect.pipe(
        Effect.flatMap((a) =>
          done(a)
            ? Effect.succeed(a)
            : Effect.fail(
                new TckError({
                  phase: "pending",
                  message: "Waiting for asynchronous completion",
                }),
              ),
        ),
        Effect.retry({
          while: (e) => e instanceof TckError && e.phase === "pending",
          schedule: Schedule.spaced("500 millis"),
          times: 120,
        }),
        Effect.timeout("90 seconds"),
      );
    const proxy = yield* runtime.controls.proxy();
    const mode = (mode: string, ms: number) =>
      transport
        .request(proxy, { path: `/mode?mode=${mode}&ms=${ms}` })
        .pipe(Effect.tap((r) => equal(r.status, 200)));
    return {
      runtime,
      fleet,
      nodes,
      targets,
      name,
      seed,
      artifacts,
      request,
      json,
      identity,
      owner,
      ledger,
      write,
      state,
      verify,
      start,
      crash,
      ready,
      poll,
      mode,
      proxy,
      transport,
    };
  });

const events = (ctx: QualificationContext) =>
  ctx
    .json("/events")
    .pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(
          Schema.Array(Schema.Tuple([Schema.String, Schema.Int])),
        ),
      ),
    );
const acknowledgedBatch = (ctx: QualificationContext, count: number) =>
  Effect.forEach(
    Array.from({ length: count }),
    (_, i) =>
      ctx
        .write(ctx.nodes[i % 3]!)
        .pipe(Effect.flatMap((ack) => equal(ack, true))),
    { concurrency: 4, discard: true },
  );
const traffic = (ctx: QualificationContext, count: number) =>
  Effect.forEach(
    Array.from({ length: count }),
    (_, i) =>
      ctx
        .write(ctx.nodes[i % 3]!)
        .pipe(Effect.andThen(Effect.sleep("30 millis"))),
    { concurrency: 4, discard: true },
  );

const runCase = (id: string, ctx: QualificationContext) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { fleet, nodes, artifacts } = ctx;
      if (id.startsWith("traffic.")) {
        yield* acknowledgedBatch(ctx, 24);
        if (id === "traffic.paused-owner") {
          const prior = yield* ctx.owner();
          const oldActivation = (yield* ctx.ledger.read())
            .filter((event) => event.kind === "ack")
            .at(-1)!.activation!;
          const successor = nodes.find((node) => node !== prior.node)!;
          yield* fleet.pause(prior.node);
          yield* Effect.sleep("11 seconds");
          yield* ctx
            .write(successor)
            .pipe(Effect.flatMap((ack) => equal(ack, true)));
          const after = yield* ctx.owner();
          yield* equal(
            after.node !== prior.node && after.epoch > prior.epoch,
            true,
          );
          const takeoverAt = Date.now();
          yield* artifacts.json("takeover.json", {
            prior,
            after,
            oldActivation,
            takeoverAt,
          });
          const pending = yield* traffic(ctx, 96).pipe(Effect.forkScoped);
          yield* fleet.unpause(prior.node);
          yield* Fiber.join(pending);
          yield* checkFencedReceipts(
            yield* ctx.ledger.read(),
            oldActivation,
            takeoverAt,
          );
          const stopped = yield* fleet.inspect(prior.node);
          yield* equal(stopped.State.Running, false);
          yield* equal(stopped.State.ExitCode, 3);
          yield* ctx.start(prior.node);
        } else {
          for (let round = 0; round < 3; round++) {
            const owner = (yield* ctx.owner()).node;
            const fiber = yield* traffic(ctx, 96).pipe(Effect.forkScoped);
            yield* Effect.sleep(
              `${100 + ((ctx.seed + round * 137) % 600)} millis`,
            );
            yield* fleet.kill(owner);
            if (id === "traffic.restart-races") {
              yield* ctx.start(owner);
              yield* fleet.kill(owner);
            }
            yield* Effect.sleep("11 seconds");
            yield* ctx.start(owner);
            yield* Fiber.join(fiber);
            for (const node of nodes) yield* ctx.verify(node);
          }
        }
        yield* acknowledgedBatch(ctx, 12);
        return yield* ctx.verify();
      }
      if (id.includes("queue-")) {
        const count = id === "capacity.queue-load" ? 500 : 4;
        const retry = id === "dependencies.queue-redelivery";
        const started = Date.now();
        for (let offset = 0; offset < count; offset += 100) {
          const batch = Math.min(100, count - offset);
          yield* equal(
            yield* ctx.json(
              `/queue/send?count=${batch}&offset=${offset}&delay=${retry || count > 4 ? 0 : 15}&retry=${retry ? 1 : 0}`,
              "celld",
              "POST",
            ),
            { accepted: batch },
          );
          if (count > 4) yield* Effect.sleep("1 second");
        }
        const acceptedAt = started;
        if (retry) {
          const firstDelivery = yield* ctx.poll(
            events(ctx),
            (items) => items.length === count,
          );
          yield* equal(
            firstDelivery.every(([, attempts]) => attempts === 1),
            true,
          );
        } else if (count === 4) yield* equal(yield* events(ctx), []);
        if (id !== "capacity.queue-load") {
          for (const node of nodes) yield* fleet.kill(node);
          yield* equal(Date.now() - acceptedAt < 15000, true);
          yield* artifacts.json(`${id}-outage.json`, {
            acceptedAt,
            stoppedAt: Date.now(),
            delaySeconds: 15,
          });
          yield* Effect.sleep("16 seconds");
          yield* Effect.forEach(nodes, ctx.start, {
            concurrency: "unbounded",
            discard: true,
          });
        }
        const observed = yield* ctx.poll(
          events(ctx),
          (items) =>
            items.length === count &&
            items.every(([, attempts]) => attempts >= (retry ? 2 : 1)),
        );
        yield* equal(
          observed.map(([key]) => key).sort(),
          Array.from({ length: count }, (_, i) => `event:queue:${i}`).sort(),
        );
        return { accepted: count, observed, elapsedMs: Date.now() - started };
      }
      if (id === "dependencies.workflow-recovery") {
        yield* ctx.json("/flow/start", "celld", "POST");
        yield* ctx.poll(events(ctx), (items) =>
          items.some(([key]) => key === "event:flow-first"),
        );
        yield* ctx.poll(
          ctx.json("/flow/status"),
          (value) =>
            typeof value === "object" &&
            value !== null &&
            "status" in value &&
            value.status === "waiting",
        );
        for (const node of nodes) yield* fleet.kill(node);
        yield* Effect.sleep("11 seconds");
        yield* Effect.forEach(nodes, ctx.start, {
          concurrency: "unbounded",
          discard: true,
        });
        yield* equal(yield* events(ctx), [["event:flow-first", 1]]);
        yield* ctx.json("/flow/continue", "celld", "POST");
        const status = yield* ctx.poll(
          ctx.json("/flow/status"),
          (value) =>
            typeof value === "object" &&
            value !== null &&
            "status" in value &&
            value.status === "complete",
        );
        yield* checkWorkflowResult(status);
        yield* equal(yield* events(ctx), [
          ["event:flow-first", 1],
          ["event:flow-last", 1],
        ]);
        return status;
      }
      if (id.startsWith("faults.storage-")) {
        yield* acknowledgedBatch(ctx, 12);
        const mode =
          id.replace("faults.storage-", "") === "ambiguous"
            ? "drop-response"
            : id.replace("faults.storage-", "");
        yield* ctx.mode(mode, mode === "timeout" ? 12000 : 5000);
        yield* Effect.addFinalizer(() =>
          ctx.mode("normal", 0).pipe(Effect.orDie),
        );
        yield* traffic(ctx, 24);
        yield* ctx.mode("normal", 0);
        const stats = yield* ctx.transport.request(ctx.proxy, {
          path: "/stats",
        });
        yield* artifacts.json(`${id}-proxy.json`, stats.body);
        const observed = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            events: Schema.Array(StorageEvent),
          }),
        )(stats.body);
        yield* equal(
          hasStorageFaultEvidence(observed.events, mode, ctx.identity.cell),
          true,
        );
        for (const node of nodes) {
          if ((yield* fleet.inspect(node)).State.Running)
            yield* fleet.kill(node);
        }
        yield* Effect.sleep("11 seconds");
        yield* Effect.forEach(nodes, ctx.start, {
          concurrency: "unbounded",
          discard: true,
        });
        yield* acknowledgedBatch(ctx, 4);
        return yield* ctx.verify();
      }
      if (id === "faults.peer-partition") {
        yield* acknowledgedBatch(ctx, 24);
        const owner = (yield* ctx.owner()).node;
        const container = yield* fleet.inspect(owner);
        const project = container.Config.Labels["com.docker.compose.project"]!;
        const processes = yield* Processes;
        yield* processes.run("docker", [
          "network",
          "disconnect",
          `${project}_default`,
          container.Id,
        ]);
        yield* Effect.addFinalizer(() =>
          processes
            .run("docker", [
              "network",
              "connect",
              "--alias",
              `peer-${owner}`,
              `${project}_default`,
              container.Id,
            ])
            .pipe(Effect.orDie),
        );
        yield* equal(
          Object.keys((yield* fleet.inspect(owner)).NetworkSettings.Networks),
          [`${project}_store`],
        );
        const probe = yield* ctx.runtime.controls.compose([
          "exec",
          "-T",
          "proxy",
          "node",
          "--input-type=module",
          "-e",
          `try { await fetch("http://peer-${owner}:8081/health", { signal: AbortSignal.timeout(1000) }); process.exitCode = 1; } catch { console.log("peer-unreachable"); }`,
        ]);
        yield* equal(probe.stdout.trim(), "peer-unreachable");
        yield* artifacts.text("peer-partition-proof.txt", probe.stdout);
        yield* traffic(ctx, 40);
        // Restore before reading through all public endpoints. Finalizer owns reconnect.
        return {
          partitioned: owner,
          attempted: (yield* ctx.ledger.read()).filter(
            (event) => event.kind === "intent",
          ).length,
        };
      }
      if (id === "faults.rolling-deployment") {
        yield* acknowledgedBatch(ctx, 24);
        const fs = yield* FileSystem.FileSystem;
        const path = `${artifacts.directory}/fixture/worker.js`;
        const source = yield* fs.readFileString(path);
        yield* equal(source.includes("qualification-v1"), true);
        const replacement = source.replaceAll(
          "qualification-v1",
          "qualification-v2",
        );
        yield* artifacts.text("rolling-worker-v2.js", replacement);
        yield* artifacts.json("rolling-manifest.json", {
          initialSha256: sha256(source),
          replacementSha256: sha256(replacement),
        });
        yield* fs.writeFileString(path, replacement);
        const deployed = yield* ctx.runtime.controls
          .deploy()
          .pipe(
            Effect.ensuring(
              fs.writeFileString(path, source).pipe(Effect.orDie),
            ),
          );
        yield* artifacts.text("rolling-deployment.json", deployed.stdout);
        for (const node of nodes) {
          const fiber = yield* traffic(ctx, 24).pipe(Effect.forkScoped);
          yield* ctx.runtime.controls.compose([
            "stop",
            "--timeout",
            "20",
            node,
          ]);
          yield* ctx.start(node);
          yield* Fiber.join(fiber);
          yield* equal(yield* ctx.json("/service", node), {
            value: ctx.name,
            revision: "qualification-v2",
          });
          yield* ctx.verify(node);
        }
        return yield* ctx.verify();
      }
      if (id === "capacity.large-restore") {
        const count = 256; // 16 MiB of application state, checked in bounded chunks.
        for (let i = 0; i < count; i++)
          yield* equal(
            yield* ctx.json(`/blob/write?id=${i}`, "celld", "POST"),
            { id: i, bytes: 65536 },
          );
        const prior = (yield* ctx.owner()).node;
        yield* fleet.kill(prior);
        yield* Effect.sleep("11 seconds");
        yield* fleet.discard(prior);
        yield* ctx.start(prior);
        const started = Date.now();
        yield* equal(yield* ctx.json(`/blob/check?count=${count}`, prior), {
          count,
          bytes: count * 65536,
        });
        return {
          bytes: count * 65536,
          restoreAndCheckMs: Date.now() - started,
        };
      }
      if (
        id === "capacity.memory-pressure" ||
        id === "capacity.insufficient-spare"
      ) {
        yield* acknowledgedBatch(ctx, 24);
        const processes = yield* Processes;
        const constrained =
          id === "capacity.memory-pressure"
            ? nodes
            : nodes.filter((node) => node !== "celld");
        for (const node of constrained) {
          const container = yield* fleet.inspect(node);
          yield* processes.run("docker", [
            "update",
            "--memory",
            id === "capacity.insufficient-spare" ? "8m" : "128m",
            "--memory-swap",
            id === "capacity.insufficient-spare" ? "8m" : "128m",
            container.Id,
          ]);
          yield* Effect.addFinalizer(() =>
            processes
              .run("docker", [
                "update",
                "--memory",
                "512m",
                "--memory-swap",
                "512m",
                container.Id,
              ])
              .pipe(Effect.orDie),
          );
        }
        const limits = yield* Effect.forEach(constrained, (node) =>
          Effect.gen(function* () {
            const inspected = yield* fleet.inspect(node);
            const raw = yield* processes.run("docker", [
              "inspect",
              inspected.Id,
            ]);
            yield* artifacts.text(`${id}-${node}-limits.json`, raw.stdout);
            const decoded = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(
                Schema.Array(
                  Schema.Struct({
                    HostConfig: Schema.Struct({
                      Memory: Schema.Number,
                      MemorySwap: Schema.Number,
                    }),
                  }),
                ),
              ),
            )(raw.stdout);
            yield* equal(
              decoded[0]!.HostConfig.Memory,
              (id === "capacity.insufficient-spare" ? 8 : 128) * 1024 * 1024,
            );
            return decoded[0]!.HostConfig;
          }),
        );
        const pressures = yield* Effect.forEach(
          constrained,
          (node) => ctx.request("/pressure?mb=96", node).pipe(Effect.exit),
          { concurrency: "unbounded" },
        );
        yield* artifacts.json(`${id}-pressure.json`, pressures);
        const oom = yield* Effect.forEach(constrained, (node) =>
          Effect.gen(function* () {
            const container = yield* fleet.inspect(node);
            const inspected = yield* processes.run("docker", [
              "inspect",
              container.Id,
            ]);
            yield* artifacts.text(
              `${id}-${node}-after-pressure.json`,
              inspected.stdout,
            );
            const decoded = yield* Schema.decodeUnknownEffect(
              Schema.fromJsonString(
                Schema.Array(
                  Schema.Struct({
                    State: Schema.Struct({ OOMKilled: Schema.Boolean }),
                  }),
                ),
              ),
            )(inspected.stdout);
            return decoded[0]!.State.OOMKilled;
          }),
        );
        let allocationCompleted = false;
        for (const pressure of pressures)
          if (Exit.isSuccess(pressure) && pressure.value.status === 200) {
            yield* equal(pressure.value.body, { mb: 96, checksum: 4560 });
            allocationCompleted = true;
          }
        const pressureStates = yield* Effect.forEach(
          constrained,
          fleet.inspect,
        );
        const terminatedUnderLimit = pressureStates.some(
          (state) => !state.State.Running && state.State.ExitCode === 137,
        );
        yield* equal(
          allocationCompleted || oom.some(Boolean) || terminatedUnderLimit,
          true,
        );
        if (id === "capacity.insufficient-spare") {
          yield* fleet.kill("celld");
          // Both replacement nodes are below the observed runtime footprint.
          yield* equal(
            (yield* Effect.forEach(constrained, (node) =>
              fleet.inspect(node),
            )).every((state) => !state.State.Running),
            true,
          );
        }
        yield* traffic(ctx, 24);
        for (const node of nodes) {
          const state = yield* fleet.inspect(node);
          yield* artifacts.json(`${id}-${node}.json`, state);
          if (state.State.Running) yield* fleet.kill(node);
        }
        // Limits are restored before recovery by the scoped finalizers below.
        return {
          limits,
          oom,
          allocationCompleted,
          terminatedUnderLimit,
          pressures: pressures.map((exit) => exit._tag),
          acknowledged: (yield* ctx.ledger.read()).filter(
            (event) => event.kind === "ack",
          ).length,
        };
      }
      return yield* runSocketOrStream(id, ctx);
    }),
  );
import { runSocketOrStream } from "./QualificationStreams.js";

export const runQualification = (options: {
  runId: string;
  profile: string;
  suite: string;
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
    const ids = qualificationIds.filter(
      (id) =>
        (!options.caseId || id === options.caseId) &&
        (options.suite === "qualification" ||
          id.startsWith(options.suite + ".")),
    );
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
      for (const id of ids) {
        yield* executor.runCase(
          id,
          (test) =>
            Effect.gen(function* () {
              const bundle = yield* buildFixtureFor("qualification");
              // Bucket proofs for S3 fault cases ensure storage faults are on the acknowledgment path.
              const runtime = yield* acquireLocal(
                `${options.runId}-${id.replaceAll(".", "-")}`,
                bundle,
                executor.cleanupError,
                true,
                id.startsWith("faults.storage-") ? "bucket" : "fleet",
                3,
                true,
              );
              environment.candidates.push(runtime.metadata);
              const ctx = yield* makeContext(
                runtime,
                id.replaceAll(".", "-") + "-" + options.runId.slice(4, 12),
                options.seed,
              );
              yield* test.ready;
              const result = yield* runCase(id, ctx);
              if (id.startsWith("traffic."))
                yield* auditLedger({
                  ledger: ctx.ledger.path,
                  endpoint: ctx.targets.celld.baseUrl,
                  name: ctx.name,
                });
              if (
                id === "faults.peer-partition" ||
                id === "capacity.memory-pressure" ||
                id === "capacity.insufficient-spare"
              ) {
                if (id === "faults.peer-partition") {
                  const partitioned = yield* Schema.decodeUnknownEffect(
                    Schema.Struct({
                      partitioned: Schema.Literals([
                        "celld",
                        "celld2",
                        "celld3",
                      ]),
                    }),
                  )(result);
                  const other = ctx.nodes.find(
                    (node) => node !== partitioned.partitioned,
                  )!;
                  yield* ctx.verify(other);
                  // Docker removes the ephemeral published mapping on disconnect.
                  // Restart only the reconnected owner to restore its public endpoint.
                  if (
                    (yield* ctx.fleet.inspect(partitioned.partitioned)).State
                      .Running
                  )
                    yield* ctx.fleet.kill(partitioned.partitioned);
                  yield* Effect.sleep("11 seconds");
                  yield* ctx.start(partitioned.partitioned);
                }
                if (id.startsWith("capacity.")) {
                  yield* Effect.sleep("11 seconds");
                  yield* Effect.forEach(ctx.nodes, ctx.start, {
                    concurrency: "unbounded",
                    discard: true,
                  });
                }
                if (id.startsWith("capacity.")) {
                  const processes = yield* Processes;
                  for (const node of id === "capacity.memory-pressure"
                    ? ctx.nodes
                    : ctx.nodes.filter((node) => node !== "celld")) {
                    const container = yield* ctx.fleet.inspect(node);
                    const restored = yield* processes.run("docker", [
                      "inspect",
                      container.Id,
                    ]);
                    yield* artifacts.text(
                      `${id}-${node}-restored-capacity.json`,
                      restored.stdout,
                    );
                    const parsed = yield* Schema.decodeUnknownEffect(
                      Schema.fromJsonString(
                        Schema.Array(
                          Schema.Struct({
                            HostConfig: Schema.Struct({
                              Memory: Schema.Number,
                            }),
                          }),
                        ),
                      ),
                    )(restored.stdout);
                    yield* equal(
                      parsed[0]!.HostConfig.Memory,
                      512 * 1024 * 1024,
                    );
                  }
                }
                for (const node of ctx.nodes) {
                  ctx.targets[node] = yield* ctx.fleet.target(node);
                  yield* ctx.verify(node);
                }
              }
              return result;
            }).pipe(
              Effect.provide(artifactsLayer(`${artifacts.directory}/${id}`)),
            ),
          { timeout: "8 minutes", includesSetup: true },
        );
      }
    });
    yield* executor.execute(work);
  });
