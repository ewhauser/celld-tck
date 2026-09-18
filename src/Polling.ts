import { Duration, Effect, Schedule } from "effect";
import { TckError, type Observation } from "./Domain.js";

export interface PollOptions<E> {
  readonly interval: Duration.Input;
  readonly attempts: number;
  readonly timeout: Duration.Input;
  readonly retryable: (error: E) => boolean;
}

// Callers supply read-only probes and explicitly choose transient failures.
export const retryRead = <A, E, R>(
  probe: Effect.Effect<A, E, R>,
  options: PollOptions<E>,
) =>
  probe.pipe(
    Effect.retry({
      while: options.retryable,
      schedule: Schedule.spaced(options.interval),
      times: options.attempts - 1,
    }),
    Effect.timeout(options.timeout),
  );

export const pendingPhase = (phase: string) => (error: unknown) =>
  error instanceof TckError && error.phase === phase;

export const pollUntil = <A, E, R>(
  probe: Effect.Effect<A, E, R>,
  done: (value: A) => boolean,
  options: {
    interval: Duration.Input;
    attempts: number;
    timeout: Duration.Input;
    message: string;
  },
) =>
  retryRead(
    probe.pipe(
      Effect.flatMap((value) =>
        done(value)
          ? Effect.succeed(value)
          : Effect.fail(
              new Pending({ phase: "pending", message: options.message }),
            ),
      ),
    ),
    { ...options, retryable: (error) => error instanceof Pending },
  );

// Distinguish our pending outcome from a probe failure with the same phase.
class Pending extends TckError {}

// HTTP readiness may be temporarily unavailable. A successful response is returned
// unchanged so its semantic assertions run once, outside the retry loop.
export const waitForReady = <E, R>(
  probe: Effect.Effect<Observation, E, R>,
  options: Omit<PollOptions<E>, "retryable">,
) =>
  retryRead(
    probe.pipe(
      Effect.flatMap((response) =>
        response.status === 200
          ? Effect.succeed(response)
          : response.status === 502 ||
              response.status === 503 ||
              response.status === 504
            ? Effect.fail(
                new Pending({
                  phase: "readiness",
                  message: `HTTP ${response.status} while waiting for readiness`,
                }),
              )
            : Effect.fail(
                new TckError({
                  phase: "assertion",
                  message: `Unexpected readiness HTTP ${response.status}`,
                }),
              ),
      ),
    ),
    {
      ...options,
      retryable: (error) =>
        error instanceof Pending || pendingPhase("http")(error),
    },
  );
