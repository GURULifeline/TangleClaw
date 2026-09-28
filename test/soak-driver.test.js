'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const driver = require('../lib/soak/driver');
const sched = require('../lib/soak/schedule');

const MIN = 60 * 1000;

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
    assert.deepEqual(result, { status: 'completed', ran: s.events.length, resumedFrom: 0, truncated: false });
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
    await driver.runSchedule({ schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(0) });
    assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
  });

  it('records a failed outcome and keeps going', async () => {
    const s = apiSchedule();
    const executors = recordingExecutors([]);
    executors['api.health'] = async () => ({ ok: false, code: 'HTTP_STATUS', status: 503 });
    await driver.runSchedule({ schedule: s, executors, ctx: {}, logPath, clock: fakeClock(0) });
    const events = records(logPath).filter((r) => r.type === 'event');
    assert.equal(events.length, s.events.length);
    for (const r of events.filter((e) => e.kind === 'api.health')) assert.deepEqual([r.ok, r.code, r.status], [false, 'HTTP_STATUS', 503]);
  });

  it('records an executor that throws as EXECUTOR_THREW and keeps going', async () => {
    const s = apiSchedule();
    const executors = recordingExecutors([]);
    executors['api.health'] = async () => { throw new Error('boom'); };
    const result = await driver.runSchedule({ schedule: s, executors, ctx: {}, logPath, clock: fakeClock(0) });
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
    await driver.runSchedule({ schedule: s, executors, ctx: { tag: 'guest' }, logPath, clock: fakeClock(0) });
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
      driver.runSchedule({ schedule: bad, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(0) }),
      (err) => err instanceof driver.DriverRefusal && err.code === 'INVALID_SCHEDULE'
    );
    assert.equal(fs.existsSync(logPath), false);
  });

  it('refuses a schedule with kinds that have no executor, naming them, rather than skipping them', async () => {
    const s = sched.buildSchedule({ seed: 'x', phase: 'certifying', durationMs: 6 * 60 * MIN, faultMeanMs: 30 * MIN });
    await assert.rejects(
      driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(0) }),
      (err) => err.code === 'NO_EXECUTOR' && err.details.kinds.includes('engine.session.cycle') && err.details.kinds.some((k) => k.startsWith('fault.'))
    );
    assert.equal(fs.existsSync(logPath), false);
  });

  it('refuses a log that belongs to another schedule', async () => {
    await driver.runSchedule({ schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(0) });
    await assert.rejects(
      driver.runSchedule({ schedule: apiSchedule({ seed: 'other' }), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(0) }),
      (err) => err.code === 'LOG_MISMATCH'
    );
  });

  it('refuses a log with a malformed line before its end', async () => {
    fs.writeFileSync(logPath, `${JSON.stringify({ type: 'header', schema: driver.LOG_SCHEMA, scheduleDigest: apiSchedule().digest, startEpochMs: 0 })}\nnot json\n`);
    await assert.rejects(
      driver.runSchedule({ schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(0) }),
      (err) => err.code === 'LOG_UNREADABLE'
    );
  });

  it('refuses a file that is not a soak log', async () => {
    fs.writeFileSync(logPath, `${JSON.stringify({ hello: 'world' })}\n`);
    await assert.rejects(
      driver.runSchedule({ schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(0) }),
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

  it('runs events whose slot passed while it was down at once, and records how late', async () => {
    const s = apiSchedule();
    const clock = fakeClock(0);
    let n = 0;
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: () => n++ >= 2 });
    clock.advance(5 * MIN); // the driver was down for five minutes
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock });
    const resumed = records(logPath).filter((r) => r.type === 'event' && r.index >= 1);
    assert.ok(resumed[0].lateMs > 0, 'the first missed event is late');
    assert.equal(resumed[0].startedAt - resumed[0].scheduledAt, resumed[0].lateMs);
    assert.equal(resumed[resumed.length - 1].lateMs, 0, 'later events are back on their slots');
  });

  it('cuts a torn final line and runs that event again', async () => {
    const s = apiSchedule();
    const clock = fakeClock(0);
    let n = 0;
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: () => n++ >= 6 });
    fs.appendFileSync(logPath, '{"type":"event","index":3,"kind":"api.he');
    const ran = [];
    const result = await driver.runSchedule({ schedule: s, executors: recordingExecutors(ran), ctx: {}, logPath, clock });
    assert.equal(result.truncated, true);
    assert.equal(result.resumedFrom, 3);
    assert.equal(ran[0], s.events[3].kind);
    const indexes = records(logPath).filter((r) => r.type === 'event').map((r) => r.index);
    assert.deepEqual(indexes, s.events.map((e) => e.index));
  });

  it('does nothing for a log that already ended', async () => {
    const s = apiSchedule();
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(0) });
    const before = fs.readFileSync(logPath, 'utf8');
    const ran = [];
    const result = await driver.runSchedule({ schedule: s, executors: recordingExecutors(ran), ctx: {}, logPath, clock: fakeClock(0) });
    assert.equal(result.status, 'already-complete');
    assert.equal(ran.length, 0);
    assert.equal(fs.readFileSync(logPath, 'utf8'), before);
  });
});

describe('soak driver — the live-install guard', () => {
  it('refuses the pane\'s own TangleClaw, however the URL is spelled', () => {
    for (const target of ['http://localhost:3102', 'http://localhost:3102/', 'http://localhost:3102/api']) {
      assert.throws(() => driver.refuseLiveTarget(target, 'http://localhost:3102'), (err) => err.code === 'LIVE_INSTALL_TARGET', target);
    }
  });

  it('allows a different origin, and allows anything when there is no live install', () => {
    driver.refuseLiveTarget('http://192.168.64.7:3102', 'http://localhost:3102');
    driver.refuseLiveTarget('http://localhost:3202', 'http://localhost:3102');
    driver.refuseLiveTarget('http://localhost:3102', undefined);
  });
});
