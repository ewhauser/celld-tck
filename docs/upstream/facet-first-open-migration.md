# First-open facet migration loses access to a persisted SQL table

The v0.6.0 release says facets persisted by v0.5.1 migrate on first open. `operations.persisted-upgrade` fails this contract using the identical qualification fixture, loader key, facet name and object identity on both digest-pinned releases. No mixed-version reads occur: all three nodes stop before changing their images. Durability is `bucket`, using local MinIO.

Run:

```sh
pnpm tck --profile local --suite operations --case operations.persisted-upgrade
```

The fixture writes facet KV `balance: 10` and SQL `entries` row `{id: 1, value: "facet λ"}`, root KV `root-witness: "root λ"`, and an R2 object under `photos/`. It reads back the facet before stopping. A same-version v0.5.1 restart must change the root activation while preserving every value before the upgrade is allowed to proceed.

In `tck-1f0f90de-902a-4d12-92c7-661103e9775a`, the original and restarted v0.5.1 activations were different; both returned the exact facet SQL and KV values. After replacing all binaries with v0.6.0, the first facet read failed with `SQL error: prepare SQL cursor: no such table: entries`. An earlier run without the same-version control reproduced the same first-open failure (`tck-3be86aa3-e131-4efe-896e-a6e5935843c3`). Root and facet checks never reseed the table after the upgrade.

The final run, `tck-dcd162d9-d936-43f2-94f8-447d27e17b64`, independently passed the same-version restart control again. Its first v0.6.0 read retained the root witness and the legacy R2 identity (`photos` readable, `photos/` absent, list containing only `photos`) but still returned the missing-table facet error. The exact first-open observation is saved as `operations.persisted-upgrade/first-open-upgrade.json` in that run's evidence bundle.

The final fixture records a failed facet read as an error observation so root and R2 observations can also be retained. The oracle still requires exact facet SQL/KV data, a new activation, and the documented legacy R2 key identity. It never accepts an error observation. New writes and a second v0.6.0 restart are required only after migration passes; those stages have not been reached.

This establishes that the migrated facet cannot read its previously persisted table. It does not establish that the old bytes were physically deleted or identify the underlying cause. The [v0.6.0 implementation](https://github.com/denoland/celld/blob/v0.6.0/crates/celld/storage.rs) imports the legacy image from the root's `_cf_FACETS` table when opening an empty, unrestored facet database; further upstream investigation should inspect that path and its activation conditions.

This lifecycle failure has no known-bug waiver. It fails the operations suite and CI. This report is a local draft, not an upstream submission.
