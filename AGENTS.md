# Glassmorphism Plus Permanent Development Rules

This is the root-scope, permanent development and release contract for Glassmorphism Plus. It applies to bug fixes, features, upstream syncs, version bumps, builds, releases, and GitHub pushes even when a later task does not repeat it.

For implementation architecture, read [AIAGENTREADME.md](AIAGENTREADME.md). For persistent handoff and progress, read and update [AICACHE.md](AICACHE.md). The nearer [src/AGENTS.md](src/AGENTS.md) applies inside `src/`, but it must not relax this release and safety contract.

## 1. Canonical source and reference directories

- The only formal development source is `komari-theme-Glassmorphism-main` (this directory). Do all code, UI, version, test, and build work here first.
- Do **not** develop directly in `Glassmorphism-Plus-publish-<version>` or `Glassmorphism-Plus-release-<version>`. They are release snapshots only. A release validation bug always returns to this formal source, then repeats test, build, publish, and release preparation.
- Treat `_upstream-komari-glassmorphism-reference`, `komari-main`, and `Komari-Theme-LuminaPlus-main` as read-only by default. The upstream reference is only for explicit sanrokamlan upstream tag/commit/diff work; `komari-main` is only for Komari API/data-structure research; LuminaPlus is only a reference theme.
- Never copy, build, commit, or push LuminaPlus content as part of Glassmorphism Plus work.

## 2. Required start-of-task workflow

1. Read this file, [AIAGENTREADME.md](AIAGENTREADME.md), [AICACHE.md](AICACHE.md), and the nearest scoped `AGENTS.md`.
2. Record a multi-file or interruptible task in `AICACHE.md` before broad edits and update it with results before handoff. Never put secrets, private hosts, cookies, or tokens there.
3. Classify the work (M2 performance, M3 security, M4 UI/UX, M5 feature, M6 docs/tests/DX) and identify the affected data path before editing.
4. Keep the architecture boundary: `Component -> Composable -> Service -> RequestManager / CacheService -> API / RPC`. Do not add component-local business caches or direct business RPC calls.

## 3. Permanent release flow for every version

For every formal version (`1.3.3`, `1.3.4`, `1.4.0`, `2.0.0`, and later), execute this complete sequence unless a real, reported blocker prevents it:

```text
formal source modification
  -> dependency verify/install
  -> type-check
  -> lint
  -> relevant behavior/unit tests
  -> build
  -> real browser regression (including the changed behavior)
  -> privacy/sensitive-data scan
  -> git status/diff preflight and version consistency check
  -> versioned publish clone
  -> filtered release snapshot
  -> local customer installer ZIP
  -> ZIP structure/manifest verification
  -> commit approved source only
  -> remote/branch confirmation
  -> non-force push main
  -> GitHub main/release verification
```

- Do not call an unexecuted command “passed.” If a tool is unavailable, report the exact reason and run an equivalent check where safe.
- `bun run lint` currently fixes files; always inspect the resulting diff.
- Production source changes normally require `bun run type-check`, `bun run lint`, `bun run build`, relevant targeted tests, and `bun run test:visual` (or an explicitly justified subset) before release.

## 4. Versioned release paths and installer ZIP

`komari-theme.json.version` is the sole release-version source. If `package.json` has a top-level `version`, it is mirrored metadata and must match, but is never the source of truth.

For version `<version>`, use the established sibling paths below the formal source parent:

```text
<source-parent>/<version>/Glassmorphism-Plus-publish-<version>/
<source-parent>/<version>/Glassmorphism-Plus-release-<version>/
<source-parent>/<version>/Glassmorphism-Plus-release-<version>.zip
```

- `bun run build` must produce `dist/` and the versioned installer path computed from the manifest.
- `bun run release:prepare` must verify the installer before creating a filtered, non-overwritable release snapshot.
- Create the publishing directory by cloning the approved repository into the versioned publish path so its `.git` history is retained. Never turn a release snapshot into the next development source.
- The packaged `preview.png` comes from `docs/preview.png`. Do not rename `komari-theme.json`, `docs/preview.png`, or the established versioned ZIP pattern without auditing the packaging contract.
- The final customer installer ZIP is allowed and required locally. Its root must directly contain exactly the install contract:

  ```text
  komari-theme.json
  preview.png
  dist/
  ```

  It must not add a wrapper project directory, source/tests, `.git`, `node_modules`, `.env`, HAR, browser profiles, or debugging artifacts.

- A final customer installer such as `Glassmorphism-Plus-release-<version>.zip` is **local-only**. Never `git add`, commit, push it to `main`, or upload it as a GitHub Release asset unless the user explicitly requests that specific upload. This does not prohibit unrelated ZIP files required for development, testing, or upstream sync.

## 5. Formal GitHub policy

- The only formal remote is `https://github.com/helloworld-mars/Glassmorphism-Plus` (Git URL may end in `.git`). The only formal branch is `main`.
- Before every commit/push/release, run and inspect:

  ```bash
  git status
  git diff
  git diff --cached
  git remote -v
  git branch --show-current
  git log --oneline -10   # when history context is needed
  ```

- Stop and report if the remote or branch is not the formal target. Never push to sanrokamlan, `komari-monitor`, LuminaPlus, or the upstream reference by mistake.
- Preserve the fork's `.git` history in the publish clone. Use normal non-force `git push origin main`; never force-push `main` unless the user explicitly directs it after a separate safety review.
- GitHub `main` must contain the complete maintainable source—not dist-only content, release-only content, customer installer ZIPs, temporary builds, or local test files.
- If a release workflow is used, verify its tag, target commit, Release status, and assets afterward. Do not allow workflow configuration to upload the final customer installer without explicit user authorization.

## 6. Mandatory privacy and staged-file review

Before each commit, push, or Release, scan the candidate source/staged list for:

- `.env`, `.env.local`, tokens, API keys, Authorization headers, passwords, secrets, Telegram tokens, cookies, sessions, browser exports, private keys, SSH/TLS keys, certificates, databases, logs, cache, `node_modules`, `dist`, ZIP installers, HAR, traces, test results, screenshots, AICACHE, debug output, and temporary files;
- Playwright `storageState`, auth state, browser profiles, Incognito dumps, Cache Storage/IndexedDB exports, and Chrome network exports;
- real local absolute paths (for example `<local-user-profile>/...`).

Normal public project metadata is not a secret merely because it contains `helloworld-mars`, `sanrokamlan`, public GitHub URLs, LICENSE text, public RPC names, test UUIDs, or fixture data.

Never add browser debugging data to source control. Keep `.gitignore` narrowly protective: do not broadly ignore tracked runtime images or intentional visual fixtures, but do ignore local profile/auth/storage/debug outputs.

## 7. Version and product integrity

When bumping a formal version, inspect all genuine current-version locations: `komari-theme.json`, `package.json` metadata, Footer/build metadata, README current-version text, manifest/build tests, root lockfile project version if one exists, and release metadata. Do not blindly change historical changelog entries, upstream/Komari versions, dependency versions, schema/cache versions, or business fixture data.

Preserve these Glassmorphism Plus capabilities during fixes and upstream syncs:

- per-node Ping task bindings, `pingsettings`, `task.clients` validation, and task-name display;
- selected-task Metric behavior, same-task legacy fallback, 100% loss semantics, and invalid-binding fallback;
- Ping cache identity isolation, promise dedupe, automatic refresh cleanup, fixed history buckets, stale-while-revalidate behavior, and canonical task ordering;
- dark/light UI, Glassmorphism Plus identity, public monitoring routes, and the existing administrative functionality.

When upstream changes conflict with Plus behavior, selectively absorb the repair while preserving these features.

## 8. Ping/history reliability rules

Do not fabricate history values: no copying prior latency/loss into a newer timestamp, no `null -> 0`, no interpolation, and no fake sample timestamp. Preserve real missing buckets once they are confirmed, and allow later real samples to backfill them.

For new-sample timing behavior, share raw data/cache semantics between NodeCard and Detail where practical. Use keyed request dedupe and a shared scheduler/cache; do not create per-card infinite timers or permanent one-second polling. When an ingestion window is pending, use finite, sample-aware retries with cleanup and an explicit missing-decision deadline.

## 9. Source and UI guardrails

- Use Vue Composition API / `<script setup lang="ts">`, Tailwind tokens/utilities, reka-ui/local primitives, and `@iconify/vue`. Do not add Naive UI, UnoCSS, SCSS, `lucide-vue-next`, or another component library.
- UI/view orchestration belongs in `src/components/` and `src/views/`; Vue lifecycle/reactive glue belongs in `src/composables/`; business/infrastructure behavior belongs in `src/services/`; pure helpers belong in `src/utils/`; state belongs in `src/stores/`; low-level transport stays in `src/utils/api.ts`, `src/utils/rpc.ts`, and `src/utils/init.ts`.
- The default NodeCard size remains `compact`; `mini` remains optional. Realtime node metrics must update without a page refresh, and node indexes must keep pointing to Vue-reactive node objects.
- Public home/detail routes remain public. Sensitive features are gated at their action/data boundary, not with broad router guards.
- Runtime `public/images/` names are contracts. Do not rename them without auditing all helper mappings.
- Keep route views single-element roots because `App.vue` uses `Transition` and `KeepAlive`; browser-test home -> detail -> home after changing a route root.

## 10. Fixed final release report

Every completed formal version report must state:

1. formal modification directory and changed files;
2. bug root cause and implementation/data-flow decision;
3. dependency, type-check, lint, build, behavior/Playwright/browser regression results;
4. privacy scan and staged Git diff results;
5. exact publish clone, release snapshot, and local installer ZIP paths; ZIP size, root structure, manifest version, and confirmation that the customer ZIP was not uploaded;
6. origin, branch, commit hash, non-force push result, and confirmation GitHub `main` contains the current complete source;
7. remaining limitations or recommended follow-up.
