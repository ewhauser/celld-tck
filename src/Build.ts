import { Effect, FileSystem, Schema } from "effect";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Artifacts } from "./Artifacts.js";
import { decodeJsonc } from "./Jsonc.js";
import { TckError, type Bundle } from "./Domain.js";

const Config = Schema.Struct({
  name: Schema.String,
  main: Schema.String,
  compatibility_date: Schema.String,
  compatibility_flags: Schema.Array(Schema.String),
  durable_objects: Schema.Struct({
    bindings: Schema.Array(
      Schema.Struct({ name: Schema.String, class_name: Schema.String }),
    ),
  }),
  migrations: Schema.Array(
    Schema.Struct({
      tag: Schema.String,
      new_sqlite_classes: Schema.Array(Schema.String),
    }),
  ),
});
export const sha256 = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

export const buildFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const artifacts = yield* Artifacts;
  const directory = resolve(artifacts.directory, "fixture");
  yield* fs.makeDirectory(directory, { recursive: true });
  const config = yield* decodeJsonc(
    Config,
    yield* fs.readFileString(
      new URL("../fixtures/core/wrangler.jsonc", import.meta.url).pathname,
    ),
  );
  const binding = config.durable_objects.bindings[0];
  if (!binding)
    return yield* Effect.fail(
      new TckError({ phase: "build", message: "Missing fixture DO binding" }),
    );
  yield* Effect.tryPromise({
    try: () =>
      build({
        entryPoints: [
          new URL("../fixtures/core/worker.ts", import.meta.url).pathname,
        ],
        outfile: resolve(directory, "worker.js"),
        bundle: true,
        format: "esm",
        platform: "neutral",
        target: "es2023",
        external: ["cloudflare:*"],
        sourcemap: false,
        legalComments: "none",
        metafile: true,
      }),
    catch: (error) => new TckError({ phase: "build", message: String(error) }),
  }).pipe(
    Effect.flatMap((result) =>
      artifacts.json("fixture/build-meta.json", result.metafile),
    ),
  );
  yield* artifacts.json("fixture/wrangler.jsonc", {
    ...config,
    main: "worker.js",
    no_bundle: true,
  });
  const source = yield* fs.readFileString(resolve(directory, "worker.js"));
  const bundle: Bundle = {
    directory,
    source,
    sha256: sha256(source),
    compatibilityDate: config.compatibility_date,
    binding: { name: binding.name, className: binding.class_name },
  };
  yield* artifacts.json("fixture/manifest.json", {
    ...bundle,
    source: "worker.js",
    effect: "4.0.0-rc.115",
  });
  return bundle;
});
