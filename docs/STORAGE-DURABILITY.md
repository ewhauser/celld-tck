# Storage durability

The API suite and fault suite cover explicit durability barriers, unfinished SQL cursors, and runtime deadlines. Expectations follow the [celld v0.5.0 compatibility contract](https://github.com/denoland/celld/blob/v0.5.0/docs/cloudflare-compat.md) and [Cloudflare SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/).

## Portable API cases

These fixtures run unchanged on workerd and celld:

| Case                        | Required behavior                                                                                                                         |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `storage.sync-committed`    | `sync()` completes after committed SQL writes and KV writes/deletes using `allowUnconfirmed`; repeated barriers preserve the exact state. |
| `sql.consumed-write-cursor` | Draining an `INSERT … RETURNING` cursor permits `sync()` and preserves every returned and stored row.                                     |
| `sql.open-read-cursor`      | An open read cursor permits `sync()` and retains the remaining rows when no concurrent writer intervenes.                                 |

## Local fault cases

Run `pnpm test:faults`, or select one case:

```sh
pnpm tck --profile local --suite faults --case faults.sync-recovery
```

| Case                           | Required behavior                                                                                                                                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `faults.sync-recovery`         | Acknowledged SQL and KV writes survive a restart of all three nodes using bucket durability.                                                                                                                        |
| `faults.sync-outage`           | `sync()` rejects while the object's storage uploads are throttled. After storage recovery and fleet restart, previously acknowledged state survives. The unacknowledged replacement value may survive or be absent. |
| `faults.sync-transaction`      | `sync()` rejects inside an open transaction; rollback removes its SQL write.                                                                                                                                        |
| `faults.write-cursor-sync`     | `sync()` rejects an unfinished write cursor without consuming its remaining rows.                                                                                                                                   |
| `faults.write-cursor-response` | An unfinished write cursor prevents a successful response.                                                                                                                                                          |
| `faults.write-cursor-outbound` | An unfinished write cursor prevents an outbound request from reaching a separate witness object. A consumed cursor first proves that the witness path works.                                                        |
| `faults.transaction-deadline`  | A transaction held open for 40 seconds hits the runtime's 30-second limit, resets the object, and rolls back the pending SQL write.                                                                                 |
| `faults.gate-deadline`         | A gate held open for 40 seconds hits the same limit, resets the object, and preserves committed state.                                                                                                              |

Deadline cases require a runtime timeout response between 25 and 45 seconds and a changed activation token. Their driver deadline is 50 seconds; a driver timeout or unrelated handler error cannot pass. The outage case uses `allowUnconfirmed` and identifies rejection from the explicit `sync()` call, so an ordinary output-gate failure cannot substitute for the barrier. Fault evidence must identify the test object's storage path. A scoped finalizer clears the fault even when an assertion fails.

Every new semantic oracle has deliberate negative examples: lost writes, stale values, leaked output, accepted barriers, missing cursor rows, unchanged activations, early failures, and unrolled-back transactions. Portable positive observations are captured from actual workerd runs.

## Remaining coverage

These cases do not establish `sync()` rejection after object abort, interrupted peer replication during a barrier, or AWS durability. The restart case retains local disks and MinIO; it does not simulate permanent loss of every replica or an availability zone. Existing disk-loss and partition cases provide separate coverage. Post-abort `sync()` needs an observable result that distinguishes barrier rejection from the abort itself before it can be claimed as covered.
