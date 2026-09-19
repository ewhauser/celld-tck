# Assets, dynamic Workers, and facets

The extensions fixture exercises three platform features that are not part of the core Worker or Durable Object surface: static assets, Worker Loader (dynamic Worker) bindings, and Durable Object facets. Every case is a differential API case: the same fixture runs on workerd and on celld, and the driver owns the expectations.

Expectations follow the Cloudflare reference contracts and the [celld v0.5.0 compatibility page](https://celld.dev/docs/cloudflare-compat/). A documented celld difference is registered as a divergence rather than removed from the reference expectation.

## Static assets

The fixture ships `hello.txt`, `page.html`, `folder/index.html`, a `_headers` file, and a `_redirects` file. All observations go through the `ASSETS` binding with `redirect: "manual"` so redirect responses stay visible.

| Case                  | Required behavior                                                                                                                                                                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `assets.binding`      | `ASSETS.fetch()` serves a UTF-8 file with its `_headers` rule applied and answers 404 for a missing file.                                                                                                                                                                                    |
| `assets.html-routing` | Default [HTML handling](https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/): `/page` serves `page.html`, `/page.html` and `/folder` answer 307 to the canonical path, `/folder/` serves the directory index, and an unmatched path is 404 with no body. |
| `assets.redirects`    | [`_redirects`](https://developers.cloudflare.com/workers/static-assets/routing/advanced/redirects/) rules produce 301 and 302 responses with the configured `Location`, and an unlisted path is unaffected.                                                                                  |

## Dynamic Workers

The fixture loads one child bundle through the `LOADER` binding. A `Gateway` `WorkerEntrypoint` in the same script provides a Fetcher that the loaded Worker can reach, either as a service capability in its `env` or as its `globalOutbound`.

| Case               | Required behavior                                                                                                                                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dynamic.fetch`    | A loaded Worker's default entrypoint answers a request.                                                                                                                                                                                                         |
| `dynamic.props`    | `getEntrypoint(undefined, { props })` delivers per-call props to the loaded Worker's `ctx.props`; a second call on the same loaded Worker sees its own props, not the first call's.                                                                             |
| `dynamic.bindings` | `WorkerCode.env` carries structured-clone values and a Service Binding capability that the loaded Worker can call.                                                                                                                                              |
| `dynamic.outbound` | [Egress control](https://developers.cloudflare.com/dynamic-workers/usage/egress-control/): `globalOutbound: null` makes a global `fetch()` throw while an `env` service capability still works, and a `globalOutbound` Fetcher intercepts the global `fetch()`. |

The loaded Worker reports only whether the blocked call threw. The error class is not part of the documented contract, so it is not asserted.

## Facets

Facets require a Durable Object class obtained from a Worker Loader binding, which is how the fixture creates them on both runtimes.

| Case                 | Required behavior                                                                                                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `facets.isolation`   | Two named facets of the same root object keep separate SQLite state.                                                                                                            |
| `facets.transaction` | An explicit facet transaction reads its own uncommitted write, a commit makes the new value visible to later reads, and `rollback()` discards the transaction's write entirely. |

## Running the suite

```sh
pnpm tck --profile reference --suite extensions
pnpm tck --profile local --suite extensions
pnpm tck --profile reference --suite extensions --case assets.redirects
```

Each case has an independently captured positive observation in `test/case-oracles/observations.json` and named semantic mutations in `test/case-oracles/Mutations.ts`: a lost `_headers` rule, an ignored `_redirects` rule, a suppressed trailing-slash redirect, leaked props, a lost env capability, an outbound block that leaks or that also disables bindings, and a facet transaction that commits a rolled back write or discards a committed one.

An asset error page's body and media type are presentation rather than contract, so only a served asset reports them; the not-found status itself is asserted.

## Local celld results

On celld v0.5.0 every case above passes except `assets.html-routing`, which is registered as the known bug [CELL-004](BUGS.md): celld redirects `/folder` to `/folder/` and then answers 404 for that canonical path, so a directory index is unreachable. Every other observation in that case matches the reference. No divergence was needed for these cases; the compatibility page documents no difference in asset routing, dynamic Worker props/env/outbound handling, or facet transactions.

## Remaining coverage

These cases do not cover asset-only deployments, worker-first static routing rules, `_headers` restrictions on protocol headers, dynamic Worker generation limits, or celld's documented rejection of an outbound effect from a facet while a root storage transaction holds an uncommitted facet image. Facet persistence after eviction or restart belongs to the lifecycle suites. The open items stay unticked in the [roadmap](ROADMAP.md).
