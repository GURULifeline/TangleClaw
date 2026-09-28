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

/**
 * A stop condition that trips once the log holds `k` event records, so a test
 * says "stop after k events" rather than counting how often the driver asks.
 * @param {number} k - Events to allow
 * @returns {() => boolean} Stop check
 */
function afterEvents(k) {
  return () => fs.existsSync(logPath) && fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.includes('"type":"event"')).length >= k;
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
    // Damage in the MIDDLE of the log, with a valid record after it, is never
    // the leftovers of a crash, so it is refused. (Unsealed damage at the very
    // end is the pending region of the last crash, tested separately.)
    fs.writeFileSync(logPath, `${JSON.stringify({ type: 'header', schema: driver.LOG_SCHEMA, scheduleDigest: apiSchedule().digest, startEpochMs: T0 })}\nnot json\n${JSON.stringify({ type: 'event', index: 0, kind: 'api.health', startedAt: T0 })}\n`);
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
    const stopAfter = 4;
    const first = await driver.runSchedule({
      schedule: s, executors: recordingExecutors(firstRun), ctx: {}, logPath, clock,
      shouldStop: afterEvents(stopAfter)
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
    const resume = recs.filter((r) => r.type === 'resume');
    assert.equal(resume.length, 1, 'the second segment is marked');
    assert.equal(resume[0].resumedFrom, stopAfter);
    const indexes = recs.filter((r) => r.type === 'event').map((r) => r.index);
    assert.deepEqual(indexes, s.events.map((e) => e.index), 'every event exactly once, in order');
    for (const r of recs.filter((x) => x.type === 'event')) assert.equal(r.scheduledAt, 5_000 + s.events[r.index].atMs);
  });

  it('runs an event that is only slightly late at once, and records how late', async () => {
    const s = apiSchedule();
    const clock = fakeClock(T0);
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: afterEvents(1) });
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
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: afterEvents(1) });
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
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: afterEvents(3) });
    const fragment = '{"type":"event","index":3,"kind":"api.he';
    fs.appendFileSync(logPath, fragment);
    const before = fs.readFileSync(logPath, 'utf8');

    const peek = driver.readLog(logPath);
    const crypto = require('node:crypto');
    assert.deepEqual([peek.tornTail, peek.lastIndex], [true, 2]);
    assert.deepEqual(peek.torn, { offset: Buffer.byteLength(before) - Buffer.byteLength(fragment), bytes: Buffer.byteLength(fragment), sha256: crypto.createHash('sha256').update(fragment).digest('hex'), endsWithNewline: false });
    assert.equal(fs.readFileSync(logPath, 'utf8'), before, 'reading the log changes nothing');

    const ran = [];
    const result = await driver.runSchedule({ schedule: s, executors: recordingExecutors(ran), ctx: {}, logPath, clock });
    assert.equal(result.tornTail, true);
    assert.equal(result.resumedFrom, 3);
    assert.equal(ran[0], s.events[3].kind);
    const after = fs.readFileSync(logPath, 'utf8');
    assert.ok(after.startsWith(before), 'every original byte, the fragment included, is still there');
    const seal = after.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((r) => r && r.type === 'torn-tail-sealed');
    assert.deepEqual([seal.offset, seal.bytes, seal.sha256], [peek.torn.offset, peek.torn.bytes, peek.torn.sha256]);
    const indexes = after.split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && r.type === 'event').map((r) => r.index);
    assert.deepEqual(indexes, s.events.map((e) => e.index));
    // and the sealed log reads back cleanly
    assert.equal(driver.readLog(logPath).ended, true);
  });

  describe('seals bind their exact fragment', () => {
    /**
     * A log with one sealed fragment in it, as a real crash and resume leave it.
     * @returns {Promise<{text: string, fragment: string}>} The log text and the fragment
     */
    async function sealedLog() {
      const s = apiSchedule();
      const clock = fakeClock(T0);
      await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: afterEvents(2) });
      const fragment = '{"type":"event","index":2,"kind":"api.he';
      fs.appendFileSync(logPath, fragment);
      // afterEvents counts the fragment too (it contains "type":"event"), so 4
      // here means one real event runs after the seal.
      await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: afterEvents(4) });
      return { text: fs.readFileSync(logPath, 'utf8'), fragment };
    }
    const sealOf = (text) => JSON.parse(text.split('\n').find((l) => l.includes('"torn-tail-sealed"')));
    const rewriteSeal = (text, edit) => text.split('\n').map((l) => {
      if (!l.includes('"torn-tail-sealed"')) return l;
      const r = JSON.parse(l);
      edit(r);
      return JSON.stringify(r);
    }).join('\n');

    it('accepts a genuine seal', async () => {
      await sealedLog();
      assert.equal(driver.readLog(logPath).lastIndex, 2);
    });

    const tampers = [
      ['a seal with the wrong sha256', (t) => rewriteSeal(t, (r) => { r.sha256 = '0'.repeat(64); })],
      ['a seal with the wrong length', (t) => rewriteSeal(t, (r) => { r.bytes += 1; })],
      ['a seal with the wrong offset', (t) => rewriteSeal(t, (r) => { r.offset -= 1; })],
      ['a seal with no binding at all', (t) => rewriteSeal(t, (r) => { delete r.offset; delete r.bytes; delete r.sha256; })],
      ['a fragment altered after sealing (same length)', (t, f) => t.replace(f, f.replace('api.he', 'api.xx'))],
      ['a second malformed line under one seal', (t, f) => t.replace(`${f}\n`, `${f}\n{also-broken\n`)],
      ['a stray seal with no fragment before it', (t) => { const lines = t.split('\n'); const seal = lines.find((l) => l.includes('"torn-tail-sealed"')); return t.replace(seal, `${seal}\n${seal}`); }],
      ['an empty line in the middle', (t) => t.replace('\n', '\n\n')]
    ];
    for (const [label, tamper] of tampers) {
      it(`refuses ${label}`, async () => {
        const { text, fragment } = await sealedLog();
        fs.writeFileSync(logPath, tamper(text, fragment));
        assert.throws(() => driver.readLog(logPath), (err) => err.code === 'LOG_UNREADABLE', label);
      });
    }

    it('still resumes when the crash cut off only the newline, leaving a complete, valid record', async () => {
      const s = apiSchedule();
      const clock = fakeClock(T0);
      await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: afterEvents(2) });
      // A whole event record, as the writer would have written it, minus its newline.
      fs.appendFileSync(logPath, JSON.stringify({ type: 'event', index: 2, kind: s.events[2].kind, startedAt: T0, ok: true }));
      const first = await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: afterEvents(4) });
      assert.equal(first.tornTail, true);
      // The next resume must read the sealed log, not refuse it.
      const second = await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock });
      assert.equal(second.status, 'completed');
      assert.equal(driver.readLog(logPath).ended, true);
    });

    // The two fragment kinds a crash can leave: a record cut mid-way, and a
    // complete record that lost only its newline, which parses as JSON.
    const FRAGMENTS = [
      ['a record cut mid-way', () => '{"type":"event","index":2,"kind":"api.he'],
      ['a complete record missing only its newline', (s) => JSON.stringify({ type: 'event', index: 2, kind: s.events[2].kind, startedAt: T0 + 1, ok: true })]
    ];

    /**
     * Rebuild the crashed log deterministically.
     * @param {object} s - Schedule
     * @param {string} fragment - Torn bytes
     * @returns {Promise<Buffer>} The crashed log
     */
    async function crashedLog(s, fragment) {
      if (fs.existsSync(logPath)) fs.rmSync(logPath);
      await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0), shouldStop: afterEvents(2) });
      fs.appendFileSync(logPath, fragment);
      return fs.readFileSync(logPath);
    }

    /**
     * The exact bytes sealing would append to a log.
     * @param {Buffer} log - Log bytes
     * @returns {Buffer} The seal write
     */
    function sealWriteFor(log) {
      const scratch = `${logPath}.probe`;
      fs.writeFileSync(scratch, log);
      driver.sealTornTail(scratch, driver.readLog(scratch).torn, T0 + 1);
      const out = fs.readFileSync(scratch).subarray(log.length);
      fs.rmSync(scratch);
      return out;
    }

    /**
     * Resume to completion, then check the log reads back the same way twice.
     * @param {object} s - Schedule
     * @param {string} label - For messages
     */
    async function resumesCleanly(s, label) {
      const result = await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0 + 10 * MIN) });
      assert.equal(result.status, 'completed', label);
      const once = driver.readLog(logPath);
      // Every event is on record exactly once: none lost, none duplicated,
      // whatever the crash cut. The sealed region is the only place bytes of
      // a record may sit outside the record list.
      const events = fs.readFileSync(logPath, 'utf8').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } });
      const sealedAt = new Set(events.filter((r) => r && r.type === 'torn-tail-sealed').map((r) => r.offset));
      let offset = 0;
      const counted = [];
      for (const line of fs.readFileSync(logPath, 'utf8').split('\n')) {
        let r = null;
        try { r = JSON.parse(line); } catch { r = null; }
        if (r && r.type === 'event' && !sealedAt.has(offset)) counted.push(r.index);
        offset += Buffer.byteLength(line) + 1;
      }
      assert.deepEqual([...counted].sort((a, b) => a - b), s.events.map((e) => e.index), `${label}: each event exactly once`);
      const twice = driver.readLog(logPath);
      assert.equal(once.ended, true, label);
      assert.equal(once.torn, null, `${label}: nothing left pending`);
      assert.deepEqual(twice, once, `${label}: reads back the same every time`);
    }

    for (const [kind, make] of FRAGMENTS) {
      it(`resumes whichever byte the seal's own write was cut at: ${kind}`, async () => {
        const s = apiSchedule();
        const crashed = await crashedLog(s, make(s));
        const seal = sealWriteFor(crashed);
        for (let cut = 0; cut <= seal.length; cut++) {
          fs.writeFileSync(logPath, Buffer.concat([crashed, seal.subarray(0, cut)]));
          await resumesCleanly(s, `${kind}, seal cut at byte ${cut}`);
        }
      });

      it(`resumes when a second seal is cut too: ${kind}`, async () => {
        // A crash tears the seal; the next run seals the leftovers and is
        // torn again. Sampled cut points keep the pairs to a few hundred.
        const s = apiSchedule();
        const crashed = await crashedLog(s, make(s));
        const seal1 = sealWriteFor(crashed);
        for (let c1 = 0; c1 <= seal1.length; c1 += 9) {
          const afterFirst = Buffer.concat([crashed, seal1.subarray(0, c1)]);
          fs.writeFileSync(logPath, afterFirst);
          const back = driver.readLog(logPath);
          if (!back.torn) continue; // nothing to seal a second time at this cut
          const seal2 = sealWriteFor(afterFirst);
          for (let c2 = 0; c2 <= seal2.length; c2 += 11) {
            fs.writeFileSync(logPath, Buffer.concat([afterFirst, seal2.subarray(0, c2)]));
            await resumesCleanly(s, `${kind}, seals cut at ${c1} and ${c2}`);
          }
        }
      });
    }

    it('still resumes a log that survived two crashes, each sealed to its own fragment', async () => {
      const s = apiSchedule();
      const clock = fakeClock(T0);
      await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: afterEvents(2) });
      fs.appendFileSync(logPath, '{"type":"event","index":2');
      await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: afterEvents(4) });
      fs.appendFileSync(logPath, '{"type":"eve');
      const result = await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock });
      assert.equal(result.status, 'completed');
      const seals = fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.includes('"torn-tail-sealed"'));
      assert.equal(seals.length, 2);
      assert.notEqual(sealOf(seals[0]).offset, sealOf(seals[1]).offset);
      assert.equal(driver.readLog(logPath).ended, true);
    });
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

  it('never follows a redirect on either side: live refuses, target is unchecked', async () => {
    const modes = [];
    const redirecting = (who) => async (url, init) => {
      modes.push(init.redirect);
      if (url.origin === who) return { status: 307, text: async () => '' };
      return { status: 200, text: async () => JSON.stringify(url.origin === LIVE ? same.body : other.body) };
    };
    await assert.rejects(
      driver.refuseSameInstall({ apiBase: PROXY, liveApi: LIVE, fetch: redirecting(LIVE) }),
      (err) => err.code === 'LIVE_IDENTITY_UNREADABLE' && /redirect refused \(HTTP 307\)/.test(err.details.reason)
    );
    const r = await driver.refuseSameInstall({ apiBase: PROXY, liveApi: LIVE, fetch: redirecting(PROXY) });
    assert.deepEqual([r.checked, r.reason], [false, 'target server-info: redirect refused (HTTP 307)']);
    assert.ok(modes.length === 4 && modes.every((m) => m === 'manual'));
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

describe('soak driver — the target address', () => {
  const names = { exact: new Set(['localhost', '::1', 'devbox', '192.168.1.20']), hostnamePrefix: 'devbox.' };
  const LIVE = 'http://localhost:3102';
  const lookupFrom = (table) => async (host) => {
    if (!(host in table)) { const e = new Error('nope'); e.code = 'ENOTFOUND'; throw e; }
    return table[host];
  };
  const never = async (host) => { throw new Error(`must not resolve ${host}`); };

  it('requires an IP-literal target when a live install is guarded, and never resolves the target', async () => {
    // DNS rebinding: a name that resolves elsewhere when checked and to
    // 127.0.0.1 when connected to. The target is never looked up at all, so
    // there is no check-to-connect window for it to exploit.
    let answers = 0;
    const rebinding = async () => (answers++ === 0 ? ['10.9.9.9'] : ['127.0.0.1']);
    for (const target of ['http://guest.example:3102', 'http://sneaky.example:3102', 'http://localhost:3202']) {
      await assert.rejects(
        driver.refuseLiveAddress({ apiBase: target, liveApi: LIVE, names, lookup: rebinding }),
        (err) => err.code === 'TARGET_NOT_IP_LITERAL',
        target
      );
    }
    assert.equal(answers, 0, 'the target name was never resolved');
  });

  it('refuses an IP-literal target that is this machine on the live port, in any spelling', async () => {
    for (const target of ['http://127.0.0.1:3102', 'http://[::1]:3102', 'http://[::ffff:127.0.0.1]:3102', 'http://192.168.1.20:3102', 'http://2130706433:3102', 'http://0.0.0.0:3102']) {
      await assert.rejects(
        driver.refuseLiveAddress({ apiBase: target, liveApi: LIVE, names, lookup: never }),
        (err) => err.code === 'LIVE_INSTALL_TARGET',
        target
      );
    }
  });

  it('allows a guest IP, and a local IP on another port, and reports what it checked', async () => {
    assert.deepEqual(await driver.refuseLiveAddress({ apiBase: 'http://192.168.64.7:3102', liveApi: LIVE, names, lookup: never }), { targetAddress: '192.168.64.7', liveLocal: true });
    assert.deepEqual(await driver.refuseLiveAddress({ apiBase: 'http://127.0.0.1:3202', liveApi: LIVE, names, lookup: never }), { targetAddress: '127.0.0.1', liveLocal: true });
  });

  it('does not apply without a live install, the soak guest\'s case', async () => {
    assert.equal(await driver.refuseLiveAddress({ apiBase: 'http://localhost:3102', liveApi: undefined, names, lookup: never }), null);
  });

  it('refuses 127.0.0.1 on the live port when TANGLECLAW_API names this machine by another name', async () => {
    // e.g. a Tailscale name that is not the hostname and so fails every spelling rule.
    const live = 'http://tc-box.tail123678.ts.net:3102';
    const lookup = lookupFrom({ 'tc-box.tail123678.ts.net': ['192.168.1.20'] });
    driver.refuseLiveTarget('http://127.0.0.1:3102', live, names); // the spelling check cannot know
    await assert.rejects(
      driver.refuseLiveAddress({ apiBase: 'http://127.0.0.1:3102', liveApi: live, names, lookup }),
      (err) => err.code === 'LIVE_INSTALL_TARGET'
    );
  });

  it('treats a live name that does not resolve as this machine, the protective answer', async () => {
    await assert.rejects(
      driver.refuseLiveAddress({ apiBase: 'http://127.0.0.1:3102', liveApi: 'http://gone.example:3102', names, lookup: lookupFrom({}) }),
      (err) => err.code === 'LIVE_INSTALL_TARGET'
    );
  });

  it('allows a local target when the live install resolves to another machine', async () => {
    const r = await driver.refuseLiveAddress({ apiBase: 'http://127.0.0.1:3102', liveApi: 'http://far.example:3102', names, lookup: lookupFrom({ 'far.example': ['10.0.0.9'] }) });
    assert.deepEqual(r, { targetAddress: '127.0.0.1', liveLocal: false });
  });

  it('knows the real loopback addresses of this machine', async () => {
    await assert.rejects(driver.refuseLiveAddress({ apiBase: 'http://127.0.0.1:3102', liveApi: LIVE }), (err) => err.code === 'LIVE_INSTALL_TARGET');
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
    await driver.runSchedule({ schedule: s, executors: allOk(s), ctx: {}, logPath, clock, shouldStop: afterEvents(1) });
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
    await driver.runSchedule({ schedule: s, executors: allOk(s), ctx: {}, logPath, clock, shouldStop: () => true });
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
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, shouldStop: afterEvents(1) });
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

describe('soak driver — stopping and record integrity', () => {
  it('honours a stop during a long deferred-fault wait within one poll, not after the whole window', async () => {
    const s = sched.buildSchedule({ seed: 'pace', phase: 'certifying', durationMs: 12 * 60 * MIN, loadMeanMs: 5 * MIN, faultMeanMs: 60 * MIN, faultQuietMs: 30 * MIN, classes: ['api', 'fault'] });
    const executors = {};
    for (const k of new Set(s.events.map((e) => e.kind))) executors[k] = async () => ({ ok: true, code: 'OK' });
    const clock = fakeClock(T0);
    let asked = null;
    const result = await driver.runSchedule({
      schedule: s, executors, ctx: {}, logPath, clock, stopPollMs: 1000,
      // Ask to stop 5 s into the first wait that is longer than a minute.
      shouldStop: () => {
        const last = clock.sleeps[clock.sleeps.length - 1];
        if (asked === null && clock.sleeps.length > 0 && last === 1000) asked = clock.now();
        return asked !== null && clock.now() >= asked + 5000;
      }
    });
    assert.equal(result.status, 'stopped');
    assert.ok(clock.now() - asked <= 5000 + 1000, 'stopped within one poll of the request');
  });

  it('never lets an override key overwrite the header or resume record fields', async () => {
    const s = apiSchedule();
    const clock = fakeClock(T0);
    const headerExtra = { type: 'end', schema: 'x', startEpochMs: 1, scheduleDigest: 'x', resumedFrom: -1, guardContextOverride: 'no-live-install' };
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, headerExtra, shouldStop: afterEvents(1) });
    await driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock, headerExtra });
    const recs = records(logPath);
    assert.deepEqual([recs[0].type, recs[0].schema, recs[0].startEpochMs, recs[0].scheduleDigest], ['header', driver.LOG_SCHEMA, T0, s.digest]);
    const resume = recs.find((r) => r.type === 'resume');
    assert.equal(resume.resumedFrom, 1);
    assert.equal(resume.guardContextOverride, 'no-live-install');
    assert.equal(recs[recs.length - 1].type, 'end');
  });

  it('never lets an executor overwrite the fields resume depends on', async () => {
    const s = apiSchedule();
    const executors = recordingExecutors([]);
    for (const k of Object.keys(executors)) executors[k] = async () => ({ ok: true, code: 'OK', type: 'end', index: 999, kind: 'x', startedAt: 1 });
    await driver.runSchedule({ schedule: s, executors, ctx: {}, logPath, clock: fakeClock(T0) });
    const ev = records(logPath).filter((r) => r.type === 'event');
    assert.deepEqual(ev.map((r) => r.index), s.events.map((e) => e.index));
    assert.ok(ev.every((r) => r.kind === s.events[r.index].kind && r.startedAt > T0));
  });

  it('uses the validated quiet window, never a value read raw from the file', async () => {
    const s = sched.buildSchedule({ seed: 'pace', phase: 'certifying', durationMs: 12 * 60 * MIN, loadMeanMs: 5 * MIN, faultMeanMs: 60 * MIN, faultQuietMs: 30 * MIN, classes: ['api', 'fault'] });
    const tampered = JSON.parse(JSON.stringify(s));
    delete tampered.params.faultQuietMs;
    tampered.digest = sched.scheduleDigest(tampered);
    const executors = {};
    for (const k of new Set(s.events.map((e) => e.kind))) executors[k] = async () => ({ ok: true });
    await assert.rejects(
      driver.runSchedule({ schedule: tampered, executors, ctx: {}, logPath, clock: fakeClock(T0) }),
      (err) => err.code === 'INVALID_SCHEDULE'
    );
  });
});

describe('soak driver — writing every byte', () => {
  it('keeps writing until a partial write has written everything', () => {
    const got = [];
    const partial = (fd, buf, off, len) => { const n = Math.min(3, len); got.push(buf.subarray(off, off + n).toString()); return n; };
    driver.writeAll(7, Buffer.from('abcdefgh'), partial);
    assert.equal(got.join(''), 'abcdefgh');
  });

  it('throws, instead of leaving a partial record, when a write makes no progress', () => {
    let calls = 0;
    const stuck = (fd, buf, off, len) => (calls++ === 0 ? Math.min(2, len) : 0);
    assert.throws(() => driver.writeAll(7, Buffer.from('abcdefgh'), stuck), (err) => err.code === 'ESHORTWRITE' && /2 of 8/.test(err.message));
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

  it('lets exactly one of many concurrent processes reclaim a stale lock: never two holders at once', async () => {
    const { spawn, spawnSync } = require('node:child_process');
    // A pid that is certainly dead: a process that has already exited.
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;
    fs.writeFileSync(`${logPath}.lock`, JSON.stringify({ pid: dead, host: os.hostname() }));
    const child = `
      const driver = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'soak', 'driver.js'))});
      try {
        // Every contender waits here after finding the lock stale, so they
        // all reach the reclaim together: the window a naive reclaim loses in.
        const hold = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
        const lock = driver.acquireLogLock(${JSON.stringify(logPath)}, { afterStaleCheck: hold });
        const t0 = Date.now();
        setTimeout(() => { const t1 = Date.now(); lock.release(); console.log(JSON.stringify({ won: true, t0, t1, reclaimed: lock.reclaimed !== null })); }, 1500);
      } catch (err) {
        console.log(JSON.stringify({ won: false, code: err.code }));
      }`;
    const runs = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve) => {
      const c = spawn(process.execPath, ['-e', child]);
      let out = '';
      c.stdout.on('data', (d) => { out += d; });
      c.on('close', () => resolve(JSON.parse(out.trim())));
    })));
    const winners = runs.filter((r) => r.won).sort((a, b) => a.t0 - b.t0);
    assert.ok(winners.length >= 1, 'someone takes the lock');
    for (let i = 1; i < winners.length; i++) assert.ok(winners[i].t0 >= winners[i - 1].t1, 'no two holders overlap');
    assert.equal(winners.filter((w) => w.reclaimed).length, 1, 'the stale lock is reclaimed exactly once');
    assert.ok(runs.filter((r) => !r.won).every((r) => r.code === 'LOG_LOCKED'));
    assert.equal(fs.existsSync(`${logPath}.lock.reclaim`), false, 'the reclaim mutex is gone');
  });

  it('refuses while another process is mid-reclaim, naming the mutex', () => {
    fs.writeFileSync(`${logPath}.lock`, JSON.stringify({ pid: 999999, host: os.hostname() }));
    fs.mkdirSync(`${logPath}.lock.reclaim`);
    assert.throws(() => driver.acquireLogLock(logPath, { isAlive: () => false }), (err) => err.code === 'LOG_LOCKED' && /reclaiming/.test(err.details.why));
    assert.ok(fs.existsSync(`${logPath}.lock`), 'the stale lock was left alone');
  });

  it('does not reclaim a lock that changed hands between the first read and the mutex', () => {
    fs.writeFileSync(`${logPath}.lock`, JSON.stringify({ pid: 999999, host: os.hostname() }));
    let checks = 0;
    // isAlive runs after the first read; swap the holder at that moment, as a
    // faster reclaimer would.
    const isAlive = () => {
      if (checks++ === 0) fs.writeFileSync(`${logPath}.lock`, JSON.stringify({ pid: 424242, host: os.hostname() }));
      return false;
    };
    assert.throws(() => driver.acquireLogLock(logPath, { isAlive }), (err) => err.code === 'LOG_LOCKED' && /changed hands/.test(err.details.why));
    assert.equal(JSON.parse(fs.readFileSync(`${logPath}.lock`, 'utf8')).pid, 424242, 'the new holder keeps its lock');
    assert.equal(fs.existsSync(`${logPath}.lock.reclaim`), false);
  });

  it('release tells ownership loss apart from a lock it still owns but cannot remove, and never throws', () => {
    const lock = driver.acquireLogLock(logPath);
    fs.writeFileSync(`${logPath}.lock`, JSON.stringify({ pid: 1, host: 'someone-else' }));
    const taken = lock.release();
    assert.ok(fs.existsSync(`${logPath}.lock`), 'another holder\'s lock survives our release');
    assert.deepEqual([taken.lost.why, taken.lost.holder, taken.releaseFailed], ['lock taken over during the run', { pid: 1, host: 'someone-else' }, null]);
    fs.rmSync(`${logPath}.lock`);

    const gone = driver.acquireLogLock(logPath);
    fs.rmSync(`${logPath}.lock`);
    assert.equal(gone.release().lost.why, 'lock file removed during the run');

    const io = (what) => ({
      readFileSync: (p, enc) => { if (what === 'read') { const e = new Error('io'); e.code = 'EIO'; throw e; } return fs.readFileSync(p, enc); },
      rmSync: (p, o) => { if (what === 'rm') { const e = new Error('perm'); e.code = 'EPERM'; throw e; } return fs.rmSync(p, o); }
    });
    const unreadable = driver.acquireLogLock(logPath, { releaseFs: io('read') });
    assert.equal(unreadable.release().lost.why, 'lock unreadable (EIO)', 'ownership that cannot be verified is lost');
    fs.rmSync(`${logPath}.lock`);
    const stuck = driver.acquireLogLock(logPath, { releaseFs: io('rm') });
    const r = stuck.release();
    assert.equal(r.lost, null, 'a lock we still own was not lost');
    assert.match(r.releaseFailed.why, /could not be removed \(EPERM\)/);
  });

  describe('a lock lost during a run', () => {
    const lockFile = () => `${logPath}.lock`;
    const takeOver = () => fs.writeFileSync(lockFile(), JSON.stringify({ pid: 4242, host: 'intruder' }));
    const logLines = () => fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

    it('stops the moment an event finds the lock taken over: that event and end are never written, and a bound sidecar is', async () => {
      const s = apiSchedule();
      // Take the lock over inside the SECOND executor call, whatever its kind.
      const executors = {};
      let calls = 0;
      for (const [kind, fn] of Object.entries(recordingExecutors([]))) {
        executors[kind] = async (...a) => { if (++calls === 2) takeOver(); return fn(...a); };
      }
      await assert.rejects(
        driver.runSchedule({ schedule: s, executors, ctx: {}, logPath, clock: fakeClock(T0) }),
        (err) => err.code === 'LOCK_LOST' && err.details.observed.host === 'intruder' && err.details.expected.pid === process.pid
      );
      const recs = logLines();
      assert.ok(!recs.some((r) => r.type === 'end'), 'no end');
      assert.deepEqual(recs.filter((r) => r.type === 'event').map((r) => r.index), [0], 'the first event is on record; the one in flight at the loss is not');
      assert.ok(!recs.some((r) => r.type === 'lock-lost'), 'nothing about the loss goes into the shared log');
      const side = JSON.parse(fs.readFileSync(driver.lockLostPath(logPath), 'utf8'));
      const bytes = fs.readFileSync(logPath);
      assert.deepEqual([side.logPath, side.logBytes, side.logSha256], [path.resolve(logPath), bytes.length, require('node:crypto').createHash('sha256').update(bytes).digest('hex')]);
      assert.deepEqual(side.observed, { pid: 4242, host: 'intruder' });
      assert.equal(fs.readFileSync(lockFile(), 'utf8'), JSON.stringify({ pid: 4242, host: 'intruder' }), 'the other holder\'s lock is left alone');
    });

    it('checks ownership immediately before end: a loss after the last event leaves no end record', async () => {
      const s = apiSchedule();
      const base = fakeClock(T0);
      let taken = false;
      // The end record reads the clock just before it is written; take the
      // lock over at that exact moment, after every event is on record.
      const clock = {
        ...base,
        now: () => {
          if (!taken && fs.existsSync(logPath) && logLines().filter((r) => r.type === 'event').length === s.events.length) { taken = true; takeOver(); }
          return base.now();
        }
      };
      await assert.rejects(driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock }), (err) => err.code === 'LOCK_LOST');
      const recs = logLines();
      assert.equal(recs.filter((r) => r.type === 'event').length, s.events.length, 'every event was written while the lock was held');
      assert.ok(!recs.some((r) => r.type === 'end'), 'but no end');
      assert.ok(fs.existsSync(driver.lockLostPath(logPath)));
    });

    it('refuses to read, resume or rerun the log while the sidecar exists: never already-complete', async () => {
      const s = apiSchedule();
      const executors = recordingExecutors([]);
      const k = s.events[0].kind;
      const inner = executors[k];
      let fired = false;
      executors[k] = async (...a) => { if (!fired) { fired = true; fs.rmSync(lockFile()); } return inner(...a); };
      await assert.rejects(driver.runSchedule({ schedule: s, executors, ctx: {}, logPath, clock: fakeClock(T0) }), (err) => err.code === 'LOCK_LOST');
      assert.throws(() => driver.readLog(logPath), (err) => err.code === 'LOG_LOCK_LOST');
      const ran = [];
      await assert.rejects(
        driver.runSchedule({ schedule: s, executors: recordingExecutors(ran), ctx: {}, logPath, clock: fakeClock(T0) }),
        (err) => err.code === 'LOG_LOCK_LOST'
      );
      assert.equal(ran.length, 0, 'the rerun ran nothing');
      assert.equal(fs.existsSync(lockFile()), false, 'the refused rerun did not even take the lock');
    });

    const tampers = [
      ['a sidecar whose sha256 was altered', (side) => { side.logSha256 = '0'.repeat(64); }],
      ['a sidecar naming another log', (side) => { side.logPath = '/tmp/some-other.ndjson'; }],
      ['a sidecar claiming more bytes than the log has', (side) => { side.logBytes += 10; }],
      ['a malformed sidecar', () => 'not json'],
      ['a sidecar of the wrong type', (side) => { side.type = 'lock-reclaimed'; }]
    ];
    for (const [label, edit] of tampers) {
      it(`still refuses, as invalid, ${label}`, async () => {
        const s = apiSchedule();
        const executors = recordingExecutors([]);
        const k = s.events[0].kind;
        const inner = executors[k];
        let fired = false;
        executors[k] = async (...a) => { if (!fired) { fired = true; takeOver(); } return inner(...a); };
        await assert.rejects(driver.runSchedule({ schedule: s, executors, ctx: {}, logPath, clock: fakeClock(T0) }));
        const sp = driver.lockLostPath(logPath);
        const side = JSON.parse(fs.readFileSync(sp, 'utf8'));
        const out = edit(side);
        fs.writeFileSync(sp, typeof out === 'string' ? out : JSON.stringify(side));
        assert.throws(() => driver.readLog(logPath), (err) => err.code === 'LOG_LOCK_LOST_INVALID', label);
        fs.rmSync(lockFile(), { force: true });
        await assert.rejects(driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0) }), (err) => err.code === 'LOG_LOCK_LOST_INVALID');
      });
    }

    it('refuses, as invalid, a log cut back after the loss was recorded', async () => {
      const s = apiSchedule();
      const executors = recordingExecutors([]);
      const k = s.events[1].kind;
      const inner = executors[k];
      let fired = false;
      executors[k] = async (...a) => { if (!fired) { fired = true; takeOver(); } return inner(...a); };
      await assert.rejects(driver.runSchedule({ schedule: s, executors, ctx: {}, logPath, clock: fakeClock(T0) }));
      const bytes = fs.readFileSync(logPath);
      fs.writeFileSync(logPath, bytes.subarray(0, bytes.length - 5));
      assert.throws(() => driver.readLog(logPath), (err) => err.code === 'LOG_LOCK_LOST_INVALID');
    });

    it('reports LOCK_LOST_UNRECORDED, and still writes no end, when the sidecar cannot be created', async () => {
      const s = apiSchedule();
      const executors = recordingExecutors([]);
      const k = s.events[0].kind;
      const inner = executors[k];
      let fired = false;
      executors[k] = async (...a) => {
        if (!fired) { fired = true; takeOver(); fs.chmodSync(dir, 0o500); }
        return inner(...a);
      };
      try {
        await assert.rejects(
          driver.runSchedule({ schedule: s, executors, ctx: {}, logPath, clock: fakeClock(T0) }),
          (err) => err.code === 'LOCK_LOST_UNRECORDED' && err.details.sidecar === null && /EACCES/.test(err.details.sidecarError)
        );
      } finally {
        fs.chmodSync(dir, 0o700);
      }
      assert.ok(!logLines().some((r) => r.type === 'end'));
      assert.equal(fs.existsSync(driver.lockLostPath(logPath)), false);
    });

    it('keeps the run\'s own error first when the lock is also lost, with the recorded loss attached', async () => {
      const boom = new Error('primary failure');
      let calls = 0;
      await assert.rejects(
        driver.runSchedule({
          schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0),
          shouldStop: () => { if (++calls === 3) { takeOver(); throw boom; } return false; }
        }),
        (err) => err === boom && err.lockLost.observed.host === 'intruder' && err.lockLost.sidecar === driver.lockLostPath(logPath)
      );
      assert.ok(fs.existsSync(driver.lockLostPath(logPath)), 'the loss is on record even though another error came first');
    });

    it('keeps the run\'s own error first when the lock is unreadable at release', async () => {
      const boom = new Error('primary failure');
      const ioFail = { readFileSync: () => { const e = new Error('io'); e.code = 'EIO'; throw e; }, rmSync: fs.rmSync };
      let calls = 0;
      await assert.rejects(
        driver.runSchedule({
          schedule: apiSchedule(), executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0), lockDeps: { releaseFs: ioFail },
          shouldStop: () => { if (++calls === 3) throw boom; return false; }
        }),
        (err) => err === boom && /lock unreadable \(EIO\)/.test(err.lockLost.why)
      );
    });
  });

  it('reports LOCK_RELEASE_FAILED, not a loss, when a clean run cannot remove the lock it still owns', async () => {
    const s = apiSchedule();
    const perm = { readFileSync: fs.readFileSync, rmSync: () => { const e = new Error('perm'); e.code = 'EPERM'; throw e; } };
    await assert.rejects(
      driver.runSchedule({ schedule: s, executors: recordingExecutors([]), ctx: {}, logPath, clock: fakeClock(T0), lockDeps: { releaseFs: perm } }),
      (err) => err.code === 'LOCK_RELEASE_FAILED' && err.details.result.status === 'completed'
    );
    assert.equal(fs.existsSync(driver.lockLostPath(logPath)), false, 'no sidecar: the lock was never lost');
    fs.rmSync(`${logPath}.lock`);
    assert.equal(driver.readLog(logPath).ended, true, 'the log is intact and complete');
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
