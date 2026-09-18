import { Effect } from "effect";
export { platform } from "../shared/Platform.js";
export const operation = <A>(body: () => A) =>
  Effect.try({ try: body, catch: (cause) => cause });
export const rejection = (effect: Effect.Effect<unknown, unknown>) =>
  effect.pipe(
    Effect.as("accepted"),
    Effect.catch((cause) =>
      Effect.succeed(cause instanceof Error ? cause.name : "Unknown"),
    ),
  );
