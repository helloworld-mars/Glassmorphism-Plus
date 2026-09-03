# Upstream relationship

## Original project

- **Original theme:** Komari Glassmorphism
- **Original maintainer:** [sanrokamlan](https://github.com/sanrokamlan-prog)
- **Original repository:** [sanrokamlan-prog/komari-theme-Glassmorphism](https://github.com/sanrokamlan-prog/komari-theme-Glassmorphism)
- **License:** MIT; the complete inherited text remains in [LICENSE](LICENSE)

Glassmorphism Plus is a derivative, independently maintained customization. It preserves the original project attribution and does not present upstream work as original Plus work.

## Current upstream baseline

The current reviewed baseline is upstream **v3.3.7**. “Baseline” means the upstream tag has been inspected and applicable changes have been selectively integrated; it does not mean that Plus is a byte-for-byte copy or that its version is v3.3.7.

## Sync history

| Plus release | Reviewed upstream | Resolution                                                                                                                                                                                     |
| :----------- | :---------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **v1.3.0**   | v3.3.4 and v3.3.5 | Selected applicable fixes while retaining Plus Ping semantics, configuration and identity. Earlier sync history is not reconstructed here without stronger Git evidence.                       |
| **v1.4.0**   | v3.3.6 and v3.3.7 | Hybrid merge: adopt the tiled summary-card fix using Plus's existing card inventory/order; adopt per-metric `last` aggregation for cumulative traffic counters in the Plus history-query path. |

### v1.4.0 conflict decisions

- **Tiled summary cards:** upstream removed the tiled-only fixed card list. Plus applies the same behavioral fix but keeps its richer presets, custom keys, ordering and responsive layout.
- **Cumulative traffic history:** upstream uses `aggregation_by_metric` so `net.total.up` and `net.total.down` take the last value in each bucket. Plus integrates that schema into its existing Metric request, cache and fallback boundaries instead of replacing the component architecture wholesale.
- **Compatibility hardening:** Plus keeps its Legacy records fallback and separates cache keys for requests whose per-metric aggregation differs.
- **Workflow:** useful frozen-install, lint, clean-diff and build checks may be absorbed without changing the rule that customer installers remain outside Git and, for formal Releases, are uploaded by default only after local verification as the sole custom asset.
- **Not merged:** upstream theme name, short ID, author, repository URL, preview identity, v3.3.6/v3.3.7 manifest versions, README branding, Release names and ZIP naming.

## Future sync policy

Each upstream update follows this sequence:

1. Fetch and verify official tags and commits in the read-only upstream reference.
2. Diff the previously reviewed baseline against the target tag.
3. Classify every change as upstream-only, already present in Plus, conflicting with protected Plus behavior, or suitable for a hybrid merge.
4. Implement only the required portions in the canonical Plus source.
5. Preserve Plus identity, managed settings, per-node Ping binding, data semantics, fallbacks, privacy boundaries, and the verified outside-Git installer plus single-asset Release policy.
6. Add targeted regression coverage and run the full validation required by the project rules.

Upstream metadata is never copied over Plus metadata merely to make the trees match.
