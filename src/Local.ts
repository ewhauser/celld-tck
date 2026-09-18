import { Effect, Exit, FileSystem, Schema, Schedule } from "effect";
import { resolve } from "node:path";
import { fleetControls } from "./FleetControls.js";
import { DiskContainer, DiskVolume, ownedStateVolume } from "./DiskLoss.js";
import { equal } from "./Oracle.js";
import { checkDeployment } from "./DeploymentChecks.js";
import { Artifacts, decodeJson } from "./Artifacts.js";
import { sha256 } from "./Build.js";
import { TckError, type Bundle, type RuntimeHandle } from "./Domain.js";
import { Processes } from "./Processes.js";
import { cleanupAll, owned } from "./Resources.js";

const Deployment = Schema.Struct({
  worker: Schema.String,
  version: Schema.String,
  location: Schema.String,
  dry_run: Schema.Boolean,
});
const Container = Schema.Struct({
  Name: Schema.String,
  Image: Schema.String,
  Platform: Schema.String,
  Config: Schema.Struct({ Image: Schema.String }),
});

export const acquireLocal = (
  runId: string,
  bundle: Bundle,
  cleanupError: (detail: string) => Effect.Effect<void>,
  multiNode = false,
) =>
  Effect.gen(function* () {
    const processes = yield* Processes;
    const artifacts = yield* Artifacts;
    const fs = yield* FileSystem.FileSystem;
    const alternatives = process.env.TCK_COMPOSE_BIN
      ? [{ file: process.env.TCK_COMPOSE_BIN, prefix: [] as string[] }]
      : [
          { file: "docker", prefix: ["compose"] },
          { file: "docker-compose", prefix: [] },
          { file: resolve(".cache/tools/docker-compose"), prefix: [] },
        ];
    let selected: (typeof alternatives)[number] | undefined;
    for (const alternative of alternatives) {
      const check = yield* Effect.exit(
        processes.run(alternative.file, [...alternative.prefix, "version"]),
      );
      if (Exit.isSuccess(check)) {
        selected = alternative;
        break;
      }
    }
    if (!selected)
      return yield* Effect.fail(
        new TckError({
          phase: "setup",
          message:
            "Install Docker Compose or set TCK_COMPOSE_BIN to its standalone executable.",
        }),
      );
    const composeCommand = selected;
    const composePath = new URL("../infra/compose.yaml", import.meta.url)
      .pathname;
    const compose = (args: ReadonlyArray<string>) =>
      processes.run(
        composeCommand.file,
        [
          ...composeCommand.prefix,
          "--project-name",
          runId,
          "--file",
          composePath,
          ...(multiNode
            ? [
                "--file",
                new URL("../infra/multinode.yaml", import.meta.url).pathname,
              ]
            : []),
          ...args,
        ],
        { TCK_FIXTURE_DIR: bundle.directory },
      );
    yield* artifacts.text(
      "compose.yaml",
      yield* fs.readFileString(composePath),
    );
    if (multiNode)
      yield* artifacts.text(
        "multinode.yaml",
        yield* fs.readFileString(
          new URL("../infra/multinode.yaml", import.meta.url).pathname,
        ),
      );
    return yield* owned(
      Effect.gen(function* () {
        yield* compose(["up", "-d", "minio"]);
        yield* compose(["run", "--rm", "-T", "storage"]);
        const diagnosis = yield* compose([
          "run",
          "--rm",
          "-T",
          "tool",
          "diagnose",
          "--json",
        ]);
        yield* artifacts.text("diagnose.jsonl", diagnosis.stdout);
        const deploymentChecks = runId.endsWith("-core")
          ? yield* checkDeployment(bundle, compose)
          : [];
        const deployed = yield* compose([
          "run",
          "--rm",
          "-T",
          "tool",
          "deploy",
          "/fixture",
          "--json",
        ]);
        yield* artifacts.text("deployment.json", deployed.stdout);
        const deployment = yield* decodeJson(Deployment, deployed.stdout);
        if (
          !/^[a-z0-9-]+$/.test(deployment.worker) ||
          !/^[a-zA-Z0-9_-]+$/.test(deployment.version) ||
          deployment.dry_run
        ) {
          return yield* Effect.fail(
            new TckError({
              phase: "deployment",
              message: "Invalid deployment identity",
            }),
          );
        }
        const key = `local/tck/deploy/${deployment.worker}/${deployment.version}/index.js`;
        const uploaded = yield* compose([
          "run",
          "--rm",
          "-T",
          "--entrypoint",
          "mc",
          "storage",
          "cat",
          key,
        ]);
        const uploadedHash = sha256(uploaded.stdout);
        if (uploadedHash !== bundle.sha256)
          return yield* Effect.fail(
            new TckError({
              phase: "deployment",
              message: "Uploaded fixture bytes differ from reference artifact",
            }),
          );
        for (const [name, hash] of Object.entries(bundle.modules)) {
          if (!name.endsWith(".wasm")) continue;
          const wasmKey = `local/tck/deploy/${deployment.worker}/${deployment.version}/${name}`;
          const result = yield* compose([
            "run",
            "--rm",
            "-T",
            "--entrypoint",
            "/bin/sh",
            "storage",
            "-ec",
            'mc cat "$1" | sha256sum',
            "verify-module",
            wasmKey,
          ]);
          if (result.stdout.trim().split(/\s+/)[0] !== hash)
            return yield* Effect.fail(
              new TckError({
                phase: "deployment",
                message: `Uploaded module differs: ${name}`,
              }),
            );
        }
        const version = (yield* compose([
          "run",
          "--rm",
          "-T",
          "tool",
          "--version",
        ])).stdout.trim();
        yield* compose(["up", "-d", "celld", ...(multiNode ? ["celld2"] : [])]);
        const address = (yield* compose([
          "port",
          "celld",
          "8080",
        ])).stdout.trim();
        if (!/^127\.0\.0\.1:\d+$/.test(address))
          return yield* Effect.fail(
            new TckError({
              phase: "setup",
              message: `Unexpected public address: ${address}`,
            }),
          );
        const ids = (yield* compose(["ps", "-q", "--all"])).stdout
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        const inspected = yield* decodeJson(
          Schema.Array(Container),
          (yield* processes.run("docker", ["inspect", ...ids])).stdout,
        );
        const containers = inspected.map((entry) => ({
          name: entry.Name,
          image: entry.Config.Image,
          imageId: entry.Image,
          platform: entry.Platform,
        }));
        const target = {
          name: "candidate",
          baseUrl: `http://${address}`,
          engine: "celld" as const,
          version: version.replace(/^celld\s+/, ""),
        };
        const fleet = yield* fleetControls(compose, runId, target);
        let sequence = 0;
        const recordState = (label: string) =>
          Effect.gen(function* () {
            const id = (yield* compose([
              "ps",
              "--all",
              "-q",
              "celld",
            ])).stdout.trim();
            const output = yield* processes.run("docker", ["inspect", id]);
            yield* artifacts.text(
              `lifecycle-${++sequence}-${label}.json`,
              output.stdout,
            );
            return yield* decodeJson(
              Schema.Array(
                Schema.Struct({
                  State: Schema.Struct({
                    Running: Schema.Boolean,
                    ExitCode: Schema.Number,
                  }),
                }),
              ),
              output.stdout,
            );
          });
        return {
          fleet,
          lifecycle: {
            stopStorage: () =>
              Effect.gen(function* () {
                const before = (yield* recordState("before-outage"))[0]?.State;
                if (!before?.Running)
                  return yield* Effect.fail(
                    new TckError({
                      phase: "lifecycle",
                      message: "celld must be running before the outage",
                    }),
                  );
                yield* compose(["stop", "--timeout", "5", "minio"]);
                const id = (yield* compose([
                  "ps",
                  "--all",
                  "-q",
                  "minio",
                ])).stdout.trim();
                const raw = (yield* processes.run("docker", ["inspect", id]))
                  .stdout;
                yield* artifacts.text("outage-minio-stopped.json", raw);
                const state = (yield* decodeJson(
                  Schema.Array(DiskContainer),
                  raw,
                ))[0];
                if (!state || state.State.Running)
                  return yield* Effect.fail(
                    new TckError({
                      phase: "lifecycle",
                      message: "MinIO did not stop",
                    }),
                  );
              }),
            restoreStorage: () =>
              Effect.gen(function* () {
                yield* compose(["start", "minio"]);
                yield* compose([
                  "run",
                  "--no-deps",
                  "--rm",
                  "-T",
                  "--entrypoint",
                  "mc",
                  "storage",
                  "stat",
                  "local/tck",
                ]).pipe(
                  Effect.retry({
                    schedule: Schedule.spaced("500 millis"),
                    times: 10,
                  }),
                  Effect.timeout("30 seconds"),
                  Effect.mapError((error) =>
                    error instanceof TckError
                      ? error
                      : new TckError({
                          phase: "lifecycle",
                          message: String(error),
                        }),
                  ),
                );
              }),
            prepareRestart: () =>
              Effect.gen(function* () {
                const state = (yield* recordState("after-outage"))[0]?.State;
                if (!state)
                  return yield* Effect.fail(
                    new TckError({
                      phase: "lifecycle",
                      message: "Missing celld state after outage",
                    }),
                  );
                if (state.Running) {
                  yield* compose(["kill", "--signal", "SIGKILL", "celld"]);
                  const stopped = (yield* recordState(
                    "outage-restart-stopped",
                  ))[0]?.State;
                  if (!stopped || stopped.Running || stopped.ExitCode !== 137)
                    return yield* Effect.fail(
                      new TckError({
                        phase: "lifecycle",
                        message: "Could not stop celld for recovery",
                      }),
                    );
                } else if (state.ExitCode !== 3)
                  return yield* Effect.fail(
                    new TckError({
                      phase: "lifecycle",
                      message: `Unexpected celld exit after outage: ${state.ExitCode}`,
                    }),
                  );
              }),
            discardDisk: () =>
              Effect.gen(function* () {
                const inspectService = (service: string) =>
                  Effect.gen(function* () {
                    const id = (yield* compose([
                      "ps",
                      "--all",
                      "-q",
                      service,
                    ])).stdout.trim();
                    const raw = (yield* processes.run("docker", [
                      "inspect",
                      id,
                    ])).stdout;
                    yield* artifacts.text(
                      `disk-loss-${++sequence}-${service}.json`,
                      raw,
                    );
                    const entries = yield* decodeJson(
                      Schema.Array(DiskContainer),
                      raw,
                    );
                    if (entries.length !== 1)
                      return yield* Effect.fail(
                        new TckError({
                          phase: "lifecycle",
                          message: "Expected one owned container",
                        }),
                      );
                    return entries[0]!;
                  });
                const previous = yield* inspectService("celld");
                const minio = yield* inspectService("minio");
                const raw = (yield* processes.run("docker", [
                  "volume",
                  "inspect",
                  `${runId}_celld-state`,
                ])).stdout;
                yield* artifacts.text("disk-loss-old-volume.json", raw);
                const volumes = yield* decodeJson(
                  Schema.Array(DiskVolume),
                  raw,
                );
                if (volumes.length !== 1)
                  return yield* Effect.fail(
                    new TckError({
                      phase: "lifecycle",
                      message: "Expected one state volume",
                    }),
                  );
                const name = yield* ownedStateVolume(
                  runId,
                  previous,
                  volumes[0]!,
                );
                const logs = yield* compose([
                  "logs",
                  "--no-color",
                  "--timestamps",
                  "celld",
                ]);
                yield* artifacts.text(
                  "celld-before-disk-loss.log",
                  logs.stdout + logs.stderr,
                );
                yield* compose(["rm", "--force", "celld"]);
                yield* processes.run("docker", ["volume", "rm", name]);
                yield* compose(["create", "celld"]);
                const replacement = yield* inspectService("celld");
                if (replacement.Id === previous.Id)
                  return yield* Effect.fail(
                    new TckError({
                      phase: "lifecycle",
                      message: "Container was not replaced",
                    }),
                  );
                // Verify the recreated disk is empty before any celld process can use it.
                yield* compose([
                  "run",
                  "--no-deps",
                  "--rm",
                  "-T",
                  "--volume",
                  `${name}:/empty:ro`,
                  "--entrypoint",
                  "/bin/sh",
                  "storage",
                  "-ec",
                  'entries=$(ls -A /empty); test -z "$entries"',
                ]);
                yield* equal(yield* inspectService("minio"), minio);
                yield* artifacts.json("disk-loss.json", {
                  removedVolume: name,
                  oldContainer: previous.Id,
                  newContainer: replacement.Id,
                  emptyBeforeStart: true,
                  minioUnchanged: true,
                });
              }),
            stop: (crash: boolean) =>
              Effect.gen(function* () {
                const before = (yield* recordState("before-stop"))[0]?.State;
                if (!before?.Running)
                  return yield* Effect.fail(
                    new TckError({
                      phase: "lifecycle",
                      message:
                        "Expected a running container before fault injection",
                    }),
                  );
                yield* compose(
                  crash
                    ? ["kill", "--signal", "SIGKILL", "celld"]
                    : ["stop", "--timeout", "20", "celld"],
                );
                const state = (yield* recordState("stopped"))[0]?.State;
                if (
                  !state ||
                  state.Running ||
                  (crash ? state.ExitCode !== 137 : state.ExitCode !== 0)
                )
                  return yield* Effect.fail(
                    new TckError({
                      phase: "lifecycle",
                      message:
                        "Container did not stop with the expected exit status",
                    }),
                  );
              }),
            start: () =>
              Effect.gen(function* () {
                yield* compose(["start", "celld"]);
                const started = (yield* recordState("started"))[0]?.State;
                if (!started?.Running)
                  return yield* Effect.fail(
                    new TckError({
                      phase: "lifecycle",
                      message: "Container did not start",
                    }),
                  );
                const endpoint = (yield* compose([
                  "port",
                  "celld",
                  "8080",
                ])).stdout.trim();
                if (!/^127\.0\.0\.1:\d+$/.test(endpoint))
                  return yield* Effect.fail(
                    new TckError({
                      phase: "lifecycle",
                      message: "Invalid restarted endpoint",
                    }),
                  );
                return { ...target, baseUrl: `http://${endpoint}` };
              }),
          },
          target: {
            name: "candidate",
            baseUrl: `http://${address}`,
            engine: "celld",
            version: version.replace(/^celld\s+/, ""),
          },
          metadata: {
            deploymentChecks,
            engine: "celld",
            version,
            project: runId,
            storage: "minio",
            durability: "bucket",
            nodes: multiNode ? 2 : 1,
            fixtureSha256: uploadedHash,
            containers,
          },
        } satisfies RuntimeHandle & { fleet: typeof fleet };
      }),
      cleanupAll([
        compose(["logs", "--no-color", "--timestamps"]).pipe(
          Effect.flatMap((output) =>
            artifacts.text("celld.log", output.stdout + output.stderr),
          ),
        ),
        compose(["down", "--volumes", "--remove-orphans", "--timeout", "10"]),
      ]),
      cleanupError,
    );
  });
