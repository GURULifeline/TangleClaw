'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const sched = require('../lib/soak/schedule');

const HOUR = 60 * 60 * 1000;

/**
 * A schedule with a shortened fault cadence, so a few hours carry enough
 * faults to test the phase and quiet-window rules.
 * @param {object} [over] - Option overrides
 * @returns {object} Schedule
 */
function build(over = {}) {
  return sched.buildSchedule({ seed: 'rc-5.30', phase: 'certifying', durationMs: 6 * HOUR, faultMeanMs: 5 * 60 * 1000, faultQuietMs: 2 * 60 * 1000, ...over });
}

/**
 * A deep copy with the digest recomputed, as a hand edit that also fixed the
 * digest would produce. Tests that exercise a content rule use this, so they
 * are not satisfied by DIGEST_MISMATCH alone.
 * @param {object} s - Schedule
 * @param {(c: object) => void} edit - Mutation
 * @returns {object} Edited schedule with a matching digest
 */
function edited(s, edit) {
  const c = JSON.parse(JSON.stringify(s));
  edit(c);
  c.digest = sched.scheduleDigest(c);
  return c;
}

/**
 * The violation codes of a schedule.
 * @param {object} s - Schedule
 * @returns {string[]} Codes
 */
function codes(s) {
  return sched.validateSchedule(s).map((v) => v.code);
}

describe('soak schedule — determinism', () => {
  it('produces the identical schedule and digest from the same seed and params', () => {
    const a = build();
    const b = build();
    assert.deepEqual(a, b);
    assert.equal(a.digest, b.digest);
    assert.match(a.digest, /^[0-9a-f]{64}$/);
  });

  it('produces a different schedule from a different seed', () => {
    assert.notEqual(build().digest, build({ seed: 'rc-5.30-rerun' }).digest);
  });

  it('keeps the load events unchanged when the fault class is turned off', () => {
    // The fault stream is separate, so a load-only rehearsal exercises the
    // same load the faulted run would.
    const load = (s) => s.events.filter((e) => e.class !== 'fault').map(({ atMs, kind, params }) => ({ atMs, kind, params }));
    const withFaults = build();
    const without = build({ classes: ['api', 'engine', 'browser'] });
    assert.deepEqual(load(without), load(withFaults));
    assert.equal(without.events.some((e) => e.class === 'fault'), false);
  });

  it('is stable across runs: a pinned seed keeps its pinned digest', () => {
    // Guards against an unnoticed change to the PRNG, the catalogue or the
    // canonical form, any of which would silently change what a recorded
    // seed means.
    // If this fails, the change broke every recorded seed; a deliberate change
    // needs a new schema version, not a new pin.
    const s = sched.buildSchedule({ seed: 'pin', phase: 'certifying', durationMs: HOUR });
    assert.equal(s.digest, 'c8e99aed473041cc472fe517aa86c065784ae4e07a6b61f4ebc9411d20049c61');
    assert.deepEqual(s.events[0], { index: 0, atMs: 33813, kind: 'api.ports.lease-release', class: 'api', params: { port: 5579 } });
  });

  it('mulberry32 gives the same sequence for the same seed and stays in [0, 1)', () => {
    const a = sched.mulberry32(42);
    const b = sched.mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      assert.equal(x, b());
      assert.ok(x >= 0 && x < 1);
    }
  });
});

describe('soak schedule — shape', () => {
  it('orders events by time, indexes them densely and keeps them inside the duration', () => {
    const s = build();
    s.events.forEach((e, i) => {
      assert.equal(e.index, i);
      assert.ok(e.atMs > 0 && e.atMs < s.params.durationMs);
      if (i > 0) assert.ok(e.atMs >= s.events[i - 1].atMs);
    });
  });

  it('includes only the classes asked for', () => {
    const s = build({ classes: ['api'] });
    assert.ok(s.events.length > 0);
    assert.ok(s.events.every((e) => e.class === 'api'));
  });

  it('draws event params from the configured projects and port range', () => {
    const s = build({ projects: ['only-one'], leasePortRange: [5510, 5512] });
    for (const e of s.events) {
      if (e.params.project !== undefined) assert.equal(e.params.project, 'only-one');
      if (e.kind === 'api.ports.lease-release') assert.ok(e.params.port >= 5510 && e.params.port <= 5512);
      if (e.kind === 'engine.session.cycle') assert.equal(e.params.commands, s.params.commandsPerCycle);
    }
  });

  it('spaces every fault at least the quiet window after the previous one', () => {
    const s = build();
    const faults = s.events.filter((e) => e.class === 'fault');
    assert.ok(faults.length > 3, 'the shortened cadence should yield several faults');
    for (let i = 1; i < faults.length; i++) assert.ok(faults[i].atMs - faults[i - 1].atMs >= s.params.faultQuietMs);
  });

  it('validates cleanly as generated', () => {
    assert.deepEqual(sched.validateSchedule(build()), []);
    assert.deepEqual(sched.validateSchedule(build({ phase: 'destructive' })), []);
  });

  it('summarizes counts by kind that add up to the event total', () => {
    const s = build();
    const sum = Object.values(sched.summarize(s)).reduce((a, b) => a + b, 0);
    assert.equal(sum, s.events.length);
  });
});

describe('soak schedule — the owned-ttyd restart rule', () => {
  it('never generates an owned-ttyd restart in a certifying schedule', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e']) {
      const s = build({ seed, durationMs: 24 * HOUR });
      assert.equal(s.events.some((e) => e.kind === 'fault.ttyd.restart'), false, `seed ${seed}`);
    }
  });

  it('can generate an owned-ttyd restart in a destructive schedule', () => {
    const s = build({ phase: 'destructive', durationMs: 24 * HOUR });
    assert.ok(s.events.some((e) => e.kind === 'fault.ttyd.restart'));
  });

  it('rejects a certifying schedule with a ttyd restart added by hand, even with its digest fixed', () => {
    const s = build();
    const i = s.events.findIndex((e) => e.class === 'fault');
    const bad = edited(s, (c) => { c.events[i].kind = 'fault.ttyd.restart'; c.events[i].params = {}; });
    assert.deepEqual(codes(bad), ['FAULT_NOT_PERMITTED_IN_PHASE']);
  });

  it('catalogues the ttyd restart as destructive-only', () => {
    const ttyd = sched.FAULTS.find((f) => f.kind === 'fault.ttyd.restart');
    assert.deepEqual([...ttyd.phases], ['destructive']);
  });
});

describe('soak schedule — validation of tampered or malformed schedules', () => {
  it('reports a digest mismatch when content changes and the digest does not', () => {
    const s = build();
    const c = JSON.parse(JSON.stringify(s));
    c.events[0].atMs += 1;
    assert.ok(codes(c).includes('DIGEST_MISMATCH'));
  });

  it('reports events out of order', () => {
    const s = build();
    const bad = edited(s, (c) => { c.events[2].atMs = c.events[1].atMs - 1; });
    assert.ok(codes(bad).includes('NOT_ORDERED'));
  });

  it('reports an event outside the duration', () => {
    const s = build();
    const bad = edited(s, (c) => { c.events[c.events.length - 1].atMs = c.params.durationMs; });
    assert.ok(codes(bad).includes('OUT_OF_RANGE'));
  });

  it('reports an unknown kind and a class that does not match its kind', () => {
    const s = build();
    assert.ok(codes(edited(s, (c) => { c.events[0].kind = 'api.rm-rf'; })).includes('UNKNOWN_KIND'));
    assert.ok(codes(edited(s, (c) => { c.events[0].kind = 'api.health'; c.events[0].class = 'fault'; })).includes('UNKNOWN_KIND'));
  });

  it('reports an event from a class the params exclude', () => {
    const s = build({ classes: ['api'] });
    const bad = edited(s, (c) => { c.events[0].kind = 'engine.session.cycle'; c.events[0].class = 'engine'; });
    assert.ok(codes(bad).includes('CLASS_EXCLUDED'));
  });

  it('reports two faults inside the quiet window', () => {
    const s = build();
    const faults = s.events.filter((e) => e.class === 'fault');
    const bad = edited(s, (c) => {
      const first = c.events[faults[0].index];
      const second = c.events[faults[1].index];
      second.atMs = first.atMs + 1;
      c.events.sort((x, y) => x.atMs - y.atMs);
      c.events.forEach((e, i) => { e.index = i; });
    });
    assert.ok(codes(bad).includes('FAULT_IN_QUIET_WINDOW'));
  });

  it('reports a broken index sequence', () => {
    const s = build();
    assert.ok(codes(edited(s, (c) => { c.events[3].index = 99; })).includes('INDEX'));
  });

  it('reports a wrong schema, bad params and a missing event list', () => {
    const s = build();
    assert.deepEqual(codes({ ...s, schema: 'other/v9' }), ['SCHEMA']);
    assert.deepEqual(codes(null), ['SCHEMA']);
    assert.deepEqual(codes(edited(s, (c) => { c.params.phase = 'party'; })), ['PARAMS']);
    assert.deepEqual(codes(edited(s, (c) => { c.events = 'none'; })), ['SCHEMA']);
  });
});

describe('soak schedule — parameter checks', () => {
  const base = { seed: 's', phase: 'certifying', durationMs: HOUR };
  const bad = [
    ['an empty seed', { seed: '' }],
    ['an unknown phase', { phase: 'soak' }],
    ['a zero duration', { durationMs: 0 }],
    ['a duration over the ceiling', { durationMs: sched.MAX_DURATION_MS + 1 }],
    ['a fractional duration', { durationMs: 1.5 }],
    ['a zero load mean', { loadMeanMs: 0 }],
    ['a negative quiet window', { faultQuietMs: -1 }],
    ['no projects', { projects: [] }],
    ['a privileged port range', { leasePortRange: [80, 90] }],
    ['an inverted port range', { leasePortRange: [5600, 5500] }],
    ['an unknown class', { classes: ['api', 'cosmic-ray'] }],
    ['a repeated class', { classes: ['api', 'api'] }],
    ['faults with no load', { classes: ['fault'] }]
  ];
  for (const [label, over] of bad) {
    it(`refuses ${label}`, () => {
      assert.throws(() => sched.buildSchedule({ ...base, ...over }), (err) => err.code === 'PARAMS');
    });
  }

  it('records the defaults it used in the params, so the digest covers them', () => {
    const s = sched.buildSchedule(base);
    assert.equal(s.params.loadMeanMs, sched.DEFAULTS.loadMeanMs);
    assert.deepEqual(s.params.projects, [...sched.DEFAULTS.projects]);
    assert.deepEqual(s.params.classes, [...sched.CLASSES]);
  });

  it('stores classes in canonical order whatever order they were given in', () => {
    const a = sched.buildSchedule({ ...base, classes: ['engine', 'api'] });
    const b = sched.buildSchedule({ ...base, classes: ['api', 'engine'] });
    assert.equal(a.digest, b.digest);
  });
});
