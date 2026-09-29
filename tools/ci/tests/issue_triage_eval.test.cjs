'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const evalHarness = require('../issue_triage_eval.cjs');

const { STATUS, decide } = evalHarness;
const SHA = 'b'.repeat(40);
const VALID = { schema_valid: true, citations_valid: true, errors: [] };

function scorecard(scores, overrides = {}) {
  return {
    case_id: 'case-a',
    reviewer: 'maintainer',
    scores: { grounding: 2, reasoning: 2, uncertainty: 2, missing_information: 2, next_steps: 2, ...scores },
    critical_failure: null,
    ...overrides,
  };
}

function report(overrides = {}) {
  return {
    kind: 'bug',
    summary: 'Summary.',
    assessment: 'Assessment.',
    confidence: 'medium',
    confidence_rationale: 'Because.',
    findings: [{ path: 'src/a.cpp', start_line: 2, end_line: 3, explanation: 'Relevant.' }],
    version_notes: '',
    missing_information: [],
    next_steps: ['Fix it.'],
    security_sensitive: false,
    ...overrides,
  };
}

function issueFixture(overrides = {}) {
  return {
    number: 5,
    url: 'https://github.com/microsoft/XBOX-Godot-Sample/issues/5',
    title: 'Title',
    body: 'Body',
    state: 'open',
    labels: [{ name: 'bug' }],
    user: { login: 'reporter', type: 'User' },
    created_at: '2026-01-01T00:00:00Z',
    captured_at: '2026-02-01T00:00:00Z',
    discussion_cutoff: '2026-02-01T00:00:00Z',
    comments: [],
    ...overrides,
  };
}

function expectationsFixture(overrides = {}) {
  return {
    case_id: 'case-a',
    acceptable_kinds: ['bug'],
    evidence: [
      { id: 'core', required: true, locations: [{ path: 'src/a.cpp', start_line: 1, end_line: 4 }] },
      { id: 'extra', required: false, locations: [{ path: 'src/b.cpp', start_line: 1, end_line: 2 }] },
    ],
    key_facts: [],
    acceptable_uncertainty: [],
    relevant_questions: [],
    avoid: [],
    ...overrides,
  };
}

function caseFixture(issue, overrides = {}) {
  return {
    id: 'case-a',
    target_sha: SHA,
    sha_justification: 'Reported commit.',
    fixture_digest: evalHarness.fixtureDigest(issue),
    ...overrides,
  };
}

test('a total of 7 is a quality fail', () => {
  const result = decide({ validation: VALID, scorecard: scorecard({ reasoning: 1, uncertainty: 1, next_steps: 1 }) });
  assert.equal(result.total, 7);
  assert.equal(result.status, STATUS.QUALITY_FAIL);
});

test('a total of 8 with grounding 2 passes', () => {
  const result = decide({ validation: VALID, scorecard: scorecard({ reasoning: 1, next_steps: 1 }) });
  assert.equal(result.total, 8);
  assert.equal(result.status, STATUS.QUALITY_PASS);
});

test('a total of 8 with grounding 1 fails', () => {
  const result = decide({ validation: VALID, scorecard: scorecard({ grounding: 1, reasoning: 1 }) });
  assert.equal(result.total, 8);
  assert.equal(result.status, STATUS.QUALITY_FAIL);
  assert.match(result.reasons.join('\n'), /grounding is 1/);
});

test('a critical failure overrides a perfect total', () => {
  const result = decide({ validation: VALID, scorecard: scorecard({}, { critical_failure: { reason: 'claimed to reproduce' } }) });
  assert.equal(result.total, 10);
  assert.equal(result.status, STATUS.QUALITY_FAIL);
  assert.match(result.reasons.join('\n'), /critical failure: claimed to reproduce/);
});

test('unscored or partially scored runs are never a pass', () => {
  assert.equal(decide({ validation: VALID, scorecard: null }).status, STATUS.PENDING_REVIEW);
  assert.equal(decide({ validation: VALID, scorecard: evalHarness.blankScorecard('case-a') }).status, STATUS.PENDING_REVIEW);
  assert.equal(decide({ validation: VALID, scorecard: scorecard({}, { reviewer: null }) }).status, STATUS.PENDING_REVIEW);
  assert.equal(decide({ validation: VALID, scorecard: scorecard({ next_steps: 3 }) }).status, STATUS.PENDING_REVIEW);
  assert.equal(decide({ validation: VALID, scorecard: scorecard({}, { critical_failure: 'yes' }) }).status, STATUS.PENDING_REVIEW);
});

test('invalid reports and missing output fail before human scores are considered', () => {
  const invalid = { schema_valid: true, citations_valid: false, errors: ['bad citation'] };
  assert.equal(decide({ validation: invalid, scorecard: scorecard({}) }).status, STATUS.INVALID_REPORT);
  assert.equal(decide({ validation: null, scorecard: scorecard({}) }).status, STATUS.INFRA_FAILURE);
  assert.equal(decide({ outcome: 'timeout', validation: VALID, scorecard: scorecard({}) }).status, STATUS.INFRA_FAILURE);
});

test('the suite passes only when every case passed', () => {
  const results = [
    { case_id: 'a', status: STATUS.QUALITY_PASS },
    { case_id: 'b', status: STATUS.PENDING_REVIEW },
  ];
  assert.deepEqual(evalHarness.suiteVerdict(results, ['a', 'b']), { pass: false, failing_or_missing: ['b'] });
  assert.deepEqual(evalHarness.suiteVerdict(results.slice(0, 1), ['a', 'c']), { pass: false, failing_or_missing: ['c'] });
  assert.equal(evalHarness.suiteVerdict([{ case_id: 'a', status: STATUS.QUALITY_PASS }], ['a']).pass, true);
});

test('fixtureDigest covers every model-visible fixture field and ignores key order', () => {
  const issue = issueFixture({
    user: { login: 'reporter' },
    created_at: '2026-01-01T00:00:00Z',
    comments: [{ id: 1, user: { login: 'u', type: 'User' }, author_association: 'NONE', body: 'hi', created_at: '2026-01-02T00:00:00Z' }],
  });
  const digest = evalHarness.fixtureDigest(issue);
  const reordered = Object.fromEntries(Object.entries(issue).reverse());
  assert.equal(evalHarness.fixtureDigest(reordered), digest);
  const variants = [
    { ...issue, user: { login: 'someone-else' } },
    { ...issue, created_at: '2026-01-05T00:00:00Z' },
    { ...issue, comments: [{ ...issue.comments[0], user: { login: 'other', type: 'User' } }] },
    { ...issue, comments: [{ ...issue.comments[0], author_association: 'MEMBER' }] },
    { ...issue, comments: [{ ...issue.comments[0], created_at: '2026-01-03T00:00:00Z' }] },
  ];
  for (const variant of variants) assert.notEqual(evalHarness.fixtureDigest(variant), digest);
});

test('checkCaseShape accepts a well-formed case', () => {
  const issue = issueFixture();
  assert.deepEqual(evalHarness.checkCaseShape('case-a', caseFixture(issue), issue, expectationsFixture()), []);
});

test('checkCaseShape rejects short SHAs, stale digests, and gold without required evidence', () => {
  const issue = issueFixture();
  const errors = evalHarness.checkCaseShape(
    'case-a',
    caseFixture(issue, { target_sha: 'abc1234', fixture_digest: 'f'.repeat(64) }),
    issue,
    expectationsFixture({ evidence: [{ id: 'x', required: false, locations: [{ path: 'a', start_line: 1, end_line: 1 }] }] }),
  );
  const text = errors.join('\n');
  assert.match(text, /full 40-character/);
  assert.match(text, /fixture_digest does not match/);
  assert.ok(text.includes(`expected ${evalHarness.fixtureDigest(issue)}`));
  assert.match(text, /at least one required group/);
});

test('checkCaseShape rejects closed issues and comments after the cutoff', () => {
  const issue = issueFixture({
    state: 'closed',
    comments: [{ id: 1, user: { login: 'u', type: 'User' }, body: 'late', created_at: '2026-03-01T00:00:00Z' }],
  });
  const text = evalHarness.checkCaseShape('case-a', caseFixture(issue), issue, expectationsFixture()).join('\n');
  assert.match(text, /open issue/);
  assert.match(text, /after the discussion cutoff/);
});

test('checkEvidenceAtCommit reports missing files and out-of-range anchors', () => {
  const counts = { 'src/a.cpp': 3 };
  const errors = evalHarness.checkEvidenceAtCommit(SHA, expectationsFixture(), (_sha, file) => counts[file] ?? null);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /past the end of the file \(3 lines\)/);
  assert.match(errors[1], /src\/b\.cpp.*does not exist/);
});

test('validateFixtures fails when the pinned commit is unavailable instead of falling back', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-eval-'));
  try {
    const dir = path.join(root, 'case-a');
    fs.mkdirSync(dir);
    const issue = issueFixture();
    const missingSha = '0123456789abcdef0123456789abcdef01234567';
    fs.writeFileSync(path.join(dir, 'issue.json'), JSON.stringify(issue));
    fs.writeFileSync(path.join(dir, 'expectations.json'), JSON.stringify(expectationsFixture()));
    fs.writeFileSync(path.join(dir, 'case.json'), JSON.stringify(caseFixture(issue, { target_sha: missingSha })));
    const [result] = evalHarness.validateFixtures({ casesRoot: root, fetch: false });
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), new RegExp(`${missingSha} is not available`));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('extractReport reads raw JSON or the last fenced json block', () => {
  assert.equal(evalHarness.extractReport(JSON.stringify(report())).kind, 'bug');
  const transcript = `Header\n\`\`\`json\n{"kind":"old"}\n\`\`\`\nMore\n\`\`\`json\n${JSON.stringify(report({ kind: 'feature' }))}\n\`\`\`\n`;
  assert.equal(evalHarness.extractReport(transcript).kind, 'feature');
  assert.throws(() => evalHarness.extractReport('no json here'), /No report JSON found/);
});

test('validateReportAt flags schema errors and invalid citations against the pinned source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-eval-src-'));
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'a.cpp'), 'one\ntwo\nthree\n');
    const good = evalHarness.validateReportAt({ reportText: JSON.stringify(report()), sourceDir: root });
    assert.equal(good.schema_valid && good.citations_valid, true);

    const badCitation = report({ findings: [{ path: 'src/a.cpp', start_line: 2, end_line: 9, explanation: 'x' }] });
    const cited = evalHarness.validateReportAt({ reportText: JSON.stringify(badCitation), sourceDir: root });
    assert.equal(cited.schema_valid, true);
    assert.equal(cited.citations_valid, false);

    const badSchema = evalHarness.validateReportAt({ reportText: JSON.stringify(report({ kind: 'nope' })), sourceDir: root });
    assert.equal(badSchema.schema_valid, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('automatedSignals reports kind fit and required evidence coverage', () => {
  const signals = evalHarness.automatedSignals(report(), expectationsFixture());
  assert.equal(signals.kind_acceptable, true);
  assert.equal(signals.required_evidence_covered, true);
  assert.deepEqual(signals.evidence.map((item) => item.covered), [true, false]);

  const missed = evalHarness.automatedSignals(report({ kind: 'feature', findings: [] }), expectationsFixture());
  assert.equal(missed.kind_acceptable, false);
  assert.equal(missed.required_evidence_covered, false);
});

test('the eval context labels the pinned commit and keeps gold data out', () => {
  const issue = issueFixture({
    comments: [
      { id: 1, user: { login: 'bot[bot]', type: 'Bot' }, body: 'bot noise', created_at: '2026-01-02T00:00:00Z' },
      { id: 2, user: { login: 'm', type: 'User' }, body: '/triage', created_at: '2026-01-03T00:00:00Z' },
      { id: 3, user: { login: 'u', type: 'User' }, body: 'real comment', created_at: '2026-01-04T00:00:00Z' },
    ],
  });
  const markdown = evalHarness.buildEvalContext(issue, SHA);
  assert.match(markdown, new RegExp(`Repository snapshot \\(pinned eval commit\\): \`${SHA}\``));
  assert.match(markdown, /real comment/);
  assert.doesNotMatch(markdown, /bot noise/);
  assert.doesNotMatch(markdown, /acceptable_kinds|expected_assessment/);
});

test('collectAgentOutput copies one report item and records missing output as an infra outcome', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'triage-eval-run-'));
  try {
    const runFile = path.join(dir, 'run.json');
    const agentOutput = path.join(dir, 'agent_output.json');
    fs.writeFileSync(runFile, JSON.stringify({ case_id: 'case-a', outcome: 'prepared' }));

    fs.writeFileSync(agentOutput, JSON.stringify({ items: [] }));
    assert.equal(evalHarness.collectAgentOutput({ runDir: dir, agentOutputPath: agentOutput, itemType: 'submit_report' }), 'no-report');
    assert.equal(decide({ outcome: 'no-report', validation: VALID, scorecard: scorecard({}) }).status, STATUS.INFRA_FAILURE);

    const item = { type: 'submit_report', report: JSON.stringify(report({ kind: 'nope' })) };
    fs.writeFileSync(agentOutput, JSON.stringify({ items: [{ type: 'other' }, item] }));
    assert.equal(evalHarness.collectAgentOutput({ runDir: dir, agentOutputPath: agentOutput, itemType: 'submit_report' }), 'completed');
    assert.equal(JSON.parse(fs.readFileSync(runFile, 'utf8')).outcome, 'completed');
    assert.equal(evalHarness.extractReport(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')).kind, 'nope');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('checked-in eval cases are well formed', () => {
  const ids = evalHarness.listCaseIds();
  assert.ok(ids.length >= 4);
  for (const id of ids) {
    const loaded = evalHarness.loadCase(id);
    assert.deepEqual(evalHarness.checkCaseShape(id, loaded.caseDef, loaded.issue, loaded.expectations), [], id);
  }
});

test('parseArgs collects repeated --case/--run and rejects missing values', () => {
  const args = evalHarness.parseArgs(['score', '--run', 'a', '--run', 'b', '--no-fetch']);
  assert.deepEqual(args, { _: ['score'], run: ['a', 'b'], fetch: false });
  assert.throws(() => evalHarness.parseArgs(['prepare', '--out']), /needs a value/);
});
