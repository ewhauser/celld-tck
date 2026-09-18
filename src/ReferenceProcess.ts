import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Schema } from "effect";
import { Log, LogLevel, Miniflare } from "miniflare";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { decodeJson } from "./Artifacts.js";
import { sha256 } from "./Build.js";
import { TckError } from "./Domain.js";
import { ReferenceConfig } from "./Reference.js";

// The parent owns this entire process and captures stdout/stderr. Miniflare's
// own signal hook can safely stop workerd here without terminating the driver.
const program = Effect.scoped(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Schema.decodeUnknownEffect(Schema.String)(
      process.argv[2],
    );
    const config = yield* decodeJson(
      ReferenceConfig,
      yield* fs.readFileString(path),
    );
    const source = yield* fs.readFileString(config.scriptPath);
    if (sha256(source) !== config.sha256)
      return yield* Effect.fail(
        new TckError({
          phase: "reference",
          message: "Fixture changed before reference startup",
        }),
      );
    const runtime = yield* Effect.acquireRelease(
      Effect.try({
        try: () =>
          new Miniflare({
            name: "celld-tck-core",
            modules: true,
            modulesRoot: dirname(config.scriptPath),
            script: source,
            scriptPath: config.scriptPath,
            compatibilityDate: config.compatibilityDate,
            compatibilityFlags: [],
            durableObjects: {
              [config.binding.name]: {
                className: config.binding.className,
                useSQLite: true,
              },
            },
            durableObjectsPersist: resolve(config.directory, "state"),
            host: "127.0.0.1",
            port: 0,
            cf: false,
            log: new Log(LogLevel.INFO),
          }),
        catch: (error) =>
          new TckError({ phase: "reference", message: String(error) }),
      }),
      (runtime) => Effect.promise(() => runtime.dispose()),
    );
    const url = yield* Effect.tryPromise({
      try: () => runtime.ready,
      catch: (error) =>
        new TckError({ phase: "reference", message: String(error) }),
    });
    const require = createRequire(import.meta.url);
    const fromMiniflare = createRequire(
      require.resolve("miniflare/package.json"),
    );
    const ready = {
      target: { name: config.name, baseUrl: url.origin },
      metadata: {
        engine: "workerd",
        miniflare: require("miniflare/package.json").version,
        workerd: fromMiniflare("workerd/package.json").version,
        fixtureSha256: config.sha256,
      },
    };
    // Atomic publish: the parent must never parse a half-written JSON document.
    const pending = resolve(config.directory, "ready.tmp");
    yield* fs.writeFileString(pending, JSON.stringify(ready));
    yield* fs.rename(pending, resolve(config.directory, "ready.json"));
    yield* Effect.never;
  }),
);

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
