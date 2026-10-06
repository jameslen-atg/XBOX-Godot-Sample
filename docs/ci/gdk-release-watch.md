# GDK release watch

Microsoft publishes new GDK releases to [microsoft/GDK][gdk-releases] on its own
cadence. This automation notices them, asks an AI agent what the release means
for this repository, and files a tracking issue. When a release turns out to
need nothing but revalidation, the issue also carries a complete, ready-to-apply
task: the exact files, the exact values, and the local validation a human has to
run. Assign that issue to GitHub Copilot and it produces the draft pull request.

Nothing here merges anything, and nothing here edits addon source. The issue and
everything in it are proposals for a human.

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
| `tools/ci/gdk_support_update.cjs` | Deterministic support-list updater: vcpkg registry lookup, bounded config edits, and the assignable task body (or, if ever enabled, the draft pull request). |
| `tools/ci/tests/gdk_*.test.cjs` | `node:test` suites for all three helpers. |
| `.github/workflows/gdk-release-checks.yml` | PR/push checks: helper tests and lock-file drift. |

The agent is read-only. It cannot edit files, open issues, or open pull
requests; it emits one JSON report and the helpers above decide what is
published. The release notes it reads are untrusted text, fenced and labelled as
data in the evidence bundle.

Its egress allowlist is exactly `learn.microsoft.com` and `devdocs.xbox.com`.
Unlike `issue-triage.md`, this workflow deliberately omits gh-aw's `defaults`
host bundle: that bundle adds roughly three dozen apt, snap, package-registry
and certificate-revocation hosts, and this agent has no shell and installs
nothing, so those hosts would only widen the exfiltration surface available to a
prompt-injection payload hidden in upstream release notes. `doc_references`
hosts are validated a second time in `tools/ci/gdk_release_assess.cjs`, so a
cited URL outside those two hosts fails publication even if the fetch somehow
succeeded.

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
   configuration, and an evidence fingerprint. The label is created first if the
   repository does not have it yet — the queue is found *by* that label, so an
   unlabelled issue would be re-created on every later run.
4. Dispatches `gdk-release-assess.lock.yml` for that release.

It queues at most one release per run, so a backlog drains one release per week
unless you dispatch it manually with `drain_backlog`. Tracking issues are the
durable queue: a bot-authored issue carries the release id, the last assessment
status, and the fingerprint of the evidence that status was based on. If the
upstream notes or this repository's support lists change, the fingerprint
changes and the release is reassessed.

If an assessor run dies without posting a report — a rejected dispatch, a
crashed agent, a blocked safe output — its ledger entry would otherwise read
`assessment-dispatched` forever. The watcher treats such an entry as in flight
for six hours; past that it writes an `assessment-failed` state closing the dead
attempt out and re-queues the release behind never-attempted work. A dispatch
that fails outright is recorded the same way before the error is re-raised, so a
failed run is always visible in both the Actions log and the tracking issue.

Each dispatch also carries an **attempt id** — the watcher run that queued it —
as a workflow input. The assessor never re-derives that id from the ledger,
because an explicit retry re-queues the *same* evidence under a *new* watcher
run: a slow assessor reading the ledger at publish time would otherwise adopt
the retry's id and settle it with an older report. An assessor that finds a
different attempt in flight refuses to publish and lets the retry win. Both
terminal states preserve the queuing watcher run and record the assessor run
separately as `assessorRunUrl`, so re-running a finished assessor recognises its
own report instead of posting a duplicate.

Because the attempt id is the only thing that separates two dispatches over
identical evidence, it cannot be reconstructed. Dispatching the assessor
directly therefore requires copying the `attempt` value out of the in-flight
state comment on the tracking issue; a run that omits it renders its staged
preview and then refuses to post. The ledger is re-read and re-validated after
the support-change lookup — the longest step in the publish path — so a retry
queued during that lookup stops the older run before it posts rather than after.
GitHub comments have no compare-and-swap, so a narrow window remains between
that final read and the write; the six-hour staleness sweep above is what
recovers a retry that loses it.

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
| `tests_only` | Nothing in this repository needs to change; the release only needs to be added to the supported lists and validated. | Assessment comment **plus** a ready-to-apply support task. |
| `needs_review` | The notes are ambiguous or the evidence is incomplete. | Assessment comment asking for a human read. |

`tests_only` is the only verdict that proposes a support change, so it carries
the strictest bar. A report claiming `tests_only` is downgraded to
`needs_review` unless it has `high` confidence, zero required changes, zero
evidence gaps, at least three *distinct* reviewed areas (repeating one area
three times does not count), and at least one validation task.
The downgrade and its reason are shown in the comment — a model cannot talk its
way past it.

Truncation is enforced the same way, but from the other side. The context
builder records what it actually had to cut — the release notes, the
release-note delta, or the whole evidence bundle — into `context.json`, and the
publisher downgrades `tests_only` on that record alone. Asking the model to
report the gap would be asking the wrong witness: a breaking change in the tail
it never received is exactly the change it cannot warn about. A missing
comparison baseline is tracked separately and does **not** downgrade, because it
widens the delta rather than shortening it.

## The support change

This repository does not allow GitHub Actions to create pull requests, so the
automation does not try. For a `tests_only` verdict it derives the change
deterministically and renders it into the assessment comment under
**Proposed support change — assign this issue to complete it**. Assign the
tracking issue to GitHub Copilot (or do it by hand) and the task body is the
whole brief: it is written to stand alone, because the coding agent may see
nothing but the issue.

The derived change edits **only** these files:

- `cmake/GDKDependencies.cmake` — adds the edition to `GDK_SUPPORTED_VERSIONS`.
- `.github/gdk-versions.json` — adds the hosted vcpkg entry, when the port
  exists in the public registry.
- `vcpkg-configuration.json` — moves the registry baseline, when a newer one is
  needed to resolve the port.
- `vcpkg.json` — only if the manifest needs the new version. An `ms-gdk`
  override left behind by an earlier proposal is always realigned, because an
  override beats the registry baseline: a stale pin silently resolves the old
  SDK no matter what the hosted default says.

Each file is listed with its current value and its required value, so a stale
"current" value is a visible signal that main has moved and the change must be
re-derived rather than forced in. If the public vcpkg registry has no `ms-gdk`
port for the release yet, the task covers the installed-GDK path only and says
so.

A servicing update from an older family never becomes the hosted default, so its
validation commands pin the candidate through the `ms-gdk` override first and
restore the committed default afterwards. Without that, `cmake --preset default`
would build the newer SDK and prove nothing about the release under review.

The task also tells the agent, in as many words, that it **cannot** validate the
change — building needs Windows and an installed GDK — and that it must open the
pull request as a draft that honestly records validation as not yet run. The
exact local validation commands for the edition are included verbatim; they
differ between the installed-GDK and hosted-vcpkg paths. **Nothing in this
automation ever runs them.**

## Posting and staged mode

`GDK_ASSESS_MODE` in the publisher step of `gdk-release-assess.md` controls
writes. `post` (the default) comments on the tracking issue. Set it to `staged`
to render the assessment to the job summary and write nothing. The watcher's
equivalent is the `preview` dispatch input.

The assessor is independently dispatchable, so the publisher re-checks the
trusted context the watcher checks — target repository, `refs/heads/main` — and
stages instead of posting anywhere else. A fork or feature-branch run therefore
produces a job summary and nothing else, whatever `GDK_ASSESS_MODE` says.

`GDK_SUPPORT_PROPOSAL_MODE` controls how the support change is handed off:

| Value | Behaviour |
| ----- | --------- |
| `issue` (default) | Render the change as an assignable task in the assessment comment. No branch, no pull request, no write beyond the comment. |
| `pull-request` | Push `automation/gdk-<version>-<id>` and open a draft pull request. |

`pull-request` additionally needs `contents: write` and `pull-requests: write`
restored on the `post-gdk-assessment` job **and** **Allow GitHub Actions to
create and approve pull requests** enabled in the repository's Actions settings.
Flip both or neither; the job is deliberately shipped with neither. If the mode
is on but a permission is missing, the publisher detects the permission error,
falls back to the assignable task, and still posts the assessment rather than
losing it.

Do not add a personal access token or a GitHub App to work around the setting.
The change exists to be reviewed by a human, and a token with more authority
does not change that.

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
