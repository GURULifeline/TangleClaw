'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const driver = require('../lib/soak/driver');
const sched = require('../lib/soak/schedule');

const MIN = 60 * 1000;

/** A realistic epoch start: the log refuses a start time that is not a real epoch. */
const T0 = 1_790_000_000_000;

/**
 * A fake wall clock: `sleep` advances time instantly and records each wait.
 * @param {number} start - Initial epoch ms
 * @returns {{now: () => number, sleep: (ms: number) => Promise<void>, advance: (ms: number) => void, sleeps: number[]}} Clock
 */
function fakeClock(start) {
  let t = start;
  const sleeps = [];
  return {
    now: () => t,
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    advance: (ms) => { t += ms; },
    sleeps
  };
}

/**
 * An api-only schedule short enough to reason about event by event.
 * @param {object} [over] - Option overrides
 * @returns {object} Schedule
 */
function apiSchedule(over = {}) {
  return sched.buildSchedule({ seed: 'driver', phase: 'certifying', durationMs: 10 * MIN, loadMeanMs: MIN, classes: ['api'], ...over });
}

/**
 * Executors for every api kind that record what ran and resolve OK.
 * @param {string[]} ran - Receives each kind as it runs
 * @returns {object} Executors
 */
function recordingExecutors(ran) {
  const out = {};
  for (const t of sched.TASKS.filter((k) => k.class === 'api')) {
    out[t.kind] = async () => { ran.push(t.kind); return { ok: true, code: 'OK', status: 200 }; };
  }
  return out;
}

/**
 * Parse a log file into records.
 * @param {string} p - Log path
 * @returns {object[]} Records
 */
function records(p) {
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

let dir;
let logPath;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-driver-'));
  logPath = path.join(dir, 'soak.ndjson');
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('soak driver — a complete run', () => {
  it('runs every event at its scheduled slot and writes header, events and end', async () => {
    const s = apiSchedule();
    const clock = fakeClock(1_000_000);
    const ran = [];
    const result = await driver.runSchedule({ schedule: s, executors: recordingExecutors(ran), ctx: {}, logPath, clock });
    assert.deepEqual(result, { status: 'completed', ran: s.events.length, resumedFrom: 0, tornTail: false, skipped: 0 });
    assert.deepEqual(ran, s.events.map((e) => e.kind));

    const recs = records(logPath);
    assert.equal(recs[0].type, 'header');
    assert.equal(recs[0].schema, driver.LOG_SCHEMA);
    assert.equal(recs[0].scheduleDigest, s.digest);
    assert.equal(recs[0].startEpochMs, 1_000_000);
    const events = recs.filter((r) => r.type === 'event');
    assert.deepEqual(events.map((r) => r.index), s.events.map((e) => e.index));
    events.forEach((r, i) => {
      assert.equal(r.scheduledAt, 1_000_000 + s.events[i].atMs);
      assert.equal(r.startedAt, r.scheduledAt);
      assert.equal(r.lateMs, 0);
      assert.equal(r.ok, true);
    });
    assert.equal(recs[recs.length - 1].type, 'end');
    assert.equal(recs[recs.length - 1].events, s.events.length);
  });

  it('creates the log readable by its owner only', async () => {
    await driver.runSchedule({ schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) });
    assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
  });

  it('records a failed outcome and keeps going', async () => {
    const s = apiSchedule();
    const executors = recordingExecutors([]);
    executors['api.health'] = async () => ({ ok: false, code: 'HTTP_STATUS', status: 503 });
    await driver.runSchedule({ schedule: s, executors, ctx: {}, logPath, clock: fakeClock(T0) });
    const events = records(logPath).filter((r) => r.type === 'event');
    assert.equal(events.length, s.events.length);
    for (const r of events.filter((e) => e.kind === 'api.health')) assert.deepEqual([r.ok, r.code, r.status], [false, 'HTTP_STATUS', 503]);
  });

  it('records an executor that throws as EXECUTOR_THREW and keeps going', async () => {
    const s = apiSchedule();
    const executors = recordingExecutors([]);
    executors['api.health'] = async () => { throw new Error('boom'); };
    const result = await driver.runSchedule({ schedule: s, executors, ctx: {}, logPath, clock: fakeClock(T0) });
    assert.equal(result.status, 'completed');
    const thrown = records(logPath).filter((r) => r.kind === 'api.health');
    assert.ok(thrown.length > 0);
    for (const r of thrown) assert.deepEqual([r.ok, r.code, r.error], [false, 'EXECUTOR_THREW', 'boom']);
  });

  it('passes each event its own params and the shared context', async () => {
    const s = apiSchedule({ durationMs: 60 * MIN });
    const seen = [];
    const executors = recordingExecutors([]);
    executors['api.ports.lease-release'] = async (ctx, params) => { seen.push([ctx.tag, params.port]); return { ok: true, code: 'OK' }; };
    await driver.runSchedule({ schedule: s, executors, ctx: { tag: 'guest' }, logPath, clock: fakeClock(T0) });
    const expected = s.events.filter((e) => e.kind === 'api.ports.lease-release').map((e) => ['guest', e.params.port]);
    assert.ok(expected.length > 0);
    assert.deepEqual(seen, expected);
  });
});

describe('soak driver — refusals', () => {
  it('refuses an invalid schedule before writing anything', async () => {
    const s = apiSchedule();
    const bad = { ...s, digest: '0'.repeat(64) };
    await assert.rejects(
      driver.runSchedule({ schedule: bad, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) }),
      (err) => err instanceof driver.DriverRefusal && err.code === 'INVALID_SCHEDULE'
    );
    assert.equal(fs.existsSync(logPath), false);
  });

  it('refuses a schedule with kinds that have no executor, naming them, rather than skipping them', async () => {
    const s = sched.buildSchedule({ seed: 'x', phase: 'certifying', durationMs: 6 * 60 * MIN, faultMeanMs: 30 * MIN });
    await assert.rejects(
      driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) }),
      (err) => err.code === 'NO_EXECUTOR' && err.details.kinds.includes('engine.session.cycle') && err.details.kinds.some((k) => k.startsWith('fault.'))
    );
    assert.equal(fs.existsSync(logPath), false);
  });

  it('refuses a log that belongs to another schedule', async () => {
    await driver.runSchedule({ schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) });
    await assert.rejects(
      driver.runSchedule({ schedule: apiSchedule({ seed: 'other' }), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) }),
      (err) => err.code === 'LOG_MISMATCH'
    );
  });

  it('refuses a log with a malformed line before its end', async () => {
    fs.writeFileSync(logPath, `${JSON.stringify({ type: 'header', schema: driver.LOG_SCHEMA, scheduleDigest: apiSchedule().digest, startEpochMs: T0 })}\nnot json\n`);
    await assert.rejects(
      driver.runSchedule({ schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) }),
      (err) => err.code === 'LOG_UNREADABLE'
    );
  });

  it('refuses a file that is not a soak log', async () => {
    fs.writeFileSync(logPath, `${JSON.stringify({ hello: 'world' })}\n`);
    await assert.rejects(
      driver.runSchedule({ schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) }),
      (err) => err.code === 'LOG_UNREADABLE'
    );
  });
});

describe('soak driver — resume', () => {
  it('resumes after a stop without re-running any logged event, at the original slots', async () => {
    const s = apiSchedule();
    const clock = fakeClock(5_000);
    const firstRun = [];
    let n = 0;
    const stopAfter = 4;
    const first = await driver.runSchedule({
      schedule: s, executors: recordingExecutors(firstRun), ctx: {}, logPath, clock,
      shouldStop: () => n++ >= stopAfter * 2 // checked twice per event
    });
    assert.equal(first.status, 'stopped');
    assert.equal(firstRun.length, stopAfter);

    const secondRun = [];
    const second = await driver.runSchedule({ schedule: s, executors: recordingExecutors(secondRun), ctx: {}, logPath, clock });
    assert.equal(second.status, 'completed');
    assert.equal(second.resumedFrom, stopAfter);
    assert.deepEqual([...firstRun, ...secondRun], s.events.map((e) => e.kind));

    const recs = records(logPath);
    assert.equal(recs.filter((r) => r.type === 'header').length, 1, 'one header across both runs');
    const indexes = recs.filter((r) => r.type === 'event').map((r) => r.index);
    assert.deepEqual(indexes, s.events.map((e) => e.index), 'every event exactly once, in order');
    for (const r of recs.filter((x) => x.type === 'event')) assert.equal(r.scheduledAt, 5_000 + s.events[r.index].atMs);
  });

  it('runs an event that is only slightly late at once, and records how late', async () => {
    const s = apiSchedule();
    const clock = fakeClock(T0);
    let n = 0;
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: () => n++ >= 2 });
    const next = s.events[1];
    clock.advance(next.atMs - s.events[0].atMs + 20 * 1000); // resume 20 s after the next slot
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock });
    const r = records(logPath).find((x) => x.type === 'event' && x.index === 1);
    assert.equal(r.skipped, undefined);
    assert.ok(r.lateMs >= 20 * 1000 && r.lateMs < driver.STALE_LOAD_MS);
    assert.equal(r.startedAt - r.scheduledAt, r.lateMs);
  });

  it('skips and records load that went stale while it was down, then runs the rest on time', async () => {
    const s = apiSchedule();
    const clock = fakeClock(T0);
    let n = 0;
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: () => n++ >= 2 });
    clock.advance(5 * MIN);
    const ran = [];
    const result = await driver.runSchedule({ schedule: s, executors: recordingExecutors(ran), ctx: {}, logPath, clock });
    const ev = records(logPath).filter((r) => r.type === 'event');
    const stale = ev.filter((r) => r.skipped);
    assert.ok(stale.length > 0);
    assert.equal(result.skipped, stale.length);
    for (const r of stale) {
      assert.deepEqual([r.code, r.ok, r.startedAt], ['SKIPPED_STALE', null, null]);
      assert.ok(r.lateMs > driver.STALE_LOAD_MS);
    }
    assert.equal(ran.length + stale.length, s.events.length - 1, 'every remaining event is either run or recorded as skipped');
    assert.deepEqual(ev.map((r) => r.index), s.events.map((e) => e.index), 'still exactly once each, in order');
    assert.equal(ev[ev.length - 1].lateMs, 0, 'later events are back on their slots');
  });

  it('seals a torn final line by appending, never rewriting, and runs that event again', async () => {
    const s = apiSchedule();
    const clock = fakeClock(T0);
    let n = 0;
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: () => n++ >= 6 });
    const fragment = '{"type":"event","index":3,"kind":"api.he';
    fs.appendFileSync(logPath, fragment);
    const before = fs.readFileSync(logPath, 'utf8');

    const peek = driver.readLog(logPath);
    assert.deepEqual([peek.tornTail, peek.tornBytes, peek.lastIndex], [true, Buffer.byteLength(fragment), 2]);
    assert.equal(fs.readFileSync(logPath, 'utf8'), before, 'reading the log changes nothing');

    const ran = [];
    const result = await driver.runSchedule({ schedule: s, executors: recordingExecutors(ran), ctx: {}, logPath, clock });
    assert.equal(result.tornTail, true);
    assert.equal(result.resumedFrom, 3);
    assert.equal(ran[0], s.events[3].kind);
    const after = fs.readFileSync(logPath, 'utf8');
    assert.ok(after.startsWith(before), 'every original byte, the fragment included, is still there');
    const seal = after.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((r) => r && r.type === 'torn-tail-sealed');
    assert.equal(seal.bytes, Buffer.byteLength(fragment));
    const indexes = after.split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && r.type === 'event').map((r) => r.index);
    assert.deepEqual(indexes, s.events.map((e) => e.index));
    // and the sealed log reads back cleanly
    assert.equal(driver.readLog(logPath).ended, true);
  });

  it('refuses a malformed line that no seal follows', () => {
    fs.writeFileSync(logPath, `${JSON.stringify({ type: 'header', schema: driver.LOG_SCHEMA, scheduleDigest: 'x', startEpochMs: T0 })}\n{broken\n${JSON.stringify({ type: 'event', index: 0 })}\n`);
    assert.throws(() => driver.readLog(logPath), (err) => err.code === 'LOG_UNREADABLE');
  });

  it('refuses a log whose only content is a torn header', () => {
    fs.writeFileSync(logPath, '{"type":"header","sch');
    assert.throws(() => driver.readLog(logPath), (err) => err.code === 'LOG_UNREADABLE');
  });

  it('does nothing for a log that already ended', async () => {
    const s = apiSchedule();
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) });
    const before = fs.readFileSync(logPath, 'utf8');
    const ran = [];
    const result = await driver.runSchedule({ schedule: s, executors: recordingExecutors(ran), ctx: {}, logPath, clock: fakeClock(T0) });
    assert.equal(result.status, 'already-complete');
    assert.equal(ran.length, 0);
    assert.equal(fs.readFileSync(logPath, 'utf8'), before);
  });
});

describe('soak driver — the live-install guard', () => {
  // A fixed picture of "this machine", so the tests do not depend on the
  // interfaces of whichever host runs them.
  const names = { exact: new Set(['localhost', '::1', '[::1]', '0.0.0.0', '::', '[::]', 'devbox', '192.168.1.20', '100.64.0.7']), hostnamePrefix: 'devbox.' };
  const LIVE = 'http://localhost:3102';

  it('refuses every spelling that reaches the live port on this machine', () => {
    const spellings = [
      'http://localhost:3102', 'http://localhost:3102/', 'http://localhost:3102/api',
      'http://127.0.0.1:3102', 'http://127.1.2.3:3102', 'http://[::1]:3102', 'http://0.0.0.0:3102',
      'https://localhost:3102', 'http://DEVBOX:3102', 'http://devbox.tail123678.ts.net:3102',
      'http://192.168.1.20:3102', 'http://100.64.0.7:3102',
      'http://[::ffff:127.0.0.1]:3102', 'http://[::ffff:7f00:1]:3102', 'http://localhost.:3102', 'http://localhost..:3102',
      'http://foo.localhost:3102', 'http://2130706433:3102', 'http://0x7f.1:3102', 'http://devbox.:3102'
    ];
    for (const target of spellings) {
      assert.throws(() => driver.refuseLiveTarget(target, LIVE, names), (err) => err.code === 'LIVE_INSTALL_TARGET', target);
    }
  });

  it('refuses the same origin even on another machine', () => {
    assert.throws(() => driver.refuseLiveTarget('http://tc.example:3102', 'http://tc.example:3102', names), (err) => err.code === 'LIVE_INSTALL_TARGET');
  });

  it('fills in the scheme default port when comparing', () => {
    assert.throws(() => driver.refuseLiveTarget('http://127.0.0.1', 'http://localhost:80', names), (err) => err.code === 'LIVE_INSTALL_TARGET');
  });

  it('allows another port on this machine, another machine, or anything when there is no live install', () => {
    driver.refuseLiveTarget('http://localhost:3202', LIVE, names);
    driver.refuseLiveTarget('http://192.168.64.7:3102', LIVE, names);
    driver.refuseLiveTarget('http://devboxer:3102', LIVE, names);
    driver.refuseLiveTarget('http://localhost:3102', undefined, names);
  });

  it('knows this machine\'s real loopback and hostname', () => {
    const real = driver.localNames();
    assert.ok(real.exact.has('localhost'));
    assert.ok(real.exact.has(os.hostname().toLowerCase().split('.')[0]));
  });
});

describe('soak driver — the same-install identity check', () => {
  /**
   * A fetch that answers /api/server-info per origin.
   * @param {Object<string, {status: number, body?: object}|Error>} byOrigin - Answer per origin
   * @returns {Function} Fetch
   */
  function infoFetch(byOrigin) {
    return async (url) => {
      const a = byOrigin[url.origin];
      if (a instanceof Error) throw a;
      assert.equal(url.pathname, '/api/server-info');
      return { status: a.status, text: async () => JSON.stringify(a.body || {}) };
    };
  }
  const LIVE = 'http://localhost:3102';
  const PROXY = 'https://devbox.tail123678.ts.net:8443';
  const same = { status: 200, body: { startedAt: '2026-09-28T17:27:45.023Z', startupSha: 'a'.repeat(40) } };
  const other = { status: 200, body: { startedAt: '2026-09-28T18:00:00.000Z', startupSha: 'a'.repeat(40) } };

  it('refuses a target that reports the same running server, whatever address reached it', async () => {
    await assert.rejects(
      driver.refuseSameInstall({ apiBase: PROXY, liveApi: LIVE, fetch: infoFetch({ [LIVE]: same, [PROXY]: same }) }),
      (err) => err.code === 'LIVE_INSTALL_TARGET'
    );
  });

  it('allows a different server', async () => {
    const r = await driver.refuseSameInstall({ apiBase: PROXY, liveApi: LIVE, fetch: infoFetch({ [LIVE]: same, [PROXY]: other }) });
    assert.deepEqual(r, { checked: true, reason: null, liveUnverified: false });
  });

  it('refuses when the LIVE identity cannot be read, whatever the reason', async () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    const unreadable = [
      [new TypeError('fetch failed'), /fetch failed/],
      [timeout, /timeout/],
      [{ status: 401 }, /HTTP 401/],
      [{ status: 503 }, /HTTP 503/],
      [{ status: 200, body: {} }, /no startedAt\/startupSha/],
      [{ status: 200, body: { startedAt: 'x' } }, /no startedAt\/startupSha/]
    ];
    for (const [liveAnswer, reason] of unreadable) {
      await assert.rejects(
        driver.refuseSameInstall({ apiBase: PROXY, liveApi: LIVE, fetch: infoFetch({ [LIVE]: liveAnswer, [PROXY]: other }) }),
        (err) => err.code === 'LIVE_IDENTITY_UNREADABLE' && reason.test(err.details.reason),
        String(reason)
      );
    }
  });

  it('proceeds on an unreadable live identity only with the explicit override, and says so', async () => {
    const r = await driver.refuseSameInstall({ apiBase: PROXY, liveApi: LIVE, allowUnverifiedLive: true, fetch: infoFetch({ [LIVE]: { status: 503 }, [PROXY]: other }) });
    assert.deepEqual(r, { checked: false, reason: 'live install server-info: HTTP 503', liveUnverified: true });
  });

  it('reports unchecked, not refused, when only the TARGET cannot be read', async () => {
    for (const [answer, reason] of [[{ status: 401 }, /target server-info: HTTP 401/], [new TypeError('fetch failed'), /target server-info: fetch failed/]]) {
      const r = await driver.refuseSameInstall({ apiBase: PROXY, liveApi: LIVE, fetch: infoFetch({ [LIVE]: same, [PROXY]: answer }) });
      assert.equal(r.checked, false);
      assert.equal(r.liveUnverified, false);
      assert.match(r.reason, reason);
    }
  });

  it('does nothing without a live install, the soak guest\'s normal case', async () => {
    const r = await driver.refuseSameInstall({ apiBase: 'http://localhost:3102', liveApi: undefined, fetch: async () => { throw new Error('must not fetch'); } });
    assert.deepEqual(r, { checked: false, reason: 'no TANGLECLAW_API in this pane', liveUnverified: false });
  });

  it('sends the service token to the target only', async () => {
    const auth = {};
    const fetch = async (url, init) => { auth[url.origin] = init.headers.authorization; return { status: 200, text: async () => JSON.stringify(url.origin === LIVE ? same.body : other.body) }; };
    await driver.refuseSameInstall({ apiBase: PROXY, liveApi: LIVE, fetch, token: 'tok' });
    assert.deepEqual(auth, { [LIVE]: undefined, [PROXY]: 'Bearer tok' });
  });
});

describe('soak driver — resolving the target', () => {
  const names = { exact: new Set(['localhost', '::1', 'devbox', '192.168.1.20']), hostnamePrefix: 'devbox.' };
  const LIVE = 'http://localhost:3102';
  const lookupFrom = (table) => async (host) => {
    if (!(host in table)) { const e = new Error('nope'); e.code = 'ENOTFOUND'; throw e; }
    return table[host];
  };

  it('refuses a name that resolves to a loopback or local-interface address on the live port', async () => {
    for (const addrs of [['127.0.0.1'], ['::1'], ['::ffff:127.0.0.1'], ['10.9.9.9', '192.168.1.20']]) {
      await assert.rejects(
        driver.refuseLiveResolved({ apiBase: 'http://sneaky.example:3102', liveApi: LIVE, names, lookup: lookupFrom({ 'sneaky.example': addrs }) }),
        (err) => err.code === 'LIVE_INSTALL_TARGET',
        addrs.join(',')
      );
    }
  });

  it('allows a name that resolves elsewhere, and any other port', async () => {
    await driver.refuseLiveResolved({ apiBase: 'http://guest.example:3102', liveApi: LIVE, names, lookup: lookupFrom({ 'guest.example': ['192.168.64.7'] }) });
    await driver.refuseLiveResolved({ apiBase: 'http://localhost:3202', liveApi: LIVE, names, lookup: async () => { throw new Error('must not look up'); } });
  });

  it('fails closed on a name that does not resolve, or resolves to nothing', async () => {
    for (const lookup of [lookupFrom({}), async () => { const e = new Error('try again'); e.code = 'EAI_AGAIN'; throw e; }, async () => []]) {
      await assert.rejects(
        driver.refuseLiveResolved({ apiBase: 'http://nowhere.example:3102', liveApi: LIVE, names, lookup }),
        (err) => err.code === 'TARGET_UNRESOLVED'
      );
    }
  });

  it('really resolves localhost through the system resolver', async () => {
    await assert.rejects(driver.refuseLiveResolved({ apiBase: 'http://localhost.:3102', liveApi: LIVE }), (err) => err.code === 'LIVE_INSTALL_TARGET');
  });
});

describe('soak driver — run-time pacing', () => {
  /**
   * A schedule with faults, as the driver sees it; a fault executor is supplied by the test.
   * @returns {object} Schedule
   */
  function faultSchedule() {
    return sched.buildSchedule({ seed: 'pace', phase: 'certifying', durationMs: 12 * 60 * MIN, loadMeanMs: 5 * MIN, faultMeanMs: 60 * MIN, faultQuietMs: 30 * MIN, classes: ['api', 'fault'] });
  }
  /**
   * Executors for every kind in a schedule, resolving OK.
   * @param {object} s - Schedule
   * @returns {object} Executors
   */
  function allOk(s) {
    const out = {};
    for (const k of new Set(s.events.map((e) => e.kind))) out[k] = async () => ({ ok: true, code: 'OK' });
    return out;
  }

  it('keeps faults a full quiet window apart after a long outage, and says so', async () => {
    const s = faultSchedule();
    const clock = fakeClock(T0);
    let n = 0;
    await driver.runSchedule({ schedule: s, executors: allOk(s), ctx: {}, logPath, clock, shouldStop: () => n++ >= 2 });
    clock.advance(10 * 60 * MIN); // down for ten hours: most of the schedule is overdue
    await driver.runSchedule({ schedule: s, executors: allOk(s), ctx: {}, logPath, clock });
    const faults = records(logPath).filter((r) => r.type === 'event' && r.kind.startsWith('fault.'));
    assert.ok(faults.length >= 3, 'the fixture must have several overdue faults');
    for (let i = 1; i < faults.length; i++) assert.ok(faults[i].startedAt - faults[i - 1].startedAt >= s.params.faultQuietMs, `fault ${i}`);
    assert.ok(faults.some((f) => f.paced === 'quiet-window'));
    // Faults are deferred, never skipped, and all of them run before the log ends.
    assert.equal(faults.length, s.events.filter((e) => e.class === 'fault').length);
    assert.ok(faults.every((f) => !f.skipped && f.ok === true));
    const all = records(logPath);
    assert.equal(all[all.length - 1].type, 'end');
    assert.ok(all[all.length - 1].completedAt >= faults[faults.length - 1].startedAt);
  });

  it('counts a fault that ran before a restart, read back from the log', async () => {
    // Both faults are overdue when the first runs, and the driver restarts
    // immediately after it. Only the fault time recovered from the log keeps
    // the second a quiet window away: a fresh process that forgot it would
    // start the second one catch-up-gap later.
    const s = faultSchedule();
    const [f0, f1] = s.events.filter((e) => e.class === 'fault');
    assert.ok(f1, 'the fixture needs two faults');
    const clock = fakeClock(T0);
    let n = 0;
    await driver.runSchedule({ schedule: s, executors: allOk(s), ctx: {}, logPath, clock, shouldStop: () => n++ >= 0 });
    clock.advance(f1.atMs + 60 * MIN); // both faults are now overdue
    await driver.runSchedule({ schedule: s, executors: allOk(s), ctx: {}, logPath, clock, shouldStop: () => records(logPath).some((r) => r.index === f0.index) });
    await driver.runSchedule({ schedule: s, executors: allOk(s), ctx: {}, logPath, clock });
    const byIndex = new Map(records(logPath).filter((r) => r.type === 'event').map((r) => [r.index, r]));
    const gap = byIndex.get(f1.index).startedAt - byIndex.get(f0.index).startedAt;
    assert.ok(gap >= s.params.faultQuietMs, `gap ${gap}`);
    assert.equal(byIndex.get(f1.index).paced, 'quiet-window');
  });

  it('spaces overdue events instead of firing them in one burst', async () => {
    const s = apiSchedule({ durationMs: 60 * MIN });
    const clock = fakeClock(T0);
    let n = 0;
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: () => n++ >= 2 });
    clock.advance(50 * MIN);
    // Stale-skipping is turned off here so the catch-up spacing itself is what is measured.
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, catchUpGapMs: 2000, staleLoadMs: Infinity });
    const ev = records(logPath).filter((r) => r.type === 'event');
    const overdue = ev.filter((r) => r.lateMs > 0);
    assert.ok(overdue.length > 3);
    for (let i = 1; i < ev.length; i++) {
      if (ev[i].lateMs > 0) assert.ok(ev[i].startedAt - ev[i - 1].startedAt >= 2000, `event ${ev[i].index}`);
    }
    assert.ok(overdue.every((r) => r.paced === 'catch-up' || r === overdue[0]));
  });

  it('leaves events that are on time at their slots, unpaced', async () => {
    const s = apiSchedule();
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) });
    for (const r of records(logPath).filter((x) => x.type === 'event')) {
      assert.equal(r.paced, null);
      assert.equal(r.lateMs, 0);
    }
  });
});

describe('soak driver — the guard context', () => {
  it('refuses to run unguarded with no TANGLECLAW_API unless told so explicitly', () => {
    assert.throws(() => driver.requireGuardContext(undefined, false), (err) => err.code === 'GUARD_CONTEXT_ABSENT');
    assert.equal(driver.requireGuardContext(undefined, true), true);
    assert.equal(driver.requireGuardContext('http://localhost:3102', false), false);
  });
});

describe('soak driver — the log lock and header', () => {
  it('refuses a second driver on the same log while the first holds it', async () => {
    const lock = driver.acquireLogLock(logPath);
    try {
      await assert.rejects(
        driver.runSchedule({ schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) }),
        (err) => err.code === 'LOG_LOCKED' && err.details.holder.pid === process.pid
      );
      assert.equal(fs.existsSync(logPath), false, 'the refused run wrote nothing');
    } finally {
      lock.release();
    }
  });

  it('releases the lock when the run ends, and when it is refused', async () => {
    await driver.runSchedule({ schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) });
    assert.equal(fs.existsSync(`${logPath}.lock`), false);
    await assert.rejects(driver.runSchedule({ schedule: apiSchedule({ seed: 'other' }), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) }));
    assert.equal(fs.existsSync(`${logPath}.lock`), false);
  });

  it('reclaims a lock left by a dead process on this host, and records it', async () => {
    fs.writeFileSync(`${logPath}.lock`, JSON.stringify({ pid: 999999, host: os.hostname() }));
    await driver.runSchedule({ schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0), lockDeps: { isAlive: () => false } });
    const reclaim = records(logPath).find((r) => r.type === 'lock-reclaimed');
    assert.deepEqual(reclaim.holder, { pid: 999999, host: os.hostname() });
  });

  it('never reclaims a lock held on another host', async () => {
    fs.writeFileSync(`${logPath}.lock`, JSON.stringify({ pid: 1, host: 'elsewhere' }));
    await assert.rejects(
      driver.runSchedule({ schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0), lockDeps: { isAlive: () => false } }),
      (err) => err.code === 'LOG_LOCKED'
    );
  });

  it('refuses a header without a real start time, instead of firing every event at once', async () => {
    for (const startEpochMs of [undefined, 'soon', 0, -5, 1.5]) {
      fs.writeFileSync(logPath, `${JSON.stringify({ type: 'header', schema: driver.LOG_SCHEMA, scheduleDigest: apiSchedule().digest, startEpochMs })}\n`);
      await assert.rejects(
        driver.runSchedule({ schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) }),
        (err) => err.code === 'LOG_UNREADABLE',
        String(startEpochMs)
      );
    }
  });
});
