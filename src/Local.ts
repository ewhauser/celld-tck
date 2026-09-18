import { Effect, Exit, FileSystem, Schema } from "effect";
import { resolve } from "node:path";
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
          ...args,
        ],
        { TCK_FIXTURE_DIR: bundle.directory },
      );
    yield* artifacts.text(
      "compose.yaml",
      yield* fs.readFileString(composePath),
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
        yield* compose(["up", "-d", "celld"]);
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
        return {
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
            nodes: 1,
            fixtureSha256: uploadedHash,
            containers,
          },
        } satisfies RuntimeHandle;
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
