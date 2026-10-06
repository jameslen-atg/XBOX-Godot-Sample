'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const support = require('../gdk_support_update.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OWNER = 'microsoft';
const REPO = 'XBOX-Godot-Sample';
const BASE_SHA = 'b'.repeat(40);
const BASELINE = '0fbc6277db12d4a3ae21e47e238f32c38ae722b8';

function readRepoFile(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');
}

const RELEASE = Object.freeze({
  id: 4242,
  tag: 'April-2026-Update-2-v2604.2.7850',
  name: 'Microsoft GDK April 2026 Update 2',
  url: 'https://github.com/microsoft/GDK/releases/tag/April-2026-Update-2-v2604.2.7850',
  version: '2604.2.7850',
  edition: '260402',
  releaseLabel: 'April 2026 Update 2',
  asset: 'GDK_2604.2.7850.zip',
});

const CMAKE_FIXTURE = [
  '# Supported installed GDK editions.',
  'set(GDK_SUPPORTED_VERSIONS "251001;251002;260400;260401"',
  '    CACHE STRING "Editions this project supports")',
  '',
].join('\n');

const HOSTED_FIXTURE = {
  _comment: 'Hosted CI matrix.',
  default: '2604.1.7839',
  supported: [
    { version: '2604.1.7839', edition: '260401', release: 'April 2026' },
    { version: '2510.2.6247', edition: '251002', release: 'October 2025' },
  ],
};

const VCPKG_CONFIG_FIXTURE = `${JSON.stringify(
  { 'default-registry': { kind: 'git', repository: 'https://github.com/microsoft/vcpkg', baseline: BASELINE } },
  null,
  2,
)}\n`;

const VCPKG_MANIFEST_FIXTURE = [
  '{',
  '    "name": "godot-gdk-extensions",',
  '    "dependencies": [ "ms-gdk" ],',
  '    "features": {',
  '        "tests": { "description": "Unit tests", "dependencies": [ "doctest" ] }',
  '    }',
  '}',
  '',
].join('\n');

function sources(overrides = {}) {
  return {
    'cmake/GDKDependencies.cmake': CMAKE_FIXTURE,
    '.github/gdk-versions.json': `${JSON.stringify(HOSTED_FIXTURE, null, 2)}\n`,
    'vcpkg-configuration.json': VCPKG_CONFIG_FIXTURE,
    'vcpkg.json': VCPKG_MANIFEST_FIXTURE,
    ...overrides,
  };
}

function fakeCore() {
  const core = { infos: [], notices: [], warnings: [] };
  core.info = (message) => core.infos.push(message);
  core.notice = (message) => core.notices.push(message);
  core.warning = (message) => core.warnings.push(message);
  return core;
}

function httpError(status) {
  const error = new Error(`HTTP ${status}`);
  error.status = status;
  return error;
}

// Models the append-only vcpkg version database: `commits` is newest-first and
// each entry declares the ms-gdk versions published at that commit.
function fakeRegistry({ commits, descendants = true, baselineVersions = {} }) {
  const byRef = new Map(commits.map((commit) => [commit.sha, commit]));
  return {
    request: async (_route, params) => {
      const commit = byRef.get(params.ref);
      if (!commit) throw httpError(404);
      if (params.path === support.MS_GDK_VERSIONS_PATH) {
        return {
          data: JSON.stringify({
            versions: commit.versions.map((version) => ({ version, 'port-version': 0, 'git-tree': 'x'.repeat(40) })),
          }),
        };
      }
      if (params.path === support.VCPKG_BASELINE_PATH) {
        const resolved = baselineVersions[commit.sha] || commit.versions[0];
        return { data: JSON.stringify({ default: { 'ms-gdk': { baseline: resolved } } }) };
      }
      throw httpError(404);
    },
    paginate: async (fn, params, mapper) => {
      const response = await fn(params);
      return mapper ? mapper(response, () => {}) : response.data;
    },
    rest: {
      repos: {
        listCommits: async () => ({ data: commits.map((commit) => ({ sha: commit.sha })) }),
        compareCommitsWithBasehead: async () => ({ data: { status: descendants ? 'ahead' : 'diverged' } }),
      },
    },
  };
}

function registryCommits() {
  // Newest first, exactly as the commits API returns them.
  return [
    { sha: 'c'.repeat(40), versions: ['2604.3.7874', '2604.2.7850', '2604.1.7839', '2510.2.6247'] },
    { sha: 'd'.repeat(40), versions: ['2604.2.7850', '2604.1.7839', '2510.2.6247'] },
    { sha: 'e'.repeat(40), versions: ['2604.2.7850', '2604.1.7839', '2510.2.6247'] },
    { sha: 'f'.repeat(40), versions: ['2604.1.7839', '2510.2.6247'] },
    { sha: BASELINE, versions: ['2604.1.7839', '2510.2.6247'] },
  ];
}

// ---------------------------------------------------------------------------
// Bounded file edits
// ---------------------------------------------------------------------------

test('listRegistryCommits stops paginating once the commit cap is reached', async () => {
  // A real Octokit paginate() keeps calling until the mapper calls done(), so a
  // cap compared against one page's length (<= per_page) never fires and the
  // whole version-database history gets fetched and then discarded.
  const pages = 12;
  let requested = 0;
  const github = {
    paginate: async (fn, params, mapper) => {
      const collected = [];
      let stop = false;
      const done = () => {
        stop = true;
      };
      for (let page = 0; page < pages && !stop; page += 1) {
        const response = await fn({ ...params, page });
        collected.push(...mapper(response, done));
      }
      return collected;
    },
    rest: {
      repos: {
        listCommits: async ({ page }) => {
          requested += 1;
          return { data: Array.from({ length: 100 }, (_, i) => ({ sha: `${page}-${i}` })) };
        },
      },
    },
  };

  const commits = await support.listRegistryCommits({ github });
  assert.equal(commits.length, support.LIMITS.maxRegistryCommits, 'the cap still bounds the result');
  assert.equal(requested, 3, 'three 100-commit pages reach the 300 cap; the other nine are never fetched');
});

test('updateSupportedEditions inserts the edition in order and leaves the rest alone', () => {
  const result = support.updateSupportedEditions(CMAKE_FIXTURE, '260402');
  assert.equal(result.changed, true);
  assert.match(result.text, /set\(GDK_SUPPORTED_VERSIONS "251001;251002;260400;260401;260402"/);
  assert.match(result.text, /CACHE STRING "Editions this project supports"/);
  assert.equal(result.text.split('\n').length, CMAKE_FIXTURE.split('\n').length);
});

test('updateSupportedEditions sorts numerically and is idempotent', () => {
  const inserted = support.updateSupportedEditions('set(GDK_SUPPORTED_VERSIONS "251002;260401")', '251003');
  assert.deepEqual(inserted.value, ['251002', '251003', '260401']);
  assert.equal(support.updateSupportedEditions(inserted.text, '251003').changed, false);
  assert.throws(() => support.updateSupportedEditions('set(OTHER "1")', '260402'), /was not found/);
});

test('hosted matrix edits preserve the committed file layout exactly', () => {
  const committed = readRepoFile('.github/gdk-versions.json');
  assert.equal(
    support.stringifyHostedMatrix(JSON.parse(committed)),
    committed,
    'a re-serialised matrix must be byte-identical so a diff shows only the real change',
  );
});

test('updateHostedMatrix adds newest-first, never drops, and only advances a stale default', () => {
  const added = support.updateHostedMatrix(
    HOSTED_FIXTURE,
    { version: '2604.2.7850', edition: '260402', release: 'April 2026' },
    { advanceDefault: true },
  );
  assert.equal(added.changed, true);
  assert.equal(added.defaultChanged, true);
  assert.equal(added.json.default, '2604.2.7850');
  assert.deepEqual(added.json.supported.map((entry) => entry.edition), ['260402', '260401', '251002']);
  assert.equal(added.json._comment, HOSTED_FIXTURE._comment, 'unrelated keys survive');

  // An older backlog entry must not steal the default from a newer release.
  const older = support.updateHostedMatrix(
    HOSTED_FIXTURE,
    { version: '2510.4.6300', edition: '251004', release: 'October 2025' },
    { advanceDefault: true },
  );
  assert.equal(older.changed, true);
  assert.equal(older.defaultChanged, false);
  assert.equal(older.json.default, '2604.1.7839');
  assert.equal(older.json.supported.length, 3);

  assert.equal(
    support.updateHostedMatrix(HOSTED_FIXTURE, { version: '2604.1.7839', edition: '260401', release: 'April 2026' }, { advanceDefault: true })
      .changed,
    false,
  );
});

test('updateRegistryBaseline rewrites only the pinned baseline', () => {
  const next = 'a'.repeat(40);
  const result = support.updateRegistryBaseline(VCPKG_CONFIG_FIXTURE, next);
  assert.equal(result.changed, true);
  assert.equal(result.from, BASELINE);
  assert.equal(JSON.parse(result.text)['default-registry'].baseline, next);
  assert.equal(JSON.parse(result.text)['default-registry'].repository, 'https://github.com/microsoft/vcpkg');
  assert.equal(support.updateRegistryBaseline(result.text, next).changed, false);
  assert.throws(() => support.updateRegistryBaseline(VCPKG_CONFIG_FIXTURE, 'not-a-sha'), /40-character/);
});

test('updateMsGdkOverride inserts, bumps and refuses to guess', () => {
  const inserted = support.updateMsGdkOverride(VCPKG_MANIFEST_FIXTURE, '2604.2.7850');
  assert.equal(inserted.changed, true);
  assert.equal(inserted.from, null);
  const parsed = JSON.parse(inserted.text);
  assert.deepEqual(parsed.overrides, [{ name: 'ms-gdk', version: '2604.2.7850' }]);
  assert.ok(parsed.features.tests, 'the hand-formatted features block survives');
  assert.match(inserted.text, /"dependencies": \[ "ms-gdk" \]/, 'inline arrays are not reflowed');

  assert.equal(support.updateMsGdkOverride(inserted.text, '2604.2.7850').changed, false);
  const bumped = support.updateMsGdkOverride(inserted.text, '2604.3.7874');
  assert.equal(bumped.from, '2604.2.7850');
  assert.equal(JSON.parse(bumped.text).overrides[0].version, '2604.3.7874');

  const foreign = '{\n    "overrides": [ { "name": "zlib", "version": "1.0" } ],\n    "features": {\n    }\n}\n';
  assert.throws(() => support.updateMsGdkOverride(foreign, '2604.2.7850'), /unrecognised shape/);
  assert.throws(() => support.updateMsGdkOverride('{}\n', '2604.2.7850'), /expected top-level "features"/);
});

test('the committed vcpkg manifest still matches the shape the override edit expects', () => {
  const result = support.updateMsGdkOverride(readRepoFile('vcpkg.json'), '2604.2.7850');
  assert.equal(result.changed, true);
  assert.deepEqual(JSON.parse(result.text).overrides, [{ name: 'ms-gdk', version: '2604.2.7850' }]);
});

test('parsePortVersion rejects anything that is not a port version', () => {
  assert.deepEqual(support.parsePortVersion('2604.2.7850'), { family: 2604, update: 2, build: 7850 });
  for (const bad of ['260402', '2604.2', 'v2604.2.7850', '']) {
    assert.throws(() => support.parsePortVersion(bad), /port version/);
  }
});

test('branchNameFor is stable and unique per release', () => {
  assert.equal(support.branchNameFor(RELEASE), 'automation/gdk-2604.2.7850-4242');
});

// ---------------------------------------------------------------------------
// Registry resolution
// ---------------------------------------------------------------------------

test('resolveRegistryCandidate reports no change when the pinned baseline already publishes the port', async () => {
  const github = fakeRegistry({
    commits: [{ sha: BASELINE, versions: ['2604.2.7850', '2604.1.7839'] }],
    baselineVersions: { [BASELINE]: '2604.2.7850' },
  });
  const result = await support.resolveRegistryCandidate({ github, core: fakeCore(), baseline: BASELINE, version: '2604.2.7850' });
  assert.deepEqual(result, { available: true, baselineChange: null, baselineMsGdk: '2604.2.7850' });
});

test('resolveRegistryCandidate picks the earliest registry commit that publishes the port', async () => {
  const commits = registryCommits();
  const github = fakeRegistry({ commits });
  const result = await support.resolveRegistryCandidate({
    github,
    core: fakeCore(),
    baseline: BASELINE,
    version: '2604.2.7850',
    requiredVersions: ['2604.1.7839', '2510.2.6247'],
  });
  assert.equal(result.available, true);
  assert.deepEqual(result.baselineChange, { from: BASELINE, to: 'e'.repeat(40) });
});

test('resolveRegistryCandidate falls back to the installed-only path when the port is unpublished', async () => {
  const core = fakeCore();
  const github = fakeRegistry({ commits: registryCommits() });
  const result = await support.resolveRegistryCandidate({ github, core, baseline: BASELINE, version: '2604.9.7999' });
  assert.deepEqual(result, { available: false });
  assert.ok(core.infos.some((message) => /not published to the public vcpkg registry/.test(message)));
});

test('resolveRegistryCandidate refuses a baseline move that is unsafe', async () => {
  await assert.rejects(
    support.resolveRegistryCandidate({
      github: fakeRegistry({ commits: registryCommits(), descendants: false }),
      core: fakeCore(),
      baseline: BASELINE,
      version: '2604.2.7850',
    }),
    /not a descendant of the pinned baseline/,
  );

  await assert.rejects(
    support.resolveRegistryCandidate({
      github: fakeRegistry({ commits: registryCommits() }),
      core: fakeCore(),
      baseline: BASELINE,
      version: '2604.2.7850',
      requiredVersions: ['2604.1.7839', '2404.0.0000'],
    }),
    /no longer publishes already-supported ms-gdk version\(s\): 2404\.0\.0000/,
  );
});

test('findEarliestRegistryCommit returns null when even registry HEAD lacks the port', async () => {
  const github = fakeRegistry({ commits: registryCommits() });
  assert.equal(await support.findEarliestRegistryCommit({ github, version: '2700.0.1' }), null);
});

// ---------------------------------------------------------------------------
// Update plan
// ---------------------------------------------------------------------------

test('planSupportUpdate touches only the installed allowlist when the port is unpublished', () => {
  const plan = support.planSupportUpdate({ release: RELEASE, sources: sources(), registry: { available: false } });
  assert.equal(plan.kind, 'installed');
  assert.deepEqual(plan.files.map((file) => file.path), ['cmake/GDKDependencies.cmake']);
  assert.equal(plan.hostedChanged, false);
  assert.ok(plan.notes.some((note) => /installed-GDK only/.test(note)));
});

test('planSupportUpdate moves the whole vcpkg configuration when the port is published', () => {
  const plan = support.planSupportUpdate({
    release: RELEASE,
    sources: sources(),
    registry: { available: true, baselineChange: { from: BASELINE, to: 'e'.repeat(40) }, baselineMsGdk: '2604.1.7839' },
  });
  assert.equal(plan.kind, 'vcpkg');
  assert.deepEqual(plan.files.map((file) => file.path), [
    'cmake/GDKDependencies.cmake',
    '.github/gdk-versions.json',
    'vcpkg-configuration.json',
    'vcpkg.json',
  ]);
  assert.equal(plan.defaultChanged, true);
  const manifest = plan.files.find((file) => file.path === 'vcpkg.json');
  assert.deepEqual(JSON.parse(manifest.content).overrides, [{ name: 'ms-gdk', version: '2604.2.7850' }]);
});

test('planSupportUpdate omits the manifest override when the baseline already resolves the default', () => {
  const plan = support.planSupportUpdate({
    release: RELEASE,
    sources: sources(),
    registry: { available: true, baselineChange: null, baselineMsGdk: '2604.2.7850' },
  });
  assert.deepEqual(plan.files.map((file) => file.path), ['cmake/GDKDependencies.cmake', '.github/gdk-versions.json']);
});

test('planSupportUpdate realigns a stale ms-gdk override even when the baseline already resolves the default', () => {
  // A previous proposal pinned an older edition. Leaving that override in place
  // silently resolves the *old* SDK no matter what the hosted default says.
  const stale = VCPKG_MANIFEST_FIXTURE.replace(
    '    "features": {',
    '    "overrides": [ { "name": "ms-gdk", "version": "2604.1.7839" } ],\n    "features": {',
  );
  const plan = support.planSupportUpdate({
    release: RELEASE,
    sources: sources({ 'vcpkg.json': stale }),
    registry: { available: true, baselineChange: null, baselineMsGdk: '2604.2.7850' },
  });
  const manifest = plan.files.find((file) => file.path === 'vcpkg.json');
  assert.ok(manifest, 'the stale override is rewritten, not left behind');
  assert.deepEqual(JSON.parse(manifest.content).overrides, [{ name: 'ms-gdk', version: '2604.2.7850' }]);
});

test('planSupportUpdate validates the candidate, not the newer committed default', () => {
  // An older-family servicing release never becomes the default, so the
  // validation instructions have to select it explicitly.
  const older = { ...RELEASE, version: '2510.3.6300', edition: '251003', tag: 'October-2025-Update-3-v2510.3.6300' };
  const plan = support.planSupportUpdate({
    release: older,
    sources: sources(),
    registry: { available: true, baselineChange: null, baselineMsGdk: '2604.1.7839' },
  });
  assert.equal(plan.defaultChanged, false);
  assert.equal(plan.candidateIsDefault, false);
  const commands = support.validationCommands({ plan, release: older }).join('\n');
  assert.match(commands, /2510\.3\.6300/);
  assert.match(commands, /Restore the committed "ms-gdk" override/);
});

test('planSupportUpdate normalises CRLF sources so no line-ending churn is committed', () => {
  const crlf = Object.fromEntries(Object.entries(sources()).map(([key, value]) => [key, value.replace(/\n/g, '\r\n')]));
  const plan = support.planSupportUpdate({ release: RELEASE, sources: crlf, registry: { available: false } });
  assert.ok(!plan.files.some((file) => file.content.includes('\r')), 'committed blobs are LF');
});

test('planSupportUpdate refuses to open a pull request that changes nothing', () => {
  const covered = sources({
    'cmake/GDKDependencies.cmake': CMAKE_FIXTURE.replace('260401"', '260401;260402"'),
  });
  assert.throws(
    () => support.planSupportUpdate({ release: RELEASE, sources: covered, registry: { available: false } }),
    /already covers this release/,
  );
});

test('planSupportUpdate rejects a release whose version and edition disagree', () => {
  assert.throws(
    () => support.planSupportUpdate({ release: { ...RELEASE, edition: '260403' }, sources: sources(), registry: { available: false } }),
    /does not map to edition/,
  );
});

// ---------------------------------------------------------------------------
// Pull request body
// ---------------------------------------------------------------------------

test('splitTemplate keeps every required section of the committed template', () => {
  const { sections, order } = support.splitTemplate(readRepoFile('.github/PULL_REQUEST_TEMPLATE.md'));
  for (const heading of support.TEMPLATE_HEADINGS) assert.ok(sections.has(heading), heading);
  assert.deepEqual(order.slice(0, support.TEMPLATE_HEADINGS.length), [...support.TEMPLATE_HEADINGS]);
  assert.throws(() => support.splitTemplate('no headings here'), /no "## " sections/);
  assert.throws(() => support.splitTemplate('## Summary\n\ntext\n'), /missing the "Public API changes" section/);
});

test('leadingComments extracts the template guidance comments', () => {
  const { comments, rest } = support.leadingComments('\n<!-- one -->\n<!-- two -->\n\nbody text\n');
  assert.deepEqual(comments, ['<!-- one -->', '<!-- two -->']);
  assert.equal(rest.trim(), 'body text');
});

test('tickChecklist only ticks the matching unchecked item', () => {
  const body = ['- [ ] Docs updated', '- [ ] Not applicable', '- [x] Already done'].join('\n');
  const ticked = support.tickChecklist(body, { tickLabel: 'Not applicable' });
  assert.deepEqual(ticked.split('\n'), ['- [ ] Docs updated', '- [x] Not applicable', '- [x] Already done']);
});

test('renderPullRequestBody fills the real template without dropping its structure', () => {
  const template = readRepoFile('.github/PULL_REQUEST_TEMPLATE.md');
  const plan = support.planSupportUpdate({ release: RELEASE, sources: sources(), registry: { available: false } });
  const body = support.renderPullRequestBody({
    template,
    release: RELEASE,
    plan,
    issueNumber: 321,
    assessmentUrl: 'https://example.test/assessment',
    analyzedSha: BASE_SHA,
    runUrl: 'https://example.test/run',
  });

  for (const heading of support.TEMPLATE_HEADINGS) assert.ok(body.includes(`## ${heading}`), heading);
  const templateComments = template.match(/<!--[\s\S]*?-->/g) || [];
  assert.ok(templateComments.length > 0, 'the committed template has reviewer guidance comments');
  for (const comment of templateComments) assert.ok(body.includes(comment), `dropped template comment: ${comment}`);
  assert.match(body, /Tracking issue: #321/);
  assert.match(body, /Nothing in this list has been run yet/);
  assert.match(body, /pending local validation/i);
  assert.ok(!body.includes('\r'));
});

test('validationCommands match the path the plan actually took', () => {
  const installed = support.validationCommands({ plan: { kind: 'installed' }, release: RELEASE });
  assert.ok(installed.some((command) => command.includes('--preset installed-gdk -DGDK_VERSION=260402')));
  assert.ok(
    installed.some((command) => command.includes('run_all_tests.ps1 -SkipBuild -SkipDoctest')),
    'the orchestrator always builds the default vcpkg tree, so the installed path must skip its build',
  );

  const vcpkg = support.validationCommands({ plan: { kind: 'vcpkg' }, release: RELEASE });
  assert.ok(vcpkg.includes('cmake --preset default'));
  assert.ok(vcpkg.some((command) => /run_all_tests\.ps1$/.test(command)));
});

// ---------------------------------------------------------------------------
// Branch and draft pull request
// ---------------------------------------------------------------------------

function fakeRepoGithub({ pulls = [], branchHead, treeSha = 'tree-new' } = {}) {
  const state = { pulls: pulls.slice(), refs: [], commits: [], trees: [], createdPulls: [], updatedRefs: [] };
  return {
    state,
    paginate: async (fn, params) => (await fn(params)).data,
    rest: {
      pulls: {
        list: async () => ({ data: state.pulls.slice() }),
        create: async ({ title, head, base, body, draft }) => {
          const pull = {
            number: 900 + state.createdPulls.length,
            title,
            head: { ref: head },
            base: { ref: base },
            body,
            draft,
            html_url: `https://github.com/${OWNER}/${REPO}/pull/${900 + state.createdPulls.length}`,
          };
          state.createdPulls.push(pull);
          state.pulls.push(pull);
          return { data: pull };
        },
      },
      git: {
        getRef: async () => {
          if (!branchHead) throw httpError(404);
          return { data: { object: { sha: branchHead } } };
        },
        getCommit: async ({ commit_sha: sha }) => ({ data: { sha, tree: { sha: 'tree-base' } } }),
        createTree: async ({ tree }) => {
          state.trees.push(tree);
          return { data: { sha: treeSha } };
        },
        createCommit: async ({ message, tree, parents }) => {
          state.commits.push({ message, tree, parents });
          return { data: { sha: 'commit-new' } };
        },
        createRef: async ({ ref, sha }) => {
          state.refs.push({ ref, sha });
          return { data: {} };
        },
        updateRef: async (params) => {
          state.updatedRefs.push(params);
          return { data: {} };
        },
      },
    },
  };
}

test('createSupportPullRequest opens a draft pull request from a single commit', async () => {
  const github = fakeRepoGithub();
  const core = fakeCore();
  const plan = support.planSupportUpdate({ release: RELEASE, sources: sources(), registry: { available: false } });
  const result = await support.createSupportPullRequest({
    github,
    core,
    owner: OWNER,
    repo: REPO,
    release: RELEASE,
    plan,
    baseSha: BASE_SHA,
    baseBranch: 'main',
    body: 'body',
    issueNumber: 321,
  });

  assert.equal(result.created, true);
  assert.equal(result.branch, 'automation/gdk-2604.2.7850-4242');
  assert.equal(github.state.createdPulls.length, 1);
  assert.equal(github.state.createdPulls[0].draft, true, 'a human must validate before this is reviewable');
  assert.equal(github.state.createdPulls[0].base.ref, 'main');
  assert.deepEqual(github.state.refs, [{ ref: 'refs/heads/automation/gdk-2604.2.7850-4242', sha: 'commit-new' }]);
  assert.deepEqual(github.state.commits[0].parents, [BASE_SHA]);
  assert.match(github.state.commits[0].message, /^build\(gdk\): propose support for GDK 2604\.2\.7850/);
  assert.match(github.state.commits[0].message, /see #321/);
  assert.deepEqual(github.state.trees[0].map((entry) => entry.path), ['cmake/GDKDependencies.cmake']);
});

test('createSupportPullRequest is idempotent when a pull request already exists', async () => {
  const existing = { number: 55, html_url: 'https://example.test/pull/55', head: { ref: 'automation/gdk-2604.2.7850-4242' } };
  const github = fakeRepoGithub({ pulls: [existing] });
  const plan = support.planSupportUpdate({ release: RELEASE, sources: sources(), registry: { available: false } });
  const result = await support.createSupportPullRequest({
    github,
    core: fakeCore(),
    owner: OWNER,
    repo: REPO,
    release: RELEASE,
    plan,
    baseSha: BASE_SHA,
    baseBranch: 'main',
    body: 'body',
    issueNumber: 321,
  });
  assert.deepEqual(result, { created: false, url: existing.html_url, number: 55, branch: 'automation/gdk-2604.2.7850-4242' });
  assert.equal(github.state.createdPulls.length, 0);
  assert.equal(github.state.refs.length, 0, 'nothing is pushed when the proposal already exists');
});

test('pushSupportBranch never force-pushes over a branch someone advanced', async () => {
  const github = fakeRepoGithub({ branchHead: 'someone-elses-commit' });
  const result = await support.pushSupportBranch({
    github,
    owner: OWNER,
    repo: REPO,
    branch: 'automation/gdk-2604.2.7850-4242',
    baseSha: BASE_SHA,
    files: [{ path: 'a.txt', content: 'x' }],
    message: 'msg',
  });
  assert.deepEqual(result, { pushed: false, head: 'someone-elses-commit', reason: 'branch already has commits' });
  assert.equal(github.state.commits.length, 0);
  assert.equal(github.state.updatedRefs.length, 0);
});

test('createSupportPullRequest reports an advanced branch with no pull request instead of guessing', async () => {
  const github = fakeRepoGithub({ branchHead: 'someone-elses-commit' });
  const plan = support.planSupportUpdate({ release: RELEASE, sources: sources(), registry: { available: false } });
  await assert.rejects(
    support.createSupportPullRequest({
      github,
      core: fakeCore(),
      owner: OWNER,
      repo: REPO,
      release: RELEASE,
      plan,
      baseSha: BASE_SHA,
      baseBranch: 'main',
      body: 'body',
      issueNumber: 321,
    }),
    /already exists at someone-elses-commit without a pull request/,
  );
});

test('pushSupportBranch refuses a commit that would be empty', async () => {
  const github = fakeRepoGithub({ treeSha: 'tree-base' });
  await assert.rejects(
    support.pushSupportBranch({
      github,
      owner: OWNER,
      repo: REPO,
      branch: 'automation/gdk-2604.2.7850-4242',
      baseSha: BASE_SHA,
      files: [{ path: 'a.txt', content: 'x' }],
      message: 'msg',
    }),
    /produce no change against the analyzed commit/,
  );
});

test('readSourcesAtCommit reads raw file contents at the analyzed commit', async () => {
  const seen = [];
  const github = {
    request: async (_route, params) => {
      seen.push(params);
      return { data: `contents of ${params.path}` };
    },
  };
  const result = await support.readSourcesAtCommit({
    github,
    owner: OWNER,
    repo: REPO,
    ref: BASE_SHA,
    paths: ['vcpkg.json', 'cmake/GDKDependencies.cmake'],
  });
  assert.deepEqual(Object.keys(result), ['vcpkg.json', 'cmake/GDKDependencies.cmake']);
  assert.equal(result['vcpkg.json'], 'contents of vcpkg.json');
  assert.ok(seen.every((params) => params.ref === BASE_SHA && params.mediaType.format === 'raw'));
});

// ---------------------------------------------------------------------------
// End-to-end proposal
// ---------------------------------------------------------------------------

function parsedSources() {
  return sources({ '.github/PULL_REQUEST_TEMPLATE.md': readRepoFile('.github/PULL_REQUEST_TEMPLATE.md') });
}

// Serves repository contents, vcpkg registry contents, and the git/pulls APIs
// from one object, exactly as octokit does inside the workflow.
function fakeWorldGithub({ registry, repoSources, pulls = [] }) {
  const repo = fakeRepoGithub({ pulls });
  return {
    state: repo.state,
    request: async (route, params) => {
      if (params.owner === support.VCPKG_OWNER && params.repo === support.VCPKG_REPO) {
        return registry.request(route, params);
      }
      if (!(params.path in repoSources)) throw httpError(404);
      return { data: repoSources[params.path] };
    },
    paginate: async (fn, params, mapper) => {
      if (params && params.repo === support.VCPKG_REPO) return registry.paginate(fn, params, mapper);
      return repo.paginate(fn, params);
    },
    rest: {
      ...repo.rest,
      repos: registry.rest.repos,
    },
  };
}

test('openSupportProposal opens a draft pull request when that mode is explicitly enabled', async () => {
  const github = fakeWorldGithub({
    registry: fakeRegistry({ commits: registryCommits() }),
    repoSources: parsedSources(),
  });
  const core = fakeCore();
  const result = await support.openSupportProposal({
    github,
    core,
    context: { repo: { owner: OWNER, repo: REPO } },
    env: { GDK_SUPPORT_PROPOSAL_MODE: 'pull-request' },
    release: RELEASE,
    issueNumber: 321,
    sha: BASE_SHA,
    runUrl: 'https://example.test/run',
    assessmentUrl: 'https://example.test/comment/1',
  });

  assert.equal(result.created, true);
  assert.equal(result.branch, 'automation/gdk-2604.2.7850-4242');

  const pull = github.state.createdPulls[0];
  assert.equal(pull.draft, true, 'the pull request must never open ready for review');
  assert.equal(pull.base.ref, 'main');
  assert.match(pull.title, /propose support for GDK 2604\.2\.7850 \(edition 260402\)/);
  assert.match(pull.body, /Tracking issue: #321 · \[assessment report\]\(https:\/\/example\.test\/comment\/1\)/);
  assert.match(pull.body, /pending local validation/i);

  const written = github.state.trees[0].map((entry) => entry.path).sort();
  assert.deepEqual(written, ['.github/gdk-versions.json', 'cmake/GDKDependencies.cmake', 'vcpkg-configuration.json']);
  assert.ok(
    written.every((entry) => support.SOURCE_PATHS.includes(entry)),
    'the automation may only ever write files it declared',
  );
});

test('openSupportProposal falls back to an installed-only proposal when vcpkg has no port', async () => {
  const github = fakeWorldGithub({
    registry: fakeRegistry({ commits: registryCommits().map((commit) => ({ ...commit, versions: ['2604.1.7839', '2510.2.6247'] })) }),
    repoSources: parsedSources(),
  });
  const result = await support.openSupportProposal({
    github,
    core: fakeCore(),
    context: { repo: { owner: OWNER, repo: REPO } },
    env: { GDK_SUPPORT_BASE_BRANCH: 'public/main', GDK_SUPPORT_PROPOSAL_MODE: 'pull-request' },
    release: RELEASE,
    issueNumber: 321,
    sha: BASE_SHA,
    runUrl: 'https://example.test/run',
    assessmentUrl: null,
  });

  assert.equal(result.created, true);
  const pull = github.state.createdPulls[0];
  assert.equal(pull.base.ref, 'public/main');
  assert.deepEqual(github.state.trees[0].map((entry) => entry.path), ['cmake/GDKDependencies.cmake']);
  assert.match(pull.body, /not published to the public vcpkg registry/);
  assert.match(pull.body, /cmake --preset installed-gdk -DGDK_VERSION=260402/);
  assert.ok(!pull.body.includes('[assessment report]'), 'no report link is rendered before the report exists');
});

test('openSupportProposal defaults to an assignable task and writes nothing', async () => {
  const github = fakeWorldGithub({
    registry: fakeRegistry({ commits: registryCommits() }),
    repoSources: parsedSources(),
  });
  const result = await support.openSupportProposal({
    github,
    core: fakeCore(),
    context: { repo: { owner: OWNER, repo: REPO } },
    env: {},
    release: RELEASE,
    issueNumber: 321,
    sha: BASE_SHA,
    runUrl: 'https://example.test/run',
    assessmentUrl: 'https://example.test/comment/1',
  });

  assert.equal(result.mode, 'issue');
  assert.equal(result.created, false);
  assert.equal(result.branch, 'automation/gdk-2604.2.7850-4242');
  assert.equal(github.state.trees.length, 0, 'issue mode must not push a branch');
  assert.equal(github.state.createdPulls.length, 0, 'issue mode must not open a pull request');

  // The task body is the entire handoff, so every file the plan touches has to
  // be spelled out with the value to write.
  assert.match(result.instructions, /edition `260402`/);
  assert.match(result.instructions, /`cmake\/GDKDependencies\.cmake`/);
  assert.match(result.instructions, /`\.github\/gdk-versions\.json`/);
  assert.match(result.instructions, /`vcpkg-configuration\.json`/);
  assert.match(result.instructions, /251001;251002;260400;260401;260402/);
  assert.match(result.instructions, /automation\/gdk-2604\.2\.7850-4242/);
  assert.match(result.instructions, /draft/i);
  assert.match(result.instructions, /You cannot complete the validation for this task/);
  assert.match(result.instructions, /Base the work on `main`/);
  assert.ok(!result.instructions.includes('.github/PULL_REQUEST_TEMPLATE.md\n- `'), 'the template is not an editable file');
});

test('openSupportProposal degrades to an assignable task when Actions may not open pull requests', async () => {
  const github = fakeWorldGithub({
    registry: fakeRegistry({ commits: registryCommits() }),
    repoSources: parsedSources(),
  });
  github.rest.pulls.create = async () => {
    throw new Error('GitHub Actions is not permitted to create or approve pull requests');
  };
  const core = fakeCore();
  const result = await support.openSupportProposal({
    github,
    core,
    context: { repo: { owner: OWNER, repo: REPO } },
    env: { GDK_SUPPORT_PROPOSAL_MODE: 'pull-request' },
    release: RELEASE,
    issueNumber: 321,
    sha: BASE_SHA,
    runUrl: 'https://example.test/run',
    assessmentUrl: null,
  });

  assert.equal(result.created, false);
  assert.equal(result.mode, 'issue');
  assert.match(result.fallbackReason, /not permitted to create or approve pull requests/);
  assert.match(result.instructions, /Required edits/);
  assert.ok(core.warnings.some((message) => /Falling back to an assignable task/.test(message)));
});

test('openSupportProposal never hides an unrelated pull request failure', async () => {
  const github = fakeWorldGithub({
    registry: fakeRegistry({ commits: registryCommits() }),
    repoSources: parsedSources(),
  });
  github.rest.pulls.create = async () => {
    throw new Error('Validation Failed: head sha is missing');
  };
  await assert.rejects(
    support.openSupportProposal({
      github,
      core: fakeCore(),
      context: { repo: { owner: OWNER, repo: REPO } },
      env: { GDK_SUPPORT_PROPOSAL_MODE: 'pull-request' },
      release: RELEASE,
      issueNumber: 321,
      sha: BASE_SHA,
      runUrl: 'https://example.test/run',
    }),
    /head sha is missing/,
  );
});

test('resolveSupportMode defaults to issue and rejects anything it does not implement', () => {
  assert.equal(support.resolveSupportMode({}), 'issue');
  assert.equal(support.resolveSupportMode({ GDK_SUPPORT_PROPOSAL_MODE: ' Pull-Request ' }), 'pull-request');
  assert.throws(() => support.resolveSupportMode({ GDK_SUPPORT_PROPOSAL_MODE: 'auto' }), /GDK_SUPPORT_PROPOSAL_MODE/);
});

test('parseSupportSources reads the pinned baseline and the hosted versions it must keep', () => {
  const parsed = support.parseSupportSources(parsedSources());
  assert.equal(parsed.baseline, BASELINE);
  assert.deepEqual(parsed.hostedVersions, ['2604.1.7839', '2510.2.6247']);
  assert.throws(() => support.parseSupportSources(sources({ 'vcpkg-configuration.json': '{}' })), /baseline/);
});
