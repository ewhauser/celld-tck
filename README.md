# celld-tck

An independent test suite for celld's Cloudflare Workers and Durable Objects compatibility, storage recovery, and multi-node behavior.

## Latest results

**[View the live test matrix →](https://ewhauser.github.io/celld-tck/)**

Updated by CI on `main`, including failing runs. Browse case results, known bugs, divergences, and evidence. [View CI runs](https://github.com/ewhauser/celld-tck/actions/workflows/ci.yml?query=branch%3Amain).

## Why

celld doesn't ship with tests, by the author's preference. This project fills that gap with an open-source suite that anyone can run against a celld release.

The goal is to help users understand which behaviors they can rely on, catch regressions, and provide reproducible bug reports. The suite runs the same Worker and Durable Object code on celld and Cloudflare's workerd runtime. It checks each runtime against expected behavior, then compares the results—agreement alone isn't enough to pass.

Separate recovery and fault tests exercise what happens when processes restart, storage becomes unavailable, or nodes fail.

## Getting started

You'll need:

- Node.js **24.21.0** and pnpm **11.15.0** (the versions used by this repo).
- Docker with Compose to test celld locally.

No cloud account or credentials are needed. From a checkout of this repository:

```sh
pnpm install --frozen-lockfile
pnpm test:local
```

This starts workerd, celld, and MinIO, deploys the test fixtures, and runs the compatibility suite. The runner collects logs and removes its Docker resources when finished, including on test failures and handled interrupts.

To check the harness using two independent workerd instances, without Docker:

```sh
pnpm test:reference
```

Both `docker compose` and `docker-compose` are supported. If Compose is installed elsewhere, set `TCK_COMPOSE_BIN` to its executable path.

## Running tests

Run a suite or a single case:

```sh
pnpm tck --profile local --suite bindings
pnpm tck --profile local --case storage.transaction-rollback --seed 123
pnpm tck --profile reference --suite extensions
pnpm tck --help
```

The default API suite includes 63 compatibility cases and, for local runs, 6 celld deployment checks.

| Suite           | What it tests                                                                                                                                |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `core`          | HTTP, Durable Object identity, storage, SQL, RPC, concurrency, alarms, streams, WebSockets, crypto, HTMLRewriter, cache, and background work |
| `bindings`      | Service RPC, KV, D1, R2, Queues, and Workflows                                                                                               |
| `node`          | Buffer, paths, events, async context, hashing, and compression with `nodejs_compat`                                                          |
| `extensions`    | Static assets, WebAssembly, Dynamic Workers, and facets                                                                                      |
| `all` (default) | All of the above                                                                                                                             |

Recovery and fault tests run separately and require Docker:

| Command                   | What it tests                                              |
| ------------------------- | ---------------------------------------------------------- |
| `pnpm test:recovery`      | Process restarts, disk loss, and object-store outages      |
| `pnpm test:multinode`     | Two-node bucket-durable failover and fencing               |
| `pnpm test:fleet`         | Fleet-durable follower recovery                            |
| `pnpm test:resilience`    | Three-node fault scenarios                                 |
| `pnpm test:qualification` | Traffic, dependency recovery, storage faults, and capacity |

The optional `repros` suite contains isolated cases for upstream bug reports and is excluded from `all`. See the [upstream reports](docs/upstream/README.md) for details.

## Results

Each run writes reports and debugging evidence to `artifacts/tck-<uuid>/`, including:

- `report.json` and `junit.xml` for test results, including handled interruption and cleanup failures. API reports retain the driver Node.js version in `environment.hostNode`; fixture provenance is grouped under `environment.fixtures.core|node|extensions|repro`.
- `run.json` and `coverage.json` for versions, configuration, seed, and selected cases.
- Process logs, HTTP and WebSocket observations, and deployed fixtures for investigating failures.

Use `--output ./artifacts` to choose a different output directory.

Unexpected failures make the command exit nonzero. Registered [known bugs](docs/BUGS.md) are reported separately and allowed by default, but only for the exact celld version, compatibility date, compatibility flags, and observations in the registry. To make known bugs fail the run too:

```sh
pnpm tck --profile local --known-bugs error
```

Intentional compatibility differences are reported as divergences, not passes. See [findings](docs/FINDINGS.md) for observed results and [coverage](docs/coverage.json) for the full case list and exclusions.

Tests currently target **celld v0.5.0** and **workerd 1.20260730.1**, with compatibility date **2026-07-30**. Container images are pinned by digest in [infra/compose.yaml](infra/compose.yaml). A passing local run covers the tested behaviors; it does not establish production Cloudflare equivalence or AWS qualification. AWS adapters and provisioning are not implemented.

## Contributing

Bug reproductions, new test cases, and improvements to coverage are welcome. For a failure report, include the case ID, runtime versions, and relevant artifacts from the run.

The runner and fixtures are written in TypeScript using Effect v4. To validate changes:

```sh
pnpm check
pnpm test:reference
pnpm test:local
```

`pnpm check` runs formatting, type checks, and unit tests. Run the relevant recovery or fault suite when changing those areas.

Add API cases in `src/CoreCases.ts`, `src/ServiceCases.ts`, `src/NodeCases.ts`, or `src/ExtensionCases.ts`, and register their IDs in `docs/coverage.json`. Keep fixtures identical across runtimes: fixtures perform operations and return observations; the driver owns assertions.

Every new case needs a targeted negative example exercising its actual oracle. For API cases, add an independently reviewed positive observation to `test/case-oracles/observations.json` and at least one named semantic mutation in `test/case-oracles/Mutations.ts`. `pnpm check` enforces exact coverage of the case registry and tests the real checker against each mutation, including matching wrong reference/candidate observations. Generic HTTP failures, malformed envelopes, and no-op mutations do not count. See [the oracle corpus guide](test/case-oracles/README.md) for the authoring workflow. Lifecycle and qualification cases must likewise include targeted bad observations in their oracle tests.

The four runners share `src/SuiteExecutor.ts` for case results, deadlines, cleanup diagnostics, and JSON/JUnit reporting. Runners retain selection, provisioning, and scenario sequencing. Use `record` for results already classified by the API oracle and `runCase` for lifecycle scenarios; scenarios that include provisioning mark `ready` after setup succeeds. Dependent stages stop on failure, while independent cases can continue. Only the API suite accepts reviewed divergences and known bugs. Reports are finalized after resource cleanup, including on cancellation, and all suites include status counts and placeholders for unreached cases. Executor changes should extend `test/SuiteExecutor.test.ts` and run the affected runtime suites.

Qualification cases live in `src/QualificationTraffic.ts`, `src/QualificationDependencies.ts`, `src/QualificationFaults.ts`, and `src/QualificationCapacity.ts`. Each registered case owns its complete fault and recovery sequence; `QualificationContext.ts` supplies shared requests, traffic, and evidence handling. `LocalOptions` names the topology and durability settings and constrains qualification to three nodes.

Use `FleetControls` for Docker fault operations. Its scoped peer partitions and memory limits capture prior settings, install restoration before mutation, and retain inspection evidence. Memory faults on initially unlimited nodes require an explicit finite recovery budget because Docker update treats zero as unchanged; the capacity scenarios retain their existing 512 MiB recovery budget. Keep the fault scope inside the case so restoration completes before recovery assertions. Use `Polling.ts` only for read probes: specify pending conditions or transient errors, an attempt limit, and a deadline. Readiness checks retry transport failures and HTTP 502/503/504; successful response bodies are asserted outside the retry loop. Shared history readers handle decoding and pagination; scenario oracles still check correctness, and standalone audit stays read-only.

See [AGENTS.md](AGENTS.md) for implementation conventions and [the design document](docs/DESIGN.md) for the harness architecture.

## Further reading

- [Recovery tests](docs/RECOVERY.md)
- [Multi-node failover](docs/MULTINODE.md)
- [Fleet durability](docs/FLEET.md)
- [Resilience tests](docs/RESILIENCE.md)
- [Qualification scenarios](docs/QUALIFICATION.md)
- [Remaining work](docs/BACKLOG.md)

## Results dashboard

The Compatibility workflow builds a static, searchable test matrix from each job’s JSON report and CI status. Main-branch runs publish it to GitHub Pages, including runs with failing tests. Pull requests and other branches produce a downloadable `compatibility-site` artifact without deploying. Cancelled or superseded runs do not publish. GitHub must support Pages for the repository’s visibility and account plan. Enable **Settings → Pages → Build and deployment → Source: GitHub Actions** for a fork.

If you rerun a workflow, rerun all jobs: evidence from an earlier attempt is deliberately rejected.

The page separates passes, accepted divergences, known bugs, failures, missing evidence, and unscheduled diagnostic cases. It includes suite diagnostics, individual observations, report downloads, and links to the exact commit and CI run. Missing, malformed, duplicate, or mismatched evidence cannot mark a run complete. Published evidence covers local runtime validation, not AWS qualification. Full logs stay in the CI artifacts; the website contains structured reports and observations.

To preview a run locally, download all `compatibility-summary-*` artifacts into `.cache/site-input/`, keeping their artifact-name directories, and provide the run context:

```json
{
  "repository": "ewhauser/celld-tck",
  "sha": "FULL_COMMIT_SHA",
  "runId": "GITHUB_RUN_ID",
  "attempt": "1",
  "number": "GITHUB_RUN_NUMBER",
  "branch": "main",
  "conclusion": "success"
}
```

```sh
pnpm site:build --context .cache/site-context.json
python3 -m http.server 8765 --directory .cache/site
```

Open `http://localhost:8765`. Without input artifacts, the builder renders the complete matrix with missing-evidence states. CI supplies the context through GitHub’s environment variables and `CI_RESULT`. The site uses relative asset links so it works under a GitHub Pages project path.

## License

[Apache License 2.0](LICENSE).
