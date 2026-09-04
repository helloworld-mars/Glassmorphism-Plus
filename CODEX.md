# Glassmorphism Plus Codex Permanent Development Guide

This document is the permanent Codex operating manual for Glassmorphism Plus.

It is intentionally version-independent. Version-specific bugs, feature requests,
temporary experiments, release notes, validation output, and task handoff state
belong in the user task and `AICACHE.md`, not here.

## 1. Required reading and instruction model

Before non-trivial work, read:

1. root `AGENTS.md`;
2. this `CODEX.md`;
3. `AIAGENTREADME.md`;
4. `AICACHE.md`;
5. the nearest scoped `AGENTS.md`;
6. relevant documentation under `docs/`.

`AIAGENTREADME.md` owns detailed architecture and implementation explanations.
`AICACHE.md` owns temporary task progress, validation results, blockers, and
handoff context. This file owns durable Codex workflow, safety, product, release,
privacy, and Git rules.

Nested `AGENTS.md` files may add scoped implementation guidance, but they must
not intentionally weaken repository-wide safety, privacy, Git, version, release,
or product invariants defined here.

## 2. Project identity

Glassmorphism Plus is a customized Komari Monitor theme based on the original
Glassmorphism theme by sanrokamlan.

The project uses Vue 3, Vite, TypeScript, Bun, Tailwind-based project styling, and
Playwright regression/visual testing. Its production artifact is a
Komari-importable theme ZIP; it is not a generic standalone web deployment.

Protected project identity:

- Product: Komari Glassmorphism Plus
- Maintainer: helloworld-mars
- Repository: `https://github.com/helloworld-mars/Glassmorphism-Plus`
- Upstream author: sanrokamlan
- Upstream repository: `https://github.com/sanrokamlan-prog/komari-theme-Glassmorphism`

Do not accidentally restore upstream branding or repository identity during
upstream synchronization.

## 3. Canonical source and reference directories

The only formal development source is `komari-theme-Glassmorphism-main`. All
code, UI, configuration, version changes, tests, builds, and release preparation
begin there.

Never continue normal development directly inside:

- `Glassmorphism-Plus-publish-<version>`;
- `Glassmorphism-Plus-release-<version>`.

Those are snapshots/artifacts only. If release validation exposes a bug, return to
the canonical source, fix it there, rerun validation, and regenerate affected
artifacts.

The following are read-only reference directories by default:

- `_upstream-komari-glassmorphism-reference` — upstream tag/commit/diff research;
- `komari-main` — Komari API, backend, and data-model research;
- `Komari-Theme-LuminaPlus-main` — reference-theme research.

Never copy, commit, build, or push LuminaPlus content as Glassmorphism Plus
source.

## 4. Task authorization modes

Classify the user request before acting.

### Review, analysis, or diagnosis

Examples: inspect, analyze, compare, review, explain, or locate the cause.

Allowed work includes reading files, inspecting Git, and safe diagnostics. Do not
edit production source, bump versions, commit, push, or publish unless the user
explicitly requests implementation or release work.

### Implementation, fix, or feature

Examples: fix, implement, optimize, modify, or add a feature.

Edit only in-scope canonical source, add/update directly relevant tests, and run
proportionate validation. Do not automatically turn implementation into a formal
release.

### Formal release

A formal release requires an explicit version/release/publication instruction.
Only then follow the formal release pipeline in this guide.

## 5. Start-of-task workflow

Before broad edits:

1. confirm the working directory;
2. read the active instruction files;
3. inspect `git status`;
4. inspect relevant Git history when needed;
5. identify the affected architecture/data path;
6. identify unrelated pre-existing changes;
7. preserve user work.

For long, multi-file, interruptible, architecture, security, or release work,
maintain `AICACHE.md`. Never store secrets, tokens, cookies, credentials, private
server access, or private keys there.

## 6. Architecture boundary

New application code follows this boundary:

```text
Component
  -> Composable
  -> Service
  -> RequestManager / CacheService
  -> API / RPC
```

- Components own UI rendering and orchestration.
- Composables own Vue reactive state and lifecycle.
- Services own business and infrastructure behavior.
- Stores own application-level normalized state.
- `src/constants/` owns shared limits/settings.
- `src/utils/` owns pure/general helpers.
- Existing API/RPC utilities own low-level transport.

Do not add direct business RPC workflows inside components when the service layer
should own them. Do not create ad-hoc component-local caches for shared business
data. Do not parse raw `theme_settings` in UI components; normalize it through the
appropriate store/service path.

## 7. Existing work and destructive-Git protection

Never silently discard pre-existing user changes. When the working tree is dirty:

1. inspect the changes;
2. determine whether they belong to the current task;
3. preserve unrelated work;
4. report ambiguity before any destructive action.

Without explicit authorization, do not use destructive or history-rewriting
operations, including `git reset --hard`, `git clean -fd`, destructive restore or
checkout of unrelated work, branch/tag deletion, published-history rewriting,
force-push, or moving published tags.

Never solve a merge by replacing the current Plus tree with another source tree.

## 8. Dependency policy

Prefer the repository lockfile. Normal dependency verification is:

```bash
bun install --frozen-lockfile
```

Do not automatically run `bun update` or `npm update`. Use them only when the
user explicitly requests it, an intentional upstream change requires it, or a
confirmed implementation need makes it necessary.

Do not add a production dependency when the existing stack can reasonably solve
the task. Justify every new production dependency in the final report.

## 9. Standard commands

Run commands from the repository root. `package.json` is the authority for scripts.
Current supported commands include:

```bash
bun run dev
bun run type-check
bun run lint
bun run build
bun run test:visual
bun run test:visual:update
bun run release:prepare
bun run preview
```

`bun run build` performs type-checking and the production Vite build. `bun run
test:visual` runs the deterministic Playwright regression suite after a
`build-only` build. `bun run lint` currently includes `--fix`, so always inspect
the resulting diff.

Do not invent `bun test`, Vitest, or another test framework unless it actually
exists in the repository. Never claim an unexecuted command passed.

`bun run publish` is a state-mutating version/release preparation command. It may
write project version metadata and create a release workspace. Never run it,
`bun run release:prepare`, or a release workflow for ordinary implementation or
documentation work; each requires explicit release/version authorization.

## 10. Test integrity

Tests detect regressions; they are not obstacles to bypass. Never make tests green
by deleting relevant tests, unjustified skipping, weakening assertions merely to
accept incorrect behavior, turning failures into warnings, blindly updating visual
snapshots, or fabricating unrealistic fixtures that avoid the failure.

When tests fail, determine whether the cause is implementation, stale expectation,
unrealistic fixture, or environment. Visual snapshots may change only when the
product change truly requires it. Update only directly affected snapshots and
document why.

## 11. Permanent formal-release pipeline

For every formal release, use this complete sequence unless a real, reported
blocker prevents a required step:

```text
canonical source implementation
  -> dependency verify/install
  -> type-check
  -> lint and resulting-diff review
  -> targeted regression tests
  -> build (creates the installer ZIP)
  -> broader Playwright/browser regression
  -> privacy and sensitive-data scan
  -> Git status/diff/staged-file review
  -> version consistency verification
  -> establish the final approved source state
  -> versioned publish clone
  -> filtered release snapshot
  -> local customer installer ZIP verification
  -> artifact/source provenance verification
  -> commit approved maintainable source
  -> remote/branch confirmation
  -> non-force push main
  -> tag/GitHub Release verification when used
  -> GitHub main verification
  -> upload the verified customer installer as the sole custom Release asset
  -> download the Release asset outside the repository and verify SHA-256, structure, and manifest
  -> safely clean the temporary downloaded copy
```

`bun run release:prepare` verifies the installer produced by the build and then
creates the filtered release snapshot. It does not create the publish clone. A
release is not complete merely because the build succeeds.

## 12. Version source of truth

`komari-theme.json.version` is the formal release-version source of truth. If
`package.json` has a top-level `version`, it is mirrored metadata and must match.

For a version bump, inspect genuine current-version locations such as:

- `komari-theme.json`;
- `package.json`;
- root lockfile project metadata, if present;
- footer/build metadata;
- README current-version text;
- manifest/build tests;
- release metadata.

Do not blindly replace version-looking values in historical changelog entries,
old release notes, upstream/Komari versions, dependency versions, schema/cache
versions, or fixture/business data. After a bump, search for the previous current
version and classify every remaining occurrence.

## 13. Versioned release paths

For version `<version>`, the established paths are:

```text
<source-parent>/<version>/Glassmorphism-Plus-publish-<version>/
<source-parent>/<version>/Glassmorphism-Plus-release-<version>/
<source-parent>/<version>/Glassmorphism-Plus-release-<version>.zip
```

`bun run build` must produce valid installer inputs and the versioned installer.
`bun run release:prepare` verifies that installer and creates the filtered release
snapshot. A publish clone must be created separately from the approved repository
so that valid Git history is retained.

Do not rename `komari-theme.json`, `docs/preview.png`, or established release-path
logic without auditing all related build/release scripts.

## 14. Final customer installer ZIP

Do not broadly prohibit ZIP files. Development/testing/upstream ZIPs may be used
when appropriate.

The final customer installer is normally:

```text
Glassmorphism-Plus-release-<version>.zip
```

It is required locally for formal-release verification. Its root must directly
contain:

```text
komari-theme.json
preview.png
dist/
```

It must not contain a wrapper source directory, `src/`, `tests/`, `.git/`,
`node_modules/`, `.env`, HAR, browser profiles, storage/auth exports, or debug
artifacts.

The final customer installer always remains outside Git: never stage, commit, or
push it to `main`. For a formal GitHub Release, upload that exact locally verified
ZIP by default as the Release's only custom asset unless the user explicitly opts
out for that version. Before upload, record its SHA-256 and verify its structure,
manifest version, privacy scan, tag target, and `main` target. Never upload publish
directories, release snapshots, test/debug artifacts, or alternate ZIPs.

After upload, download the asset into a temporary directory outside every source,
publish, and release tree. Verify the downloaded SHA-256 exactly matches the local
installer, confirm it extracts safely, recheck the manifest version/root contract,
and then safely clean the temporary copy. If a same-name asset already exists,
compare content first: keep an identical asset, but do not use clobber, delete, or
replace a differing public asset without stopping for user direction.

## 15. Artifact provenance

A formal release has one authoritative final source state. GitHub `main`, the
final commit, release tag when used, publish clone, release snapshot, customer
installer ZIP, and installer manifest version must all correspond to that state.

Do not publish an installer built from a stale pre-fix tree. If artifacts were
built before the final source change, rebuild them or prove exact payload parity.
A GitHub Release tag must target the intended final commit.

## 16. Published-release immutability

Do not silently rewrite an already published formal version. After public release,
do not move the published tag, rewrite its history, silently replace it with
incompatible code, or present a changed artifact as the same immutable release.

If a released version has a serious regression, normally prepare the next patch
version. Rewrite a published release only when the user explicitly requests it
after understanding the implications.

## 17. Formal GitHub policy

The formal repository is:

```text
https://github.com/helloworld-mars/Glassmorphism-Plus
```

The formal branch is `main`. Before a formal commit, push, or release, run and
inspect:

```bash
git status
git diff
git diff --cached
git remote -v
git branch --show-current
git log --oneline -10
```

Stop and report if the remote or branch is not the intended target. Never
accidentally push to sanrokamlan upstream, `komari-monitor`, LuminaPlus, or the
upstream reference.

Use normal non-force `git push origin main`. Never force-push `main` without
explicit authorization and a separate safety review. GitHub `main` must contain
complete maintainable source, not a dist-only, release-only, installer-only, or
local-debug repository.

When GitHub Releases are used, verify the tag, target commit, release status, and
assets. Unless the user explicitly opts out for that version, the completed
Release must contain exactly one custom asset: the verified final customer
installer ZIP. GitHub-generated source archives are not custom assets.

### GitHub Release metadata contract

Before creating or maintaining Releases, query the repository's complete current
Release metadata with pagination. Treat GitHub's current values as authoritative;
do not restore titles, notes, status, targets, or assets from an old README,
template, report, screenshot, cache, or local backup.

For every future formal Release:

- use the full SemVer tag `v<version>`;
- set the Release title/name to exactly the tag (`release.name === release.tag_name`)
  without a product-name or `Release` prefix;
- write the body in Simplified Chinese, preserve real Markdown line breaks, never
  emit a literal `\n`, and include a `完整变更记录` link comparing the real previous
  tag with the current tag;
- describe only verified work from that version and preserve exact hotfix,
  installer-name, project-name, version, and technical-boundary facts;
- preserve current `Latest`, pre-release, draft, target, tag, publication, asset,
  and user-edited body state unless the task explicitly authorizes that exact
  change.

When maintaining existing Releases, back up the complete current metadata outside
the repository before any write. Change only the authorized fields, then reread
all Releases and compare protected fields and every asset ID, name, size, digest,
and URL against the backup. Draft Releases remain private and must not be published,
deleted, or added to the public README merely as part of metadata maintenance.

### README release-maintenance contract

Every formal release must also reconcile the root README against the complete live
GitHub Release inventory. The release is not complete until all of the following
are true:

1. the current Plus version, source-release reference, installer filename, and
   single expanded `最新版本 · v<version>` section identify the released version;
2. the latest summary is a concise subset of the current GitHub Release body, not
   newly invented release content;
3. the previous latest entry is moved into the collapsed version history;
4. every public non-draft Release is represented exactly once and no nonexistent
   version is invented;
5. history is sorted from newest to oldest by SemVer, with any historical non-`v`
   tag retained exactly as it exists;
6. `（预发布）` is shown only when the current GitHub metadata reports
   `prerelease = true`, while drafts are omitted;
7. the `<details>` structure is complete and renders correctly on GitHub;
8. older history and manually revised current content are preserved rather than
   overwritten from stale templates.

## 18. Mandatory privacy and staged-file review

Before every formal commit, push, or Release, inspect actual candidate/staged files
for accidental sensitive or local material, including:

- `.env` and `.env.local`;
- tokens, API keys, Authorization headers, passwords, secrets, Telegram tokens;
- cookies, sessions, browser exports, private keys, SSH/TLS keys, certificates;
- databases, logs, HAR, Playwright `storageState`, auth state, browser profiles,
  Cache Storage/IndexedDB exports, traces, test results, screenshots, debug output,
  temporary files, `node_modules`, unintended `dist`, unintended installers, and
  `AICACHE.md`;
- real local absolute user-profile paths.

Never commit browser debugging/authentication state. Normal public metadata is not
a secret merely because it contains `helloworld-mars`, `sanrokamlan`, public
GitHub URLs, LICENSE text, public RPC method names, test UUIDs, or fixture data.

Keep `.gitignore` narrowly protective: do not broadly ignore legitimate tracked
runtime images or intentional visual fixtures.

## 19. Upstream synchronization

Only perform upstream synchronization when the user explicitly requests it. Use
`_upstream-komari-glassmorphism-reference` as the comparison source.

Process:

1. fetch the needed upstream tags/commits;
2. identify the old baseline and target;
3. generate actual diffs;
4. classify changes;
5. selectively merge into canonical Plus source;
6. preserve protected Plus behavior;
7. document conflicts;
8. test merged behavior.

Never overwrite Plus with upstream wholesale. Resolve conflicts as upstream, Plus,
or hybrid; Plus behavior wins where direct upstream adoption would remove an
intentional Plus capability. Do not restore upstream branding/repository identity
because upstream metadata changed.

## 20. Protected Glassmorphism Plus behavior

Future fixes and upstream syncs must preserve intentional Plus capabilities unless
the user explicitly requests a redesign. Protected capabilities include:

- per-node Ping task binding and `pingsettings`;
- `task.clients` validation and Ping task-name display;
- selected-task Metric behavior and same-task legacy fallback;
- correct 100% packet-loss semantics and invalid-binding fallback;
- Ping cache identity isolation and Promise dedupe;
- automatic refresh cleanup, fixed history buckets, and stale-while-revalidate;
- pending/data/confirmed-missing states and late real-sample backfill;
- canonical Ping ordering and Cold Start/Warm Start correctness;
- dark/light UI, Glassmorphism Plus identity, and administrative functionality;
- public monitoring home/detail access;
- browser `document.title` following the Komari site name.

Upstream repairs must be absorbed without unintentionally reverting these
behaviors.

## 21. Ping/history reliability invariants

Never fabricate monitoring history. Forbidden behavior includes copying prior
latency/loss into a newer timestamp, converting `null` to `0`, artificial
interpolation, fake sample timestamps, mixing different selected tasks, or
disguising selected-task failure with aggregate data.

For a valid selected task, failure is valid monitoring information: latency can be
unavailable, loss can be 100%, and a target can be offline. These do not
automatically invalidate a task binding. Only binding invalidity may trigger
invalid-binding fallback.

Preserve confirmed missing buckets and allow later genuine samples to backfill
them. Share raw cache/data semantics between NodeCard and Detail where practical;
use keyed request dedupe, bounded sample-aware retries, cleanup, and an explicit
missing-decision deadline. Avoid permanent per-card high-frequency timers.

Browser cache may improve speed but must never be required for correctness. Cold
Start and Warm Start must converge to the same monitoring semantics.

## 22. UI and source safeguards

Use the established stack:

- Vue Composition API and `<script setup lang="ts">`;
- Tailwind/project tokens;
- reka-ui/local primitives;
- `@iconify/vue`.

Do not introduce Naive UI, UnoCSS, SCSS, `lucide-vue-next`, or another component
framework without explicit need and authorization. The only established app global
is `window.$message`.

Keep public home/detail routes public. Gate sensitive actions/data using established
authentication services and `appStore.requireLoginPermission()` rather than broad
router guards. Do not parse raw `theme_settings` directly in components.

Keep `nodeCardSize` default as `compact`; `mini` is optional and must not replace
compact behavior. Runtime files under `public/images/` are compatibility
contracts—audit helper mappings before renaming them. Route views must retain the
single root structure required by `Transition`/`KeepAlive`; after route-root or
lifecycle changes, browser-test home -> detail -> home.

## 23. Generated-file safeguards

Do not hand-edit generated or minified artifacts when authoritative source exists.
This especially applies to `public/admin-app` unless all of the following are true:

1. the task explicitly requires admin-app work;
2. the authoritative source/build/sync path is identified;
3. rebuilding/synchronizing is the deliberate approved solution.

Do not treat generated output as source of truth.

## 24. Release completion gate

Do not declare a formal release complete merely because code compiles, the build
succeeds, or an installer ZIP exists. Applicable completion gates include:

- requested implementation complete;
- targeted regressions pass;
- type-check, lint, and build pass;
- relevant Playwright/browser regression pass;
- privacy scan and staged-diff review complete;
- version consistency and artifact provenance verified;
- Git remote/branch verified;
- approved source committed and pushed;
- GitHub `main` verified;
- release tag/status verified when used;
- customer installer verified locally, kept outside Git, uploaded by default as
  the sole custom Release asset unless explicitly opted out, then downloaded and
  reverified outside the repository before temporary cleanup.

If a required gate cannot be completed, report the task as blocked or partially
verified rather than fully complete.

## 25. Fixed formal release report

Every completed formal release report must state:

1. canonical modification directory;
2. changed source files;
3. root cause or feature behavior;
4. architecture/data-flow decisions;
5. dependency status;
6. type-check result;
7. lint result;
8. build result;
9. targeted regression result;
10. Playwright/browser result;
11. privacy scan result;
12. Git status/diff/staged review;
13. version consistency;
14. publish clone path;
15. release snapshot path;
16. local customer installer path;
17. installer size;
18. ZIP root structure;
19. manifest version;
20. installer upload result or explicit opt-out, custom asset count, local and
    downloaded SHA-256 parity, remote manifest/root verification, and temporary
    download cleanup;
21. origin;
22. branch;
23. final commit hash;
24. non-force push result;
25. GitHub main verification;
26. Release tag/target/assets when applicable;
27. remaining limitations;
28. recommended follow-up.

## 26. Permanent-rule maintenance

This file is intentionally version-independent. Do not add ordinary version-specific
bug descriptions, temporary plans, one-off debugging notes, or release notes here.
They belong in the user task, `AICACHE.md`, or release notes/changelog.

Update `CODEX.md` only when durable policy changes, such as repository identity,
permanent development workflow, release policy, Git policy, privacy/security rules,
architecture invariants, or repeated failures revealing a missing guardrail. Keep
this file reusable across future Glassmorphism Plus versions.
