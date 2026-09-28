'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = require('../scripts/soak');

/**
 * A writable that collects what is written.
 * @returns {{write: (s: string) => void, text: () => string}} Sink
 */
function sink() {
  let buf = '';
  return { write: (s) => { buf += s; }, text: () => buf };
}

/**
 * Run the CLI with collected output.
 * @param {string[]} argv - Arguments
 * @param {object} [deps] - Extra deps
 * @returns {Promise<{code: number, out: string, err: string}>} Result
 */
async function run(argv, deps = {}) {
  const stdout = sink();
  const stderr = sink();
  // Names resolve to a guest-like address unless a test says otherwise, so no
  // test depends on this machine's DNS.
  const code = await cli.main(argv, { stdout, stderr, env: {}, onStopSignal: () => {}, lookup: async () => ['192.168.64.7'], ...deps });
  return { code, out: stdout.text(), err: stderr.text() };
}

/**
 * An instant fake clock.
 * @returns {{now: () => number, sleep: (ms: number) => Promise<void>}} Clock
 */
function instantClock() {
  let t = 1_790_000_000_000;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

let dir;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-cli-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('soak CLI — plan and validate', () => {
  it('writes a schedule file readable by its owner only and reports its digest', async () => {
    const out = path.join(dir, 's.json');
    const r = await run(['plan', '--seed', 'rc', '--phase', 'certifying', '--duration-hours', '1', '--out', out]);
    assert.equal(r.code, 0, r.err);
    const schedule = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.equal(JSON.parse(r.err).digest, schedule.digest);
    assert.equal(fs.statSync(out).mode & 0o777, 0o600);
    const v = await run(['validate', '--schedule', out]);
    assert.equal(v.code, 0);
    assert.equal(JSON.parse(v.out).digest, schedule.digest);
  });

  it('never overwrites an existing schedule', async () => {
    const out = path.join(dir, 's.json');
    fs.writeFileSync(out, 'keep');
    const r = await run(['plan', '--seed', 'rc', '--phase', 'certifying', '--duration-hours', '1', '--out', out]);
    assert.equal(r.code, 2);
    assert.equal(fs.readFileSync(out, 'utf8'), 'keep');
  });

  it('passes classes, projects and intervals through to the schedule', async () => {
    const out = path.join(dir, 's.json');
    const r = await run(['plan', '--seed', 'rc', '--phase', 'destructive', '--duration-hours', '0.5', '--out', out,
      '--classes', 'api,engine', '--projects', 'soak-p1,soak-p2', '--load-mean-ms', '10000', '--fault-mean-ms', '60000', '--fault-quiet-ms', '0']);
    assert.equal(r.code, 0, r.err);
    const p = JSON.parse(fs.readFileSync(out, 'utf8')).params;
    assert.deepEqual([p.phase, p.classes, p.projects, p.loadMeanMs, p.faultMeanMs, p.faultQuietMs, p.durationMs],
      ['destructive', ['api', 'engine'], ['soak-p1', 'soak-p2'], 10000, 60000, 0, 30 * 60 * 1000]);
  });

  it('exits 3 and lists violations for a tampered schedule', async () => {
    const out = path.join(dir, 's.json');
    await run(['plan', '--seed', 'rc', '--phase', 'certifying', '--duration-hours', '1', '--out', out]);
    const s = JSON.parse(fs.readFileSync(out, 'utf8'));
    s.events[0].atMs += 1;
    fs.writeFileSync(out, JSON.stringify(s));
    const v = await run(['validate', '--schedule', out]);
    assert.equal(v.code, 3);
    assert.ok(JSON.parse(v.err).violations.some((x) => x.code === 'DIGEST_MISMATCH'));
  });

  const usage = [
    ['no command', []],
    ['an unknown command', ['explode']],
    ['a missing required flag', ['plan', '--seed', 'x', '--phase', 'certifying', '--out', 'y']],
    ['an unknown flag', ['validate', '--schedule', 'x', '--verbose', 'yes']],
    ['a flag with no value', ['validate', '--schedule']],
    ['a repeated flag', ['validate', '--schedule', 'a', '--schedule', 'b']],
    ['a repeated boolean flag', ['run', '--schedule', 'a', '--api', 'http://h:1', '--log', 'l', '--allow-unverified-live', '--allow-unverified-live']],
    ['a boolean flag on a command that does not take it', ['validate', '--schedule', 'a', '--allow-unverified-live']],
    ['a bad phase', ['plan', '--seed', 'x', '--phase', 'nope', '--duration-hours', '1', '--out', 'y']],
    ['a non-numeric interval', ['plan', '--seed', 'x', '--phase', 'certifying', '--duration-hours', '1', '--out', 'y', '--load-mean-ms', '1e3']],
    ['a token on the command line', ['run', '--schedule', 'a', '--api', 'http://h:1', '--log', 'l', '--token', 'secret']],
    ['an --api that is not http(s)', ['run', '--schedule', 'a', '--api', 'file:///etc', '--log', 'l']],
    ['an unreadable schedule', ['validate', '--schedule', '/nonexistent/soak.json']]
  ];
  for (const [label, argv] of usage) {
    it(`exits 2 with usage for ${label}`, async () => {
      const r = await run(argv);
      assert.equal(r.code, 2);
      assert.match(r.err, /usage: soak plan/);
    });
  }
});

describe('soak CLI — run', () => {
  /**
   * Plan an api-only schedule into the temp dir.
   * @returns {Promise<string>} Schedule path
   */
  async function planApi() {
    const out = path.join(dir, 's.json');
    const r = await run(['plan', '--seed', 'rc', '--phase', 'certifying', '--duration-hours', '0.25', '--out', out, '--classes', 'api', '--load-mean-ms', '60000']);
    assert.equal(r.code, 0, r.err);
    return out;
  }

  it('runs an api-only schedule against the named server with the env token', async () => {
    const schedulePath = await planApi();
    const log = path.join(dir, 'soak.ndjson');
    const seen = [];
    const fetch = async (url, init) => {
      seen.push({ origin: url.origin, path: url.pathname, auth: init.headers.authorization });
      if (url.pathname === '/api/server-info') {
        return { status: 200, text: async () => JSON.stringify({ startedAt: url.origin, startupSha: 'c'.repeat(40) }) };
      }
      return { status: 200, text: async () => '{}' };
    };
    const r = await run(['run', '--schedule', schedulePath, '--api', 'http://guest.invalid:3102', '--log', log],
      { fetch, clock: instantClock(), env: { TANGLECLAW_SERVICE_TOKEN: 'tok', TANGLECLAW_API: 'http://localhost:3102' } });
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).status, 'completed');
    // The live install is contacted once, without the token, for the identity
    // check; every other request goes to the guest, with it.
    const live = seen.filter((s) => s.origin === 'http://localhost:3102');
    assert.deepEqual(live, [{ origin: 'http://localhost:3102', path: '/api/server-info', auth: undefined }]);
    const guest = seen.filter((s) => s.origin !== 'http://localhost:3102');
    assert.ok(guest.length > 1);
    assert.ok(guest.every((s) => s.origin === 'http://guest.invalid:3102' && s.auth === 'Bearer tok'));
  });

  it('refuses the pane\'s own TangleClaw with exit 3 and makes no request', async () => {
    const schedulePath = await planApi();
    let calls = 0;
    const r = await run(['run', '--schedule', schedulePath, '--api', 'http://localhost:3102/', '--log', path.join(dir, 'l')],
      { fetch: async () => { calls++; return { status: 200, text: async () => '{}' }; }, clock: instantClock(), env: { TANGLECLAW_API: 'http://localhost:3102' } });
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.err).code, 'LIVE_INSTALL_TARGET');
    assert.equal(calls, 0);
  });

  it('refuses, before any load, a target that reports the same running server as the live install', async () => {
    const schedulePath = await planApi();
    const hits = [];
    const info = JSON.stringify({ startedAt: '2026-09-28T17:27:45.023Z', startupSha: 'b'.repeat(40) });
    const fetch = async (url) => { hits.push(url.pathname); return { status: 200, text: async () => info }; };
    const r = await run(['run', '--schedule', schedulePath, '--api', 'https://proxy.example:8443', '--log', path.join(dir, 'l')],
      { fetch, clock: instantClock(), env: { TANGLECLAW_API: 'http://localhost:3102' } });
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.err).code, 'LIVE_INSTALL_TARGET');
    assert.deepEqual(hits, ['/api/server-info', '/api/server-info'], 'only the identity check reached any server');
    assert.equal(fs.existsSync(path.join(dir, 'l')), false);
  });

  it('refuses when the live identity cannot be read, and makes no load request', async () => {
    const schedulePath = await planApi();
    const hits = [];
    const fetch = async (url) => { hits.push(`${url.origin}${url.pathname}`); return { status: 503, text: async () => '{}' }; };
    const r = await run(['run', '--schedule', schedulePath, '--api', 'http://guest.invalid:3102', '--log', path.join(dir, 'l')],
      { fetch, clock: instantClock(), env: { TANGLECLAW_API: 'http://localhost:3102' } });
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.err).code, 'LIVE_IDENTITY_UNREADABLE');
    assert.ok(hits.every((h) => h.endsWith('/api/server-info')));
    assert.equal(fs.existsSync(path.join(dir, 'l')), false);
  });

  it('runs past an unreadable live identity only with --allow-unverified-live, and records the override in the log', async () => {
    const schedulePath = await planApi();
    const log = path.join(dir, 'l');
    const fetch = async (url) => (url.origin === 'http://localhost:3102'
      ? { status: 503, text: async () => '{}' }
      : { status: 200, text: async () => '{}' });
    const r = await run(['run', '--schedule', schedulePath, '--api', 'http://guest.invalid:3102', '--log', log, '--allow-unverified-live'],
      { fetch, clock: instantClock(), env: { TANGLECLAW_API: 'http://localhost:3102' } });
    assert.equal(r.code, 0, r.err);
    const warning = JSON.parse(r.err.split('\n')[0]);
    assert.deepEqual([warning.warning, warning.liveUnverified], ['IDENTITY_UNCHECKED', true]);
    const header = JSON.parse(fs.readFileSync(log, 'utf8').split('\n')[0]);
    assert.deepEqual(header.liveIdentityOverride, { reason: 'live install server-info: HTTP 503' });
  });

  it('refuses to run with no TANGLECLAW_API unless --no-live-install says so', async () => {
    const schedulePath = await planApi();
    let calls = 0;
    const r = await run(['run', '--schedule', schedulePath, '--api', 'http://guest.invalid:3102', '--log', path.join(dir, 'l')],
      { fetch: async () => { calls++; return { status: 200, text: async () => '{}' }; }, clock: instantClock() });
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.err).code, 'GUARD_CONTEXT_ABSENT');
    assert.equal(calls, 0);
  });

  it('runs in the guest with --no-live-install, and records the override in the log header', async () => {
    const schedulePath = await planApi();
    const log = path.join(dir, 'l');
    const r = await run(['run', '--schedule', schedulePath, '--api', 'http://localhost:3102', '--log', log, '--no-live-install'],
      { fetch: async () => ({ status: 200, text: async () => '{}' }), clock: instantClock() });
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(fs.readFileSync(log, 'utf8').split('\n')[0]).guardContextOverride, 'no-live-install');
  });

  it('rejects --no-live-install where TANGLECLAW_API is set, since the claim is false', async () => {
    const schedulePath = await planApi();
    const r = await run(['run', '--schedule', schedulePath, '--api', 'http://guest.invalid:3102', '--log', path.join(dir, 'l'), '--no-live-install'],
      { fetch: async () => ({ status: 200, text: async () => '{}' }), clock: instantClock(), env: { TANGLECLAW_API: 'http://localhost:3102' } });
    assert.equal(r.code, 2);
  });

  it('refuses a target whose name does not resolve', async () => {
    const schedulePath = await planApi();
    const r = await run(['run', '--schedule', schedulePath, '--api', 'http://guest.invalid:3102', '--log', path.join(dir, 'l')],
      { fetch: async () => ({ status: 200, text: async () => '{}' }), lookup: async () => { const e = new Error('nope'); e.code = 'ENOTFOUND'; throw e; }, clock: instantClock(), env: { TANGLECLAW_API: 'http://localhost:3102' } });
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.err).code, 'TARGET_UNRESOLVED');
  });

  it('refuses a target name that resolves to this machine on the live port', async () => {
    const schedulePath = await planApi();
    let calls = 0;
    const r = await run(['run', '--schedule', schedulePath, '--api', 'http://sneaky.example:3102', '--log', path.join(dir, 'l')],
      { fetch: async () => { calls++; return { status: 200, text: async () => '{}' }; }, lookup: async () => ['127.0.0.1'], clock: instantClock(), env: { TANGLECLAW_API: 'http://localhost:3102' } });
    assert.equal(r.code, 3);
    assert.equal(JSON.parse(r.err).code, 'LIVE_INSTALL_TARGET');
    assert.equal(calls, 0);
  });

  it('warns, and still runs, when only the target cannot be compared', async () => {
    const schedulePath = await planApi();
    const fetch = async (url) => {
      if (url.origin === 'http://localhost:3102') return { status: 200, text: async () => JSON.stringify({ startedAt: 'live', startupSha: 'd'.repeat(40) }) };
      return { status: 200, text: async () => '{}' };
    };
    const r = await run(['run', '--schedule', schedulePath, '--api', 'http://guest.invalid:3102', '--log', path.join(dir, 'l')],
      { fetch, clock: instantClock(), env: { TANGLECLAW_API: 'http://localhost:3102' } });
    assert.equal(r.code, 0, r.err);
    const warning = JSON.parse(r.err.split('\n')[0]);
    assert.deepEqual([warning.warning, warning.liveUnverified], ['IDENTITY_UNCHECKED', false]);
  });

  it('refuses a schedule whose kinds have no executor with exit 3', async () => {
    const out = path.join(dir, 'full.json');
    await run(['plan', '--seed', 'rc', '--phase', 'certifying', '--duration-hours', '4', '--out', out]);
    const r = await run(['run', '--schedule', out, '--api', 'http://guest.invalid:3102', '--log', path.join(dir, 'l'), '--no-live-install'],
      { fetch: async () => ({ status: 200, text: async () => '{}' }), clock: instantClock() });
    assert.equal(r.code, 3);
    const lines = r.err.trim().split('\n');
    assert.equal(JSON.parse(lines[lines.length - 1]).code, 'NO_EXECUTOR');
  });

  it('exits 4 when stopped by a signal, and a second run resumes to completion', async () => {
    const schedulePath = await planApi();
    const log = path.join(dir, 'soak.ndjson');
    const fetch = async () => ({ status: 200, text: async () => '{}' });
    const clock = instantClock();
    let fire;
    let count = 0;
    const counting = async (...a) => { count++; if (count === 3) fire(); return fetch(...a); };
    const first = await run(['run', '--schedule', schedulePath, '--api', 'http://guest.invalid:3102', '--log', log, '--no-live-install'],
      { fetch: counting, clock, onStopSignal: (fn) => { fire = fn; } });
    assert.equal(first.code, 4);
    const second = await run(['run', '--schedule', schedulePath, '--api', 'http://guest.invalid:3102', '--log', log, '--no-live-install'], { fetch, clock });
    assert.equal(second.code, 0, second.err);
    assert.equal(JSON.parse(second.out).status, 'completed');
    assert.ok(JSON.parse(second.out).resumedFrom > 0);
  });
});
