'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const sm = require('../lib/release-certification/state-machine');
const sc = require('../lib/release-certification/scorecard');
const { STATES } = require('../lib/release-certification/codes');

const SHA = 'a'.repeat(40);
const WTID = 'c'.repeat(64);
const DIGEST = 'f'.repeat(64);
const GEN = '4242@Sun Sep 27 09:00:00 2026';
const WORKTREE = '/Users/secret-operator/private/rc-worktree';
const HOST = 'secret-host.tail123678.ts.net';
const MIN = 60 * 1000;
const T0 = 1_000_000;

/**
 * A manifest carrying recognisable private values.
 * @param {object} [thresholds] - Overrides
 * @returns {object} Manifest
 */
function manifest(thresholds) {
  return sm.buildManifest({
    candidateSha: SHA, version: '5.30.0', repository: 'o/r', requiredChecks: ['test'], createdAt: T0,
    worktreePath: WORKTREE, worktreeId: WTID, ttydGeneration: GEN, host: HOST, thresholds
  });
}

/**
 * Healthy observations with overrides.
 * @param {object} [over] - Per-probe overrides
 * @returns {object} Observations
 */
function obs(over = {}) {
  const base = {
    worktree: { headSha: SHA, detached: true, dirty: false },
    server: { checkoutId: WTID, currentDiskSha: SHA, isStale: false, startupSha: SHA, shaBaselineSource: 'startup', runningVersion: '5.30.0', startedAt: 500 },
    ttyd: { applicable: true, managed: true, generation: GEN, leakState: 'clear', wedgedCount: 0, orphanGate: false, poolUsed: 4 },
    github: { state: 'ok', checks: { test: 'success' } },
    pty: { instance: 's1', attaches: 0, detaches: 0, lastAt: null }
  };
  for (const [k, v] of Object.entries(over)) base[k] = v === null ? null : { ...base[k], ...v };
  return base;
}

/**
 * A sample.
 * @param {number} t - Offset ms
 * @param {object} [o] - Observations
 * @returns {object} Sample
 */
function sample(t, o = obs()) {
  return { wallAt: T0 + t, monoAt: t, runnerInstance: 'r1', observations: o, diagnostics: { server: 'http-401' } };
}

/**
 * Run samples through the state machine, carrying a manifest digest as the store would.
 * @param {object} m - Manifest
 * @param {object[]} samples - Samples after admission
 * @returns {{state: object, events: object[]}} Final state and all events
 */
function run(m, samples) {
  let { state, events } = sm.admit(m, sample(0));
  state = { ...state, manifestDigest: DIGEST };
  for (const s of samples) {
    const out = sm.reduce(state, m, s);
    state = out.state;
    events = events.concat(out.events);
  }
  return { state, events };
}

const FAST = { targetQualifiedMs: 2 * MIN, ptyMinAttaches: 1, ptyMinDetaches: 1, ptyMinSpanMs: 1 };
const busy = (n, t) => obs({ pty: { attaches: n, detaches: n, lastAt: T0 + t } });

describe('published documents (#1949 C02)', () => {
  it('lays out each candidate under release-certification/v1/', () => {
    assert.deepEqual(sc.paths(SHA), {
      admission: `release-certification/v1/admissions/${SHA}.json`,
      scorecard: `release-certification/v1/scorecards/${SHA}.json`,
      events: `release-certification/v1/events/${SHA}.ndjson`
    });
    assert.equal(sc.INDEX_PATH, 'release-certification/v1/index.json');
  });

  it('admits with the manifest digest and the rules the run is judged by', () => {
    const a = sc.admissionRecord(manifest(), DIGEST);
    assert.deepEqual(Object.keys(a).sort(), ['admittedAt', 'candidateSha', 'canonicalThresholds', 'manifestDigest', 'repository', 'requiredChecks', 'schema', 'thresholds', 'version']);
    assert.equal(a.manifestDigest, DIGEST);
    assert.equal(a.canonicalThresholds, true);
    assert.equal(a.admittedAt, T0);
    assert.deepEqual(sc.validateAdmission(a), []);
    assert.equal(sc.admissionRecord(manifest(FAST), DIGEST).canonicalThresholds, false);
  });

  it('builds a scorecard that validates, carrying the digest and the standing', () => {
    const m = manifest();
    const { state } = run(m, [sample(MIN), sample(2 * MIN, obs({ server: null }))]);
    const c = sc.scorecard(state, m, T0 + 2 * MIN, 3);
    assert.deepEqual(sc.validateScorecard(c), []);
    assert.equal(c.manifestDigest, DIGEST);
    assert.equal(c.state, STATES.EXTENDED);
    assert.equal(c.qualifiedMs, MIN);
    assert.deepEqual(c.extensions, { PROBE_UNKNOWN: { intervals: 1, lostMs: MIN } });
    assert.equal(c.publishSeq, 3);
    assert.equal(c.failure, null);
  });

  it('publishes only a failure code and time, not the per-probe reasons', () => {
    const m = manifest();
    const { state } = run(m, [sample(MIN, obs({ worktree: { dirty: true } }))]);
    const c = sc.scorecard(state, m, T0 + MIN, 1);
    assert.deepEqual(c.failure, { code: 'WORKTREE_DIRTY', at: T0 + MIN });
    assert.deepEqual(sc.validateScorecard(c), []);
  });

  it('publishes the accepting operator, or withholds the id when asked', () => {
    const m = manifest(FAST);
    const reviewing = run(m, [sample(MIN, busy(1, MIN)), sample(2 * MIN, busy(2, 2 * MIN))]).state;
    assert.equal(reviewing.state, STATES.AWAITING_REVIEW);
    const passed = sm.accept(reviewing, 'jason', T0 + 3 * MIN).state;
    assert.deepEqual(sc.scorecard(passed, m, T0 + 3 * MIN, 1).acceptance, { actor: 'jason', at: T0 + 3 * MIN });
    const quiet = sc.scorecard(passed, m, T0 + 3 * MIN, 1, { publishActor: false });
    assert.deepEqual(quiet.acceptance, { at: T0 + 3 * MIN });
    assert.deepEqual(sc.validateScorecard(quiet), []);
  });

  it('never publishes the worktree path, host, ttyd generation or diagnostics', () => {
    const m = manifest();
    const { state, events } = run(m, [sample(MIN), sample(2 * MIN, obs({ github: { state: 'unavailable' } })), sample(3 * MIN, obs({ ttyd: { leakState: 'fired' } }))]);
    const cancelled = sm.cancel(run(m, [sample(MIN)]).state, 'op', T0 + 5 * MIN).state;
    const docs = [
      sc.admissionRecord(m, DIGEST),
      sc.scorecard(state, m, T0 + 3 * MIN, 1),
      sc.scorecard(cancelled, m, T0 + 5 * MIN, 1),
      ...events.map(sc.eventLine),
      sc.indexDoc([sc.scorecard(state, m, T0 + 3 * MIN, 1)])
    ];
    const text = docs.map(sc.serialize).join('');
    for (const secret of [WORKTREE, 'secret-operator', HOST, GEN, '4242', 'http-401', WTID, 'runner', 'diagnostics', 'private']) {
      assert.equal(text.includes(secret), false, `published text must not contain ${secret}`);
    }
  });

  it('builds event lines and an index newest first, each valid', () => {
    const m = manifest();
    const { events } = run(m, [sample(MIN, obs({ server: null })), sample(2 * MIN), sample(3 * MIN)]);
    const lines = events.map(sc.eventLine);
    assert.deepEqual(lines.map((l) => [l.from, l.to, l.code]), [
      ['not-started', 'running', 'ADMITTED'], ['running', 'extended', 'PROBE_UNKNOWN'], ['extended', 'running', 'RECOVERED']
    ]);
    for (const l of lines) assert.deepEqual(sc.validateEvent(l), []);
    const older = { candidateSha: 'b'.repeat(40), version: '5.29.0', state: 'passed', updatedAt: 5 };
    const newer = { candidateSha: SHA, version: '5.30.0', state: 'running', updatedAt: 9 };
    const idx = sc.indexDoc([older, newer]);
    assert.deepEqual(idx.candidates.map((c) => c.candidateSha), [SHA, 'b'.repeat(40)]);
    assert.deepEqual(sc.validateIndex(idx), []);
  });

  it('serializes deterministically, so published bytes compare', () => {
    const a = sc.admissionRecord(manifest(), DIGEST);
    assert.equal(sc.serialize(a), sc.serialize(sc.admissionRecord(manifest(), DIGEST)));
    assert.ok(sc.serialize(a).endsWith('}\n'));
  });
});

describe('validators refuse what the builder would never emit', () => {
  const m = manifest();
  const good = () => sc.scorecard(run(m, [sample(MIN)]).state, m, T0 + MIN, 1);

  for (const [name, mutate, violation] of [
    ['a wrong schema', (d) => { d.schema = 'x'; }, 'SCHEMA'],
    ['an extra field such as a worktree path', (d) => { d.worktreePath = WORKTREE; }, 'UNKNOWN_FIELD:worktreePath'],
    ['a short SHA', (d) => { d.candidateSha = 'abc'; }, 'FIELD:candidateSha'],
    ['an unknown state', (d) => { d.state = 'certified'; }, 'FIELD:state'],
    ['an unknown extension code', (d) => { d.extensions.MADE_UP = { intervals: 1, lostMs: 1 }; }, 'FIELD:extensions'],
    ['a failure on a running scorecard', (d) => { d.failure = { code: 'LEAK_FIRED', at: 1 }; }, 'FIELD:failure'],
    ['a passed scorecard with no acceptance', (d) => { d.state = 'passed'; }, 'FIELD:acceptance'],
    ['a negative time', (d) => { d.qualifiedMs = -1; }, 'FIELD:qualifiedMs'],
    ['a publish sequence of zero', (d) => { d.publishSeq = 0; }, 'FIELD:publishSeq']
  ]) {
    it(`refuses a scorecard with ${name}`, () => {
      const d = good();
      mutate(d);
      assert.ok(sc.validateScorecard(d).includes(violation), `${sc.validateScorecard(d)} should include ${violation}`);
    });
  }

  it('refuses an admission with no required checks, a bad digest, or a missing threshold', () => {
    const a = () => sc.admissionRecord(m, DIGEST);
    const noChecks = { ...a(), requiredChecks: [] };
    const badDigest = { ...a(), manifestDigest: 'nope' };
    const t = { ...a().thresholds };
    delete t.maxIntervalMs;
    const missing = { ...a(), thresholds: t };
    assert.deepEqual(sc.validateAdmission(noChecks), ['FIELD:requiredChecks']);
    assert.deepEqual(sc.validateAdmission(badDigest), ['FIELD:manifestDigest']);
    assert.deepEqual(sc.validateAdmission(missing), ['FIELD:thresholds']);
    assert.deepEqual(sc.validateAdmission({ ...a(), host: HOST }), ['UNKNOWN_FIELD:host']);
  });

  it('refuses a malformed event line and index', () => {
    assert.deepEqual(sc.validateEvent({ schema: sc.SCHEMAS.event, from: 'running', to: 'not-started', code: 'ADMITTED', at: 1, sampleSeq: 1 }), ['FIELD:to']);
    assert.deepEqual(sc.validateEvent({ schema: sc.SCHEMAS.event, from: 'running', to: 'failed', code: 'NOPE', at: 1, sampleSeq: null }), ['FIELD:code']);
    assert.deepEqual(sc.validateIndex({ schema: sc.SCHEMAS.index, candidates: [{ candidateSha: SHA }] }), ['FIELD:candidates']);
    assert.deepEqual(sc.validateIndex(null), ['SCHEMA']);
  });
});
