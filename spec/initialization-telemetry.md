# SDK component initialization telemetry

Status: native local-capture ETW emission implemented for both addons.
**No central collector, upload route, destination or production approval
is configured or claimed complete.** The user explicitly authorized a project-owned
provider for local capture; the RIT runbook is a reference, not a dependency.

This is the shared design for `godot_gdk` and `godot_playfab`. It does not change
their public initialization API. The design is engine/language neutral; its
implementation scope is only these two native Windows addons.

## Contract and scope

Use native ETW/TraceLogging, not an HTTP uploader, PlayFab analytics, title-facing
`GDK.events`, a managed facade emitter, or a new engine singleton. Do not introduce
a telemetry framework, spool, upload thread, retry, backfill, or shutdown flush.
PlayFab must work independently of the GDK addon; each DLL owns its provider and
loaded-image correlation state.

The event is `SdkComponentInitialized`. It measures successful eligible
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

User-supplied provider name: `Microsoft.Gaming.Middleware`, local-capture GUID
`{FB4DE56A-AB3F-4E6A-8254-DDDCFCC76572}`, informational ETW severity level 4,
Core event tag `0x00080000` and Critical Data category keyword
`0x0000800000000000`. Core is not an ETW severity level. These values match
`MICROSOFT_EVENTTAG_CORE_DATA` and `MICROSOFT_KEYWORD_CRITICAL_DATA` in the
[public WIL definitions](https://github.com/microsoft/wil/blob/master/include/wil/traceloggingconfig.h).
They are event metadata, not additional payload fields. Core classification was
user-directed; it is not a claim of approval or automatic UTC collection.
No Microsoft provider group or privacy data tag is configured. **Core provider
registration is not implemented:** the event tag and keyword do not substitute
for `TraceLoggingOptionWindowsCoreTelemetry()`. Its supported, non-no-op
definition is still needed; the public WIL definition is intentionally empty
and must not be used to claim Core registration. Privacy tagging must also be
reconciled with the current 18-field payload contract before adding standard
privacy metadata.
The existing GUID remains project-owned and local-capture-only; an approved GUID
for this provider name has not been supplied. Neither the name nor the current
metadata establishes production onboarding. Registering this provider does not
configure a Windows telemetry upload channel. An authorized ETW consumer must enable it;
without one, optional metadata is not collected and no event is written.

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
selection for telemetry. Successful WithOptions initialization is positive
development evidence even outside an editor-capable engine and without a debug
feature; classify that case as a development runtime. Package exclusions and
explicit release/conflicting evidence still suppress.

The private shared code is compiled separately into each DLL:
`development_policy.h` contains the pure decision policy,
`native_telemetry.*` contains Windows identity/correlation/TraceLogging code, and
`godot_telemetry.*` collects the actual running engine and Gaming Runtime metadata.
Each successful root initialization calls it before `initialized`. Unknown
package/engine evidence fails closed, and release evidence cannot be overridden
by debug/editor/WithOptions evidence. Sequence advancement precedes suppression;
eligible captured events can therefore have gaps when earlier cycles were suppressed.

Do not query, collect, persist, or use
`XPackageGetCurrentProcessPackageIdentifier` as a package gate. The isolated
experiment established that it can succeed in an unpackaged config-backed process;
its opaque installation/session token is not a PFN.

## Local-capture schema version 1

Exactly 18 payload fields plus the ETW header timestamp. Empty optional strings
retain the fixed schema. No per-field status/source, package/evidence/path,
HRESULT, success flag, redundant SignalType, or current-process PFN fields.
No persistent user/device/install identifiers.

| Field | Native type | Meaning/source |
| --- | --- | --- |
| SchemaVersion | UInt32 | Payload revision 1 |
| ComponentId | UnicodeString | `godot_gdk` or `godot_playfab` |
| ComponentVersion | UnicodeString | Owning addon's plugin.cfg release version, embedded at build time |
| ComponentKind | UInt32 enum | Engine addon = 3; reserved native SDK = 1, managed SDK = 2, language wrapper = 4 |
| RuntimeSessionId | GUID | Loaded DLL image, not process/user/install identity |
| InitializationSequence | UInt64 | Successful-cycle number within image |
| EngineName | UnicodeString | Godot for these emitters |
| EngineVersion | UnicodeString | Actual calling `Engine::get_version_info()`, not godot-cpp build constants |
| ExecutionRuntimeName | UnicodeString | Empty; managed/interpreted attribution deferred |
| ExecutionRuntimeVersion | UnicodeString | Empty; do not infer .NET |
| GamingRuntimeVersion | UnicodeString | XSystemGetRuntimeInfo().runtimeVersion, four decimal components; all-zero result is unavailable |
| GdkBuildSdkVersion | UnicodeString | Real selected grdk.h macros; never synthesized edition 999999 |
| DevelopmentContext | UInt32 enum | Editor = 1, editor-runtime = 2, development runtime = 3; tooling = 4 is reserved, not emitted |
| ConfiguredTitlePackageFamilyName | UnicodeString | Explicit valid game config identity, not editor identity |
| PackagePublisherId | UnicodeString | Windows package publisher ID from configured game PFN |
| DeviceType | UInt32 enum | Exact `XSystemDeviceType` numeric value returned by `XSystemGetDeviceType()`, without model flattening or remapping |
| XboxTitleId | UnicodeString | XGameGetXboxTitleId as eight uppercase hex digits, else empty |
| PlayFabTitleId | UnicodeString | Resolved configured PlayFab title ID, else empty |

Underlying PlayFab SDK versions are expressly excluded; SDK HTTP headers already
provide that attribution outside this event. Keep the addon's ComponentVersion.
Do not inspect network traffic or investigate another SDK-version field.

The selected GDK defines device values as Unknown = 0, Pc = 1, XboxOne = 2,
XboxOneS = 3, XboxOneX = 4, XboxOneXDevkit = 5, XboxScarlettLockhart = 6,
XboxScarlettAnaconda = 7 and XboxScarlettDevkit = 8. Preserve future UInt32 values
unchanged rather than coercing them to Unknown or suppressing the event.

Lengths are UTF-16 code units, excluding the terminating NUL. Versions are limited
to 128, component/PlayFab IDs to 256, configured PFN to Windows'
`PACKAGE_FAMILY_NAME_MAX_LENGTH` (64), package publisher ID to 13, and Xbox title ID
to exactly eight uppercase hex digits when present. EngineName is fixed `Godot`;
execution-runtime strings are empty. Reject embedded NUL/control characters and
invalid surrogate pairs. Invalid optional metadata becomes unavailable, not
truncated; an invalid required payload suppresses the event with a bounded local
diagnostic. These local choices still need review for any future production route.

Use `PackageFamilyNameFromId` with explicit valid game config `Identity.Name` and
`Identity.Publisher`, then `PackageNameAndPublisherIdFromFamilyName` to extract
the publisher ID with documented buffer sizing. Leave both empty if unavailable.
No custom hashing, raw publisher DN telemetry, installed-package enumeration,
editor identity substitution, or new setting before using existing config.
This is configured identity, not ownership verification; it is not a Partner
Center seller/organization ID or a PlayFab publisher ID.

For WithOptions, use the actual successfully selected config path preserved by
the owning runtime across shutdown/reinitialize. For plain initialization, use
the physical project-root config only when its path is also the executable's
adjacent `MicrosoftGame.config`; never substitute a Godot editor config.
Read at most 1 MiB after successful Gaming Runtime and addon initialization.
Reuse Godot's `XMLParser` to extract `Identity.Name` and `Identity.Publisher`,
then stop. This is metadata extraction from an already accepted config, not a
second schema validator; no separate XML library is needed. Reading/parsing
remains best-effort if the file becomes unavailable or changes after runtime
initialization. No raw publisher distinguished name or config path is emitted.
A missing config/identity leaves the two fields empty.

The Gaming Runtime version source is documented by
[XSystemGetRuntimeInfo](https://learn.microsoft.com/en-us/gaming/gdk/docs/reference/system/xsystem/functions/xsystemgetruntimeinfo)
and [XSystemRuntimeInfo](https://learn.microsoft.com/en-us/gaming/gdk/docs/reference/system/xsystem/structs/xsystemruntimeinfo):
`runtimeVersion` is the runtime service the game is running on; zero means
unavailable. Do not substitute `availableVersion`, an OS version or a build SDK.

Include grdk.h independently of the existing feature-gate wrappers that synthesize
999999. Missing or synthetic metadata is unavailable; preserve existing feature
gates. Recording console device enum values does not add console build support.

Other-engine/direct-SDK/managed consumers may reuse the vocabulary only with an
explicitly reviewed source and eligibility mapping: component version describes
the measured component, engine version describes the actual host, execution
runtime describes the actual executing runtime, and unavailable values stay empty.
A forwarding wrapper must not emit a second native initialization event.

## Plan

1. **Establish local contract.** Use the project-owned provider and typed schema
   above for explicitly authorized local capture. Neither `rit-events.json` nor
   a provider from the source runbook's repository is required.
2. **Implement and integrate.** Compile a minimal private helper into both DLLs
   without a shared runtime dependency. Preserve initializer evidence and native
   references. Wire owning emitters, registration, cycle state, typed schema,
   truthful metadata and CMake versions/libraries. Update Markdown addon docs/specs,
   scoped instructions, sample guidance and tests in the same change. Telemetry
   does not belong in XML class docs. Emit no shutdown event; provider teardown
   only unregisters the handle, without writing or flushing.
3. **Verify source locally.** In runbook order: review exact contract, Debug build,
   separate-tree Release build, then targeted native and offline tests. Build
   GDK-only and PlayFab-only configurations and cover both combined init orders,
   duplicate calls, rollback, retries, reentrant signals, shutdown/reinitialize,
   duplicate registrations and actual unload/reload. Run the managed headless
   validator for any .gd change. Suppress ordinary test emissions.
4. **Capture locally.** Enable this provider with an authorized ETW session, run
   controlled synthetic addon lifecycle scenarios, stop the session and decode
   its ETL. Check names/types, counts, session/sequence and truthful metadata.
   Do not elevate, install/register a package or switch sandbox without permission.
5. **Choose production collection, if wanted.** Obtain the intended collector,
   route/destination, retention/recipients, release scope, ownership and applicable
   privacy data tags and required approvals for the requested Core classification.
   No centralized delivery is implemented.
   Provider filtering and the user's local-capture approval are not production
   distribution/privacy approval.
6. **Onboard the chosen backend.** Follow that pipeline's actual requirements.
   TRTT/DataGrid, Privacy/STaR, Dr. Isaac and Interceptor/ADX are conditional on
   selecting that Microsoft pipeline, not universal ETW implementation gates.
   They remain pending/not performed; do not infer approvals from local capture.
7. **Reporting/evidence.** Report deduplicated cycles separately from loaded
   images, with unavailable-value rules and distinct Xbox/PlayFab namespaces.
   Validate raw-table agreement, duplicate delivery versus repeat cycles, mixed
   versions and empty intervals. Confirm reporting ownership/access before
   publishing or changing any dashboard.
   Retain source/build/test, capture, approval, ingestion and report evidence
   required by the chosen pipeline. No external inventory is assumed.

No live writes, sandbox switch, package install/registration, machine elevation,
backend publication or console work is authorized by the current implementation.

## Local capture

Ordinary test/CI execution sets `RIT_SUPPRESS_TELEMETRY=1`. For an explicitly
authorized synthetic capture, start a session, unset that variable **only in the
controlled process environment**, run the game, then stop/decode:

```powershell
logman start GodotAddonInit -p "{FB4DE56A-AB3F-4E6A-8254-DDDCFCC76572}" 0x0000800000000000 4 -o .\addon-init.etl -ets
# Launch the eligible development game here, without RIT_SUPPRESS_TELEMETRY.
logman stop GodotAddonInit -ets
tracerpt .\addon-init.etl -o .\addon-init.xml -of XML -y
```

Use a unique session name and stop it in a `finally` block in scripted captures.
Capture requires the appropriate existing ETW permissions; do not automatically
elevate or change membership. ETL files include configured identity values and
ETW header process metadata: handle them as local diagnostic artifacts, not
public repository content. There is no uploader or remote destination.

## Progress

- Handoff plan, onboarding runbook and isolated experiment reviewed.
- Isolated experiment (prior work): eight native/Godot scenarios using Godot 4.6.2
  and real GDK edition 260405 established unpackaged identifier-query success.
  Synthetic literal config-to-PFN derivation succeeded separately. No actual
  addon, registered/packaged, combined ordering or publisher-extraction controls
  were exercised by that experiment.
- Local policy and native metadata/correlation/provider tests are implemented;
  shared source paths route to both addon CI scopes and the native test gate.
- User-directed correction: successful WithOptions also establishes development
  runtime evidence without editor/debug features. The corrected policy passed
  the Debug and Release native suites; addon initializer selection remains unchanged.
- User clarified that `rit-events` is specific to the source repository and
  approved a project-owned local-capture provider. Native integration, truthful
  metadata, per-image session/cycle keys and safe provider lifetime are implemented.
- Actual addon captures verified both combined orders, independent-addon hosts,
  GDK reentrancy, PlayFab failure/recovery and non-Boolean suppression values.
  Synthetic configured PFN and Windows publisher-ID extraction were observed on
  the wire. Windows TDH verified all 18 payload property names and input types.
- User-directed simplification: use Godot's existing XML parser only after
  successful runtime initialization, without duplicating config schema validation.
  Removed XmlLite, Shlwapi and the native XML-validation helper/tests. Repeated
  the capture matrix with the Godot parser, including the trailing-whitespace
  config that exposed the earlier traversal issue; identity fields remain correct.
- User-directed device attribution: preserve the actual `XSystemDeviceType`
  numeric result, including model/devkit distinctions and future values, instead
  of flattening consoles into one category.
- User-directed Core classification: emit the public Core event tag and Critical
  Data keyword, keeping ETW severity Informational and all 18 payload fields
  unchanged. Provider-group/UTC routing, privacy tagging and approvals remain
  separate pending work, not implied by the event classification.
  Rebuilt both addons in Debug/Release and passed both native suites (26 cases,
  1816 assertions each). All nine local capture scenarios passed; Windows TDH
  verified the actual Core tag, Critical Data keyword, Informational severity and
  unchanged 18-field schema on four combined-addon events. The orchestrator was
  intentionally not repeated for this metadata-only follow-up; no `.gd` edits
  or live-service tests/writes were involved.
- User supplied `Microsoft.Gaming.Middleware` as the provider name. Renamed it
  without changing the event name or borrowing another component's GUID.
  Rebuilt Debug/Release, passed both native suites and all nine local capture
  scenarios, and verified the provider name and unchanged schema with Windows
  TDH on four actual events. Validation was narrowed to these native/capture
  checks for the metadata-only rename; no `.gd` edits or live tests.
- **Still needed for centralized delivery:** approved provider GUID, real Core
  provider-option definition, collector/transport owner, intended
  destination/table/route, supported release/distribution scope, retention and
  recipients, privacy data tags and required Core/privacy approvals, reporting
  owner and success criteria. No remote delivery is implemented or claimed.
- TRTT, DataGrid, Privacy/STaR, Dr. Isaac, Interceptor and ADX remain **pending/not
  performed**, and are relevant only if that specific backend is chosen.

### Local implementation evidence (2026-10-28)

| Command | Result |
| --- | --- |
| `cmake --preset default` | Initially blocked by missing pinned godot-cpp; passed after `git submodule update --init --recursive` restored all three required submodules |
| `cmake --build --preset debug --target godot_gdk godot_playfab gdk_unit_tests` | Passed |
| `cmake --preset default-release` | Passed, separate Release tree |
| `cmake --build --preset release --target godot_gdk godot_playfab gdk_unit_tests` | Passed |
| `.\build\bin\Debug\gdk_unit_tests.exe` | 26 cases / 1816 assertions passed |
| `.\build\release\bin\Release\gdk_unit_tests.exe` | 26 cases / 1816 assertions passed |
| `cmake --preset gdk-only` then `cmake --build --preset debug-gdk --target godot_gdk` | Passed, independent GDK Debug |
| `cmake --preset playfab-only` then `cmake --build --preset debug-playfab --target godot_playfab` | Passed, independent PlayFab Debug |
| `cmake --preset gdk-only-release` then `cmake --build --preset release-gdk --target godot_gdk` | Passed, independent GDK Release |
| `cmake --preset playfab-only-release` then `cmake --build --preset release-playfab --target godot_playfab` | Passed, independent PlayFab Release |
| `node --test .\tools\ci\tests\pr_gate_scope.test.cjs` | 34 tests passed using a checksum-verified portable Node 22 runtime because Node was absent from PATH |

`RIT_SUPPRESS_TELEMETRY=1` was set for configure/build/native test runs.
The repository orchestrator was intentionally scoped to the affected GDK and
PlayFab hosts; GameInput is unchanged. With official Godot 4.6.2 selected using
`GODOT_CONSOLE`, this command passed:

```powershell
pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\tools\run_all_tests.ps1 -SkipBuild -Hosts tests\godot\gdk,tests\godot\playfab -ParsePaths addons\godot_gdk,addons\godot_playfab,tests\godot\gdk,tests\godot\playfab
```

The parse gate, native suite and all ten bootstrap runners passed. GDK: 339 tests,
306 passing/33 pending, 3235 validated assertions, zero failures. PlayFab: 151
tests, 128 passing/23 pending, 4966 validated assertions, zero failures. Build was
intentionally skipped in this command because the builds above had completed.
No repository `.gd` file was changed; parse still ran as part of this scoped run.
Live-service tests and writes were skipped; neither `-Live` nor
`-AllowLiveWrites` was used.

Non-elevated local ETW captures used a synthetic config/title and official Godot
4.6.2. Combined GDK-first and PlayFab-first runs each produced four events;
GDK reentrant, PlayFab failed-then-successful, GDK-only and PlayFab-only runs each
produced two. `RIT_SUPPRESS_TELEMETRY` values `0`, `false` and whitespace each
produced zero. Sequences were 1/2 per component, session GUIDs were stable within
each image and distinct across components/processes. Captured metadata included
the actual engine string, running Gaming Runtime version, real `_GRDK_EDITION`
value, configured PFN/publisher, canonical Xbox/PlayFab title IDs and the exact
`XSystemDeviceType::Pc` value (1). Console/devkit and future device values have
native payload-validation coverage, not console hardware coverage. ETL and
the synthetic harness remain local session artifacts, not public source.

Limitations: registered/packaged controls and loose debug/release export controls
were not executed in this integration run; the package/release exclusion policy
has offline matrix coverage. Fresh scratch-host editor imports intermittently
crashed during teardown (including before the parser replacement); immediate repeated
imports and all lifecycle scenarios passed. The import crash is unresolved, not
claimed fixed or conclusively attributed. A first parse attempt using an ambient
custom Godot 4.5.1 build failed leak-warning checks; the explicit official 4.6.2
run above passed. Other engine versions and backend delivery remain unverified.
