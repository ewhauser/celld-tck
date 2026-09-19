# Coverage roadmap

This roadmap prioritizes gaps in celld-tck's feature and operational coverage. It describes planned work, not established guarantees. The [qualification backlog](BACKLOG.md) records the existing reliability checklist; the [live results](https://ewhauser.github.io/celld-tck/) show current CI evidence.

The suite currently pins celld v0.5.0. Upstream documentation changes independently: confirm each feature's availability and contract on the pinned release before implementing a case. A feature requiring a newer binary must explicitly declare that requirement or accompany a reviewed version update.

## Priorities

| Order | Workstream                          | Starting point                                                                                                              | Environment                                                          |
| ----- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1     | Storage durability contracts        | Barrier, cursor, and deadline cases implemented; post-abort sync remains open                                               | Local workerd and celld; fault scenarios on celld                    |
| 2     | In-place deployment                 | Explicit reload and invalid-replacement cases implemented; lifecycle transitions remain open                                | Local celld fleet                                                    |
| 3     | Security boundaries                 | Listener, reserved-class, forwarded-header, and body-limit cases implemented; peer credential ageing and replay remain open | Isolated local celld fleet                                           |
| 4     | Assets, dynamic Workers, and facets | One API case per feature                                                                                                    | Local reference and candidate, with celld recovery scenarios         |
| 5     | Runtime and service breadth         | Representative cases, not comprehensive API coverage                                                                        | Local where possible; controlled network/clock fixtures where needed |
| 6     | Fleet operations and upgrades       | Failover and bounded capacity tests exist                                                                                   | Local multi-node fleet and explicitly selected binary versions       |
| 7     | CLI and telemetry                   | No dedicated end-to-end suites                                                                                              | Local celld, object store, and test collector                        |
| 8     | Containers and Sandbox              | Explicitly excluded today                                                                                                   | Separate container-runtime test environment                          |
| 9     | Cloud qualification                 | Local MinIO coverage only                                                                                                   | Dedicated provider accounts and managed reference environment        |

These are implementation priorities, not release dates. Keep workstreams independently reviewable.

## 1. Storage durability contracts

- [x] Exercise `storage.sync()` after committed writes and during an open transaction.
- [ ] Exercise `storage.sync()` after object abort with an oracle that distinguishes sync rejection from the abort itself.
- [x] Interrupt object storage while synchronization is pending; verify failure classification and recovery of acknowledged writes using independent evidence.
- [ ] Interrupt peer replication during a synchronization barrier.
- [x] Leave a SQL write `RETURNING` cursor unfinished and test response, outbound-effect, and synchronization boundaries. Contrast with a fully consumed write cursor and an open read cursor.
- [x] Test transaction and `blockConcurrencyWhile()` deadlines, rollback, and object reset.

Implemented coverage and limits are in [STORAGE-DURABILITY.md](STORAGE-DURABILITY.md).

Completion requires assertions about stored values and externally observable effects, not just successful requests or elapsed time. Keep celld-specific durability scenarios separate from portable API comparisons.

## 2. In-place deployment

- [x] Adopt a new application revision through `/reload` without restarting nodes.
- [x] Verify that invalid replacement code leaves the previous deployment serving.
- [ ] Exercise deployment adoption with in-flight requests, alarms, and pending durability work.
- [ ] Verify storage and hibernatable WebSocket preservation at a safe-point transition.
- [ ] Test forced adoption after the configured deadline, including regular WebSocket closure and client reconnection.
- [ ] Reject modified module bytes that do not match the deployment manifest.

The first two items are covered by `faults.reload-adoption` and `faults.reload-invalid`; see [IN-PLACE-DEPLOYMENT.md](IN-PLACE-DEPLOYMENT.md) for the local evidence and limits.

Record the revision that handled each request and validate retained state. This extends the current rolling application-deployment case; it does not establish binary-upgrade compatibility.

## 3. Security boundaries

- [x] Verify that operator and peer endpoints are inaccessible through the public listener and unknown internal paths do not invoke application code.
- [ ] Reject missing, forged, expired, and replayed peer authentication using controlled test credentials. Missing and forged are covered. Expired and replayed remain open: both need a _valid_ credential to age or resend, and v0.5.0 documents neither the canonical signing input for `cells-peer-request-v1` nor any supported way to mint, inject, or capture a test credential.
- [x] Verify reserved runtime classes cannot be reached through unauthenticated ordinary-object routes.
- [x] Test forwarded-header policy and malformed host handling with and without a trusted proxy configuration. Rejection of _noncanonical_ hosts remains unasserted: the published wording does not define the term, and the likeliest forms — an uppercase host and a trailing-dot host — are accepted on v0.5.0.
- [x] Enforce request-body limits for declared and streamed oversized bodies.

Implemented coverage, the v0.5.0 listener/route/credential inventory it rests on, and the untestable items are in [SECURITY-BOUNDARIES.md](SECURITY-BOUNDARIES.md).

Each denial case needs an authorized control and an assertion that no protected state changed. This verifies documented boundaries; it is not a claim of hostile multi-tenant isolation.

## 4. Deepen existing extension coverage

- [ ] **Assets:** asset-only deployments, HTML/not-found routing, redirects, worker-first rules, and header restrictions. `assets.html-routing` and `assets.redirects` now cover default HTML handling, the not-found response, `_redirects` rules, and a `_headers` rule on an HTML asset; asset-only deployments, worker-first routing rules, and `_headers` protocol-header restrictions remain open.
- [ ] **Dynamic Workers:** props, service capabilities in bindings, outbound restrictions, generation lifecycle, and documented limits. `dynamic.props`, `dynamic.bindings`, and `dynamic.outbound` now cover per-call props, structured-clone and Service Binding values in `WorkerCode.env`, and both `globalOutbound: null` and a `globalOutbound` gateway; generation lifecycle and the documented process/size limits remain open.
- [ ] **Facets:** explicit transaction commit/rollback, persistence after eviction/restart, root replication, and outbound-effect restrictions during uncommitted transactions. `facets.transaction` now covers explicit commit and rollback; persistence, root replication, and the outbound restriction during an uncommitted root transaction remain open.

Use identical fixtures for shared APIs. Validate documented celld differences explicitly rather than weakening the reference expectation.

Implemented coverage and limits are in [EXTENSIONS.md](EXTENSIONS.md).

## 5. Runtime and service breadth

- [ ] **Cron:** occurrence timing, fleet-wide deduplication, missed occurrences, serialization, retry, and `noRetry()`. Establish a controllable scheduling environment first.
- [ ] **TCP/TLS:** connection lifecycle, read/write errors, certificate validation, and event lifetime with a controlled server.
- [ ] **WebSockets:** outbound lifetime, overload, and close/reconnect behavior during ownership changes. Preserve the existing real-hibernation coverage.
- [ ] **Runtime APIs:** EventSource, MessageChannel, additional supported Node.js APIs, and Web Crypto algorithms and invalid inputs.
- [ ] **Compatibility flags:** exercise relevant behavior with flags enabled and disabled, including documented unsupported combinations.
- [ ] **Service boundaries:** inventory KV, D1, R2, Queues, and Workflows operations and limits against existing cases; add targeted cases for uncovered supported behavior.

Document whether each reference result comes from local workerd emulation or managed Cloudflare. Do not treat their service guarantees as interchangeable.

## 6. Fleet operations and binary upgrades

- [ ] Verify weighted ownership placement, rebalance pause/resume, and behavior when capacity samples are missing or stale.
- [ ] Assert readiness transitions, completion of accepted requests, and handoff behavior during graceful drain.
- [ ] Exercise concurrent drains and bounded shutdown when survivors lack capacity.
- [ ] Validate same-node preserve/reload behavior if supported by the selected release.
- [ ] Run mixed-version and rolling binary upgrades with two explicitly pinned releases; assert data preservation and documented compatibility or rejection behavior.

Use multiple cells and retain ownership, readiness, and acknowledged-write evidence. Existing failover tests are a foundation, not proof of every operational control.

## 7. CLI and telemetry

- [ ] **CLI:** `celld dev` startup, local persistence, shutdown, invalid configuration, and listener defaults; supported D1/KV operator commands and their error paths.
- [ ] **Trace context:** propagation across Worker, Durable Object, and outbound calls; malformed input; log correlation across asynchronous work.
- [ ] **Export:** Parquet schema and records, OTLP payloads, sampling, retry, and retention behavior.
- [ ] **Failure isolation:** collector/storage outages and bounded telemetry queues must not silently change application results.

Use a local collector that records received payloads. Finding a log line alone is insufficient evidence of telemetry correctness.

## 8. Containers and Sandbox

- [ ] Establish a dedicated runner with the required Docker/Podman and network-isolation capabilities.
- [ ] Exercise start, stop, execution, ports, inactivity, and resource limits.
- [ ] Verify documented egress restrictions and failure when required isolation cannot be installed.
- [ ] Test owner movement and node restart, including ephemeral container state and SDK recovery behavior.
- [ ] Add separately scoped Sandbox SDK cases for files, processes, sessions, and code execution.

The Docker container currently running celld is not a test of celld's Containers API. Keep this suite opt-in until its infrastructure and reference requirements are reproducible.

## 9. Cloud qualification

- [ ] Qualify actual S3, R2, GCS, and Azure backends separately, including conditional operations, ranged reads, multipart transfers, and recovery.
- [ ] Exercise supported workload identities, credential renewal, and permission failures.
- [ ] Run infrastructure-specific failure scenarios with independently retained acknowledged-write evidence.
- [ ] Add managed Cloudflare reference runs for contracts that local emulation cannot establish.

Provider results must identify the backend, authentication mode, runtime versions, and fault environment. A MinIO pass must never satisfy a cloud qualification gate.

## Investigate before scheduling

- [ ] **PITR:** confirm which restore/bookmark operations celld actually supports on a selected release. Define a supported contract before adding it as a delivery commitment.
- [ ] **Unsupported features:** distinguish features to test from documented rejections to enforce. An unavailable Cloudflare service is not automatically an implementation gap in celld.

## Definition of done

For every new case or scenario:

1. Identify the contract, runtime version, and required environment.
2. Add a meaningful negative example exercising the actual checker; matching wrong observations must fail.
3. Keep fixture operations separate from semantic expectations and preserve identical fixtures across reference and candidate where applicable.
4. Update the case registry, coverage/exclusions, and dashboard expectations as needed. Missing evidence must remain visible.
5. Pass `pnpm check` and the affected runtime suites. Verify cancellation and cleanup when adding resource-owning orchestration.
6. Report local, hosted-CI, managed-reference, and cloud validation separately. Remove an exclusion only when corresponding evidence exists.

See [CONTRIBUTING.md](../CONTRIBUTING.md) and the [oracle corpus guide](../test/case-oracles/README.md).

## Upstream references

These documents informed the gap review; verify their claims against the selected release before implementation:

- [Cloudflare compatibility](https://celld.dev/docs/cloudflare-compat/)
- [Deployment, storage, CLI, and fleet operations](https://celld.dev/docs/)
- [Security boundaries](https://celld.dev/docs/security/)
- [Telemetry](https://celld.dev/docs/telemetry/)
- [Limitations](https://celld.dev/docs/limitations/)
