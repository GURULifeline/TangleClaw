'use strict';

/*
 * The delivery watchdog's pass meter (#2086): each pass over the open
 * exchanges is timed, and timing it changes nothing the pass decides.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const mx = require('../lib/medusa-exchanges');
const watchdog = require('../lib/medusa-watchdog');

const T0 = Date.parse('2026-09-25T12:00:00.000Z');
const PM = { kind: 'project', projectId: 10 };

/**
 * A blocking message, stored and delivered, so the watchdog has one open exchange.
 * @param {string} hubId - Hub id
 * @returns {object} The exchange row
 */
function deliveredBlocking(hubId) {
  const x = mx.createSendIntent({
    meta: mx.validateSendMeta({ priority: 'blocking' }, PM, 10),
    sender: { projectId: 10, workspaceId: 'pm-ws' },
    recipient: { workspaceId: `builder-${hubId}`, projectId: 20, sessionId: 2 }
  });
  mx.bindHubId(x.exchange_id, hubId);
  mx.recordArrival({ hubId, recipientWorkspaceId: `builder-${hubId}` });
  return store.medusaExchanges.get(x.exchange_id);
}

describe('medusa-watchdog — pass meter (#2086)', () => {
  const saved = { ...watchdog._internal };
  const savedNow = mx._internal.now;
  let tmpDir = null;
  let mono = 0;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-watchdog-meter-'));
    store._setBasePath(tmpDir);
    store.init();
    mx._internal.now = () => new Date(T0);
    watchdog._internal.loadConfig = () => ({});
    watchdog._internal.now = () => T0;
    mono = 0;
    watchdog._internal.clock = () => { mono += 2; return mono; };
  });

  afterEach(() => {
    watchdog.stop();
    Object.assign(watchdog._internal, saved);
    mx._internal.now = savedNow;
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('records one item per open exchange, in the order the pass judged them', () => {
    const a = deliveredBlocking('hub-a');
    const b = deliveredBlocking('hub-b');
    const before = watchdog.tickMetrics().passes;
    watchdog.tick(T0);
    const snap = watchdog.tickMetrics();
    assert.equal(snap.passes, before + 1);
    assert.deepEqual(snap.last.order.map((o) => o.id).sort(), [a.exchange_id, b.exchange_id].sort());
    assert.equal(snap.last.items, 2);
    assert.ok(snap.last.durationMs > 0);
    assert.equal(snap.last.lagMs, null, 'a pass run by hand has no schedule to be late against');
  });

  it('a meter whose clock throws leaves the pass\'s decisions as they were', () => {
    deliveredBlocking('hub-c');
    const metered = watchdog.tick(T0).rearmed;
    watchdog._internal.clock = () => { throw new Error('no clock'); };
    assert.equal(watchdog.tick(T0).rearmed, metered);
    assert.equal(watchdog.tickMetrics().last.durationMs, null);
    assert.equal(watchdog.tickMetrics().last.items, 1);
  });

  it('a disabled watchdog runs no pass and records none', () => {
    watchdog._internal.loadConfig = () => ({ medusaWatchdog: { enabled: false } });
    const before = watchdog.tickMetrics().passes;
    watchdog.tick(T0);
    assert.equal(watchdog.tickMetrics().passes, before);
  });
});
