# GDK release watch

Microsoft publishes new GDK releases to [microsoft/GDK][gdk-releases] on its own
cadence. This automation notices them, asks an AI agent what the release means
for this repository, and files a tracking issue. When a release turns out to
need nothing but revalidation, it also opens a **draft** pull request that adds
the release to the supported lists, so a human only has to pull the branch down
and run the tests locally.

Nothing here merges anything, and nothing here edits addon source. The issue and
the draft pull request are both proposals for a human.

## Why a schedule and not a release trigger

A `release` event fires in the repository that published the release. A workflow
in this repository cannot subscribe to events in `microsoft/GDK`, so the watcher
polls instead: weekly on Monday, plus manual dispatch whenever you want an
answer sooner.

## Files

| File | Role |
| ---- | ---- |
| `.github/workflows/gdk-release-watch.yml` | Scheduled + manually dispatched watcher. Finds unsupported releases, opens or updates tracking issues, and dispatches the assessor. |
| `.github/workflows/gdk-release-assess.md` | [GitHub Agentic Workflow](https://github.github.com/gh-aw/) source for the assessor: trigger, permissions, tools, the agent instructions, and the publisher job. |
| `.github/workflows/gdk-release-assess.lock.yml` | Compiled workflow that Actions actually runs. Generated; never hand-edit. |
| `tools/ci/gdk_release_watch.cjs` | Deterministic discovery: release parsing, edition math, support state, backlog selection, the evidence fingerprint, and the tracking-issue ledger. |
| `tools/ci/gdk_release_assess.cjs` | Deterministic assessment half: evidence bundle, report validation, consistency rules, rendering, and publishing. |
| `tools/ci/gdk_support_update.cjs` | Deterministic support-list updater: vcpkg registry lookup, bounded config edits, and the draft pull request. |
| `tools/ci/tests/gdk_*.test.cjs` | `node:test` suites for all three helpers. |
| `.github/workflows/gdk-release-checks.yml` | PR/push checks: helper tests and lock-file drift. |

The agent is read-only. It cannot edit files, open issues, or open pull
requests; it emits one JSON report and the helpers above decide what is
published. The release notes it reads are untrusted text, fenced and labelled as
data in the evidence bundle.

## What counts as a release worth tracking

A release is queued only when all of these hold:

- The tag parses as a GDK version (`...-v<YYMM>.<update>.<build>`), and the
  release is published and not a pre-release.
- Its edition is at or above the minimum edition in
  `tools/ci/gdk_release_watch.cjs`. **The October 2025 (`2510`) family is
  deliberately below the floor**: those editions lack GDK features the addons
  depend on, so adding one is a real porting job rather than a supported-list
  change. Editions already pinned in the supported lists keep working; the
  watcher just never proposes a new `2510` edition.
- Its edition is not already in `GDK_SUPPORTED_VERSIONS` in
  `cmake/GDKDependencies.cmake`, which is the definition of "supported".

Everything else is skipped with a reason recorded in the run summary.

## What the watcher does

1. Lists every release in `microsoft/GDK`, paginating — the list is **not**
   ordered by version, so `/releases/latest` and watermarks are both unsafe.
2. Partitions them into supported, unsupported, and ignored against this
   repository's checked-in support state.
3. For the oldest unsupported release without a tracking issue, opens one,
   labelled `gdk-release`, holding the release identity, the current support
   configuration, and an evidence fingerprint.
4. Dispatches `gdk-release-assess.lock.yml` for that release.

It queues at most one release per run, so a backlog drains one release per week
unless you dispatch it manually with `drain_backlog`. Tracking issues are the
durable queue: a bot-authored issue carries the release id, the last assessment
status, and the fingerprint of the evidence that status was based on. If the
upstream notes or this repository's support lists change, the fingerprint
changes and the release is reassessed.

### Manual dispatch

Run **GDK Release Watch** from the Actions tab:

| Input | Effect |
| ----- | ------ |
| `release_tag` | Assess exactly this tag instead of the oldest unsupported release. |
| `retry` | Reassess even if the release already has a completed assessment. |
| `drain_backlog` | Queue every unsupported release, not just the oldest. |
| `preview` | Report only. No issue, comment, dispatch, or pull request is written. |

`preview` is the safe way to see what the watcher currently thinks; the summary
table lands in the run summary.

## What the assessor decides

The agent reads a prepared evidence bundle: the release identity, this
repository's current support configuration, the release notes delta against the
closest supported release, and the full notes. It reviews the addon surfaces,
the CMake/vcpkg wiring, and the packaging tooling, and returns one of:

| Classification | Meaning | Result |
| -------------- | ------- | ------ |
| `changes_required` | A concrete call site, build setting, or packaging flow has to change. Every required change cites a real file and line range. | Assessment comment on the tracking issue. |
| `tests_only` | Nothing in this repository needs to change; the release only needs to be added to the supported lists and validated. | Assessment comment **plus** a draft pull request. |
| `needs_review` | The notes are ambiguous or the evidence is incomplete. | Assessment comment asking for a human read. |

`tests_only` is the only verdict that can open a pull request, so it carries the
strictest bar. A report claiming `tests_only` is downgraded to `needs_review`
unless it has `high` confidence, zero required changes, zero evidence gaps, at
least three reviewed areas, and at least one validation task. The downgrade and
its reason are shown in the comment — a model cannot talk its way past it.

## The draft pull request

For a `tests_only` verdict, the publisher opens a draft pull request on
`automation/gdk-<version>-<id>` that edits **only** these files:

- `cmake/GDKDependencies.cmake` — adds the edition to `GDK_SUPPORTED_VERSIONS`.
- `.github/gdk-versions.json` — adds the hosted vcpkg entry, when the port
  exists in the public registry.
- `vcpkg-configuration.json` — moves the registry baseline, when a newer one is
  needed to resolve the port.
- `vcpkg.json` — only if the manifest needs the new version.

If the public vcpkg registry has no `ms-gdk` port for the release yet, the pull
request covers the installed-GDK path only and says so. Commits are written
through the Git Data API, so the checkout needs no credentials; the branch is
never force-pushed, and a commit that would be empty is an error rather than a
no-op.

The pull request body is rendered from `.github/PULL_REQUEST_TEMPLATE.md`, links
the tracking issue and the assessment comment, and lists the exact local
validation commands for the edition — which differ between the installed-GDK and
hosted-vcpkg paths. **The automation never runs those commands.** Reviewing the
pull request means pulling the branch and running them.

## Posting and staged mode

`GDK_ASSESS_MODE` in the publisher step of `gdk-release-assess.md` controls
writes. `post` (the default) comments on the tracking issue and opens the draft
pull request. Set it to `staged` to render the assessment to the job summary and
write nothing. The watcher's equivalent is the `preview` dispatch input.

Opening a pull request with the built-in `GITHUB_TOKEN` requires **Allow GitHub
Actions to create and approve pull requests** in the repository's Actions
settings. Leave it off and the assessment still posts, with a note that the
pull request could not be opened. Do not add a personal access token or a GitHub
App to work around it: the draft pull request exists to be reviewed by a human,
and a token with more authority does not change that.

## Changing the supported floor

The minimum edition lives in `tools/ci/gdk_release_watch.cjs`. Raising it means
the watcher stops proposing older editions; it does not remove anything from
`GDK_SUPPORTED_VERSIONS`. Lowering it is only meaningful if the addons actually
work on the older family. Update this page in the same change.

## Local checks

```powershell
node --test tools/ci/tests/gdk_release_watch.test.cjs tools/ci/tests/gdk_release_assess.test.cjs tools/ci/tests/gdk_support_update.test.cjs
gh aw compile gdk-release-assess --strict
```

The compile step needs the pinned gh-aw version recorded in
`.github/workflows/gdk-release-checks.yml`; a mismatch shows up as lock-file
drift in CI.

[gdk-releases]: https://github.com/microsoft/GDK/releases
