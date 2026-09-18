# celld-tck

An independent API compatibility test kit for celld, written in **Effect v4 RC.115**. Identical Worker/Durable Object bundles run on workerd and real celld. The external driver checks each engine against semantic expectations before comparing observations.

The local API corpus contains **63 differential cases plus 6 celld deployment checks**. It covers the API families in [docs/coverage.json](docs/coverage.json). This is a versioned contract corpus, not an exhaustive proof for every API input or distributed schedule. Single-node process restart and disk-loss recovery tests are available separately in [docs/RECOVERY.md](docs/RECOVERY.md). AWS provisioning, multi-node recovery, container/Sandbox APIs, and managed Cloudflare qualification are separate work.

## Run

Use Node **24.21.0** and pnpm **11.15.0**. Start Docker for the local profile. The runner accepts `docker compose` or `docker-compose`; `TCK_COMPOSE_BIN` can point to a standalone executable. A project-local `.cache/tools/docker-compose` is also recognized. No cloud credentials are needed.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:reference
pnpm test:local
pnpm test:recovery
```

`test:reference` runs two independently persisted workerd instances; it validates the harness and expectations. `test:local` compares workerd with actual celld backed by MinIO using bucket durability. An unexpected failed compatibility case makes the command exit nonzero, while the remaining cases continue. Exact version-scoped [known bugs](docs/BUGS.md) are reported separately and do not fail the default run; use `--known-bugs error` for strict enforcement. **A complete test suite does not imply that celld passes it.** See [docs/FINDINGS.md](docs/FINDINGS.md) for the observed differences.

```sh
pnpm tck --profile local --suite bindings
pnpm tck --profile reference --suite extensions
pnpm tck --profile local --case storage.transaction-rollback --seed 123
pnpm tck --profile reference --output ./artifacts
pnpm tck --help
```

Suites:

| Suite           | Coverage                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `all` (default) | All 63 conformance cases, with separate deployments for compatibility profiles                                                                                                                         |
| `core`          | HTTP bodies/headers/forms/encoding/redirects/abort, identity, async and synchronous storage, SQL, concurrency gates, DO RPC, alarms, streams, WebSockets, crypto, HTMLRewriter, cache, background work |
| `bindings`      | Named service RPC, KV, D1, R2, Queue batch/ack/retry, Workflow steps/sleep/retry/events                                                                                                                |
| `node`          | Buffer, paths/events, async context, hashing and compression under `nodejs_compat`                                                                                                                     |
| `extensions`    | Static assets, compiled WebAssembly, Dynamic Workers, facet storage/isolation                                                                                                                          |

The explicit `repros` suite contains two additional isolated diagnostic cases for the current upstream failures. See [prepared upstream reports](docs/upstream/README.md) for reproductions, source analysis, and retained observations. These cases are excluded from the default `all` suite.

The six deployment checks run whenever the local run includes the core fixture (`core` or `bindings` cases). They validate a successful dry run, then rejection of routes, unsupported bindings, invalid names, legacy migrations, and a missing DO class. A generic Docker error cannot satisfy an expected rejection. These celld-specific checks do not run in the reference self-check.

## Contracts and evidence

Each run writes `artifacts/tck-<uuid>/`:

- `report.json`, `junit.xml`: all selected cases, documented divergences, infrastructure/reference errors, and cleanup failures.
- `coverage.json`, `run.json`: declared coverage, explicit exclusions, selected/unselected IDs, seed, and version-scoped divergence records.
- `commands.jsonl`, `http.jsonl`, and `websocket-*.json`: raw process/HTTP/protocol evidence.
- `core/`, `node/`, `extensions/`: per-deployment case records, fixture modules/hashes, rendered config, runtime logs, diagnosis, and retained reference state.
- `core/deployment-checks.json`: celld-specific configuration observations.

Reports record tool versions, source revision and dirty state, compatibility flags, image IDs, storage mode, architecture, and lockfile/fixture hashes. The build includes Effect in each fixture. Both runtimes receive the same JavaScript and wasm modules; the local adapter verifies the uploaded module hashes. Readiness includes a real DO storage write/read. Storage diagnostics must pass before deployment.

Assertions preserve ordering where it is part of the contract. The rich-value observation codec distinguishes missing/undefined/null, BigInt, special numbers, byte views, ArrayBuffer, Date, Map, and Set; it rejects unsupported or cyclic observations explicitly. Concurrent increment cases validate every state transition rather than only the final counter. Alarms, Queue delivery, and Workflows use real runtime execution and bounded polling; no reference-only event injection is used.

The cache and returned-RPC-target cases have documented, version-scoped divergences: celld implements an always-miss cache and rejects transferring RPC stubs across isolates. Each is reported as `divergence` in JSON and skipped with an explanation in JUnit, never as a compatibility pass. An unexpected pass, a changed divergent result, or a different celld version fails and requires review. Other registered bugs are reported as `known-bug`, with exact version and observation checks described in [docs/BUGS.md](docs/BUGS.md). Unregistered mismatches remain failures.

The coverage manifest is checked against the executable catalog before provisioning. Missing or duplicated cases fail validation. Every selected case starts with an infrastructure-error placeholder; an unexecuted case can never disappear or pass. Cases do not retry after failures. Only readiness and observable asynchronous completion use bounded polling. Per-request deadline: 10 seconds; each case side: 30 seconds; complete run: 10 minutes. Responses are limited to 1 MiB and command output to 8 MiB per stream.

## Resource ownership

Each fixture deployment owns a unique Compose project, private network, volumes, and reference state directory. Only the celld public listener is exposed, on an ephemeral loopback port. MinIO credentials are disposable local test credentials. Miniflare runs in scoped child processes because its signal handlers otherwise bypass the driver's cleanup.

Finalizers collect logs and remove owned Docker resources on success, failure, and handled SIGINT/SIGTERM. Cleanup failures make the run fail. SIGKILL or a host crash cannot run finalizers; the report and command log identify owned resources for recovery. Never use a global Docker prune.

## Pinned stack and development

- Effect, `@effect/platform-node`, `@effect/vitest`: **4.0.0-rc.115**.
- TypeScript **7.0.2**, Node **24.21.0**, pnpm **11.15.0**.
- Miniflare **4.20260730.0**, workerd **1.20260730.1**, compatibility date **2026-07-30**. Base fixtures have no Node compatibility flag; Node tests are a separate profile.
- celld **v0.5.0**, MinIO **RELEASE.2025-09-07T16-13-09Z**, and `mc` **RELEASE.2025-08-13T08-35-41Z**, pinned by image digest in [infra/compose.yaml](infra/compose.yaml).

`pnpm check` runs formatting, host/base/Node fixture type checks, and Effect tests for the oracle, codec, coverage, configuration rejection, reports, cleanup, and reference process isolation. Regenerate binding declarations with `pnpm types:fixtures`. CI runs the reference and local suites and uploads evidence even on failure. CI uses the reviewed known-bug registry; adding a waiver requires an explicit registry change.

Add cases in `src/CoreCases.ts`, `ServiceCases.ts`, `NodeCases.ts`, or `ExtensionCases.ts`; add their IDs to `docs/coverage.json`. Assertions belong in the driver. Fixtures perform platform operations and expose observations. Keep unknown-data validation at boundaries, use Effect services and scopes, and adapt Promise APIs only at their platform boundary. See [AGENTS.md](AGENTS.md) and [docs/DESIGN.md](docs/DESIGN.md).

Only `local` and `reference` environment adapters are implemented. The same semantic cases can be reused by future S3/attached-AWS adapters; no AWS execution or provisioning is claimed here.
