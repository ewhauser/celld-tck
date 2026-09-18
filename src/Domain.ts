import { Context, Data, Effect, Schema } from "effect";

export class TckError extends Data.TaggedError("TckError")<{
  readonly phase: string;
  readonly message: string;
  readonly detail?: string;
}> {}

export const Target = Schema.Struct({
  name: Schema.String,
  baseUrl: Schema.String,
});
export type Target = typeof Target.Type;
export const Observation = Schema.Struct({
  status: Schema.Int,
  headers: Schema.Record(Schema.String, Schema.String),
  body: Schema.Unknown,
});
export type Observation = typeof Observation.Type;
export interface RequestSpec {
  readonly path: string;
  readonly method?: "GET" | "POST";
  readonly body?: string;
  readonly headers?: Readonly<Record<string, string>>;
}
export class Transport extends Context.Service<
  Transport,
  {
    readonly request: (
      target: Target,
      spec: RequestSpec,
    ) => Effect.Effect<Observation, TckError>;
  }
>()("tck/Transport") {}

export interface CaseInput {
  readonly namespace: string;
  readonly seed: number;
}
export interface TestCase {
  readonly id: string;
  readonly contract: string;
  readonly run: (
    target: Target,
    input: CaseInput,
  ) => Effect.Effect<unknown, TckError, Transport>;
  readonly check: (
    value: unknown,
    input: CaseInput,
  ) => Effect.Effect<void, TckError>;
  readonly compare: (
    reference: unknown,
    candidate: unknown,
  ) => Effect.Effect<void, TckError>;
}
export const CaseResult = Schema.Struct({
  id: Schema.String,
  status: Schema.Literals([
    "pass",
    "fail",
    "reference-error",
    "infrastructure-error",
  ]),
  durationMs: Schema.Number,
  reference: Schema.optionalKey(Schema.Unknown),
  candidate: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.String),
});
export type CaseResult = typeof CaseResult.Type;

export interface Bundle {
  readonly directory: string;
  readonly source: string;
  readonly sha256: string;
  readonly compatibilityDate: string;
  readonly binding: { readonly name: string; readonly className: string };
}
export interface RuntimeHandle {
  readonly target: Target;
  readonly metadata: Readonly<Record<string, unknown>>;
}
export type Profile = "local" | "reference";
export const Report = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  runId: Schema.String,
  profile: Schema.Literals(["local", "reference"]),
  seed: Schema.Int,
  startedAt: Schema.String,
  completedAt: Schema.String,
  environment: Schema.Record(Schema.String, Schema.Unknown),
  cases: Schema.Array(CaseResult),
  errors: Schema.Array(Schema.String),
  success: Schema.Boolean,
});
export type Report = typeof Report.Type;
