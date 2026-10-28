# SDK component initialization telemetry

Status: **blocked before emitter implementation** on approved provider and event
metadata. The native addons currently emit no initialization telemetry.

This is the shared design for `godot_gdk` and `godot_playfab`. It does not change
their public initialization API. The design is engine/language neutral; its
implementation scope is only these two native Windows addons.

## Contract and scope

Use native ETW/TraceLogging, not an HTTP uploader, PlayFab analytics, title-facing
`GDK.events`, a managed facade emitter, or a new engine singleton. Do not introduce
a telemetry framework, spool, upload thread, retry, backfill, or shutdown flush.
PlayFab must work independently of the GDK addon; each DLL owns its provider and
loaded-image correlation state.

The proposed event is `SdkComponentInitialized`. It measures successful eligible
development initialization cycles, not attempts, success rates, unique developers,
devices, installs, or process launches. Count the two components independently.
A native Gaming Runtime reference acquisition is not another addon success.

At full addon success, after GDK's rollback guard commits or PlayFab's users
initialize, assign the cycle key and attempt at most one write **before** the
existing `initialized` signal can reenter shutdown/initialization:

- `RuntimeSessionId`: random GUID for one loaded DLL image, preserved across
  ordinary shutdown/reinitialization and replaced only on actual unload/reload.
- `InitializationSequence`: UInt64 successful-cycle counter for that image.
  Advance on each full success, even when collection is suppressed; not on
  failure, rollback, rejected `already_initialized`, or shutdown.
- Deduplication key: `(ComponentId, RuntimeSessionId, InitializationSequence)`.
  Distinct legitimate cycles must not be collapsed.

Provider registration belongs at safe extension registration boundaries, respecting
each `register_types.cpp` duplicate-load reference count, never `DllMain`.
Registration/metadata/write failures cannot change addon success, rollback, or
runtime ownership. Use bounded local diagnostics for unexpected errors without
printing identity values, paths, credentials, or payloads. Disabled consumers and
missing optional metadata are expected, not failures to retry.

## Local eligibility and suppression

Check the **process environment** before optional telemetry collection and again
before a write. Any nonempty `RIT_SUPPRESS_TELEMETRY` value suppresses, including
`0`, `false`, or whitespace. Do not parse it as a Boolean or query raw user/system
registry environment values. Tests/CI must suppress ordinary telemetry; approved
controlled capture is a separate explicit scenario.

After Gaming Runtime initialization, **both addons** must query
`XPackageIsPackagedProcess()`. A true result excludes all installation-identity
processes, including debug packages. False is not sufficient for eligibility.
Supplement it with Windows `GetCurrentPackageFamilyName`; treat
`APPMODEL_ERROR_NO_PACKAGE` as positive unpackaged evidence, confirmed identity as
excluded, and an unexpected result as unknown/suppressed. Packaging is not retail.

Require positive running-engine development evidence and suppress release,
conflicting, or unavailable evidence. Use `Engine::is_editor_hint()` for editor UI,
`OS::has_feature("editor")` for an editor-capable engine running a project, and the
running engine's debug/release features for exports, not the addon's `_DEBUG`.
Editor feature evidence does not establish a parent/launcher relationship.
Keep the actual successful WithOptions selection across reused native runtime
references; do not infer it from current config presence or change initializer
selection for telemetry.

The private `addons/initialization_telemetry/development_policy.h` implements
only the pure evidence-to-decision policy. Its enums are **local decisions, not
approved numeric wire values**. It is currently tested but not yet called by
either addon; no environment/engine/package collection or event write is enabled.
Unknown package/engine evidence fails closed, and release evidence cannot be
overridden by debug/editor/WithOptions evidence.

Do not query, collect, persist, or use
`XPackageGetCurrentProcessPackageIdentifier` as a package gate. The isolated
experiment established that it can succeed in an unpackaged config-backed process;
its opaque installation/session token is not a PFN.

## Proposed fixed payload

Exactly 18 payload fields plus the ETW header timestamp. Empty optional strings
retain the fixed schema. No per-field status/source, package/evidence/path,
HRESULT, success flag, redundant SignalType, or current-process PFN fields.
No persistent user/device/install identifiers.

| Field | Native type | Meaning/source |
| --- | --- | --- |
| SchemaVersion | UInt32 | Proposed payload revision 1, independent of central contractVersion |
| ComponentId | UnicodeString | `godot_gdk` or `godot_playfab` |
| ComponentVersion | UnicodeString | Owning addon's plugin.cfg release version, embedded at build time |
| ComponentKind | UInt32 enum | Engine addon; numeric values require contract freeze |
| RuntimeSessionId | GUID | Loaded DLL image, not process/user/install identity |
| InitializationSequence | UInt64 | Successful-cycle number within image |
| EngineName | UnicodeString | Godot for these emitters |
| EngineVersion | UnicodeString | Actual calling `Engine::get_version_info()`, not godot-cpp build constants |
| ExecutionRuntimeName | UnicodeString | Empty; managed/interpreted attribution deferred |
| ExecutionRuntimeVersion | UnicodeString | Empty; do not infer .NET |
| GamingRuntimeVersion | UnicodeString | Empty unless a supported actual loaded-runtime source is verified |
| GdkBuildSdkVersion | UnicodeString | Real selected grdk.h macros; never synthesized edition 999999 |
| DevelopmentContext | UInt32 enum | Editor, editor-runtime run, development run; wire values pending |
| ConfiguredTitlePackageFamilyName | UnicodeString | Explicit valid game config identity, not editor identity |
| PackagePublisherId | UnicodeString | Windows package publisher ID from configured game PFN |
| DeviceType | UInt32 enum | XSystemGetDeviceType mapped to PC/Console/Unknown; unknown future values stay Unknown |
| XboxTitleId | UnicodeString | XGameGetXboxTitleId as eight uppercase hex digits, else empty |
| PlayFabTitleId | UnicodeString | Resolved configured PlayFab title ID, else empty |

Underlying PlayFab SDK versions are expressly excluded; SDK HTTP headers already
provide that attribution outside this event. Keep the addon's ComponentVersion.
Do not inspect network traffic or investigate another SDK-version field.

Bounds are proposals until owner approval: versions 128 characters, identifiers
256, enumerated strings 64. Freeze exact encodings, limits, enum values, optionality
and over-limit handling against the central inventory before implementation.
Reject unavailable/invalid identities rather than truncate them.

Use `PackageFamilyNameFromId` with explicit valid game config `Identity.Name` and
`Identity.Publisher`, then `PackageNameAndPublisherIdFromFamilyName` to extract
the publisher ID with documented buffer sizing. Leave both empty if unavailable.
No custom hashing, raw publisher DN telemetry, installed-package enumeration,
editor identity substitution, or new setting before using existing config.
This is configured identity, not ownership verification; it is not a Partner
Center seller/organization ID or a PlayFab publisher ID.

Include grdk.h independently of the existing feature-gate wrappers that synthesize
999999. Missing or synthetic metadata is unavailable; preserve existing feature
gates. Device categorization does not add console build support.

Other-engine/direct-SDK/managed consumers may reuse the vocabulary only with an
explicitly reviewed source and eligibility mapping: component version describes
the measured component, engine version describes the actual host, execution
runtime describes the actual executing runtime, and unavailable values stay empty.
A forwarding wrapper must not emit a second native initialization event.

## Plan

1. **Freeze ownership and contract.** Obtain provider headers/README and central
   rit-events.json; confirm provider name/GUID/group, exact event/keyword/level,
   privacy/Core-Critical metadata, numeric enums/bounds, target Windows releases,
   retention, recipient/route/table, purpose and report signals. Keep central
   contractVersion unchanged until formal release. Review engine-neutral reuse
   with intended consumers. Do not invent identifiers, approvals or destinations.
2. **Implement and integrate.** Compile a minimal private helper into both DLLs
   without a shared runtime dependency. Preserve initializer evidence and native
   references. Wire owning emitters, registration, cycle state, typed schema,
   truthful metadata and CMake versions/libraries. Update root doc_classes, addon
   docs/specs, scoped instructions, sample guidance and tests in the same change.
3. **Verify source locally.** In runbook order: review exact contract, Debug build,
   separate-tree Release build, then targeted native and offline tests. Build
   GDK-only and PlayFab-only configurations and cover both combined init orders,
   duplicate calls, rollback, retries, reentrant signals, shutdown/reinitialize,
   duplicate registrations and actual unload/reload. Run the managed headless
   validator for any .gd change. Suppress ordinary test emissions.
4. **Capture/register.** On an authorized non-retail machine, use supported
   elevated TRTT for one eligible cycle per addon, inspect all fields/types,
   compare central inventory, ingest each target Windows release to DataGrid,
   and retain capture/EDI/release/OS build. Disable Test Mode after capture.
   Verify DataGrid schema, group, latency/persistence and classifications; only
   an explicitly supported approved privacy override can explain a difference.
5. **Approve release.** Record Privacy artifact/STaR disposition and Dr. Isaac
   exact event/release rows: core_approved=true, compliance_status_flags=0, valid
   approved privacy tag and is_disallowed=false. Provider filtering is not
   privacy approval. Third-party addon distribution needs explicit coverage.
6. **Publish/validate backend.** In the owning telemetry repository, not this
   addon checkout, use approved Interceptor/Kusto generators and publication
   runbook. Verify route readback, ADX getschema, current ingestion, coverage,
   correlation, schema conformance (zero mismatches) and stability interval.
7. **Reporting/evidence.** Report deduplicated cycles separately from loaded
   images, with unavailable-value rules and distinct Xbox/PlayFab namespaces.
   Validate raw-table agreement, duplicate delivery versus repeat cycles, mixed
   versions and empty intervals. Confirm dashboard ownership/access; prototype
   only on owned pages in a clone, never overwrite shared Toolbox pages.
   Retain source/build/test, capture/DataGrid, approval, publication, ADX and report
   evidence; update inventory lastReviewed/backendStatus only from actual results.

No live writes, sandbox switch, package install/registration, machine elevation,
backend publication or console work is authorized by the current implementation.

## Progress

- Handoff plan, onboarding runbook and isolated experiment reviewed.
- Isolated experiment (prior work): eight native/Godot scenarios using Godot 4.6.2
  and real GDK edition 260405 established unpackaged identifier-query success.
  Synthetic literal config-to-PFN derivation succeeded separately. No actual
  addon, registered/packaged, combined ordering or publisher-extraction controls
  were exercised by that experiment.
- Local policy foundation: pure suppression/development classification and
  offline matrix tests added; shared path routed to both addon CI scopes.
  This is not a production emitter or approved/frozen wire schema.
- Approved provider definitions/metadata/inventory requested from coordinator.
  No fake provider, alternate transport, hidden enablement setting or
  success-shaped no-op emitter has been substituted.
- Native integration, metadata acquisition, cycle keys, Debug/Release addon and
  lifecycle verification: pending.
- TRTT, DataGrid, Privacy/STaR, Dr. Isaac, Interceptor, ADX, reporting and
  production enablement: **pending, not claimed approved or complete**.

### Local foundation evidence (2026-10-28)

| Command | Result |
| --- | --- |
| `cmake --preset default` | Initially blocked by missing pinned godot-cpp; passed after `git submodule update --init --recursive` restored all three required submodules |
| `cmake --build --preset debug --target gdk_unit_tests` | Passed |
| `cmake --preset default-release` | Passed, separate Release tree |
| `cmake --build --preset release --target gdk_unit_tests` | Passed |
| `.\build\bin\Debug\gdk_unit_tests.exe` | 20 cases / 1752 assertions passed |
| `.\build\release\bin\Release\gdk_unit_tests.exe` | 20 cases / 1752 assertions passed |
| `node --test .\tools\ci\tests\pr_gate_scope.test.cjs` | 34 tests passed using a checksum-verified portable Node 22 runtime because Node was absent from PATH |

`RIT_SUPPRESS_TELEMETRY=1` was set for configure/build/native test runs.
The repository orchestrator was intentionally narrowed to the C++ test target
and routing tests: this change adds no addon runtime integration or public
behavior. Full addon Debug/Release, independent/combined lifecycle, actual engine
metadata, process-environment inheritance, registered/packaged gate and capture
verification remain pending. No `.gd` file was touched, so the GDScript parse
gate was not required. Live-service tests and live writes were skipped;
`-Live` and `-AllowLiveWrites` were not used.
