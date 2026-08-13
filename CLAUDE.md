# Glassmorphism Plus — Claude Code Entrypoint

This file is the Claude Code entrypoint for this repository. It complements the
root [AGENTS.md](AGENTS.md); it is not a replacement for the detailed engineering
guide or the Codex-specific permanent operating manual.

## Required reading

Before non-trivial work, read:

1. [AGENTS.md](AGENTS.md) — repository bootstrap and root invariants.
2. [AIAGENTREADME.md](AIAGENTREADME.md) — detailed architecture, implementation
   guidance, development paths, and technical packaging mechanics.
3. [AICACHE.md](AICACHE.md) — current task progress, validation, blockers, and
   handoff context.
4. The nearest scoped AGENTS.md, including
   [src/AGENTS.md](src/AGENTS.md) for source-tree work.
5. [CODEX.md](CODEX.md) when work intersects its durable safety, privacy, Git,
   release, versioning, or protected-product rules. It is the Codex-specific
   permanent workflow guide.

## Project facts

Komari Glassmorphism Plus is a Komari Monitor theme built with Vue 3 and Vite.
The release artifact is a Komari-importable theme ZIP, not a generic deployed web
application.

- [komari-theme.json](komari-theme.json) is release input and the formal
  release-version source.
- A top-level [package.json](package.json) version, when present, is mirrored
  package metadata and must match the manifest.
- bun run build performs the production build and generates the versioned
  installer ZIP.
- bun run release:prepare verifies that installer ZIP and creates the filtered
  release snapshot. It does not create the publish clone.
- The installer layout remains komari-theme.json, preview.png, and dist/.
- The final customer installer stays local unless the user explicitly authorizes
  that specific upload.

## Commands and testing

Run commands from the repository root. Use actual [package.json](package.json)
scripts as the authority:

```bash
bun run dev
bun run type-check
bun run lint
bun run build
bun run test:visual
bun run release:prepare
bun run preview
```

The repository has a deterministic Playwright visual/behavior regression suite
under tests/visual/; bun run test:visual runs it after build-only.

Do not invent bun test or Vitest commands unless a real framework is introduced.
bun run lint uses --fix, so inspect its resulting diff. Do not run state-mutating
release commands such as bun run publish or release preparation without explicit
version/release authorization.

## Architecture rule

New application code follows:

```text
Component -> Composable -> Service -> RequestManager / CacheService -> API / RPC
```

- Components render UI and call composables/services.
- Composables own Vue state and lifecycle.
- Services own business logic.
- Shared limits/settings belong in [src/constants/](src/constants/).
- Low-level API/RPC clients stay in [src/utils/api.ts](src/utils/api.ts) and
  [src/utils/rpc.ts](src/utils/rpc.ts).
- Generic helpers belong in [src/utils/](src/utils/); do not put new business
  workflows there.

## AI work cache

For a task that may be interrupted, spans multiple files, or affects
architecture/security/release behavior, keep [AICACHE.md](AICACHE.md) accurate with
the plan, completed work, validation, risks, and next steps. Never store secrets,
tokens, private passwords, or private server credentials there.

## Hard safeguards

- Do not reintroduce Naive UI, UnoCSS, SCSS, or lucide-vue-next.
- Use @iconify/vue for icons; the only app global is window.$message.
- Keep public home/detail routes public; do not add broad router guards.
- Gate sensitive actions/data through verified auth
  (appStore.requireLoginPermission() / auth service).
- Do not parse raw theme_settings in components; normalize it in
  [src/stores/app.ts](src/stores/app.ts).
- Do not add ad-hoc caches for provider metadata, history records, or request
  deduplication.
- Keep nodeCardSize default as compact; mini is optional and must not replace
  compact behavior.
- Do not rename [komari-theme.json](komari-theme.json),
  [docs/preview.png](docs/preview.png), runtime image contracts, or the established
  ZIP naming/path logic without auditing their consumers.

For detailed architecture and implementation guidance, use
[AIAGENTREADME.md](AIAGENTREADME.md).
