# Local compatibility findings

The suite compares pinned celld v0.5.0 with Miniflare 4.20260730.0 / workerd 1.20260730.1 at compatibility date 2026-07-30. All authored TypeScript uses Effect 4.0.0-rc.115. These are local observations, not AWS or managed Cloudflare qualification.

## Current known-bug policy validation

- `pnpm check`: formatting, three TypeScript projects, and 30 harness tests passed.
- Full local run: **65 passed, 2 divergences, 2 known bugs**, exit 0 (`tck-b3d376f9-1c06-49c1-8919-9f0cdf333d7b`).
- Reference reproductions: **2 passed**, exit 0 (`tck-e1f63e03-89b2-4b67-a101-206498064bb0`).
- Local reproductions: **2 known bugs**, exit 0 (`tck-7c0e3f3e-47bd-46ed-9a5f-a759e0d255e1`).

- Strict local reproductions (`--known-bugs error`): **2 failures**, exit 1, no harness errors (`tck-6ca002bf-eac4-4440-8c6c-d6af63908d0f`).

## Original strict baseline

- Reference self-check: **63/63 passed** (`tck-2be81d98-acd3-4f22-92e6-eb0a63c09b3d`).
- Full local run: **65 passed, 2 documented divergences, 2 failures** across 63 differential cases and 6 deployment checks (`tck-7c8c6cf9-b2f3-4d2d-b2c0-8c21b7fbca7d`). All cases reached terminal results; no case-level infrastructure/reference errors.
- Exit status is 1 for the local run because the two unexpected differences remain failures. CI has been configured but was not run remotely.

Evidence is under `artifacts/<run-id>/report.json` and accompanying files; artifacts are intentionally ignored by Git. The full local run includes the Workflow retry/event and extension cases, unlike earlier incremental runs.

## Unexpected differences

| Case                    | workerd expectation                                                                             | celld observation                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `http.body-consumption` | Reading an already-consumed Request body rejects with `TypeError`.                              | A second `.text()` call is accepted. Cloning after consumption still rejects. |
| `storage.invalid-input` | Negative list limit rejects with `TypeError`; storing a function rejects with `DataCloneError`. | Both operations reject, but with `Error` and `TypeError`, respectively.       |

Both remain semantic contract violations. The [bug registry](BUGS.md) now classifies their exact celld 0.5.0 observations as `known-bug`; default runs allow these results, while `--known-bugs error` preserves strict failure behavior. Unexpected observations remain failures. The error-type difference is a compatibility observation, not a claim of data loss.

## Isolated upstream reproductions

The dedicated `repros` suite passes both cases on the reference self-check and reproduces both violations against celld v0.5.0, with no setup or cleanup errors. Current default runs classify both as known bugs. It confirms repeated consumption for all five readers on both Request and Response, incorrect `bodyUsed` after reading null bodies, and storage error-class differences in asynchronous, synchronous, and batch operations. The rejected batch produced no partial writes.

[Three prepared upstream reports](upstream/README.md) include minimal reproductions, pinned source analysis, repair boundaries, and checked-in observations. They remain local drafts; no upstream fix or issue submission is claimed.

## Documented divergences

- `cache.documented-miss`: celld deliberately implements an always-miss cache. The candidate must return no match and `false` for deletion after `put`; workerd must retrieve the stored response. [celld cache contract](https://celld.dev/docs/cloudflare-compat/#cache).
- `rpc.returned-target`: workerd can return a live `RpcTarget` and invoke it; celld rejects the stub crossing an isolate boundary. The fixture captures the rejection as an observation. [celld RPC contract](https://celld.dev/docs/cloudflare-compat/#rpc).

These expectations are restricted to celld 0.5.0, have exact candidate checks and review metadata, and are reported separately. An unexpected conformance pass or changed candidate result fails pending review. They do not apply to the reference-versus-reference self-check.

## Infrastructure evidence

Two runs encountered a connection reset during celld's conditional-write storage diagnostic, before API cases started:

- `tck-9b34c9d9-de59-4eaf-9fab-41dc76326aae` (extensions setup).
- `tck-fa6996a9-1724-4166-80ea-e848ecb2bebe` (core setup).

The diagnostic failed while updating its probe object, reported that the write may have committed, and returned exit 1. The harness did not bypass or automatically retry it. The raw diagnosis is retained in each run's `commands.jsonl`; cleanup ran and unexecuted cases remained infrastructure errors. Other runs completed storage diagnostics and all selected API cases. This transient local storage/transport issue remains unresolved and is not relabeled as API incompatibility.

## Scope

See [coverage.json](coverage.json) for exact coverage and exclusions. The corpus exercises real network HTTP/WebSocket calls, actual alarms, Queue delivery/retry, Workflow execution/retry/events, and uploaded fixture modules. Miniflare's KV/D1/R2/Queues/Workflows implementations remain local service emulators. Passing these cases does not establish edge caching, production service latency, host-failure durability, hibernation, or multi-node correctness.

No upstream fixes, commits, pushes, or cloud deployments are part of this change.
