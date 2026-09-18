import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { artifactsLayer } from "./Artifacts.js";
import { TckError } from "./Domain.js";
import { processesLayer } from "./Processes.js";
import { runMultinode } from "./Multinode.js";
import { runRecovery } from "./Recovery.js";
import { runSuite, selectCases } from "./Runner.js";
import { transportLayer } from "./Transport.js";

const cli = Command.make(
  "celld-tck",
  {
    profile: Flag.Literals("profile", ["local", "reference"]).pipe(
      Flag.withDefault("local"),
    ),
    suite: Flag.Literals("suite", [
      "all",
      "core",
      "bindings",
      "node",
      "extensions",
      "repros",
      "recovery",
      "multinode",
      "fleet",
      "resilience",
    ]).pipe(Flag.withDefault("all")),
    knownBugs: Flag.Literals("known-bugs", ["allow", "error"]).pipe(
      Flag.withDefault("allow"),
    ),
    seed: Flag.Int("seed").pipe(Flag.withDefault(42)),
    caseId: Flag.String("case").pipe(Flag.withDefault("")),
    output: Flag.String("output").pipe(Flag.withDefault("artifacts")),
  },
  (options) =>
    Effect.gen(function* () {
      if (options.seed < 0 || options.seed > 0xffffffff)
        return yield* Effect.fail(
          new TckError({
            phase: "arguments",
            message: "Seed must be an unsigned 32-bit integer",
          }),
        );
      if (
        options.suite !== "recovery" &&
        options.suite !== "multinode" &&
        options.suite !== "fleet" &&
        options.suite !== "resilience"
      )
        yield* selectCases(options.caseId, options.suite);
      const runId = `tck-${yield* Effect.sync(() => randomUUID())}`;
      const services = Layer.mergeAll(processesLayer, transportLayer).pipe(
        Layer.provideMerge(artifactsLayer(resolve(options.output, runId))),
      );
      const run =
        options.suite === "resilience"
          ? runMultinode({
              ...options,
              runId,
              durability: "fleet",
              resilience: true,
            })
          : options.suite === "fleet"
            ? runMultinode({ ...options, runId, durability: "fleet" })
            : options.suite === "multinode"
              ? runMultinode({ ...options, runId })
              : options.suite === "recovery"
                ? runRecovery({ ...options, runId })
                : runSuite({ ...options, runId, suite: options.suite });
      yield* run.pipe(Effect.provide(services));
    }),
);

Command.run(cli, { version: "0.0.0" }).pipe(
  Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
  NodeRuntime.runMain,
);
