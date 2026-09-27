'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const probes = require('../lib/release-certification/probes');
const runnerLib = require('../lib/release-certification/runner');
const store = require('../lib/release-certification/store');
const cli = require('../scripts/rc-cert');
const { STATES, REFUSAL, CertificationError } = require('../lib/release-certification/codes');

const SHA = 'a'.repeat(40);
const GEN = '4242@Sun Sep 27 09:00:00 2026';
const MIN = 60 * 1000;
const T0 = 1_000_000;

let tmp;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rc-runner-')));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * Healthy observations with per-probe overrides.
 * @param {object} [over] - Overrides; null makes a probe unreachable
 * @returns {object} Observations
 */
function healthy(over = {}) {
  const base = {
    worktree: { headSha: SHA, detached: true, dirty: false },
    server: { startupSha: SHA, shaBaselineSource: 'startup', runningVersion: '5.30.0', startedAt: 500 },
    ttyd: { managed: true, generation: GEN, leakState: 'clear', wedgedCount: 0, orphanGate: false, poolUsed: 2 },
    github: { state: 'ok', checks: { test: 'success' } },
    pty: { instance: 's1', attaches: 0, detaches: 0, lastAt: null }
  };
  for (const [k, v] of Object.entries(over)) base[k] = v === null ? null : { ...base[k], ...v };
  return base;
}

/**
 * A fake clock and probe set that replays scripted observations.
 * @param {object[]} script - Observations per collect call; the last repeats
 * @returns {{clock: object, probes: object, advance: function(number): void}} Fakes
 */
function fakes(script) {
  let wall = T0;
  let mono = 0;
  let i = 0;
  return {
    clock: { wall: () => wall, mono: () => mono },
    probes: { collect: async () => script[Math.min(i++, script.length - 1)] },
    advance: (ms) => { wall += ms; mono += ms; }
  };
}

/**
 * Assert an async thunk rejects with a CertificationError code.
 * @param {Function} fn - Async thunk
 * @param {string} code - Expected code
 * @returns {Promise<CertificationError>} The error
 */
async function rejects(fn, code) {
  let caught = null;
  try { await fn(); } catch (err) { caught = err; }
  assert.ok(caught instanceof CertificationError, `expected ${code}, got ${caught}`);
  assert.equal(caught.code, code);
  return caught;
}

const SPEC = { version: '5.30.0', worktreePath: '/tmp/rc-wt', requiredChecks: ['test'], host: 'h' };

describe('probe observations', () => {
  it('reads a clean detached worktree, and counts untracked files as dirty', () => {
    const m = { state: 'measured', headSha: SHA, detached: true, dirtyTracked: 0, untracked: 0 };
    assert.deepEqual(probes.worktreeObservation(m), { headSha: SHA, detached: true, dirty: false });
    assert.equal(probes.worktreeObservation({ ...m, untracked: 1 }).dirty, true);
    assert.equal(probes.worktreeObservation({ ...m, dirtyTracked: null }).dirty, null);
    assert.equal(probes.worktreeObservation({ state: 'unknown' }), null);
  });

  it('reads server-info, turning its ISO start time into epoch ms', () => {
    const o = probes.serverObservation({ startupSha: SHA, shaBaselineSource: 'startup', runningVersion: '5.30.0', startedAt: '2026-09-27T16:00:00.000Z' });
    assert.equal(o.startedAt, Date.parse('2026-09-27T16:00:00.000Z'));
    assert.equal(probes.serverObservation(null), null);
    assert.equal(probes.serverObservation({}).startupSha, null);
  });

  const health = (state, reading) => ({ conditions: [{ id: 'other' }, { id: 'ttyd-leak', state, reading }] });
  const fresh = { sampledAt: new Date(T0).toISOString(), generation: GEN, managed: true, wedged: 0, orphanGate: false, pool: { used: 7, cap: 511 } };

  it('reads the ttyd-leak condition as values', () => {
    assert.deepEqual(probes.ttydObservation(health('clear', fresh), T0 + 1000, 150_000), {
      managed: true, generation: GEN, leakState: 'clear', wedgedCount: 0, orphanGate: false, poolUsed: 7
    });
    assert.equal(probes.ttydObservation({ conditions: [] }, T0, 1), null);
  });

  it('will not let an old reading vouch for health, but keeps its failures', () => {
    const late = T0 + 10 * MIN;
    assert.deepEqual(probes.ttydObservation(health('clear', fresh), late, 150_000), {
      managed: null, generation: null, leakState: 'unknown', wedgedCount: null, orphanGate: null, poolUsed: null
    });
    const bad = { ...fresh, managed: false, wedged: 3, orphanGate: true };
    assert.deepEqual(probes.ttydObservation(health('fired', bad), late, 150_000), {
      managed: false, generation: null, leakState: 'fired', wedgedCount: 3, orphanGate: true, poolUsed: null
    });
  });

  it('judges only required checks, by their newest run, falling back to commit statuses', () => {
    const runs = { check_runs: [
      { id: 1, name: 'test', status: 'completed', conclusion: 'failure' },
      { id: 2, name: 'test', status: 'completed', conclusion: 'success' },
      { id: 3, name: 'lint', status: 'completed', conclusion: 'failure' },
      { id: 4, name: 'slow', status: 'in_progress', conclusion: null },
      { id: 5, name: 'gone', status: 'completed', conclusion: 'cancelled' },
      { id: 6, name: 'broke', status: 'completed', conclusion: 'timed_out' }
    ] };
    const statuses = { statuses: [{ context: 'legacy', state: 'error' }] };
    const o = probes.githubObservation(runs, statuses, ['test', 'slow', 'gone', 'broke', 'legacy', 'absent']);
    assert.deepEqual(o, { state: 'ok', checks: { test: 'success', slow: 'pending', gone: 'pending', broke: 'failure', legacy: 'failure', absent: 'missing' } });
    assert.deepEqual(probes.githubObservation(null, statuses, ['test']), { state: 'unavailable', checks: null });
  });

  it('reads PTY activity', () => {
    assert.deepEqual(probes.ptyObservation({ instance: 'i', attaches: 3, detaches: 2, lastAt: '2026-09-27T16:00:00.000Z' }),
      { instance: 'i', attaches: 3, detaches: 2, lastAt: Date.parse('2026-09-27T16:00:00.000Z') });
    assert.equal(probes.ptyObservation({ instance: 'i', attaches: -1, detaches: 0, lastAt: null }).attaches, null);
  });

  it('reads the required checks from branch protection', async () => {
    const gh = async () => ({ contexts: ['b'], checks: [{ context: 'a' }, { context: 'b' }] });
    assert.deepEqual(await probes.requiredChecks('o/r', gh), ['a', 'b']);
    assert.equal(await probes.requiredChecks('o/r', async () => null), null);
  });

  it('collects every probe, asking GitHub about the candidate SHA only', async () => {
    const calls = [];
    const set = probes.createProbes({ apiBase: 'http://x', worktreePath: '/wt', candidateSha: SHA, repo: 'o/r', requiredChecks: ['test'], maxReadingAgeMs: 150_000 }, {
      measure: async () => ({ state: 'measured', headSha: SHA, detached: true, dirtyTracked: 0, untracked: 0 }),
      fetchJson: async (_opts, route) => {
        calls.push(route);
        if (route === '/api/server-info') return { startupSha: SHA, shaBaselineSource: 'startup', runningVersion: '5.30.0', startedAt: 500 };
        if (route === '/api/system/health') return health('clear', fresh);
        return { instance: 's', attaches: 0, detaches: 0, lastAt: null };
      },
      ghJson: async (args) => {
        calls.push(args[1]);
        return args[1].includes('check-runs') ? { check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success' }] } : { statuses: [] };
      }
    });
    const o = await set.collect(T0);
    assert.equal(o.github.checks.test, 'success');
    assert.equal(o.ttyd.generation, GEN);
    assert.ok(calls.every((c) => !c.startsWith('repos/') || c.includes(`/commits/${SHA}/`)));
  });

  it('fetches JSON over HTTP with a bearer token, and reads a failure as null', async () => {
    let seenAuth = null;
    const server = http.createServer((req, res) => {
      seenAuth = req.headers.authorization;
      if (req.url === '/ok') { res.writeHead(200); res.end('{"a":1}'); } else { res.writeHead(401); res.end('{}'); }
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const apiBase = `http://127.0.0.1:${server.address().port}`;
    try {
      assert.deepEqual(await probes.fetchJson({ apiBase, token: 't' }, '/ok'), { a: 1 });
      assert.equal(seenAuth, 'Bearer t');
      assert.equal(await probes.fetchJson({ apiBase }, '/denied'), null);
    } finally {
      server.close();
    }
    assert.equal(await probes.fetchJson({ apiBase }, '/ok'), null);
  });
});

describe('runner', () => {
  it('admits a healthy candidate with the ttyd generation it observed as the baseline', async () => {
    const f = fakes([healthy()]);
    const r = runnerLib.createRunner({ base: path.join(tmp, 'v1'), candidateSha: SHA, probes: f.probes, clock: f.clock });
    const state = await r.start(SPEC);
    assert.equal(state.state, STATES.RUNNING);
    const { manifest } = store.readRun(path.join(tmp, 'v1'), SHA);
    assert.equal(manifest.private.baseline.ttydGeneration, GEN);
  });

  it('refuses admission, writing nothing, when the ttyd generation is unknown or the runtime is unproven', async () => {
    for (const obs of [healthy({ ttyd: { generation: null } }), healthy({ server: { shaBaselineSource: 'late' } })]) {
      const f = fakes([obs]);
      const base = path.join(tmp, 'v1');
      await rejects(() => runnerLib.createRunner({ base, candidateSha: SHA, probes: f.probes, clock: f.clock }).start(SPEC), REFUSAL.ADMISSION_REFUSED);
      assert.deepEqual(store.listRuns(base), []);
    }
  });

  it('logs transitions, and extends across a runner restart', async () => {
    const base = path.join(tmp, 'v1');
    const log = [];
    const f = fakes([healthy()]);
    const first = runnerLib.createRunner({ base, candidateSha: SHA, probes: f.probes, clock: f.clock, runnerInstance: 'r1', log: (e) => log.push(e) });
    await first.start(SPEC);
    f.advance(MIN);
    await first.tick();
    f.advance(MIN);
    const second = runnerLib.createRunner({ base, candidateSha: SHA, probes: f.probes, clock: f.clock, runnerInstance: 'r2', log: (e) => log.push(e) });
    const state = await second.tick();
    assert.equal(state.state, STATES.EXTENDED);
    assert.deepEqual(Object.keys(state.extensions), ['MONITOR_GAP']);
    assert.deepEqual(log.filter((e) => e.event === 'transition').map((e) => e.to), ['running', 'extended']);
  });

  it('fails when the owned ttyd generation changed while the runner was down', async () => {
    const base = path.join(tmp, 'v1');
    const f = fakes([healthy(), healthy({ ttyd: { generation: '9@later' } })]);
    await runnerLib.createRunner({ base, candidateSha: SHA, probes: f.probes, clock: f.clock, runnerInstance: 'r1' }).start(SPEC);
    f.advance(10 * MIN);
    const state = await runnerLib.createRunner({ base, candidateSha: SHA, probes: f.probes, clock: f.clock, runnerInstance: 'r2' }).tick();
    assert.equal(state.state, STATES.FAILED);
    assert.equal(state.failure.code, 'TTYD_GENERATION_CHANGED');
  });

  it('extends on a GitHub error and on an unproven runtime', async () => {
    const base = path.join(tmp, 'v1');
    const f = fakes([healthy(), healthy({ github: { state: 'unavailable' } }), healthy({ server: { shaBaselineSource: 'late' } })]);
    const r = runnerLib.createRunner({ base, candidateSha: SHA, probes: f.probes, clock: f.clock });
    await r.start(SPEC);
    f.advance(MIN);
    await r.tick();
    f.advance(MIN);
    const state = await r.tick();
    assert.deepEqual(Object.keys(state.extensions).sort(), ['GITHUB_UNAVAILABLE', 'RUNTIME_UNPROVEN']);
  });

  it('runs until terminal, holding and then releasing the single-runner lock', async () => {
    const base = path.join(tmp, 'v1');
    const f = fakes([healthy(), healthy(), healthy({ worktree: { dirty: true } })]);
    const log = [];
    const r = runnerLib.createRunner({ base, candidateSha: SHA, probes: f.probes, clock: f.clock, log: (e) => log.push(e) });
    await r.start(SPEC);
    const waits = [];
    const state = await r.run({ intervalMs: MIN, wait: async (ms) => { waits.push(ms); f.advance(MIN); } });
    assert.equal(state.state, STATES.FAILED);
    assert.deepEqual(waits, [MIN]);
    assert.equal(fs.existsSync(path.join(store.runPaths(base, SHA).dir, 'runner.lock')), false);
    assert.deepEqual(log.map((e) => e.event).filter((e) => e.startsWith('runner')), ['runner-started', 'runner-stopped']);
  });

  it('refuses a second runner for the same candidate', async () => {
    const base = path.join(tmp, 'v1');
    const f = fakes([healthy()]);
    const r = runnerLib.createRunner({ base, candidateSha: SHA, probes: f.probes, clock: f.clock });
    await r.start(SPEC);
    const controller = new AbortController();
    let release;
    const gate = new Promise((res) => { release = res; });
    const running = r.run({ intervalMs: MIN, signal: controller.signal, wait: async () => { await gate; } });
    await new Promise((res) => setImmediate(res));
    await rejects(() => runnerLib.createRunner({ base, candidateSha: SHA, probes: f.probes, clock: f.clock }).run({ intervalMs: MIN }), REFUSAL.LOCK_HELD);
    controller.abort();
    release();
    await running;
  });

  it('keeps sampling after a failed tick and logs it', async () => {
    const base = path.join(tmp, 'v1');
    const f = fakes([healthy()]);
    const log = [];
    const r = runnerLib.createRunner({ base, candidateSha: SHA, probes: f.probes, clock: f.clock, log: (e) => log.push(e) });
    await r.start(SPEC);
    const p = store.runPaths(base, SHA);
    const lockfile = require('../lib/release-certification/lockfile');
    const held = lockfile.acquire(p.lock);
    const controller = new AbortController();
    let n = 0;
    await r.run({ intervalMs: MIN, signal: controller.signal, wait: async () => {
      f.advance(MIN);
      if (++n === 1) lockfile.release(p.lock, held);
      if (n === 2) controller.abort();
    } });
    assert.equal(log.filter((e) => e.event === 'tick-failed')[0].code, REFUSAL.LOCK_HELD);
    assert.equal(store.readRun(base, SHA).state.sampleCount, 2);
  });

  it('bounds the sampling interval so one late tick stays inside the interval limit', () => {
    assert.equal(runnerLib.resolveInterval(undefined), MIN);
    assert.throws(() => runnerLib.resolveInterval(121_000), CertificationError);
    assert.throws(() => runnerLib.resolveInterval(14_999), CertificationError);
  });
});

describe('rc-cert CLI', () => {
  /**
   * Run the CLI with captured output.
   * @param {string[]} argv - Arguments
   * @param {object} [extra] - More io
   * @returns {Promise<{code: number, out: string, err: string}>} Result
   */
  async function run(argv, extra = {}) {
    let out = '';
    let err = '';
    const code = await cli.main(argv, {
      stdout: { write: (s) => { out += s; } },
      stderr: { write: (s) => { err += s; } },
      env: {},
      configFile: path.join(tmp, 'missing-config.json'),
      ...extra
    });
    return { code, out, err };
  }

  it('prints usage and exits 2 for a bad command line', async () => {
    assert.equal((await run(['frobnicate'])).code, 2);
    assert.equal((await run(['status'])).code, 2);
    assert.equal((await run(['status', '--sha'])).code, 2);
  });

  it('prints a refusal as JSON and exits 3', async () => {
    const r = await run(['status', '--sha', SHA, '--base', path.join(tmp, 'v1')]);
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.err).error, REFUSAL.RUN_NOT_FOUND);
  });

  it('starts, reports status, and cancels a run through injected probes', async () => {
    const base = path.join(tmp, 'v1');
    const wt = path.join(tmp, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, 'version.json'), '{"version":"5.30.0"}');
    const f = fakes([healthy()]);
    const deps = {
      repository: async () => 'o/r',
      requiredChecks: async () => ['test'],
      probes: () => f.probes,
      runner: (ctx) => runnerLib.createRunner({ ...ctx, clock: f.clock })
    };
    const started = await run(['start', '--sha', SHA, '--worktree', wt, '--base', base, '--api', 'http://127.0.0.1:1'], { deps });
    assert.equal(started.code, 0, started.err);
    assert.deepEqual(JSON.parse(started.out), { state: 'running', candidateSha: SHA });
    const status = await run(['status', '--sha', SHA, '--base', base, '--json']);
    assert.equal(JSON.parse(status.out).state, 'running');
    assert.equal(JSON.parse(status.out).canonicalThresholds, true);
    assert.match((await run(['status', '--sha', SHA, '--base', base])).out, /running/);
    assert.equal((await run(['accept', '--sha', SHA, '--base', base, '--actor', 'jason'])).code, 3);
    assert.deepEqual(JSON.parse((await run(['cancel', '--sha', SHA, '--base', base, '--actor', 'jason'])).out), { state: 'cancelled' });
    assert.deepEqual(JSON.parse((await run(['list', '--base', base])).out), [SHA]);
  });

  it('marks a run with overridden thresholds as unable to certify', async () => {
    const base = path.join(tmp, 'v1');
    const wt = path.join(tmp, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, 'version.json'), '{"version":"5.30.0"}');
    const f = fakes([healthy()]);
    const deps = { repository: async () => 'o/r', requiredChecks: async () => ['test'], probes: () => f.probes, runner: (ctx) => runnerLib.createRunner({ ...ctx, clock: f.clock }) };
    await run(['start', '--sha', SHA, '--worktree', wt, '--base', base, '--api', 'http://x', '--thresholds', '{"targetQualifiedMs":600000}'], { deps });
    assert.equal(JSON.parse((await run(['status', '--sha', SHA, '--base', base, '--json'])).out).canonicalThresholds, false);
    assert.equal((await run(['start', '--sha', SHA, '--worktree', wt, '--base', base, '--api', 'http://x', '--thresholds', '{bad'], { deps })).code, 2);
  });

  it('resolves the base from the flag, then config.json, and refuses a relative configured base', () => {
    const cfg = path.join(tmp, 'config.json');
    fs.writeFileSync(cfg, JSON.stringify({ releaseCertification: { baseDir: '/srv/rc' } }));
    assert.equal(cli.resolveBase({}, cfg), '/srv/rc');
    assert.equal(cli.resolveBase({ base: '/flag' }, cfg), '/flag');
    fs.writeFileSync(cfg, JSON.stringify({ releaseCertification: { baseDir: 'relative' } }));
    assert.throws(() => cli.resolveBase({}, cfg), (e) => e.code === REFUSAL.STORE_UNSAFE);
    assert.equal(cli.resolveBase({}, path.join(tmp, 'none.json')), store.defaultBase());
  });
});
