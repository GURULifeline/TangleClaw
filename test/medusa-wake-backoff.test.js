'use strict';

/*
 * Slow-pane backoff in the wake monitor (#2086).
 *
 * A pane whose read was slow is left alone for a growing interval
 * (`pane-read-backoff`), and one ordinary read clears it. The hold comes
 * before the pane is read and judges nothing, so it can only delay a nudge.
 * A tick that did not look at a pane is not an observation of it: the idle
 * streak ends, and a nudge needs two fresh at-rest observations.
 *
 * These drive the synchronous seams, where a read's cost is exact on the
 * synthetic fleet's virtual clock. `test/medusa-wake-async.test.js` covers the
 * same rule on the timer's non-blocking path.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');
const { useThrowawayStore } = require('./_engine-store');

setLevel('error');

const _store = useThrowawayStore('medusa-wake-backoff');
after(() => _store.cleanup());

const wake = require('../lib/medusa-wake');
const matrix = require('./helpers/medusa-wake-matrix');

const HUNG_MS = 5000;

/**
 * Install a fleet, run `fn` against it, and always restore the monitor.
 * @template T
 * @param {object[]} fleet - `matrix.buildFleet` output, or hand-built sessions
 * @param {object} opts - `matrix.install` options
 * @param {(world: object) => T} fn - The test body
 * @returns {T}
 */
function withFleet(fleet, opts, fn) {
  const world = matrix.install(fleet, opts);
  try {
    return fn(world);
  } finally {
    world.restore();
  }
}

/**
 * How many times one session's pane was read.
 * @param {object} world - The installed world
 * @param {number} sessionId - The session
 * @returns {number}
 */
const readsOf = (world, sessionId) => world.paneReads.filter((r) => r.sessionId === sessionId).length;

describe('pane backoff — a hung pane is read once per backoff, not once per tick (#2086)', () => {
  it('after one slow read the pane is left alone, and the ticks that follow are ordinary again', () => {
    const fleet = matrix.buildFleet({ size: 30, lead: ['slow'] });
    withFleet(fleet, {}, (world) => {
      const ticks = matrix.runTicks(world, 3);
      assert.equal(readsOf(world, fleet[0].record.id), 1, 'the hung pane was read on the first tick only');
      assert.ok(ticks[0].durationMs >= HUNG_MS);
      assert.ok(ticks[1].durationMs < HUNG_MS, `second tick took ${ticks[1].durationMs} ms`);
      assert.ok(ticks[2].durationMs < HUNG_MS, `third tick took ${ticks[2].durationMs} ms`);
      assert.equal(wake.tickMetrics().last.order.find((o) => o.id === fleet[0].record.id).result, 'pane-read-backoff');
    });
  });

  it('the backoff grows with each slow read in a row and stops growing at its last step', () => {
    const hung = matrix.makeSession(1, 'slow');
    withFleet([hung], {}, (world) => {
      matrix.runTicks(world, 60);
      const at = world.paneReads.map((r) => r.at);
      assert.ok(at.length >= 5, `the pane was retried ${at.length} times`);
      const gaps = at.slice(1).map((t, i) => t - at[i]);
      gaps.forEach((gap, i) => {
        const step = wake.PANE_BACKOFF_MS[Math.min(i, wake.PANE_BACKOFF_MS.length - 1)];
        // A read ends one timeout after it starts, and the backoff runs from there.
        assert.ok(gap >= HUNG_MS + step, `retry ${i + 1} came ${gap} ms after the last, under ${HUNG_MS + step}`);
        assert.ok(gap < HUNG_MS + step + 2 * matrix.INTERVAL_MS, `retry ${i + 1} came ${gap} ms after the last, well past its backoff`);
      });
    });
  });

  it('one ordinary read clears the backoff, and the recipient is then nudged once like any other', () => {
    const recovering = matrix.makeSession(1, 'slow', { slowReads: 1 });
    withFleet([recovering], {}, (world) => {
      matrix.runTicks(world, 12);
      assert.equal(world.injected.filter((n) => n.sessionId === 1).length, 1);
      // One slow read, then exactly the two at-rest observations the debounce asks for.
      const before = world.paneReads.filter((r) => r.at < world.injected[0].at).length;
      assert.equal(before, 1 + wake.IDLE_TICKS_REQUIRED);
    });
  });

  it('a pane that recovers and then hangs again starts its backoff from the first step', () => {
    const flaky = matrix.makeSession(1, 'busy');
    flaky.slowReadsLeft = 1;
    withFleet([flaky], {}, (world) => {
      // One slow read, then ticks until an ordinary one lands.
      while (world.paneReads.length < 2) matrix.runTicks(world, 1);
      flaky.slowReadsLeft = 1;
      while (world.paneReads.length < 3) matrix.runTicks(world, 1);
      const hungAgainAt = world.paneReads[2].at;
      while (world.paneReads.length < 4) matrix.runTicks(world, 1);
      const gap = world.paneReads[3].at - hungAgainAt;
      assert.ok(gap >= HUNG_MS + wake.PANE_BACKOFF_MS[0], `retried after ${gap} ms`);
      assert.ok(gap < HUNG_MS + wake.PANE_BACKOFF_MS[1], `retried after ${gap} ms, which is the second step, not the first`);
    });
  });

  it('a session in backoff is never typed into', () => {
    const hung = matrix.makeSession(1, 'slow');
    withFleet([hung], {}, (world) => {
      matrix.runTicks(world, 30);
      assert.equal(world.injected.length, 0);
    });
  });
});

describe('pane backoff — a backed-off tick is not an observation of the pane (#2086)', () => {
  it('a pane seen at rest, then backed off after a slow read, needs two fresh consecutive observations', () => {
    const only = matrix.makeSession(1, 'idle-mail');
    withFleet([only], {}, (world) => {
      matrix.runTicks(world, 1);
      assert.equal(readsOf(world, 1), 1);
      only.slowReadsLeft = 1;
      let ticks = 0;
      while (ticks < 12 && world.injected.length === 0) { matrix.runTicks(world, 1); ticks += 1; }
      assert.equal(world.injected.length, 1);
      const reads = world.paneReads.filter((r) => r.at < world.injected[0].at);
      // At rest, hung, then two ordinary reads one tick apart.
      assert.equal(reads.length, 4);
      assert.ok(reads[3].at - reads[2].at <= matrix.INTERVAL_MS + 10);
      assert.ok(reads[2].at - reads[1].at >= HUNG_MS + wake.PANE_BACKOFF_MS[0]);
    });
  });

  it('a slow read that still answers counts as no observation once the pane is backed off', () => {
    const only = matrix.makeSession(1, 'idle-mail');
    only.slowAnswersLeft = 1;
    withFleet([only], { slowMs: wake.SLOW_PANE_READ_MS }, (world) => {
      let ticks = 0;
      while (ticks < 12 && world.injected.length === 0) { matrix.runTicks(world, 1); ticks += 1; }
      assert.equal(world.injected.length, 1);
      const reads = world.paneReads.filter((r) => r.at < world.injected[0].at);
      // The slow answer showed the pane at rest, and it still takes two more.
      assert.equal(reads.length, 1 + wake.IDLE_TICKS_REQUIRED);
      assert.ok(reads[2].at - reads[1].at <= matrix.INTERVAL_MS + 10);
    });
  });

  it('a pane that moved while it was backed off is seen as writing, not at rest', () => {
    const only = matrix.makeSession(1, 'idle-mail');
    withFleet([only], {}, (world) => {
      matrix.runTicks(world, 1);
      only.slowReadsLeft = 1;
      matrix.runTicks(world, 1);
      // While it was backed off, the transcript gained a line.
      only.pane = ['a line of new output', ...only.pane];
      let ticks = 0;
      while (ticks < 8 && readsOf(world, 1) < 3) { matrix.runTicks(world, 1); ticks += 1; }
      assert.equal(wake.tickMetrics().last.order.find((o) => o.id === 1).result, 'pane-writing');
      assert.equal(world.injected.length, 0);
    });
  });
});

describe('pane backoff — what the hold is, and is not (#2086)', () => {
  it('the verdict has a meaning a sender can be shown', () => {
    assert.match(wake.peerReasonMeaning('pane-read-backoff'), /slow/);
  });

  it('a clock that cannot be read never backs a pane off: it is read every tick, as before', () => {
    const fleet = matrix.buildFleet({ size: 5, lead: ['slow'] });
    withFleet(fleet, { clock: () => { throw new Error('no clock'); } }, (world) => {
      matrix.runTicks(world, 3);
      assert.equal(readsOf(world, fleet[0].record.id), 3);
      assert.equal(world.injected.filter((n) => n.sessionId === fleet[4].record.id).length, 1);
      assert.equal(world.injected.length, 1);
    });
  });

  it('stop() forgets backoffs', () => {
    const fleet = matrix.buildFleet({ size: 3, lead: ['slow'] });
    withFleet(fleet, {}, (world) => {
      matrix.runTicks(world, 1);
      assert.equal(readsOf(world, fleet[0].record.id), 1);
      wake.stop();
      matrix.runTicks(world, 1);
      assert.equal(readsOf(world, fleet[0].record.id), 2);
    });
  });

  for (const engine of ['claude', 'antigravity']) {
    it(`${engine}: a mixed fleet behind a hung pane nudges the one eligible recipient and no other`, () => {
      const cell = matrix.runCell({ size: 10, engine, lead: ['slow'] });
      assert.equal(cell.nudgesToEligible, 1);
      assert.equal(cell.nudgesToOthers, 0);
    });

  }
});
