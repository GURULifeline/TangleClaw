'use strict';

/*
 * The wake monitor against a synthetic fleet (#2086).
 *
 * These are the properties that must hold at every fleet size, whatever the
 * scheduling around the gates becomes: each session state gets its own
 * verdict, exactly one nudge reaches the one eligible recipient, nothing is
 * typed into any other pane, a slow or failing session scanned first does not
 * cost a later recipient its wake, and a restart does not repeat a nudge the
 * durable record already holds.
 *
 * How LONG each of those takes is a measurement, not a contract, and is
 * printed by `scripts/medusa-wake-matrix.js`. Nothing here pins a latency.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');
const { useThrowawayStore } = require('./_engine-store');

setLevel('error');

// The wake profiles come from the engine profiles the store holds.
const _store = useThrowawayStore('medusa-wake-matrix');
after(() => _store.cleanup());

const wake = require('../lib/medusa-wake');
const matrix = require('./helpers/medusa-wake-matrix');

/** The verdict the monitor gives each synthetic state today. */
const VERDICT = Object.freeze({
  'no-mail': 'no-mail',
  busy: 'pane-turn-in-flight',
  draft: 'pane-no-prompt',
  unprofiled: 'unprofiled-engine',
  'listener-off': 'listener-off',
  ended: 'session-ended',
  'idle-mail': 'nudged',
  slow: 'pane-capture-failed',
  // A scan that throws stamps no verdict; the tick logs it and moves on.
  throwing: null
});

describe('wake monitor — synthetic fleet matrix (#2086)', () => {
  for (const size of matrix.SIZES) {
    for (const eligibleAt of ['first', 'last']) {
      it(`${size} session(s), eligible recipient scanned ${eligibleAt}: one nudge, to it alone, and every state keeps its verdict`, () => {
        const cell = matrix.runCell({ size, eligibleAt });
        assert.equal(cell.size, size);
        assert.equal(cell.nudgesToEligible, 1);
        assert.equal(cell.nudgesToOthers, 0);
        assert.deepEqual(cell.verdicts, cell.states.map((s) => VERDICT[s]));
      });
    }
  }

  it('every filler state appears once the fleet is large enough to hold them', () => {
    const cell = matrix.runCell({ size: 10 });
    for (const state of matrix.FILLER_STATES) assert.ok(cell.states.includes(state), state);
  });

  it('a fleet where every other session holds mail in a busy or drafting pane still nudges only the eligible one', () => {
    const cell = matrix.runCell({ size: 30, fillers: ['busy', 'draft'] });
    assert.equal(cell.nudgesToEligible, 1);
    assert.equal(cell.nudgesToOthers, 0);
  });
});

describe('wake monitor — a slow or failing session scanned first (#2086)', () => {
  for (const size of [2, 5, 10, 20, 30]) {
    it(`${size} sessions: a pane read that times out first does not cost the last recipient its wake`, () => {
      const cell = matrix.runCell({ size, lead: ['slow'] });
      assert.equal(cell.states[0], 'slow');
      assert.equal(cell.nudgesToEligible, 1);
      assert.equal(cell.nudgesToOthers, 0);
      assert.notEqual(cell.wakeMs, null);
    });

    it(`${size} sessions: a scan that throws first does not cost the last recipient its wake`, () => {
      const cell = matrix.runCell({ size, lead: ['throwing'] });
      assert.equal(cell.verdicts[0], null);
      assert.equal(cell.nudgesToEligible, 1);
      assert.equal(cell.nudgesToOthers, 0);
    });
  }
});

describe('wake monitor — the tick meter observes and decides nothing (#2086)', () => {
  it('a meter whose clock throws leaves the nudges, the ledger and the verdicts exactly as they were', () => {
    const opts = { size: 10, lead: ['throwing'] };
    const metered = matrix.runCell(opts);
    const blind = matrix.runCell({ ...opts, clock: () => { throw new Error('no clock'); } });
    assert.deepEqual(blind.verdicts, metered.verdicts);
    assert.deepEqual(blind.injected, metered.injected);
    assert.deepEqual(blind.ledger, metered.ledger);
  });

  it('tickMetrics reports the last tick\'s scan order with each session\'s position and verdict', () => {
    const fleet = matrix.buildFleet({ size: 5 });
    const world = matrix.install(fleet);
    try {
      matrix.runTicks(world, 1);
      const snap = wake.tickMetrics();
      assert.equal(snap.passes, 1);
      assert.deepEqual(snap.last.order.map((o) => o.id), fleet.map((x) => x.record.id));
      assert.deepEqual(snap.last.order.map((o) => o.position), [0, 1, 2, 3, 4]);
      assert.equal(snap.last.order[1].result, 'pane-turn-in-flight');
      // The first tick starts the eligible recipient's idle streak; it is not nudged yet.
      assert.equal(snap.last.order[4].result, 'pane-at-prompt');
      assert.ok(snap.last.durationMs > 0);
      assert.equal(snap.last.lagMs, null, 'a tick driven by hand has no schedule to be late against');
    } finally {
      world.restore();
    }
  });

  it('names the slow session as the slowest item of its tick', () => {
    const fleet = matrix.buildFleet({ size: 5, lead: ['slow'] });
    const world = matrix.install(fleet, { slowMs: 5000 });
    try {
      matrix.runTicks(world, 1);
      const last = wake.tickMetrics().last;
      assert.equal(last.slowest.id, fleet[0].record.id);
      assert.ok(last.slowest.ms >= 5000);
    } finally {
      world.restore();
    }
  });

  it('stop() clears what the meter recorded', () => {
    const world = matrix.install(matrix.buildFleet({ size: 2 }));
    try {
      matrix.runTicks(world, 2);
      assert.equal(wake.tickMetrics().passes, 2);
      wake.stop();
      assert.equal(wake.tickMetrics().passes, 0);
    } finally {
      world.restore();
    }
  });
});

describe('wake monitor — restart and departure (#2086)', () => {
  it('a restart after the nudge does not repeat it while the durable attempt record is readable', () => {
    const r = matrix.runRestart();
    assert.equal(r.nudgesBefore, 1);
    assert.equal(r.duplicates, 0);
  });

  it('a recipient that leaves the roster with mail deferred is never typed into afterwards', () => {
    const r = matrix.runDeparture({ state: 'busy' });
    assert.equal(r.nudgedDeparted, 0);
  });

  it('a replacement session of the same project is nudged once, and the departed one never', () => {
    const r = matrix.runDeparture({ state: 'busy', replaced: true });
    assert.equal(r.nudgedDeparted, 0);
    assert.equal(r.nudgedReplacement, 1);
  });
});
