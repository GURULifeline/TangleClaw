'use strict';

// #2031 with #2086: the Medusa arrival observer `server.js` registers, run as
// registered. One handler serves two things. For every listener it records the
// arrival and asks the wake monitor to look at the session the mail is for.
// For the operator bridge's gateway, which is a listener and not a session, it
// also drains the gateway's inbox. The two must not get in each other's way:
// the drain is the gateway's alone, and the wake request for the gateway's key
// has no session to look at and does nothing.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const medusa = require('../lib/medusa');
const medusaWake = require('../lib/medusa-wake');
const medusaExchanges = require('../lib/medusa-exchanges');
const bridgeGateway = require('../lib/bridge-gateway');

describe('the Medusa arrival observer, with the operator bridge in it (#2031, #2086)', () => {
  let tmpDir;
  let observer = null;
  let real;
  let calls;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-arrival-observer-'));
    store._setBasePath(tmpDir);
    store.init();
    // Catch the very function the server registers, and still register it.
    const register = medusa.setArrivalObserver;
    medusa.setArrivalObserver = (fn) => { observer = fn; register(fn); };
    try {
      require('../server');
    } finally {
      medusa.setArrivalObserver = register;
    }
    real = { drain: bridgeGateway.drainInbox, scan: medusaWake.requestScan, record: medusaExchanges.recordArrival };
  });

  after(() => {
    Object.assign(bridgeGateway, { drainInbox: real.drain });
    Object.assign(medusaWake, { requestScan: real.scan });
    Object.assign(medusaExchanges, { recordArrival: real.record });
    medusaWake.stop();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    calls = { drain: 0, scan: [], record: [] };
    bridgeGateway.drainInbox = () => { calls.drain += 1; return { held: 0, dropped: 0, waiting: 0 }; };
    medusaWake.requestScan = (key, why) => { calls.scan.push([key, why]); return true; };
    medusaExchanges.recordArrival = (arrival) => { calls.record.push(arrival.hubId); return null; };
  });

  it('the server registers one', () => {
    assert.equal(typeof observer, 'function');
  });

  it('for the gateway: records the arrival, drains the gateway\'s inbox, and asks for a look', () => {
    observer({ sessionKey: bridgeGateway.GATEWAY_KEY, workspaceId: 'gateway-ws', message: { id: 'hub-1', from: 'alpha-ws' } });
    assert.deepEqual(calls, { drain: 1, scan: [[bridgeGateway.GATEWAY_KEY, 'mail-arrived']], record: ['hub-1'] });
  });

  it('for a session or the Master: records and asks for a look, and never drains the gateway', () => {
    observer({ sessionKey: '42', workspaceId: 'alpha-ws', message: { id: 'hub-2', from: 'beta-ws' } });
    observer({ sessionKey: 'master', workspaceId: 'master-ws', message: { id: 'hub-3', from: 'beta-ws' } });
    assert.deepEqual(calls, { drain: 0, scan: [['42', 'mail-arrived'], ['master', 'mail-arrived']], record: ['hub-2', 'hub-3'] });
  });

  it('a message with no id is not recorded and not drained for; the look is still asked for', () => {
    observer({ sessionKey: bridgeGateway.GATEWAY_KEY, workspaceId: 'gateway-ws', message: { from: 'alpha-ws' } });
    observer({ sessionKey: bridgeGateway.GATEWAY_KEY, workspaceId: 'gateway-ws', message: null });
    assert.deepEqual(calls, { drain: 0, scan: [[bridgeGateway.GATEWAY_KEY, 'mail-arrived'], [bridgeGateway.GATEWAY_KEY, 'mail-arrived']], record: [] });
  });

  it('a drain that fails is contained: the look is still asked for and nothing is thrown', () => {
    bridgeGateway.drainInbox = () => { calls.drain += 1; throw new Error('store is locked'); };
    assert.doesNotThrow(() => observer({ sessionKey: bridgeGateway.GATEWAY_KEY, workspaceId: 'gateway-ws', message: { id: 'hub-4', from: 'alpha-ws' } }));
    assert.deepEqual([calls.drain, calls.scan.length], [1, 1]);
  });

  it('an arrival that cannot be recorded is not drained for, and the look is still asked for', () => {
    medusaExchanges.recordArrival = () => { throw new Error('store is locked'); };
    assert.throws(() => observer({ sessionKey: bridgeGateway.GATEWAY_KEY, workspaceId: 'gateway-ws', message: { id: 'hub-5', from: 'alpha-ws' } }), /store is locked/);
    assert.deepEqual([calls.drain, calls.scan], [0, [[bridgeGateway.GATEWAY_KEY, 'mail-arrived']]],
      'the gateway\'s own pass drains it a moment later; the wake request does not depend on the record');
  });

  it('the look asked for under the gateway\'s key finds no session and does nothing', async () => {
    medusaWake.requestScan = real.scan;
    assert.equal(medusaWake.requestScan(bridgeGateway.GATEWAY_KEY, 'mail-arrived'), false, 'with the monitor stopped nothing is queued');
    medusaWake.start({ intervalMs: 60 * 60 * 1000 });
    try {
      assert.equal(medusaWake.requestScan(bridgeGateway.GATEWAY_KEY, 'mail-arrived'), true, 'running, the request is taken');
      // The look runs on a later turn. It finds no session under that key, so it reads no pane and types nothing.
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(store.sessions.listLiveAll().some((s) => String(s.id) === bridgeGateway.GATEWAY_KEY), false);
      assert.equal(medusaWake.isRunning(), true, 'and the monitor is none the worse');
    } finally {
      medusaWake.stop();
    }
  });
});
