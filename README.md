# celld-tck

An independent test suite for celld's Cloudflare Workers and Durable Objects compatibility, storage recovery, and multi-node behavior.

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

See [AGENTS.md](AGENTS.md) for implementation conventions and [the design document](docs/DESIGN.md) for the harness architecture.

## Further reading

- [Recovery tests](docs/RECOVERY.md)
- [Multi-node failover](docs/MULTINODE.md)
- [Fleet durability](docs/FLEET.md)
- [Resilience tests](docs/RESILIENCE.md)
- [Qualification scenarios](docs/QUALIFICATION.md)
- [Remaining work](docs/BACKLOG.md)

## License

[Apache License 2.0](LICENSE).
