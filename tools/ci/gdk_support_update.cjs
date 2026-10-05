'use strict';

// Deterministic support-list updater for the GDK release watcher.
//
// When the assessor classifies a release as `tests_only`, this module computes
// the narrow set of configuration edits that would add the release to this
// repository's supported set, renders a draft pull request from the repository
// PR template, and pushes it. The agent never authors a patch: it only says
// "no source change appears to be required", and everything below is derived
// from the release identity and the files already in the repository.
//
// Unit tested in tools/ci/tests/gdk_support_update.test.cjs.

const { WatchError, editionOf, parseRegistryBaseline } = require('./gdk_release_watch.cjs');

const VCPKG_OWNER = 'microsoft';
const VCPKG_REPO = 'vcpkg';
const MS_GDK_VERSIONS_PATH = 'versions/m-/ms-gdk.json';
const VCPKG_BASELINE_PATH = 'versions/baseline.json';
const PR_TEMPLATE_PATH = '.github/PULL_REQUEST_TEMPLATE.md';

// The complete set of files this automation is ever allowed to read or write.
// Anything outside this list is a source change, which is a human's call.
const SOURCE_PATHS = Object.freeze([
  'cmake/GDKDependencies.cmake',
  '.github/gdk-versions.json',
  'vcpkg-configuration.json',
  'vcpkg.json',
  PR_TEMPLATE_PATH,
]);

const LIMITS = Object.freeze({
  maxRegistryCommits: 300,
  maxRegistryFileBytes: 8 * 1024 * 1024,
});

const TEMPLATE_HEADINGS = Object.freeze([
  'Summary',
  'Public API changes',
  'Spec / docs / samples updated',
  'Test coverage delta',
  'Validation run',
  'Migration notes',
]);

function parsePortVersion(version) {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,6})$/.exec(String(version || ''));
  if (!match) throw new WatchError(`${JSON.stringify(version)} is not a YYMM.N.build port version.`);
  return { family: Number(match[1]), update: Number(match[2]), build: Number(match[3]) };
}

// ---------------------------------------------------------------------------
// Public vcpkg registry lookups
// ---------------------------------------------------------------------------

async function fetchRegistryFile({ github, ref, path: filePath }) {
  const response = await github.request('GET /repos/{owner}/{repo}/contents/{path}', {
    owner: VCPKG_OWNER,
    repo: VCPKG_REPO,
    path: filePath,
    ref,
    mediaType: { format: 'raw' },
  });
  const data = typeof response.data === 'string' ? response.data : String(response.data || '');
  if (data.length > LIMITS.maxRegistryFileBytes) {
    throw new WatchError(`${filePath} at ${ref} is larger than the ${LIMITS.maxRegistryFileBytes}-byte read limit.`);
  }
  try {
    return JSON.parse(data);
  } catch (error) {
    throw new WatchError(`${filePath} at ${ref} is not valid JSON: ${error.message}`);
  }
}

function portVersionsIn(file) {
  const versions = file && Array.isArray(file.versions) ? file.versions : null;
  if (!versions) throw new WatchError(`${MS_GDK_VERSIONS_PATH} has no "versions" array.`);
  return versions.map((entry) => String((entry && entry.version) || ''));
}

function findPortEntry(file, version) {
  const versions = file && Array.isArray(file.versions) ? file.versions : [];
  return (
    versions.find((entry) => entry && entry.version === version && Number(entry['port-version'] || 0) === 0) || null
  );
}

async function msGdkBaselineVersion({ github, ref }) {
  const baseline = await fetchRegistryFile({ github, ref, path: VCPKG_BASELINE_PATH });
  const entry = baseline && baseline.default && baseline.default['ms-gdk'];
  if (!entry || typeof entry.baseline !== 'string') {
    throw new WatchError(`${VCPKG_BASELINE_PATH} at ${ref} does not declare an ms-gdk baseline.`);
  }
  return entry.baseline;
}

async function listRegistryCommits({ github }) {
  const commits = await github.paginate(
    github.rest.repos.listCommits,
    { owner: VCPKG_OWNER, repo: VCPKG_REPO, path: MS_GDK_VERSIONS_PATH, per_page: 100 },
    (response, done) => {
      if (response.data.length >= LIMITS.maxRegistryCommits) done();
      return response.data;
    },
  );
  return commits.slice(0, LIMITS.maxRegistryCommits).map((commit) => commit.sha);
}

// Picks the earliest registry commit that publishes `version`, so a support PR
// carries the smallest baseline move that does the job instead of jumping to an
// arbitrary registry HEAD. The vcpkg version database is append-only, so
// membership is monotonic along the commit list and can be bisected.
async function findEarliestRegistryCommit({ github, version }) {
  const commits = await listRegistryCommits({ github });
  if (!commits.length) throw new WatchError('No commits were found for the ms-gdk version database.');
  const newest = await fetchRegistryFile({ github, ref: commits[0], path: MS_GDK_VERSIONS_PATH });
  if (!findPortEntry(newest, version)) return null;

  // commits[0] is newest. Find the largest index that still contains `version`.
  let low = 0;
  let high = commits.length - 1;
  let best = 0;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const file = await fetchRegistryFile({ github, ref: commits[mid], path: MS_GDK_VERSIONS_PATH });
    if (findPortEntry(file, version)) {
      best = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return commits[best];
}

async function isDescendant({ github, base, head }) {
  if (base === head) return true;
  const { data } = await github.rest.repos.compareCommitsWithBasehead({
    owner: VCPKG_OWNER,
    repo: VCPKG_REPO,
    basehead: `${base}...${head}`,
  });
  return data.status === 'ahead' || data.status === 'identical';
}

// Returns how (or whether) the hosted vcpkg matrix can reach `version`:
//   { available: false }                      -> installed-GDK path only
//   { available: true, baselineChange: null } -> the pinned baseline suffices
//   { available: true, baselineChange: {...} }-> advance the baseline
async function resolveRegistryCandidate({ github, core, baseline, version, requiredVersions = [] }) {
  const atBaseline = await fetchRegistryFile({ github, ref: baseline, path: MS_GDK_VERSIONS_PATH });
  if (findPortEntry(atBaseline, version)) {
    return { available: true, baselineChange: null, baselineMsGdk: await msGdkBaselineVersion({ github, ref: baseline }) };
  }

  const commit = await findEarliestRegistryCommit({ github, version });
  if (!commit) {
    if (core) core.info(`ms-gdk ${version} is not published to the public vcpkg registry.`);
    return { available: false };
  }
  if (!(await isDescendant({ github, base: baseline, head: commit }))) {
    throw new WatchError(`Registry commit ${commit} is not a descendant of the pinned baseline ${baseline}.`);
  }

  const atCommit = await fetchRegistryFile({ github, ref: commit, path: MS_GDK_VERSIONS_PATH });
  const published = new Set(portVersionsIn(atCommit));
  const missing = requiredVersions.filter((required) => !published.has(required));
  if (missing.length) {
    throw new WatchError(`Registry commit ${commit} no longer publishes already-supported ms-gdk version(s): ${missing.join(', ')}.`);
  }

  return {
    available: true,
    baselineChange: { from: baseline, to: commit },
    baselineMsGdk: await msGdkBaselineVersion({ github, ref: commit }),
  };
}

// ---------------------------------------------------------------------------
// Bounded file edits
// ---------------------------------------------------------------------------

function updateSupportedEditions(text, edition) {
  const pattern = /(set\(GDK_SUPPORTED_VERSIONS\s+")([^"]*)(")/;
  const match = pattern.exec(text);
  if (!match) throw new WatchError('GDK_SUPPORTED_VERSIONS was not found in cmake/GDKDependencies.cmake.');
  const current = match[2].split(';').map((value) => value.trim()).filter(Boolean);
  if (current.includes(edition)) return { text, changed: false };
  const next = [...current, edition].sort((a, b) => Number(a) - Number(b));
  for (const existing of current) {
    if (!next.includes(existing)) throw new WatchError('Refusing an edit that would drop an existing supported edition.');
  }
  return { text: text.replace(pattern, `$1${next.join(';')}$3`), changed: true, value: next };
}

// Preserves the existing two-space JSON layout and the `_comment` keys, and
// never removes an entry: multiple backlog PRs must be able to land in any order.
function updateHostedMatrix(json, entry, { advanceDefault }) {
  const next = { ...json };
  const supported = Array.isArray(json.supported) ? json.supported.slice() : [];
  const existing = supported.find((item) => item && item.version === entry.version);
  let changed = false;
  if (!existing) {
    supported.push({ version: entry.version, edition: entry.edition, release: entry.release });
    changed = true;
  }
  supported.sort((a, b) => Number(b.edition) - Number(a.edition));
  next.supported = supported;

  if (advanceDefault) {
    const currentDefault = supported.find((item) => item.version === json.default);
    if (!currentDefault) throw new WatchError(`Current default ${json.default} is missing from the supported list.`);
    if (Number(entry.edition) > Number(currentDefault.edition)) {
      next.default = entry.version;
      changed = true;
    }
  }
  return { json: next, changed, defaultChanged: next.default !== json.default };
}

// Hand-rolled so the committed file keeps its existing layout (two-space keys,
// one-line `supported` entries). A plain JSON.stringify would reflow every
// entry and bury the real change in formatting churn.
function stringifyHostedMatrix(json) {
  const lines = ['{'];
  const keys = Object.keys(json);
  keys.forEach((key, index) => {
    const comma = index === keys.length - 1 ? '' : ',';
    if (key !== 'supported') {
      lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(json[key])}${comma}`);
      return;
    }
    lines.push('  "supported": [');
    json.supported.forEach((entry, entryIndex) => {
      const fields = ['version', 'edition', 'release']
        .map((field) => `${JSON.stringify(field)}: ${JSON.stringify(entry[field])}`)
        .join(', ');
      lines.push(`    { ${fields} }${entryIndex === json.supported.length - 1 ? '' : ','}`);
    });
    lines.push(`  ]${comma}`);
  });
  lines.push('}');
  return `${lines.join('\n')}\n`;
}

function updateRegistryBaseline(text, baseline) {
  if (!/^[0-9a-f]{40}$/.test(String(baseline || ''))) {
    throw new WatchError(`${JSON.stringify(baseline)} is not a 40-character registry commit.`);
  }
  const pattern = /("baseline"\s*:\s*")([0-9a-f]{40})(")/;
  const match = pattern.exec(text);
  if (!match) throw new WatchError('vcpkg-configuration.json does not pin a default-registry baseline.');
  if (match[2] === baseline) return { text, changed: false };
  return { text: text.replace(pattern, `$1${baseline}$3`), changed: true, from: match[2] };
}

// A surgical `ms-gdk` override, used only when the proposed hosted default is
// not what the chosen registry baseline would resolve on its own. Edited as
// text rather than re-serialised JSON so the manifest's hand-formatted inline
// arrays survive untouched, and deliberately refuses to guess at an overrides
// block it did not write itself.
const MS_GDK_OVERRIDE_PATTERN = /("overrides"\s*:\s*\[\s*\{\s*"name"\s*:\s*"ms-gdk"\s*,\s*"version"\s*:\s*")([^"]+)(")/;

function updateMsGdkOverride(text, version) {
  const source = String(text);
  if (/^\s*"overrides"\s*:/m.test(source)) {
    const match = MS_GDK_OVERRIDE_PATTERN.exec(source);
    if (!match) {
      throw new WatchError('vcpkg.json already declares "overrides" in an unrecognised shape; update it by hand.');
    }
    if (match[2] === version) return { text: source, changed: false };
    return { text: source.replace(MS_GDK_OVERRIDE_PATTERN, `$1${version}$3`), changed: true, from: match[2] };
  }

  const anchor = /^ {4}"features"\s*:\s*\{$/m;
  if (!anchor.test(source)) throw new WatchError('vcpkg.json does not have the expected top-level "features" block.');
  const block = ['    "overrides": [', `        { "name": "ms-gdk", "version": ${JSON.stringify(version)} }`, '    ],', ''].join('\n');
  const next = source.replace(anchor, (line) => `${block}${line}`);
  JSON.parse(next);
  return { text: next, changed: true, from: null };
}

// ---------------------------------------------------------------------------
// Update plan
// ---------------------------------------------------------------------------

// `sources` carries the exact current file contents (read from the analyzed
// commit), so a plan is always computed against what is really on main.
function planSupportUpdate({ release, sources: rawSources, registry }) {
  const parsed = parsePortVersion(release.version);
  if (editionOf(parsed.family, parsed.update) !== release.edition) {
    throw new WatchError(`Release ${release.version} does not map to edition ${release.edition}.`);
  }

  // Committed blobs are LF. A CRLF-normalised working copy must never leak
  // line-ending churn into a generated commit.
  const sources = Object.fromEntries(
    Object.entries(rawSources).map(([key, value]) => [key, String(value).replace(/\r\n/g, '\n')]),
  );

  const files = [];
  const notes = [];

  const cmake = updateSupportedEditions(sources['cmake/GDKDependencies.cmake'], release.edition);
  if (cmake.changed) {
    files.push({ path: 'cmake/GDKDependencies.cmake', content: cmake.text });
    notes.push(`Adds edition \`${release.edition}\` to \`GDK_SUPPORTED_VERSIONS\` (now \`${cmake.value.join(';')}\`).`);
  } else {
    notes.push(`Edition \`${release.edition}\` is already in \`GDK_SUPPORTED_VERSIONS\`.`);
  }

  let hostedChanged = false;
  let defaultChanged = false;
  if (registry && registry.available) {
    const hostedJson = JSON.parse(sources['.github/gdk-versions.json']);
    const hosted = updateHostedMatrix(
      hostedJson,
      { version: release.version, edition: release.edition, release: release.releaseLabel.replace(/ Update \d+$/, '') },
      { advanceDefault: true },
    );
    hostedChanged = hosted.changed;
    defaultChanged = hosted.defaultChanged;
    if (hosted.changed) {
      files.push({ path: '.github/gdk-versions.json', content: stringifyHostedMatrix(hosted.json) });
      notes.push(`Adds \`${release.version}\` to the hosted CI matrix${hosted.defaultChanged ? ` and advances \`default\` to \`${release.version}\`` : ''}.`);
    }

    if (registry.baselineChange) {
      const configuration = updateRegistryBaseline(sources['vcpkg-configuration.json'], registry.baselineChange.to);
      if (configuration.changed) {
        files.push({ path: 'vcpkg-configuration.json', content: configuration.text });
        notes.push(
          `Advances the vcpkg registry baseline from \`${registry.baselineChange.from}\` to \`${registry.baselineChange.to}\`, ` +
            'the earliest public-registry commit that publishes this port version.',
        );
      }
    }

    const resolved = registry.baselineMsGdk;
    const proposedDefault = hosted.json.default;
    if (resolved && resolved !== proposedDefault) {
      const manifest = updateMsGdkOverride(sources['vcpkg.json'], proposedDefault);
      if (manifest.changed) {
        files.push({ path: 'vcpkg.json', content: manifest.text });
        notes.push(
          `Pins \`ms-gdk\` to \`${proposedDefault}\` via a manifest override, because the selected registry baseline resolves \`${resolved}\` on its own.`,
        );
      }
    }
  } else {
    notes.push(
      `\`ms-gdk ${release.version}\` is not published to the public vcpkg registry, so this release is installed-GDK only. ` +
        'The hosted CI matrix and the registry baseline are unchanged.',
    );
  }

  if (!files.length) {
    throw new WatchError('The support configuration already covers this release; there is nothing to propose.');
  }

  return {
    files,
    notes,
    kind: registry && registry.available ? 'vcpkg' : 'installed',
    hostedChanged,
    defaultChanged,
    baselineChange: registry && registry.available ? registry.baselineChange : null,
  };
}

// ---------------------------------------------------------------------------
// Pull request body
// ---------------------------------------------------------------------------

function splitTemplate(rawTemplate) {
  const template = String(rawTemplate).replace(/\r\n/g, '\n');
  const sections = new Map();
  const headingPattern = /^## (.+)$/gm;
  const matches = [...template.matchAll(headingPattern)];
  if (!matches.length) throw new WatchError('The pull request template has no "## " sections.');
  const preamble = template.slice(0, matches[0].index);
  matches.forEach((match, index) => {
    const start = match.index + match[0].length;
    const end = index + 1 < matches.length ? matches[index + 1].index : template.length;
    sections.set(match[1].trim(), template.slice(start, end));
  });
  for (const heading of TEMPLATE_HEADINGS) {
    if (!sections.has(heading)) throw new WatchError(`The pull request template is missing the "${heading}" section.`);
  }
  return { preamble, sections, order: matches.map((match) => match[1].trim()) };
}

function leadingComments(body) {
  const comments = [];
  let rest = body.replace(/^\n+/, '');
  for (;;) {
    const match = /^<!--[\s\S]*?-->\n?/.exec(rest);
    if (!match) break;
    comments.push(match[0].trimEnd());
    rest = rest.slice(match[0].length).replace(/^\n+/, '');
  }
  return { comments, rest };
}

function validationCommands({ plan, release }) {
  if (plan.kind === 'vcpkg') {
    return [
      'cmake --preset default',
      'pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\\tools\\run_all_tests.ps1',
      'cmake --preset default-release',
      'cmake --build --preset release',
    ];
  }
  return [
    `cmake --preset installed-gdk -DGDK_VERSION=${release.edition}`,
    'cmake --build --preset debug-installed-gdk',
    '.\\build\\installed-gdk\\bin\\Debug\\gdk_unit_tests.exe',
    'pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\\tools\\run_all_tests.ps1 -SkipBuild -SkipDoctest',
    `cmake --preset installed-gdk-release -DGDK_VERSION=${release.edition}`,
    'cmake --build --preset release-installed-gdk',
  ];
}

function validationSection({ plan, release }) {
  const lines = [
    '**Nothing in this list has been run yet.** The automation performed public-evidence static',
    'analysis only; it did not build this repository or execute any test.',
    '',
  ];
  if (plan.kind === 'vcpkg') {
    lines.push(
      'This branch moves the vcpkg configuration, so the standard orchestrator run exercises the new SDK:',
      '',
      '```powershell',
      ...validationCommands({ plan, release }),
      '```',
      '',
      `Before trusting the result, confirm that the restored dependency really is \`ms-gdk ${release.version}\``,
      '(check the vcpkg install log and the `_GRDK_EDITION` value in the resolved `grdk.h`). A successful',
      'configure alone does not prove the new edition was selected.',
    );
  } else {
    lines.push(
      `This release has no public vcpkg port, so it must be validated against an installed GDK \`${release.edition}\``,
      'in a fresh checkout. `tools\\run_all_tests.ps1` always builds and runs the default `build\\` tree, so the',
      'build and doctest stages are run explicitly against `build\\installed-gdk\\` and then skipped in the',
      'orchestrator — otherwise the orchestrator would silently re-validate the vcpkg SDK instead:',
      '',
      '```powershell',
      ...validationCommands({ plan, release }),
      '```',
      '',
      'Record the real results of the two explicitly-run stages (`cmake --build --preset debug-installed-gdk`',
      'and `gdk_unit_tests.exe`) in the box above; they are skipped in the orchestrator run, not untested.',
      `Confirm the resolved install path and the \`_GRDK_EDITION\` value match edition \`${release.edition}\`.`,
    );
  }
  lines.push(
    '',
    'Commands are ordered so the debug host tests run before the release build mirrors DLLs over them.',
    'Attach `build\\test-results\\run-summary.json` and `run-summary.md`, and record the Godot version used.',
    'Live coverage stays off by default; live reads need `-Live`, and live writes additionally need',
    '`-AllowLiveWrites` against a verified sandbox PlayFab title. This automation never touches that title.',
  );
  return lines.join('\n');
}

function tickChecklist(body, { tickLabel }) {
  return body
    .split('\n')
    .map((line) => {
      if (!/^- \[ \] /.test(line)) return line;
      return line.includes(tickLabel) ? line.replace('- [ ] ', '- [x] ') : line;
    })
    .join('\n');
}

function renderPullRequestBody({ template, release, plan, issueNumber, assessmentUrl, analyzedSha, runUrl }) {
  const { preamble, sections, order } = splitTemplate(template);
  const replacements = new Map();

  replacements.set('Summary', () =>
    [
      `Proposes support for **Microsoft GDK ${release.version}** (edition \`${release.edition}\`,`,
      `[${release.name}](${release.url})) by extending this repository's support lists only.`,
      '',
      `The automated assessment for this release classified it as **tests only** — no addon source change`,
      `appeared to be required. That assessment is public-evidence static analysis, not proven binary`,
      `compatibility, and the SDK archive was deliberately not downloaded or inspected.`,
      '',
      '> [!IMPORTANT]',
      '> This draft claims **proposed** support pending local validation. Do not mark it ready for review',
      '> until the commands under "Validation run" have actually been executed and their results recorded.',
      '',
      `Tracking issue: #${issueNumber}${assessmentUrl ? ` · [assessment report](${assessmentUrl})` : ''}`,
      '',
      '### Proposed changes',
      '',
      ...plan.notes.map((note) => `- ${note}`),
      ...(plan.baselineChange
        ? [
            '',
            '> [!WARNING]',
            '> The vcpkg registry baseline applies to **every** port in the manifest, not just `ms-gdk`.',
            '> Review the baseline move for unrelated dependency changes before merging.',
          ]
        : []),
    ].join('\n'));

  replacements.set('Public API changes', () =>
    ['None. This branch changes build configuration and the supported-version lists only.'].join('\n'));

  replacements.set('Spec / docs / samples updated', (body) =>
    tickChecklist(body, { tickLabel: 'Not applicable' }).trimEnd());

  replacements.set('Test coverage delta', () =>
    [
      'No tests were added or removed; this branch re-runs the existing suites against a new SDK edition.',
      '',
      '- Contract (offline) tests added/removed: none',
      '- Live-read tests added/removed: none',
      '- Live-write tests added/removed: none',
      '- Live title id used (if any): none — this automation never uses live credentials',
    ].join('\n'));

  replacements.set('Validation run', () => validationSection({ plan, release }));

  replacements.set('Migration notes', () => 'None.');

  const parts = [preamble.trimEnd(), ''];
  for (const heading of order) {
    const original = sections.get(heading);
    const { comments, rest } = leadingComments(original);
    const replacement = replacements.get(heading);
    const content = replacement ? replacement(rest) : rest.trim();
    parts.push(`## ${heading}`, '', ...(comments.length ? [comments.join('\n\n'), ''] : []), content.trim(), '');
  }
  parts.push(
    '---',
    `<sub>Opened by the GDK release watcher from \`${analyzedSha}\` · [workflow run](${runUrl})</sub>`,
    '',
  );
  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Branch and draft pull request
// ---------------------------------------------------------------------------

function branchNameFor(release) {
  return `automation/gdk-${release.version}-${release.id}`;
}

async function readSourcesAtCommit({ github, owner, repo, ref, paths }) {
  const sources = {};
  for (const filePath of paths) {
    const response = await github.request('GET /repos/{owner}/{repo}/contents/{path}', {
      owner,
      repo,
      path: filePath,
      ref,
      mediaType: { format: 'raw' },
    });
    sources[filePath] = typeof response.data === 'string' ? response.data : String(response.data || '');
  }
  return sources;
}

async function findExistingPull({ github, owner, repo, branch }) {
  const pulls = await github.paginate(github.rest.pulls.list, {
    owner,
    repo,
    state: 'all',
    head: `${owner}:${branch}`,
    per_page: 100,
  });
  return pulls.length ? pulls[pulls.length - 1] : null;
}

async function getBranchHead({ github, owner, repo, branch }) {
  try {
    const { data } = await github.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
    return data.object.sha;
  } catch (error) {
    if (error && error.status === 404) return null;
    throw error;
  }
}

async function pushSupportBranch({ github, owner, repo, branch, baseSha, files, message }) {
  const existingHead = await getBranchHead({ github, owner, repo, branch });
  if (existingHead && existingHead !== baseSha) {
    // Someone (or an earlier partial run) already advanced this branch. Never
    // force over it; recover the existing pull request instead.
    return { pushed: false, head: existingHead, reason: 'branch already has commits' };
  }
  const { data: baseCommit } = await github.rest.git.getCommit({ owner, repo, commit_sha: baseSha });
  const { data: tree } = await github.rest.git.createTree({
    owner,
    repo,
    base_tree: baseCommit.tree.sha,
    tree: files.map((file) => ({ path: file.path, mode: '100644', type: 'blob', content: file.content })),
  });
  if (tree.sha === baseCommit.tree.sha) {
    throw new WatchError('The proposed edits produce no change against the analyzed commit.');
  }
  const { data: commit } = await github.rest.git.createCommit({
    owner,
    repo,
    message,
    tree: tree.sha,
    parents: [baseSha],
  });
  if (existingHead) {
    await github.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.sha, force: false });
  } else {
    await github.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: commit.sha });
  }
  return { pushed: true, head: commit.sha };
}

async function createSupportPullRequest({ github, core, owner, repo, release, plan, baseSha, baseBranch, body, issueNumber }) {
  const branch = branchNameFor(release);
  const existingPull = await findExistingPull({ github, owner, repo, branch });
  if (existingPull) {
    core.notice(`A support pull request for GDK ${release.version} already exists: ${existingPull.html_url}`);
    return { created: false, url: existingPull.html_url, number: existingPull.number, branch };
  }

  const message = [
    `build(gdk): propose support for GDK ${release.version}`,
    '',
    `Adds edition ${release.edition} to the supported lists so it can be validated locally.`,
    `Pending local validation; see #${issueNumber}.`,
  ].join('\n');

  const push = await pushSupportBranch({ github, owner, repo, branch, baseSha, files: plan.files, message });
  if (!push.pushed) {
    const recovered = await findExistingPull({ github, owner, repo, branch });
    if (recovered) return { created: false, url: recovered.html_url, number: recovered.number, branch };
    throw new WatchError(`Branch ${branch} already exists at ${push.head} without a pull request; resolve it manually.`);
  }

  const { data: pull } = await github.rest.pulls.create({
    owner,
    repo,
    title: `build(gdk): propose support for GDK ${release.version} (edition ${release.edition})`,
    head: branch,
    base: baseBranch,
    body,
    draft: true,
  });
  core.notice(`Opened draft support pull request: ${pull.html_url}`);
  return { created: true, url: pull.html_url, number: pull.number, branch };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Everything a tests-only assessment needs to turn into a draft pull request.
// Sources are read from the analyzed commit through the API rather than the
// checkout so a CRLF-normalised working tree can never leak into the commit.
async function openSupportProposal({ github, core, context, env, release, issueNumber, sha, runUrl, assessmentUrl }) {
  const { owner, repo } = context.repo;
  const baseBranch = env.GDK_SUPPORT_BASE_BRANCH || 'main';
  const sources = await readSourcesAtCommit({ github, owner, repo, ref: sha, paths: SOURCE_PATHS });
  const state = parseSupportSources(sources);

  const registry = await resolveRegistryCandidate({
    github,
    core,
    baseline: state.baseline,
    version: release.version,
    requiredVersions: state.hostedVersions,
  });
  const plan = planSupportUpdate({ release, sources, registry });
  const body = renderPullRequestBody({
    template: sources[PR_TEMPLATE_PATH],
    release,
    plan,
    issueNumber,
    assessmentUrl,
    analyzedSha: sha,
    runUrl,
  });

  return createSupportPullRequest({
    github,
    core,
    owner,
    repo,
    release,
    plan,
    baseSha: sha,
    baseBranch,
    body,
    issueNumber,
  });
}

function parseSupportSources(sources) {
  const hosted = JSON.parse(sources['.github/gdk-versions.json']);
  const configuration = JSON.parse(sources['vcpkg-configuration.json']);
  const baseline = parseRegistryBaseline(configuration);
  const hostedVersions = Array.isArray(hosted.supported)
    ? hosted.supported.map((entry) => String(entry.version)).filter(Boolean)
    : [];
  return { baseline, hostedVersions };
}

module.exports = {
  LIMITS,
  MS_GDK_VERSIONS_PATH,
  PR_TEMPLATE_PATH,
  SOURCE_PATHS,
  TEMPLATE_HEADINGS,
  VCPKG_BASELINE_PATH,
  VCPKG_OWNER,
  VCPKG_REPO,
  branchNameFor,
  createSupportPullRequest,
  fetchRegistryFile,
  findEarliestRegistryCommit,
  findExistingPull,
  findPortEntry,
  isDescendant,
  leadingComments,
  msGdkBaselineVersion,
  openSupportProposal,
  parsePortVersion,
  parseSupportSources,
  planSupportUpdate,
  portVersionsIn,
  pushSupportBranch,
  readSourcesAtCommit,
  renderPullRequestBody,
  resolveRegistryCandidate,
  splitTemplate,
  stringifyHostedMatrix,
  tickChecklist,
  updateHostedMatrix,
  updateMsGdkOverride,
  updateRegistryBaseline,
  updateSupportedEditions,
  validationCommands,
};
