import { Effect, FileSystem, Schedule, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolve } from "node:path";
import { Artifacts, decodeJson } from "./Artifacts.js";
import { TckError, type Bundle, type RuntimeHandle } from "./Domain.js";

export const ReferenceConfig = Schema.Struct({
  name: Schema.String,
  scriptPath: Schema.String,
  directory: Schema.String,
  compatibilityDate: Schema.String,
  sha256: Schema.String,
  binding: Schema.Struct({ name: Schema.String, className: Schema.String }),
});
export const ReferenceReady = Schema.Struct({
  target: Schema.Struct({ name: Schema.String, baseUrl: Schema.String }),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
});

// Miniflare installs process.exit signal handlers. Keep them outside the driver.
export const acquireReference = (
  name: string,
  bundle: Bundle,
  cleanupError: (detail: string) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const artifacts = yield* Artifacts;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const directory = resolve(artifacts.directory, name);
    yield* fs.makeDirectory(directory, { recursive: true });
    yield* artifacts.json(`${name}/config.json`, {
      name,
      directory,
      scriptPath: resolve(bundle.directory, "worker.js"),
      sha256: bundle.sha256,
      compatibilityDate: bundle.compatibilityDate,
      binding: bundle.binding,
    });
    const handle = yield* spawner.spawn(
      ChildProcess.make(
        process.execPath,
        [
          "--import",
          "tsx",
          new URL("./ReferenceProcess.ts", import.meta.url).pathname,
          resolve(directory, "config.json"),
        ],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          forceKillAfter: "2 seconds",
        },
      ),
    );
    yield* handle.all.pipe(
      Stream.decodeText(),
      Stream.runForEach((line) => artifacts.text(`${name}.log`, line, true)),
      Effect.catch((error) =>
        cleanupError(`Reference log capture: ${String(error)}`),
      ),
      Effect.forkScoped,
    );
    const ready = fs.readFileString(resolve(directory, "ready.json")).pipe(
      Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 300 }),
      Effect.flatMap((content) => decodeJson(ReferenceReady, content)),
    );
    const stopped = handle.exitCode.pipe(
      Effect.flatMap((code) =>
        Effect.fail(
          new TckError({
            phase: "reference",
            message: `${name} exited ${code} before readiness; inspect ${name}.log`,
          }),
        ),
      ),
    );
    const result = yield* Effect.raceFirst(ready, stopped).pipe(
      Effect.timeout("20 seconds"),
    );
    return result satisfies RuntimeHandle;
  });
