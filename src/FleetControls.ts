import { Effect, Schema } from "effect";
import { Artifacts, decodeJson } from "./Artifacts.js";
import { Processes } from "./Processes.js";
import { TckError, type Target } from "./Domain.js";
import { equal } from "./Oracle.js";
export const Node = Schema.Literals(["celld", "celld2"]);
export type Node = typeof Node.Type;
export const Owner = Schema.Struct({ node: Node, epoch: Schema.Int });
export const fleetControls = (
  compose: (
    args: readonly string[],
  ) => Effect.Effect<{ stdout: string; stderr: string }, TckError>,
  project: string,
  base: Target,
) =>
  Effect.gen(function* () {
    const processes = yield* Processes;
    const artifacts = yield* Artifacts;
    let sequence = 0;
    const inspect = (node: Node) =>
      Effect.gen(function* () {
        const id = (yield* compose(["ps", "--all", "-q", node])).stdout.trim();
        const raw = (yield* processes.run("docker", ["inspect", id])).stdout;
        yield* artifacts.text(`fleet-${++sequence}-${node}.json`, raw);
        const entries = yield* decodeJson(
          Schema.Array(
            Schema.Struct({
              Id: Schema.String,
              Config: Schema.Struct({
                Labels: Schema.Record(Schema.String, Schema.String),
              }),
              State: Schema.Struct({
                Running: Schema.Boolean,
                ExitCode: Schema.Int,
              }),
              NetworkSettings: Schema.Struct({
                Networks: Schema.Record(Schema.String, Schema.Unknown),
              }),
            }),
          ),
          raw,
        );
        if (entries.length !== 1)
          return yield* Effect.fail(
            new TckError({
              phase: "fleet",
              message: "Expected one node container",
            }),
          );
        const state = entries[0]!;
        yield* equal(
          state.Config.Labels["com.docker.compose.project"],
          project,
        );
        yield* equal(state.Config.Labels["com.docker.compose.service"], node);
        return state;
      });
    const target = (node: Node) =>
      Effect.gen(function* () {
        const address = (yield* compose(["port", node, "8080"])).stdout.trim();
        if (!/^127\.0\.0\.1:\d+$/.test(address))
          return yield* Effect.fail(
            new TckError({
              phase: "fleet",
              message: "Invalid public endpoint",
            }),
          );
        return { ...base, name: node, baseUrl: `http://${address}` };
      });
    return {
      inspect,
      target,
      owner: (cell: string) =>
        Effect.gen(function* () {
          if (!/^[a-f0-9]{64}$/.test(cell))
            return yield* Effect.fail(
              new TckError({
                phase: "fleet",
                message: "Invalid cell identity",
              }),
            );
          const raw = (yield* compose([
            "run",
            "--rm",
            "-T",
            "--entrypoint",
            "mc",
            "storage",
            "cat",
            `local/tck/cells/Recovery:${cell}/own.json`,
          ])).stdout;
          yield* artifacts.text(`owner-${++sequence}.json`, raw);
          return yield* decodeJson(Owner, raw);
        }),
      kill: (node: Node) =>
        Effect.gen(function* () {
          yield* equal((yield* inspect(node)).State.Running, true);
          yield* compose(["kill", "--signal", "SIGKILL", node]);
          yield* equal((yield* inspect(node)).State, {
            Running: false,
            ExitCode: 137,
          });
        }),
      start: (node: Node) =>
        Effect.gen(function* () {
          yield* compose(["start", node]);
          return yield* target(node);
        }),
      partition: (node: Node) =>
        Effect.gen(function* () {
          const before = yield* inspect(node);
          yield* equal(before.State.Running, true);
          yield* equal(
            Object.keys(before.NetworkSettings.Networks).sort(),
            [`${project}_default`, `${project}_store`].sort(),
          );
          yield* processes.run("docker", [
            "network",
            "disconnect",
            `${project}_store`,
            before.Id,
          ]);
          yield* equal(
            Object.keys((yield* inspect(node)).NetworkSettings.Networks),
            [`${project}_default`],
          );
        }),
      reconnect: (node: Node) =>
        Effect.gen(function* () {
          const current = yield* inspect(node);
          yield* processes.run("docker", [
            "network",
            "connect",
            `${project}_store`,
            current.Id,
          ]);
        }),
      logs: (node: Node) =>
        Effect.gen(function* () {
          const logs = yield* compose([
            "logs",
            "--no-color",
            "--timestamps",
            node,
          ]);
          return logs.stdout + logs.stderr;
        }),
    };
  });
