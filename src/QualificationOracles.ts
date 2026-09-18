import { Effect, Schema } from "effect";
export const StorageEvent = Schema.Struct({
  mode: Schema.String,
  path: Schema.String,
  method: Schema.String,
  upstreamStatus: Schema.optionalKey(Schema.Int),
  dropped: Schema.optionalKey(Schema.Boolean),
});
export const hasStorageFaultEvidence = (
  events: readonly (typeof StorageEvent.Type)[],
  mode: string,
  cell: string,
) =>
  events.some(
    (event) =>
      event.mode === mode &&
      (event.path.includes(`/cells/Recovery:${cell}/ltx/`) ||
        event.path.includes(`/cells/Recovery%3A${cell}/ltx/`)) &&
      (mode !== "drop-response" ||
        (event.method === "PUT" &&
          event.upstreamStatus === 200 &&
          event.dropped === true)),
  );
export const checkWorkflowResult = (value: unknown) =>
  Schema.decodeUnknownEffect(
    Schema.Struct({
      status: Schema.Literal("complete"),
      output: Schema.Struct({
        first: Schema.Literal(1),
        last: Schema.Literal(1),
      }),
    }),
  )(value).pipe(Effect.asVoid);
