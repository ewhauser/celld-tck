# In-place deployment

Two local qualification cases exercise the [celld v0.5.0 deployment contract](https://github.com/denoland/celld/blob/v0.5.0/docs/README.md). They run in the existing faults CI job and results matrix.

- `faults.reload-adoption`: publish a valid second revision, explicitly reload each node, and require the new Worker, Durable Object, and named-service revision through every public endpoint.
- `faults.reload-invalid`: publish a replacement with a deterministic top-level initialization error. Each reload must reject with that error, while the original Worker, object, and service continue serving.

Both scenarios seed an independently recorded SQL/KV acknowledgment history, verify it through all three nodes after reload, append more acknowledged writes, and verify again. Docker container IDs, process IDs, process start times, and restart counts must remain identical. Unavailability, lost acknowledged writes, stale code after successful adoption, and adoption of invalid code fail the scenario.

The scenario-specific Compose overlay sets deployment polling to 3,600 seconds, beyond the scenario's eight-minute bound. After publication and before explicit reload, all three Workers must still report the old revision. This prevents background polling from substituting for the reload trigger. Invalid code is accepted by the deployment tool but fails during runtime initialization; a deployment-tool error cannot pass this case.

Run individually:

```sh
pnpm tck --profile local --suite faults --case faults.reload-adoption
pnpm tck --profile local --suite faults --case faults.reload-invalid
```

Evidence includes source digests, deployment output, each reload response, Worker/object/service revision observations, process identities, and the existing external ledger and SQL/KV history artifacts. Negative oracle tests reject stale revisions, process restarts, accidental invalid-code adoption, unrelated errors, and lost or corrupted acknowledged history.

Local validation uses three celld v0.5.0 nodes and MinIO. This does not qualify AWS or binary upgrades. In-flight requests, alarms, pending durability work, hibernatable WebSockets, forced adoption and reconnection, and mismatched manifest/module bytes remain open in the [roadmap](ROADMAP.md).
