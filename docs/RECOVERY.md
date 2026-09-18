# Local restart and recovery tests

Run `pnpm test:recovery` (equivalent to `pnpm tck --profile local --suite recovery`). No AWS account is required. These are celld lifecycle invariants, separate from the 63-case differential API corpus; the reference profile is rejected because it has no Docker lifecycle control.

| Case                     | Fault                                                                                  | Checks after restart                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `recovery.graceful`      | Stop celld gracefully, confirm exit 0, start the same container                        | Acknowledged KV and SQL state, deleted key remains absent, rolled-back changes remain absent |
| `recovery.crash`         | SIGKILL, confirm exit 137, start the same container                                    | The same acknowledged-state invariants                                                       |
| `recovery.overdue-alarm` | Set an alarm, SIGKILL before its deadline, leave celld down past the deadline, restart | Persisted state and eventual alarm execution                                                 |

Each case uses a separate DO identity and records a per-activation random token. Before injecting the fault, the driver verifies the acknowledged state. After restarting, it requires both exact recovered values and a changed activation token. An acknowledgment is a complete successful HTTP response; no in-flight write is assumed absent after a crash. SQL cursors are consumed before responding.

The alarm test proves the container is stopped before the five-second alarm deadline. If stopping takes too long, the test fails rather than silently testing a live alarm. It then waits 11 seconds, beyond the pinned celld default ten-second lease lifetime, before restarting. Polling is bounded and only retries pending alarm completion; ordinary state assertions and write operations do not retry. Reads after restart may activate the object, so this does not prove autonomous alarm discovery without application traffic or exactly-once delivery.

Both celld's local disk and MinIO's disk are retained during each restart. The entire owned Compose project is removed afterward, including volumes. This establishes process restart behavior, not recovery after disk loss, host failure, object-store failure, or multi-node failover. It does not qualify MinIO as production S3. The durability expectations follow [celld's published guarantees](https://celld.dev/docs/guarantees/).

## Evidence and failure handling

Each run saves fixture hashes, deployment metadata, raw HTTP and commands, before/stopped/started Docker inspections, case observations, logs, JSON results, and JUnit results. Each fault checks Docker's stopped status and exit code. The driver refreshes the public endpoint after start, then waits for readiness. Failed lifecycle cases stop subsequent scenarios, which remain explicit infrastructure errors, and cleanup still runs. Known-bug API waivers do not apply to recovery cases.

Use `--case recovery.crash` with `--suite recovery` for a focused run. The suite has an eight-minute deadline and each scenario has a two-minute deadline. Readiness and alarm completion each have separate bounds. A kill is restricted to the run-owned celld service; MinIO and unrelated Docker projects are not restarted.

Future local extensions: restoring without the celld disk, ambiguous in-flight transaction outcomes, object-store outages, and multi-node fencing/failover. These need distinct fault controls and oracles; the current tests do not imply coverage of them.
