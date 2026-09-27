'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { initRepo, cloneRepo } = require('./_temp-repo');

const verify = require('../lib/release-certification/verify');
const cli = require('../scripts/scorecard-verify');
const sc = require('../lib/release-certification/scorecard');
const sm = require('../lib/release-certification/state-machine');
const publisherLib = require('../lib/release-certification/publisher');
const publicationLib = require('../lib/release-certification/publication');
const store = require('../lib/release-certification/store');

const { RULES } = verify;
const SHA = 'a'.repeat(40);
const WTID = 'c'.repeat(64);
const DIGEST = 'd'.repeat(64);
const GEN = '4242@Sun Sep 27 09:00:00 2026';
const MIN = 60 * 1000;
const T0 = 1_000_000;
const P = sc.paths(SHA);

/**
 * A canonical manifest.
 * @returns {object} Manifest
 */
function manifest() {
  return sm.buildManifest({
    candidateSha: SHA, version: '5.30.0', repository: 'o/r', requiredChecks: ['test'], requiredChecksSource: 'branch-protection',
    createdAt: T0, worktreePath: '/tmp/wt', worktreeId: WTID, ttydGeneration: GEN, host: 'h'
  });
}

/**
 * Healthy observations with overrides.
 * @param {object} [over] - Per-probe overrides
 * @returns {object} Observations
 */
function obs(over = {}) {
  const b = {
    worktree: { headSha: SHA, detached: true, dirty: false },
    server: { checkoutId: WTID, currentDiskSha: SHA, isStale: false, startupSha: SHA, shaBaselineSource: 'startup', runningVersion: '5.30.0', startedAt: 500 },
    ttyd: { applicable: true, managed: true, generation: GEN, leakState: 'clear', wedgedCount: 0, orphanGate: false, poolUsed: 1 },
    github: { state: 'ok', checks: { test: 'success' } },
    pty: { instance: 's1', attaches: 0, detaches: 0, lastAt: null }
  };
  for (const [k, v] of Object.entries(over)) b[k] = v === null ? null : { ...b[k], ...v };
  return b;
}

/**
 * The documents the publisher would write for a run: admitted, then extended.
 * @returns {{admission: string, card1: string, card2: string, events1: string, events2: string, index2: string, state2: object}} Serialized documents
 */
function documents() {
  const m = manifest();
  const admitted = sm.admit(m, { wallAt: T0, monoAt: 0, runnerInstance: 'r', observations: obs() });
  const s1 = { ...admitted.state, manifestDigest: DIGEST };
  const out = sm.reduce(s1, m, { wallAt: T0 + MIN, monoAt: MIN, runnerInstance: 'r', observations: obs({ server: null }) });
  const events1 = admitted.events.map((e) => JSON.stringify(sc.eventLine(e)));
  const events2 = [...admitted.events, ...out.events].map((e) => JSON.stringify(sc.eventLine(e)));
  const c1 = sc.scorecard(s1, m, T0, 1);
  const c2 = sc.scorecard(out.state, m, T0 + MIN, 2);
  return {
    admission: sc.serialize(sc.admissionRecord(m, DIGEST)),
    card1: sc.serialize(c1),
    card2: sc.serialize(c2),
    events1: `${events1.join('\n')}\n`,
    events2: `${events2.join('\n')}\n`,
    index1: sc.serialize(sc.indexDoc([c1])),
    index2: sc.serialize(sc.indexDoc([c2])),
    state2: out.state
  };
}

/**
 * Judge a change between two in-memory trees.
 * @param {object} before - Path to text
 * @param {object} after - Path to text
 * @returns {string[]} Rule codes found
 */
function judge(before, after) {
  const changed = Object.keys(after).filter((p) => after[p] !== before[p]);
  const deleted = Object.keys(before).filter((p) => !(p in after));
  return verify.verifyChange({
    changed, deleted,
    prev: (p) => (p in before ? before[p] : null),
    next: (p) => (p in after ? after[p] : null)
  }).map((v) => v.rule);
}

describe('verifyChange: the rules, one commit at a time (#1949 C02)', () => {
  const d = documents();
  const first = { [P.admission]: d.admission, [P.scorecard]: d.card1, [P.events]: d.events1, [sc.INDEX_PATH]: d.index1 };
  const second = { ...first, [P.scorecard]: d.card2, [P.events]: d.events2, [sc.INDEX_PATH]: d.index2 };

  it('accepts what the publisher writes: admission, then updates', () => {
    assert.deepEqual(judge({}, { [P.admission]: d.admission }), []);
    assert.deepEqual(judge({ [P.admission]: d.admission }, first), []);
    assert.deepEqual(judge(first, second), []);
  });

  const cases = [
    ['a path outside the certification documents', first, { ...first, 'server.js': 'x' }, RULES.PATH_NOT_ALLOWED],
    ['a workflow file', first, { ...first, '.github/workflows/x.yml': 'x' }, RULES.PATH_NOT_ALLOWED],
    ['a deleted document', first, (() => { const t = { ...first }; delete t[P.events]; return t; })(), RULES.DELETED],
    ['a rewritten admission', first, { ...first, [P.admission]: d.admission.replace('5.30.0', '5.30.1') }, RULES.ADMISSION_REWRITTEN],
    ['an admission that does not validate', {}, { [P.admission]: '{"schema":"x"}' }, RULES.INVALID_DOCUMENT],
    ['an admission filed under another candidate', {}, { [sc.paths('b'.repeat(40)).admission]: d.admission }, RULES.WRONG_CANDIDATE],
    ['a scorecard with no admission', {}, { [P.scorecard]: d.card1 }, RULES.SCORECARD_WITHOUT_ADMISSION],
    ['a scorecard bound to another digest', { [P.admission]: d.admission }, { [P.admission]: d.admission, [P.scorecard]: d.card1.replace(DIGEST, 'e'.repeat(64)) }, RULES.SCORECARD_MISMATCH],
    ['a publishSeq that does not rise', first, { ...second, [P.scorecard]: d.card2.replace('"publishSeq": 2', '"publishSeq": 1') }, RULES.SEQ_NOT_INCREASING],
    ['a rewritten transition log', second, { ...second, [P.events]: d.events2.replace('PROBE_UNKNOWN', 'RECOVERED') }, RULES.EVENTS_REWRITTEN],
    ['a transition log that does not start at admission', { [P.admission]: d.admission }, { [P.admission]: d.admission, [P.events]: `${d.events2.split('\n')[1]}\n` }, RULES.EVENTS_BROKEN_CHAIN],
    ['a log that disagrees with its scorecard', { [P.admission]: d.admission }, { [P.admission]: d.admission, [P.scorecard]: d.card2, [P.events]: d.events1 }, RULES.EVENTS_SCORECARD_MISMATCH],
    ['an index that disagrees with its scorecard', first, { ...second, [sc.INDEX_PATH]: d.index1 }, RULES.INDEX_MISMATCH]
  ];
  for (const [name, before, after, rule] of cases) {
    it(`refuses ${name}`, () => {
      assert.ok(judge(before, after).includes(rule), `${judge(before, after)} should include ${rule}`);
    });
  }

  it('refuses a terminal state that changes, and review going back to a live state', () => {
    const m = manifest();
    const failed = { ...d.state2, state: 'failed', failure: { code: 'LEAK_FIRED', reasons: [], at: T0 + MIN, sampleSeq: 2 } };
    const failedCard = sc.serialize(sc.scorecard(failed, m, T0 + MIN, 3));
    const revived = sc.serialize(sc.scorecard(d.state2, m, T0 + 2 * MIN, 4));
    const withFailed = { [P.admission]: d.admission, [P.scorecard]: failedCard };
    assert.ok(judge(withFailed, { ...withFailed, [P.scorecard]: revived }).includes(RULES.TERMINAL_CHANGED));
    const reviewing = sc.serialize(sc.scorecard({ ...d.state2, state: 'awaiting-review' }, m, T0 + MIN, 3));
    const withReview = { [P.admission]: d.admission, [P.scorecard]: reviewing };
    assert.ok(judge(withReview, { ...withReview, [P.scorecard]: revived }).includes(RULES.REVIEW_REOPENED));
  });
});

describe('verifyHistory: a real metrics branch', () => {
  let tmp;
  let remote;
  let base;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rc-verify-')));
    remote = path.join(tmp, 'remote.git');
    fs.mkdirSync(remote);
    initRepo(remote, ['--bare']);
    base = path.join(tmp, 'v1');
  });

  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  /**
   * Publish an admission and two updates through the real publisher.
   * @returns {Promise<void>}
   */
  async function publishHonestly() {
    const publisher = publisherLib.createPublisher({ dir: path.join(tmp, '_metrics'), remoteUrl: remote, identity: { name: 'T', email: 't@example.invalid' } }, { sleep: async () => {} });
    let t = T0;
    fs.mkdirSync(store.runPaths(base, SHA).dir, { recursive: true, mode: 0o700 });
    const publication = publicationLib.createPublication({ base, candidateSha: SHA, publisher, now: () => t });
    const m = manifest();
    await publication.admit(m, DIGEST);
    const admitted = sm.admit(m, { wallAt: T0, monoAt: 0, runnerInstance: 'r', observations: obs() });
    const s1 = { ...admitted.state, manifestDigest: DIGEST };
    await publication.update({ state: s1, manifest: m, events: admitted.events });
    t += MIN;
    const out = sm.reduce(s1, m, { wallAt: T0 + MIN, monoAt: MIN, runnerInstance: 'r', observations: obs({ server: null }) });
    await publication.update({ state: out.state, manifest: m, events: [...admitted.events, ...out.events] });
  }

  /**
   * Make a commit on metrics by hand, the way someone with push rights could.
   * @param {function(string): void} edit - Changes files in the working clone
   * @returns {void}
   */
  function tamper(edit) {
    const wc = path.join(tmp, `wc-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    cloneRepo(remote, wc, ['-b', 'metrics']);
    edit(wc);
    const g = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=x', '-c', 'user.email=x@example.invalid', ...args], { cwd: wc, stdio: 'pipe' });
    g('add', '-A');
    g('commit', '-q', '-m', 'tamper');
    g('push', '-q', 'origin', 'HEAD:metrics');
  }

  it('finds nothing wrong with what the publisher wrote', async () => {
    await publishHonestly();
    const result = await verify.verifyHistory({ repoDir: remote, ref: 'metrics' });
    assert.equal(result.exists, true);
    assert.equal(result.commits, 3);
    assert.deepEqual(result.violations, []);
  });

  it('reports a branch that does not exist yet as nothing to verify', async () => {
    assert.deepEqual(await verify.verifyHistory({ repoDir: remote, ref: 'metrics' }), { exists: false, commits: 0, violations: [] });
  });

  it('names the commit that rewrote an admission, even after later honest commits', async () => {
    await publishHonestly();
    tamper((wc) => fs.writeFileSync(path.join(wc, P.admission), fs.readFileSync(path.join(wc, P.admission), 'utf8').replace('5.30.0', '5.30.9')));
    const result = await verify.verifyHistory({ repoDir: remote, ref: 'metrics' });
    assert.deepEqual(result.violations.map((v) => [v.rule, v.path]), [[RULES.ADMISSION_REWRITTEN, P.admission]]);
    assert.match(result.violations[0].commit, /^[0-9a-f]{40}$/);
  });

  it('refuses source files and deletions pushed to metrics', async () => {
    await publishHonestly();
    tamper((wc) => {
      fs.writeFileSync(path.join(wc, 'server.js'), 'x');
      fs.rmSync(path.join(wc, P.events));
    });
    const rules = (await verify.verifyHistory({ repoDir: remote, ref: 'metrics' })).violations.map((v) => v.rule).sort();
    assert.deepEqual(rules, [RULES.DELETED, RULES.PATH_NOT_ALLOWED].sort());
  });

  it('refuses a merge commit', async () => {
    await publishHonestly();
    const wc = path.join(tmp, 'wc-merge');
    cloneRepo(remote, wc, ['-b', 'metrics']);
    const g = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=x', '-c', 'user.email=x@example.invalid', ...args], { cwd: wc, stdio: 'pipe' });
    g('checkout', '-q', '-b', 'side', 'HEAD~1');
    g('commit', '-q', '--allow-empty', '-m', 'side');
    g('checkout', '-q', 'metrics');
    g('merge', '-q', '--no-ff', '-m', 'merge', 'side');
    g('push', '-q', 'origin', 'HEAD:metrics');
    const rules = (await verify.verifyHistory({ repoDir: remote, ref: 'metrics' })).violations.map((v) => v.rule);
    assert.ok(rules.includes(RULES.MERGE_COMMIT));
  });

  it('exits 0 on a clean history and 1 with a job summary on a tampered one', async () => {
    await publishHonestly();
    const summary = path.join(tmp, 'summary.md');
    const io = (env = {}) => ({ stdout: { write: () => {} }, stderr: { write: () => {} }, env });
    assert.equal(await cli.main(['--repo', remote, '--ref', 'metrics'], io()), 0);
    tamper((wc) => fs.writeFileSync(path.join(wc, 'notes.txt'), 'x'));
    assert.equal(await cli.main(['--repo', remote, '--ref', 'metrics'], io({ GITHUB_STEP_SUMMARY: summary })), 1);
    assert.match(fs.readFileSync(summary, 'utf8'), /FAILED[\s\S]*PATH_NOT_ALLOWED[\s\S]*notes\.txt/);
    assert.equal(await cli.main(['--nope'], io()), 2);
  });
});

describe('carried in from earlier reviews', () => {
  it('creates the publishing clone with no git hooks', async () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rc-hooks-')));
    try {
      const remote = path.join(tmp, 'remote.git');
      fs.mkdirSync(remote);
      initRepo(remote, ['--bare']);
      const pub = publisherLib.createPublisher({ dir: path.join(tmp, '_metrics'), remoteUrl: remote, identity: { name: 'T', email: 't@example.invalid' } });
      await pub.publish(() => ({ [sc.INDEX_PATH]: 'x\n' }), 'x');
      const hooks = path.join(pub.cloneDir, '.git', 'hooks');
      assert.equal(fs.existsSync(hooks) ? fs.readdirSync(hooks).length : 0, 0, 'no template hooks were copied');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('takes a canonical run through the store to passed', () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rc-pass-')));
    try {
      const b = path.join(tmp, 'v1');
      const m = manifest();
      const s0 = { wallAt: T0, monoAt: 0, runnerInstance: 'r', observations: obs() };
      store.createRun(b, m, sm.admit(m, s0), s0);
      const p = store.runPaths(b, SHA);
      const st = JSON.parse(fs.readFileSync(p.state, 'utf8'));
      fs.writeFileSync(p.state, JSON.stringify({ ...st, state: 'awaiting-review' }));
      const passed = store.updateRun(b, SHA, (state, man) => sm.accept(state, 'jason', T0 + 5, man));
      assert.equal(passed.state, 'passed');
      assert.equal(store.readTransitions(b, SHA).at(-1).code, 'OPERATOR_ACCEPTED');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
