# celld-tck

An independent API compatibility test kit for celld. Identical Worker/Durable Object bundles run on workerd and real celld; an external Effect-based driver checks the documented behavior of each before comparing their observations.

The first slice is implemented. Four cases cover HTTP request/response semantics, storage CRUD/list ordering and object isolation, asynchronous storage transaction rollback, and synchronous SQL transaction rollback. This is a starting corpus, not complete Cloudflare compatibility or distributed durability qualification.

## Stack

- Effect, `@effect/platform-node`, and `@effect/vitest`: **4.0.0-rc.115**, pinned together.
- TypeScript 7, Node.js **24.21.0**, pnpm **11.15.0**.
- Miniflare **4.20260730.0** / workerd **1.20260730.1**, using compatibility date **2026-07-30** with no Node compatibility flag. This intentionally pins a stable reference rather than the newer Miniflare alpha.
- celld **v0.5.0**, MinIO **RELEASE.2025-09-07T16-13-09Z**, and `mc` **RELEASE.2025-08-13T08-35-41Z**, pinned by image digest in [infra/compose.yaml](infra/compose.yaml).

All authored TypeScript workflows use Effect. The runner uses services/Layers, Schema decoding, scoped processes, HTTP deadlines, and cleanup finalizers. Each Miniflare runtime runs in a managed child process: its immediate-exit signal handlers cannot bypass the driver's cleanup. Worker handlers and third-party APIs are the Promise boundaries. SQLite transaction callbacks remain synchronous. Generated Cloudflare type declarations are not application implementation.

## Run

Install Node and pnpm at the versions above. For the local profile, start a Docker daemon and install Docker Compose. The runner accepts the `docker compose` plugin or `docker-compose`; `TCK_COMPOSE_BIN` can point to a standalone executable. A project-local `.cache/tools/docker-compose` is also recognized. No cloud credentials are required.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test:reference
pnpm test:local
```

- `test:reference`: two independently persisted workerd instances. This verifies the test harness; it makes no celld claim.
- `test:local`: workerd versus one real celld container backed by MinIO, using bucket durability.

Run one case or change the deterministic input seed:

```sh
pnpm tck --profile local --case storage.transaction-rollback --seed 123
pnpm tck --profile reference --output ./artifacts
pnpm tck --help
```

Case IDs:

- `http.request-response`
- `storage.round-trip`
- `storage.transaction-rollback`
- `sql.transaction-rollback`

The build bundles Effect into the fixture once. Both engines receive the same bytes; the local adapter reads celld's uploaded module back from MinIO and verifies its SHA-256 against the reference artifact. Readiness includes a real DO storage write/read. MinIO conditional-write diagnostics must pass before deployment; celld also performs its normal startup checks.

Each run owns a unique Compose project, private network, volumes, and reference storage directory. Only the public application listener is published, on an ephemeral loopback port. The MinIO credentials are disposable local test credentials. Finalizers collect logs and remove that run's Docker resources on success, failure, or handled SIGINT/SIGTERM. As with any process, SIGKILL or a host crash cannot execute finalizers. The report and command log identify the project for recovery; never use a global Docker prune.

## Evidence and failure behavior

Each run writes `artifacts/tck-<uuid>/`:

- `report.json` and `junit.xml`: all selected cases, infrastructure/reference errors, and cleanup failures.
- `case-*.json`: observations, assertion differences, and status per case.
- `http.jsonl`: request records and full response headers/body bytes, before comparison filtering.
- `commands.jsonl`, `diagnose.jsonl`, `deployment.json`, and runtime logs.
- `fixture/`: built JavaScript, SHA-256, build metadata, and rendered configuration.
- Reference runtime configuration and retained SQLite state.

The report records Effect/runtime versions, image digests, host architecture, durability mode, and lockfile/fixture hashes. Ordered outputs stay ordered. Tests are not automatically retried. Only infrastructure readiness uses bounded retries. The HTTP request limit is 10 seconds, each case side 30 seconds, and the run 5 minutes; cleanup is separately bounded and cleanup failures make the run fail. Responses are limited to 1 MiB and child-process output to 8 MiB per stream.

The comparison uses only explicitly selected semantic HTTP headers (`content-type`, `x-tck-response`); transport-generated headers remain in raw evidence. This initial corpus covers JSON-compatible values. Rich values, streaming, WebSockets, concurrency histories, and documented-divergence manifests are later work.

`pnpm check` runs formatting, both host/fixture type checks, and Effect unit tests. Regenerate fixture types with `pnpm types:fixtures` after changing bindings. CI runs the reference self-check and local container comparison and uploads evidence on failure as well as success.

## Layout and next milestones

- `src/Domain.ts`, `Oracle.ts`, `Cases.ts`: case contracts and independent semantic checks.
- `src/Transport.ts`, `Processes.ts`, `Artifacts.ts`: Effect services and Layers.
- `src/Reference.ts`, `ReferenceProcess.ts`, `Local.ts`, `Resources.ts`: scoped runtime adapters and resource ownership.
- `src/Runner.ts`, `main.ts`, `Report.ts`: execution, Effect CLI, and reporting.
- `fixtures/core/`: Effect-based Worker/DO fixture and generated binding types.
- `docs/DESIGN.md`: design and the remaining coverage plan.

Only `local` and `reference` profiles are implemented. Tests have no Docker or AWS branches; new adapters can supply endpoints without changing semantic cases. Real S3, attached AWS fleets, automatic AWS provisioning, multi-node testing, and managed Cloudflare comparisons remain future milestones. No AWS resources are created by this version.
