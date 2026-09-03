# Glassmorphism Plus — Codex Bootstrap

This is the root Codex instruction entrypoint for Glassmorphism Plus.

Before any non-trivial task, read in this order:

1. `CODEX.md` — permanent Codex development, safety, release, Git, privacy, and product invariants.
2. `AIAGENTREADME.md` — detailed architecture and implementation guide.
3. `AICACHE.md` — current task/progress/handoff cache.
4. The nearest scoped `AGENTS.md` for files being edited, including `src/AGENTS.md`.

## Root invariants

- The canonical development source is this repository: `komari-theme-Glassmorphism-main`.
- Do not develop directly in publish/release snapshots.
- `_upstream-komari-glassmorphism-reference`, `komari-main`, and `Komari-Theme-LuminaPlus-main` are read-only unless the current task explicitly requires otherwise.
- Never weaken the privacy, Git, release, versioning, customer-installer, or protected-product rules defined in `CODEX.md`.
- A formal GitHub Release normally receives exactly one locally verified customer-installer ZIP after source publication; the ZIP itself must never be staged, committed, or pushed to `main`, and any per-version opt-out must be explicit.
- Nested `AGENTS.md` files may add scoped implementation rules but must not intentionally redefine repository-wide safety/release policy.
- Preserve unrelated user work and never perform destructive Git/history operations without explicit authorization.
- For multi-file or interruptible work, maintain `AICACHE.md` without secrets.

If `CODEX.md` is missing, unreadable, or materially inconsistent with these root invariants, stop and report before broad edits.
