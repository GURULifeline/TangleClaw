'use strict';

// #2031 (ADR 0023): the operator bridge's durable state. A replayed inbound
// message stays one route; a Master credential has one live generation; a
// route write is idempotent on its request id, refused on a stale version and
// audited either way; and a cleared body leaves its record behind.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const bridgeStore = require('../lib/bridge-store');

let tmpDir = null;
const digest = 'a'.repeat(64);

/**
 * A minimal inbound message for `routes.accept`.
 * @param {object} [over] - Field overrides.
 * @returns {object}
 */
function inbound(over = {}) {
  return {
    routeId: 'rt_1', externalId: 'ext-1', authorId: 'author', spaceId: 'space', channelId: 'channel',
    text: 'hello', digest, ...over
  };
}

/**
 * A close decision for `applyRouteWrite`.
 * @param {object} [over] - Field overrides.
 * @returns {object}
 */
function closeWrite(over = {}) {
  return {
    op: 'close', requestId: 'req-00000001', routeId: 'rt_1', expectedVersion: 1,
    actor: 'master', proof: 'master-launch', masterGeneration: 1,
    change: () => ({ set: { state: 'closed', closed_by: 'master', closed_at: '2026-10-04T00:00:00.000Z' } }),
    ...over
  };
}

describe('bridge store (#2031)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bridge-store-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is disabled until the operator enables it', () => {
    assert.equal(bridgeStore.settings.isEnabled(), false);
    bridgeStore.settings.set('enabled', 'true');
    assert.equal(bridgeStore.settings.isEnabled(), true);
    bridgeStore.settings.set('enabled', 'false');
    assert.equal(bridgeStore.settings.isEnabled(), false);
  });

  it('stores a replayed inbound message once', () => {
    const first = bridgeStore.routes.accept(inbound());
    const again = bridgeStore.routes.accept(inbound({ routeId: 'rt_2', text: 'different text' }));
    assert.equal(first.created, true);
    assert.equal(again.created, false);
    assert.equal(again.route.routeId, 'rt_1');
    assert.equal(bridgeStore.routes.list().length, 1);
    assert.deepEqual(bridgeStore.routes.bodies('rt_1').map((b) => b.text), ['hello']);
    assert.deepEqual(bridgeStore.routes.bodies('rt_2'), []);
  });

  it('keeps one live Master generation and revokes the one before it', () => {
    const g1 = bridgeStore.masterCredentials.mint('b'.repeat(64));
    assert.equal(bridgeStore.masterCredentials.findActive('b'.repeat(64)), null, 'pending is not active');
    assert.equal(bridgeStore.masterCredentials.activate(g1, 'b'.repeat(64)), true);
    assert.equal(bridgeStore.masterCredentials.findActive('b'.repeat(64)).generation, g1);

    const g2 = bridgeStore.masterCredentials.mint('c'.repeat(64));
    assert.equal(g2, g1 + 1);
    assert.equal(bridgeStore.masterCredentials.findActive('b'.repeat(64)), null, 'the earlier generation is revoked');
    assert.equal(bridgeStore.masterCredentials.activate(g1, 'b'.repeat(64)), false, 'a revoked generation cannot be activated');
    assert.equal(bridgeStore.masterCredentials.activate(g2, 'c'.repeat(64)), true);
    assert.equal(bridgeStore.masterCredentials.revoke('handoff-failed', { generation: g2, credentialHash: 'e'.repeat(64) }), 0,
      'a late handoff naming another credential cannot revoke this one');

    assert.equal(bridgeStore.masterCredentials.revoke('master-killed'), 1);
    assert.equal(bridgeStore.masterCredentials.findActive('c'.repeat(64)), null);
    assert.equal(bridgeStore.masterCredentials.live(), null);
    // A generation is never reused, even after every one is revoked.
    assert.equal(bridgeStore.masterCredentials.mint('d'.repeat(64)), g2 + 1);
  });

  it('applies a route write once, however often its request id is replayed', () => {
    bridgeStore.routes.accept(inbound());
    const first = bridgeStore.applyRouteWrite(closeWrite());
    assert.deepEqual([first.outcome, first.replayed, first.route.state, first.route.version], ['applied', false, 'closed', 2]);

    const again = bridgeStore.applyRouteWrite(closeWrite({ change: () => { throw new Error('a replay must not decide again'); } }));
    assert.deepEqual([again.outcome, again.replayed, again.route.version], ['applied', true, 2]);
    assert.equal(bridgeStore.audit.forRoute('rt_1').length, 1);
  });

  it('refuses a write that names a stale version, and audits the refusal', () => {
    bridgeStore.routes.accept(inbound());
    bridgeStore.applyRouteWrite(closeWrite({ change: () => ({ set: { state: 'awaiting-master' } }) }));
    const stale = bridgeStore.applyRouteWrite(closeWrite({ requestId: 'req-00000002' }));
    assert.equal(stale.outcome, 'version-conflict');
    assert.equal(stale.route.state, 'awaiting-master');
    const rows = bridgeStore.audit.forRoute('rt_1');
    assert.deepEqual(rows.map((r) => r.outcome), ['applied', 'version-conflict']);
    assert.deepEqual(rows[1].detail, { currentVersion: 2 });
    assert.equal(rows[1].masterGeneration, 1);
  });

  it('audits a write to a route that does not exist and a refused decision', () => {
    const missing = bridgeStore.applyRouteWrite(closeWrite({ routeId: 'rt_none' }));
    assert.equal(missing.outcome, 'route-not-found');
    assert.equal(bridgeStore.audit.findRequest('close', 'req-00000001').outcome, 'route-not-found');

    bridgeStore.routes.accept(inbound());
    const refused = bridgeStore.applyRouteWrite(closeWrite({ requestId: 'req-00000003', change: () => ({ refuse: 'already-closed' }) }));
    assert.equal(refused.outcome, 'already-closed');
    assert.equal(refused.route.version, 1, 'a refusal changes nothing');
  });

  it('does not let one request id answer for a different route', () => {
    bridgeStore.routes.accept(inbound());
    bridgeStore.routes.accept(inbound({ routeId: 'rt_2', externalId: 'ext-2' }));
    bridgeStore.applyRouteWrite(closeWrite());
    const reused = bridgeStore.applyRouteWrite(closeWrite({ routeId: 'rt_2' }));
    assert.equal(reused.outcome, 'request-id-reused');
    assert.equal(reused.route.state, 'accepted');
  });

  it('clears a body and keeps the route, its digest and when it was cleared', () => {
    bridgeStore.routes.accept(inbound());
    assert.equal(bridgeStore.routes.clearBodies('rt_1', { at: '2026-10-04T01:00:00.000Z' }), 1);
    assert.deepEqual(bridgeStore.routes.bodies('rt_1'), [
      { role: 'inbound', text: null, digest, clearedAt: '2026-10-04T01:00:00.000Z' }
    ]);
    assert.equal(bridgeStore.routes.get('rt_1').externalId, 'ext-1');
    assert.equal(bridgeStore.routes.clearBodies('rt_1'), 0);
  });

  it('lists open routes oldest first and leaves closed ones out', () => {
    bridgeStore.routes.accept(inbound({ at: '2026-10-04T00:00:02.000Z' }));
    bridgeStore.routes.accept(inbound({ routeId: 'rt_2', externalId: 'ext-2', at: '2026-10-04T00:00:01.000Z' }));
    bridgeStore.applyRouteWrite(closeWrite());
    assert.deepEqual(bridgeStore.routes.list().map((r) => r.routeId), ['rt_2']);
    assert.deepEqual(bridgeStore.routes.list({ states: ['closed'] }).map((r) => r.routeId), ['rt_1']);
    assert.deepEqual(bridgeStore.routes.list({ states: ['not-a-state'] }), []);
  });
});
