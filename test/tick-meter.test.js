'use strict';

/*
 * The pass meter (#2086): it records what a timer-driven pass cost and never
 * changes what the pass does.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createTickMeter, percentile, summarize } = require('../lib/tick-meter');

/**
 * A meter on a clock the test moves.
 * @param {object} [opts] - `createTickMeter` options
 * @returns {{meter: object, at: (ms: number) => void, advance: (ms: number) => void}}
 */
function metered(opts = {}) {
  let now = 0;
  const meter = createTickMeter({ clock: () => now, ...opts });
  return { meter, at: (ms) => { now = ms; }, advance: (ms) => { now += ms; } };
}

describe('tick meter — what it records', () => {
  it('records each item\'s position, duration and string result, in order', () => {
    const { meter, advance } = metered();
    const pass = meter.begin();
    assert.equal(pass.item('a', () => { advance(3); return 'no-mail'; }), 'no-mail');
    assert.equal(pass.item('b', () => { advance(40); return 'nudged'; }), 'nudged');
    pass.end();
    const last = meter.snapshot().last;
    assert.deepEqual(last.order, [
      { id: 'a', position: 0, ms: 3, result: 'no-mail', threw: false },
      { id: 'b', position: 1, ms: 40, result: 'nudged', threw: false }
    ]);
    assert.equal(last.durationMs, 43);
    assert.deepEqual(last.slowest, { id: 'b', position: 1, ms: 40 });
    assert.equal(last.items, 2);
  });

  it('rethrows an item\'s error, and still records the item and its time', () => {
    const { meter, advance } = metered();
    const pass = meter.begin();
    assert.throws(() => pass.item('a', () => { advance(7); throw new Error('boom'); }), /boom/);
    pass.item('b', () => 'no-mail');
    pass.end();
    const last = meter.snapshot().last;
    assert.equal(last.threw, 1);
    assert.deepEqual(last.order.map((o) => [o.id, o.ms, o.threw]), [['a', 7, true], ['b', 0, false]]);
  });

  it('measures lateness only for a pass the timer fired, against one interval after the previous start', () => {
    const { meter, at } = metered();
    at(0);
    meter.schedule(5000);
    at(5000);
    meter.begin({ scheduled: true }).end();
    assert.equal(meter.snapshot().last.lagMs, 0);
    // The second pass was due at 10000 and started at 10350.
    at(10350);
    meter.begin({ scheduled: true }).end();
    assert.equal(meter.snapshot().last.lagMs, 350);
    // The third is due one interval after the second STARTED, so it is on time at 15350.
    at(15350);
    meter.begin({ scheduled: true }).end();
    assert.equal(meter.snapshot().last.lagMs, 0);
    // A pass run by hand has no schedule to be late against.
    at(99999);
    meter.begin().end();
    assert.equal(meter.snapshot().last.lagMs, null);
  });

  it('counts a pass longer than its interval as an overrun', () => {
    const { meter, at, advance } = metered();
    at(0);
    meter.schedule(5000);
    at(5000);
    let pass = meter.begin({ scheduled: true });
    pass.item('slow', () => { advance(5001); });
    pass.end();
    pass = meter.begin({ scheduled: true });
    pass.item('quick', () => { advance(5000); });
    pass.end();
    const snap = meter.snapshot();
    assert.equal(snap.overruns, 1);
    assert.equal(snap.passes, 2);
    assert.equal(snap.last.overran, false, 'exactly the interval is not an overrun');
  });

  it('keeps at most `capacity` passes but counts every one', () => {
    const { meter, advance } = metered({ capacity: 3 });
    for (let i = 1; i <= 5; i++) {
      const pass = meter.begin();
      pass.item(i, () => { advance(i); });
      pass.end();
    }
    const snap = meter.snapshot();
    assert.equal(snap.passes, 5);
    assert.equal(snap.window.size, 3);
    assert.deepEqual(snap.window.durationMs, { p50: 4, p95: 5, max: 5 });
  });

  it('reset forgets the passes; unschedule stops lateness and overrun judgments', () => {
    const { meter, at } = metered();
    meter.schedule(10);
    at(100);
    meter.begin({ scheduled: true }).end();
    meter.unschedule();
    meter.begin({ scheduled: true }).end();
    assert.equal(meter.snapshot().last.lagMs, null);
    assert.equal(meter.snapshot().intervalMs, null);
    meter.reset();
    assert.deepEqual([meter.snapshot().passes, meter.snapshot().last], [0, null]);
  });
});

describe('tick meter — it never fails the pass it measures', () => {
  it('a clock that throws leaves the pass unmeasured and the items run and return normally', () => {
    const meter = createTickMeter({ clock: () => { throw new Error('no clock'); } });
    meter.schedule(5000);
    const pass = meter.begin({ scheduled: true });
    assert.equal(pass.item('a', () => 'nudged'), 'nudged');
    pass.end();
    const last = meter.snapshot().last;
    assert.equal(last.durationMs, null);
    assert.deepEqual(last.order, [{ id: 'a', position: 0, ms: null, result: 'nudged', threw: false }]);
  });
});

describe('tick meter — percentiles', () => {
  it('uses nearest rank and answers null for no data', () => {
    assert.equal(percentile([], 50), null);
    assert.equal(percentile([1, 2, 3, 4], 50), 2);
    assert.equal(percentile([1, 2, 3, 4], 95), 4);
    assert.deepEqual(summarize([]), { p50: null, p95: null, max: null });
    assert.deepEqual(summarize([9, 1, 5]), { p50: 5, p95: 9, max: 9 });
  });
});
