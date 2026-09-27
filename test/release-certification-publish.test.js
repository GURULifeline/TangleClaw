'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const publisherLib = require('../lib/release-certification/publisher');
const publicationLib = require('../lib/release-certification/publication');
const runnerLib = require('../lib/release-certification/runner');
const store = require('../lib/release-certification/store');
const sm = require('../lib/release-certification/state-machine');
const sc = require('../lib/release-certification/scorecard');
const { REFUSAL, STATES, CertificationError } = require('../lib/release-certification/codes');

const SHA = 'a'.repeat(40);
const WTID = 'c'.repeat(64);
const GEN = '4242@Sun Sep 27 09:00:00 2026';
const ID = { name: 'Test Operator', email: 'op@example.invalid' };
const MIN = 60 * 1000;
const T0 = 1_000_000;

let tmp;
let remote;
let base;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rc-publish-')));
  remote = path.join(tmp, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  base = path.join(tmp, 'v1');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Read a file from the bare remote's metrics branch.
 * @param {string} rel - Path
 * @returns {string|null} Contents, or null when absent
 */
function remoteFile(rel) {
  try {
    return execFileSync('git', ['--git-dir', remote, 'show', `metrics:${rel}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

/**
 * Commits on the remote's metrics branch.
 * @returns {number} Count
 */
function remoteCommits() {
  try {
    return Number(execFileSync('git', ['--git-dir', remote, 'rev-list', '--count', 'metrics'], { encoding: 'utf8' }).trim());
  } catch {
    return 0;
  }
}

/**
 * A publisher into the test remote.
 * @param {string} [name] - Clone directory name
 * @param {object} [deps] - Seams
 * @returns {object} Publisher
 */
function publisher(name = '_metrics', deps = {}) {
  return publisherLib.createPublisher({ dir: path.join(tmp, name), remoteUrl: remote, identity: ID }, { sleep: async () => {}, ...deps });
}

/**
 * Assert an async thunk rejects with a CertificationError code.
 * @param {Function} fn - Thunk
 * @param {string} code - Code
 * @returns {Promise<CertificationError>} The error
 */
async function rejects(fn, code) {
  let caught = null;
  try { await fn(); } catch (err) { caught = err; }
  assert.ok(caught instanceof CertificationError, `expected ${code}, got ${caught && caught.stack}`);
  assert.equal(caught.code, code);
  return caught;
}

const IDX = sc.INDEX_PATH;
const P = sc.paths(SHA);

describe('publisher: git mechanics against a real remote', () => {
  it('creates the metrics branch on first publish and writes only what it was given', async () => {
    const r = await publisher().publish(() => ({ [IDX]: '{"x":1}\n' }), 'first');
    assert.equal(r.changed, true);
    assert.match(r.commit, /^[0-9a-f]{40}$/);
    assert.equal(remoteFile(IDX), '{"x":1}\n');
    assert.equal(remoteCommits(), 1);
    const author = execFileSync('git', ['--git-dir', remote, 'log', '-1', '--format=%an <%ae>', 'metrics'], { encoding: 'utf8' }).trim();
    assert.equal(author, 'Test Operator <op@example.invalid>');
  });

  it('commits nothing when nothing changed', async () => {
    const pub = publisher();
    await pub.publish(() => ({ [IDX]: 'same\n' }), 'one');
    assert.deepEqual(await pub.publish(() => ({ [IDX]: 'same\n' }), 'two'), { changed: false, commit: null });
    assert.deepEqual(await pub.publish(() => ({}), 'three'), { changed: false, commit: null });
    assert.equal(remoteCommits(), 1);
  });

  for (const bad of ['server.js', 'lib/x.js', 'release-certification/v1/../../server.js', 'release-certification/v1/admissions/abc.json', '.github/workflows/x.yml']) {
    it(`refuses to write ${bad}`, async () => {
      await rejects(() => publisher().publish(() => ({ [bad]: 'x' }), 'bad'), REFUSAL.PATH_NOT_ALLOWED);
      assert.equal(remoteCommits(), 0);
    });
  }

  it('rebuilds from the new tip and retries when someone else published first, never forcing', async () => {
    const calls = [];
    const spy = async (args, opts) => { calls.push(args); return publisherLib.runGit(args, opts); };
    const other = publisher('_other');
    let interfered = false;
    const seen = [];
    const r = await publisher('_metrics', { git: spy }).publish(async (read) => {
      seen.push(read(IDX));
      if (!interfered) {
        interfered = true;
        await other.publish(() => ({ [IDX]: 'theirs\n' }), 'theirs');
      }
      return { [P.scorecard]: 'ours\n' };
    }, 'ours');
    assert.equal(r.changed, true);
    assert.deepEqual(seen, [null, 'theirs\n'], 'the retry saw the other publish');
    assert.equal(remoteFile(IDX), 'theirs\n');
    assert.equal(remoteFile(P.scorecard), 'ours\n');
    assert.equal(calls.filter((a) => a.includes('push')).length, 2);
    assert.ok(calls.every((a) => !a.some((x) => x === '--force' || x === '-f' || x.startsWith('+HEAD') || x === '--force-with-lease')), 'never forces');
  });

  it('reads back what the remote holds, and nothing when the branch does not exist', async () => {
    const pub = publisher();
    assert.equal(await pub.read(IDX), null);
    await publisher('_other').publish(() => ({ [IDX]: 'v\n' }), 'x');
    assert.equal(await pub.read(IDX), 'v\n');
  });

  it('refuses when the remote cannot be reached', async () => {
    const pub = publisherLib.createPublisher({ dir: path.join(tmp, '_m'), remoteUrl: path.join(tmp, 'missing.git'), identity: ID });
    await rejects(() => pub.publish(() => ({ [IDX]: 'x' }), 'x'), REFUSAL.PUBLISH_FAILED);
  });

  it('keeps its clone private', async () => {
    await publisher().publish(() => ({ [IDX]: 'x\n' }), 'x');
    assert.equal(fs.statSync(path.join(tmp, '_metrics')).mode & 0o777, 0o700);
  });

  it('reads the worktree origin and the operator identity', async () => {
    const wt = path.join(tmp, 'wt');
    execFileSync('git', ['init', '-q', wt]);
    execFileSync('git', ['-C', wt, 'remote', 'add', 'origin', remote]);
    execFileSync('git', ['-C', wt, 'config', 'user.name', 'Jay']);
    execFileSync('git', ['-C', wt, 'config', 'user.email', 'jay@example.invalid']);
    assert.deepEqual(await publisherLib.repoFacts(wt), { remoteUrl: remote, identity: { name: 'Jay', email: 'jay@example.invalid' } });
    execFileSync('git', ['-C', wt, 'remote', 'remove', 'origin']);
    await rejects(() => publisherLib.repoFacts(wt), REFUSAL.PUBLISH_FAILED);
  });
});

/**
 * A manifest.
 * @returns {object} Manifest
 */
function manifest() {
  return sm.buildManifest({
    candidateSha: SHA, version: '5.30.0', repository: 'o/r', requiredChecks: ['test'], createdAt: T0,
    worktreePath: '/tmp/wt', worktreeId: WTID, ttydGeneration: GEN, host: 'h'
  });
}

/**
 * Healthy observations.
 * @param {object} [over] - Overrides
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
 * The publication under test, with a controllable clock.
 * @param {object} [pub] - Publisher (defaults to one into the test remote)
 * @returns {{publication: object, clock: {t: number}}} Publication and its clock
 */
function publication(pub = publisher()) {
  const clock = { t: T0 };
  fs.mkdirSync(store.runPaths(base, SHA).dir, { recursive: true, mode: 0o700 });
  return { publication: publicationLib.createPublication({ base, candidateSha: SHA, publisher: pub, now: () => clock.t }), clock };
}

describe('publication: fail-closed admission and forward-only updates', () => {
  it('publishes the admission and verifies it by reading it back', async () => {
    const { publication: p } = publication();
    const m = manifest();
    const digest = 'd'.repeat(64);
    const r = await p.admit(m, digest, { remoteUrl: remote });
    assert.equal(r.verifiedAt, T0);
    assert.equal(remoteFile(P.admission), sc.serialize(sc.admissionRecord(m, digest)));
    assert.deepEqual(p.readStatus().admission, { digest, verifiedAt: T0 });
    assert.equal(p.readStatus().remoteUrl, remote);
  });

  it('re-admits the identical record as a no-op, and refuses a different one', async () => {
    const { publication: p } = publication();
    await p.admit(manifest(), 'd'.repeat(64));
    await p.admit(manifest(), 'd'.repeat(64));
    assert.equal(remoteCommits(), 1);
    await rejects(() => p.admit(manifest(), 'e'.repeat(64)), REFUSAL.ADMISSION_CONFLICT);
    assert.match(remoteFile(P.admission), /d{64}/);
  });

  it('refuses admission when the read-back does not match', async () => {
    const real = publisher();
    const lying = { publish: real.publish, read: async () => 'something else' };
    await rejects(() => publication(lying).publication.admit(manifest(), 'd'.repeat(64)), REFUSAL.ADMISSION_UNPUBLISHED);
  });

  it('publishes scorecard, transitions and index, with a rising sequence', async () => {
    const { publication: p, clock } = publication();
    const m = manifest();
    await p.admit(m, 'd'.repeat(64));
    let { state, events } = sm.admit(m, { wallAt: T0, monoAt: 0, runnerInstance: 'r', observations: obs() });
    state = { ...state, manifestDigest: 'd'.repeat(64) };
    assert.equal((await p.update({ state, manifest: m, events })).seq, 1);
    const out = sm.reduce(state, m, { wallAt: T0 + MIN, monoAt: MIN, runnerInstance: 'r', observations: obs({ server: null }) });
    clock.t += MIN;
    assert.equal((await p.update({ state: out.state, manifest: m, events: [...events, ...out.events] })).seq, 2);
    const card = JSON.parse(remoteFile(P.scorecard));
    assert.deepEqual(sc.validateScorecard(card), []);
    assert.equal(card.state, STATES.EXTENDED);
    assert.equal(card.publishSeq, 2);
    assert.equal(remoteFile(P.events).trim().split('\n').length, 2);
    assert.deepEqual(JSON.parse(remoteFile(IDX)).candidates.map((c) => c.candidateSha), [SHA]);
    assert.equal(p.readStatus().lastPublishedSeq, 2);
  });

  it('refuses an update before the admission is published', async () => {
    const { publication: p } = publication();
    const m = manifest();
    const { state, events } = sm.admit(m, { wallAt: T0, monoAt: 0, runnerInstance: 'r', observations: obs() });
    await rejects(() => p.update({ state: { ...state, manifestDigest: 'd'.repeat(64) }, manifest: m, events }), REFUSAL.ADMISSION_UNPUBLISHED);
  });

  it('refuses to rewrite a published transition log', async () => {
    const { publication: p } = publication();
    const m = manifest();
    await p.admit(m, 'd'.repeat(64));
    const { state, events } = sm.admit(m, { wallAt: T0, monoAt: 0, runnerInstance: 'r', observations: obs() });
    const run = { state: { ...state, manifestDigest: 'd'.repeat(64) }, manifest: m, events };
    await p.update(run);
    await publisher('_other').publish(() => ({ [P.events]: '{"tampered":true}\n' }), 'tamper');
    await rejects(() => p.update(run), REFUSAL.EVENTS_DIVERGED);
  });

  it('is due after a transition, a terminal state or the heartbeat, but never inside a backoff', async () => {
    const { publication: p, clock } = publication();
    await p.admit(manifest(), 'd'.repeat(64));
    assert.equal(p.due({ transitioned: false, state: 'running' }), true, 'nothing published yet');
    const m = manifest();
    const { state, events } = sm.admit(m, { wallAt: T0, monoAt: 0, runnerInstance: 'r', observations: obs() });
    await p.update({ state: { ...state, manifestDigest: 'd'.repeat(64) }, manifest: m, events });
    assert.equal(p.due({ transitioned: false, state: 'running' }), false);
    assert.equal(p.due({ transitioned: true, state: 'extended' }), true);
    assert.equal(p.due({ transitioned: false, state: 'failed' }), true);
    clock.t += publicationLib.HEARTBEAT_MS;
    assert.equal(p.due({ transitioned: false, state: 'running' }), true);
    const s = p.recordFailure(new CertificationError(REFUSAL.PUBLISH_FAILED, 'x'));
    assert.equal(s.nextAttemptAt, clock.t + 60_000);
    assert.equal(p.due({ transitioned: true, state: 'failed' }), false, 'a backoff holds even a transition');
    assert.equal(p.recordFailure(new Error('y')).nextAttemptAt, clock.t + 120_000);
    assert.equal(publicationLib.backoffMs(20), 30 * 60 * 1000);
  });
});

describe('runner: fail-closed start and background publishing', () => {
  /**
   * Probes that replay one healthy observation.
   * @returns {object} Probes
   */
  const probes = () => ({ collect: async () => ({ observations: obs(), diagnostics: {} }) });
  const SPEC = { version: '5.30.0', repository: 'o/r', worktreePath: '/tmp/wt', worktreeId: WTID, requiredChecks: ['test'], host: 'h' };

  it('refuses to start with no publisher', async () => {
    await rejects(() => runnerLib.createRunner({ base, candidateSha: SHA, probes: probes() }).start(SPEC), REFUSAL.ADMISSION_UNPUBLISHED);
    assert.deepEqual(store.listRuns(base), []);
  });

  it('commits no run when the admission cannot be published, and reuses the staged manifest on retry', async () => {
    const digests = [];
    let fail = true;
    const pub = {
      admit: async (m, digest) => {
        digests.push(digest);
        if (fail) throw new CertificationError(REFUSAL.PUBLISH_FAILED, 'offline');
        return { verifiedAt: 1 };
      },
      update: async () => ({ seq: 1, changed: true }), due: () => false, recordFailure: () => ({}), readStatus: () => ({})
    };
    let t = T0;
    const clock = { wall: () => t, mono: () => t - T0 };
    await rejects(() => runnerLib.createRunner({ base, candidateSha: SHA, probes: probes(), clock, publication: pub }).start(SPEC), REFUSAL.PUBLISH_FAILED);
    assert.deepEqual(store.listRuns(base), [], 'no run began unpublished');
    fail = false;
    t += 10 * MIN;
    const state = await runnerLib.createRunner({ base, candidateSha: SHA, probes: probes(), clock, publication: pub }).start(SPEC);
    assert.equal(state.state, STATES.RUNNING);
    assert.equal(digests[0], digests[1], 'the retry published the same admission');
    assert.equal(store.readRun(base, SHA).state.manifestDigest, digests[0]);
  });

  it('admits end to end through a real remote, then publishes each transition without delaying the tick', async () => {
    const { publication: p } = publication();
    let t = T0;
    const clock = { wall: () => t, mono: () => t - T0 };
    let current = obs();
    const pr = { collect: async () => ({ observations: current, diagnostics: {} }) };
    const log = [];
    const r = runnerLib.createRunner({ base, candidateSha: SHA, probes: pr, clock, publication: p, log: (e) => log.push(e) });
    await r.start(SPEC);
    assert.ok(remoteFile(P.admission), 'the admission is public before the run exists');
    t += MIN;
    current = obs({ worktree: { dirty: true } });
    const state = await r.tick();
    assert.equal(state.state, STATES.FAILED);
    assert.equal(log.filter((e) => e.event === 'published').length, 0, 'the tick returned before publishing finished');
    await r.run({ intervalMs: MIN });
    assert.equal(JSON.parse(remoteFile(P.scorecard)).state, STATES.FAILED);
    assert.ok(log.some((e) => e.event === 'published'));
  });

  it('records a failed publish with a backoff and never changes certification state', async () => {
    const recorded = [];
    const pub = {
      admit: async () => ({ verifiedAt: 1 }),
      update: async () => { throw new CertificationError(REFUSAL.PUBLISH_FAILED, 'offline'); },
      due: () => true,
      recordFailure: (e) => { recorded.push(e.code); return { nextAttemptAt: 42 }; },
      readStatus: () => ({})
    };
    const log = [];
    let t = T0;
    const clock = { wall: () => t, mono: () => t - T0 };
    const r = runnerLib.createRunner({ base, candidateSha: SHA, probes: probes(), clock, publication: pub, log: (e) => log.push(e) });
    await r.start(SPEC);
    t += MIN;
    const before = await r.tick();
    assert.equal(await r.publishNow(), false);
    assert.deepEqual(recorded.slice(-1), [REFUSAL.PUBLISH_FAILED]);
    assert.equal(log.filter((e) => e.event === 'publish-failed').at(-1).nextAttemptAt, 42);
    const after = store.readRun(base, SHA).state;
    assert.equal(after.qualifiedMs, before.qualifiedMs);
    assert.deepEqual(after.extensions, before.extensions);
  });
});
