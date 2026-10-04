'use strict';

// #2031 (ADR 0023): how the chat helper collects what to post. Collecting is a
// claim: each item is handed over under a lease bound to the helper token that
// claimed it, and an acknowledgement names that lease. This proves a claim is
// idempotent on its nonce, that an item holds one live lease at a time and
// comes back when it lapses, that an acknowledgement is good only from the
// lease's own token and inside its window, and that a live lease is the one
// thing that carries an item across its retention limit.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const bridgeStore = require('../lib/bridge-store');
const gateway = require('../lib/bridge-gateway');

const DAY = 24 * 60 * 60 * 1000;
const T0 = '2026-10-04T00:00:00.000Z';
const WEEK = bridgeStore.EXPIRY_MS.notification['work-blocked'];
const LEASE = bridgeStore.LEASE_MS;

let tmpDir;
let realNow;
let helper;
let nonceSeq;

/**
 * The instant a given number of milliseconds after T0.
 * @param {number} ms - Offset.
 * @returns {string}
 */
function at(ms) {
  return new Date(Date.parse(T0) + ms).toISOString();
}

/**
 * Set the gateway's clock.
 * @param {number} ms - Offset from T0.
 * @returns {void}
 */
function clockAt(ms) {
  gateway._deps.now = () => at(ms);
}

/**
 * Queue a notification at T0.
 * @param {string} name - Distinguishes it from the others.
 * @param {string} [type='work-blocked'] - Notification type.
 * @returns {number} Its id.
 */
function waiting(name, type = 'work-blocked') {
  const text = `notice ${name}`;
  return bridgeStore.outbound.enqueue({
    idemKey: `notify:${type}:${name}`, kind: 'notification', notifyType: type, sourceLabel: 'TangleClaw', text, digest: bridgeStore.digest(text), at: T0
  }).outboundId;
}

/**
 * A nonce no request has used.
 * @returns {string}
 */
function nonce() {
  return `lease-test-nonce-${String(++nonceSeq).padStart(4, '0')}`;
}

/**
 * Claim as the helper.
 * @param {object} [options] - `nonce`, `limit`, `as` (another token).
 * @returns {{status: number, body: object}}
 */
function claim(options = {}) {
  return gateway.claimOutbound(options.as || helper, options.nonce || nonce(), { limit: options.limit });
}

/**
 * Acknowledge a claimed item under its lease.
 * @param {{outboundId: number, leaseId: string}} item - A claimed item.
 * @param {string} ref - The chat's id for the post.
 * @param {object} [as] - Another token.
 * @returns {{status: number, body: object}}
 */
function ack(item, ref, as = helper) {
  return gateway.acknowledgeOutbound(item.outboundId, ref, { leaseId: item.leaseId, tokenId: as.tokenId });
}

/**
 * Every lease on an item, oldest first, as `[state, token]`.
 * @param {number} outboundId - Item id.
 * @returns {string[][]}
 */
function leasesOf(outboundId) {
  return store.getDb().prepare('SELECT state, token_id FROM bridge_outbound_leases WHERE outbound_id = ? ORDER BY issued_at, rowid')
    .all(outboundId).map((l) => [l.state, l.token_id]);
}

describe('bridge leases: what the helper holds, and until when (#2031)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bridge-leases-'));
    store._setBasePath(tmpDir);
    store.init();
    realNow = gateway._deps.now;
    gateway._reset();
    nonceSeq = 0;
    clockAt(0);
    const minted = gateway.mintHelperToken();
    helper = { tokenId: minted.tokenId };
  });

  afterEach(() => {
    gateway._deps.now = realNow;
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('hands each waiting item over once, under a lease of its own', () => {
    const [a, b] = [waiting('a'), waiting('b')];
    clockAt(1000);
    const first = claim();
    assert.deepEqual([first.status, first.body.replayed], [200, false]);
    assert.deepEqual(first.body.items.map((i) => [i.outboundId, i.text, i.leaseState, i.issuedAt, i.expiresAt]),
      [[a, 'notice a', 'live', at(1000), at(1000 + LEASE)], [b, 'notice b', 'live', at(1000), at(1000 + LEASE)]]);
    assert.equal(new Set(first.body.items.map((i) => i.leaseId)).size, 2, 'each item has its own lease');
    assert.equal(first.body.items[0].digest, bridgeStore.digest('notice a'), 'and comes with the digest of what was handed over');

    assert.deepEqual(claim().body.items, [], 'what is held is not handed over a second time');
    const c = waiting('c');
    assert.deepEqual(claim().body.items.map((i) => i.outboundId), [c], 'only what nobody holds');
  });

  it('takes no more than the claim asks for, oldest first, and refuses a limit that is not one', () => {
    const ids = ['a', 'b', 'c'].map((n) => waiting(n));
    assert.deepEqual(claim({ limit: 2 }).body.items.map((i) => i.outboundId), ids.slice(0, 2));
    assert.deepEqual(claim({ limit: 2 }).body.items.map((i) => i.outboundId), ids.slice(2));
    for (const limit of [0, -1, 1.5, '2', bridgeStore.MAX_CLAIM + 1]) {
      const refused = claim({ limit });
      assert.deepEqual([refused.status, refused.body.code], [400, 'BAD_CLAIM'], String(limit));
    }
    assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_outbound_claims').get().n, 2, 'a refused claim records nothing');
  });

  it('repeating a claim exactly returns the same leases and issues nothing', () => {
    waiting('a');
    const n = nonce();
    const first = claim({ nonce: n });
    waiting('b');
    const again = claim({ nonce: n });
    assert.equal(again.body.replayed, true);
    assert.deepEqual(again.body.items, first.body.items, 'the same leases, the same text, the same window');
    assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_outbound_leases').get().n, 1, 'no second lease was issued');

    // A claim that found nothing stays a claim that found nothing.
    const fresh = claim().body.items;
    const empty = nonce();
    assert.deepEqual(claim({ nonce: empty }).body.items, []);
    assert.equal(ack(fresh[0], 'posted-b').status, 200);
    waiting('c');
    assert.deepEqual([claim({ nonce: empty }).body.replayed, claim({ nonce: empty }).body.items], [true, []]);
  });

  it('refuses a nonce that comes back with a different request, a different token, or after another write used it', () => {
    waiting('a');
    const n = nonce();
    assert.equal(claim({ nonce: n, limit: 5 }).status, 200);
    for (const other of [{ nonce: n, limit: 6 }, { nonce: n }, { nonce: n, limit: 5, as: { tokenId: 'bht_another' } }]) {
      const refused = claim(other);
      assert.deepEqual([refused.status, refused.body.code], [409, 'NONCE_REUSED'], JSON.stringify(other));
    }
    const spent = nonce();
    assert.equal(bridgeStore.nonces.claim(spent), true);
    assert.equal(claim({ nonce: spent }).body.code, 'NONCE_REUSED', 'a nonce another helper write used cannot name a claim');
    assert.equal(bridgeStore.nonces.claim(n), false, 'and a claim\'s nonce cannot be used by another write');
  });

  it('a lapsed lease returns its item to the mailbox, and the old lease acknowledges nothing', () => {
    const id = waiting('a');
    const n = nonce();
    const [held] = claim({ nonce: n }).body.items;

    clockAt(LEASE);
    assert.deepEqual(claim().body.items, [], 'at exactly the end of its window the lease still holds');
    clockAt(LEASE + 1);
    const [again] = claim().body.items;
    assert.deepEqual([again.outboundId, again.text, again.leaseId !== held.leaseId], [id, 'notice a', true]);
    assert.deepEqual(leasesOf(id).map((l) => l[0]), ['lapsed', 'live'], 'one live lease at a time');

    const stale = ack(held, 'posted-1');
    assert.deepEqual([stale.status, stale.body.code], [409, 'LEASE_LAPSED']);
    assert.equal(bridgeStore.outbound.get(id).state, 'ready');

    // Asking the first claim again says what became of its lease, and gives no text to post.
    const replay = claim({ nonce: n }).body;
    assert.deepEqual(replay.items.map((i) => [i.leaseId, i.leaseState, i.text]), [[held.leaseId, 'lapsed', null]]);

    assert.equal(ack(again, 'posted-1').status, 200);
    assert.deepEqual(leasesOf(id).map((l) => l[0]), ['lapsed', 'used']);
  });

  it('an acknowledgement is good up to the end of the lease window and not after', () => {
    const [a, b] = [waiting('a'), waiting('b')];
    const [first, second] = claim().body.items;
    clockAt(LEASE);
    assert.equal(ack(first, 'posted-a').status, 200, 'at exactly the end of the window');
    clockAt(LEASE + 1);
    assert.equal(ack(second, 'posted-b').body.code, 'LEASE_LAPSED');
    assert.deepEqual([bridgeStore.outbound.get(a).state, bridgeStore.outbound.get(b).state], ['delivered', 'ready']);
  });

  it('an acknowledgement names its lease: the right item, the right token, a lease that exists', () => {
    const [a, b] = [waiting('a'), waiting('b')];
    const [first, second] = claim().body.items;
    const refusals = [
      [gateway.acknowledgeOutbound(a, 'posted-1', { tokenId: helper.tokenId }), 400, 'LEASE_REQUIRED'],
      [gateway.acknowledgeOutbound(a, 'posted-1', { leaseId: 'short', tokenId: helper.tokenId }), 400, 'LEASE_REQUIRED'],
      [ack({ outboundId: a, leaseId: 'bol_nosuchlease00000000000' }, 'posted-1'), 404, 'LEASE_NOT_FOUND'],
      [ack({ outboundId: a, leaseId: second.leaseId }, 'posted-1'), 404, 'LEASE_NOT_FOUND'],
      [ack(first, 'posted-1', { tokenId: 'bht_another' }), 403, 'LEASE_NOT_YOURS'],
      [ack({ outboundId: 9999, leaseId: first.leaseId }, 'posted-1'), 404, 'LEASE_NOT_FOUND']
    ];
    for (const [result, status, code] of refusals) assert.deepEqual([result.status, result.body.code], [status, code]);
    assert.deepEqual([bridgeStore.outbound.get(a).state, bridgeStore.outbound.get(b).state], ['ready', 'ready'], 'none of them delivered anything');
    assert.deepEqual(leasesOf(a), [['live', helper.tokenId]], 'or settled a lease');

    assert.deepEqual([ack(first, 'posted-1').body.replayed, ack(first, 'posted-1').body.replayed], [false, true]);
    assert.equal(ack(first, 'posted-2').body.code, 'ACK_MISMATCH');
    // The binding is judged before anything about the item is said. Whoever
    // does not hold the lease that delivered it gets the same refusal for a
    // delivered item as for a waiting one, and learns nothing from it.
    const forDelivered = [
      ack(first, 'posted-1', { tokenId: 'bht_another' }), ack(first, 'posted-2', { tokenId: 'bht_another' }),
      ack({ outboundId: a, leaseId: 'bol_nosuchlease00000000000' }, 'posted-1'), ack({ outboundId: a, leaseId: second.leaseId }, 'posted-1')
    ];
    const forWaiting = [
      ack(second, 'posted-b', { tokenId: 'bht_another' }), ack(second, 'posted-x', { tokenId: 'bht_another' }),
      ack({ outboundId: b, leaseId: 'bol_nosuchlease00000000000' }, 'posted-b'), ack({ outboundId: b, leaseId: first.leaseId }, 'posted-b')
    ];
    assert.deepEqual(forDelivered.map((r) => [r.status, r.body]), forWaiting.map((r) => [r.status, r.body]), 'the refusal is the same either way');
    assert.deepEqual(forDelivered.map((r) => r.body.code), ['LEASE_NOT_YOURS', 'LEASE_NOT_YOURS', 'LEASE_NOT_FOUND', 'LEASE_NOT_FOUND']);
  });

  it('a live lease carries an item across its limit; without one the limit is final', () => {
    const [held, unheld] = [waiting('held'), waiting('unheld')];
    // Claimed one second before the week is up, with a limit of one: only the older item.
    clockAt(WEEK - 1000);
    const [lease] = claim({ limit: 1 }).body.items;
    assert.equal(lease.outboundId, held);

    clockAt(WEEK + 1000);
    assert.deepEqual(bridgeStore.expire({ now: at(WEEK + 1000) }), { outbound: 1, candidates: 0 });
    assert.deepEqual([bridgeStore.outbound.get(held).state, bridgeStore.outbound.get(unheld).state], ['ready', 'dropped'],
      'the item somebody is holding is not let go; the one nobody collected is');
    const taken = ack(lease, 'posted-held');
    assert.deepEqual([taken.status, taken.body.state], [200, 'delivered'], 'an acknowledgement inside the window is taken, past the limit');
  });

  it('a lease that lapses past the limit lets the item go, and it is never handed over again', () => {
    const id = waiting('a');
    clockAt(WEEK - 1000);
    const [lease] = claim().body.items;
    clockAt(WEEK - 1000 + LEASE + 1);
    assert.deepEqual(claim().body.items, [], 'the claim lets it go instead of leasing it again');
    assert.deepEqual([bridgeStore.outbound.get(id).state, bridgeStore.outbound.get(id).text], ['dropped', null]);
    assert.deepEqual(leasesOf(id).map((l) => l[0]), ['lapsed']);
    const expiry = store.getDb().prepare("SELECT outcome, detail_json FROM bridge_audit WHERE op = 'expire'").get();
    assert.deepEqual([expiry.outcome, JSON.parse(expiry.detail_json).outboundId], ['uncollected-expired', id]);
    const late = ack(lease, 'posted-late');
    assert.deepEqual([late.status, late.body.code], [409, 'LEASE_LAPSED'], 'a lapsed lease is told only that, not what became of its item');
  });

  it('no lease is issued for an item already past its limit', () => {
    const id = waiting('a', 'fleet-idle');
    clockAt(DAY + 1);
    assert.deepEqual(claim().body.items, []);
    assert.equal(bridgeStore.outbound.get(id).state, 'dropped');
    assert.deepEqual(leasesOf(id), []);
  });

  it('replacing or revoking the helper token returns what it held at once', () => {
    const id = waiting('a');
    const [old] = claim().body.items;
    clockAt(1000);
    const next = { tokenId: gateway.mintHelperToken().tokenId };
    assert.deepEqual(leasesOf(id), [['lapsed', helper.tokenId]]);
    assert.equal(ack(old, 'posted-1').body.code, 'LEASE_LAPSED', 'the old token\'s lease acknowledges nothing');
    assert.equal(ack(old, 'posted-1', next).body.code, 'LEASE_NOT_YOURS', 'and it is not the new token\'s either');

    const [mine] = claim({ as: next }).body.items;
    assert.equal(mine.outboundId, id, 'the new token collects it without waiting out the old window');
    bridgeStore.helperTokens.revoke({ at: at(2000) });
    assert.deepEqual(leasesOf(id).map((l) => l[0]), ['lapsed', 'lapsed']);
    assert.equal(bridgeStore.outbound.get(id).state, 'ready', 'the item itself still waits');
  });

  it('a delivered answer, its lease and its route settle together', () => {
    const text = 'the answer';
    bridgeStore.routes.accept({ routeId: 'rt_1', externalId: 'ext-1', authorId: 'a', spaceId: 's', channelId: 'c', text: 'hello', digest: bridgeStore.digest('hello'), at: T0 });
    bridgeStore.applyRouteWrite({
      op: 'answer', requestId: 'req-answer-0001', routeId: 'rt_1', expectedVersion: 1, actor: 'master', proof: 'master-launch', masterGeneration: 1, at: T0,
      change: () => ({ set: { state: 'released' }, outbound: { idemKey: 'route:rt_1:answer', kind: 'reply', sourceLabel: 'Project Master', text, digest: bridgeStore.digest(text), releasedGeneration: 1 } })
    });
    const [item] = claim().body.items;
    assert.deepEqual([item.kind, item.inReplyTo.externalId], ['reply', 'ext-1']);

    clockAt(LEASE + 1);
    assert.equal(ack(item, 'posted-1').body.code, 'LEASE_LAPSED');
    assert.equal(bridgeStore.routes.get('rt_1').state, 'released', 'a refused acknowledgement closes nothing');

    const [again] = claim().body.items;
    assert.equal(ack(again, 'posted-1').status, 200);
    assert.equal(bridgeStore.routes.get('rt_1').state, 'closed');
    assert.deepEqual(leasesOf(item.outboundId).map((l) => l[0]), ['lapsed', 'used']);
    const delivered = bridgeStore.audit.forRoute('rt_1').find((a) => a.op === 'delivered');
    assert.equal(delivered.detail.leaseId, again.leaseId, 'the record names the lease it was delivered under');
  });

  it('retention removes a lapsed lease after a day; the lease an item was delivered under stays as long as the item', () => {
    const [a, b] = [waiting('a', 'operator-needed'), waiting('b', 'operator-needed')];
    const [first, other] = claim().body.items;
    assert.equal(ack(first, 'posted-a').status, 200);
    const states = (id) => leasesOf(id).map((l) => l[0]);

    clockAt(LEASE + 1);
    assert.equal(bridgeStore.leases.lapse({ at: at(LEASE + 1) }), 1);
    assert.deepEqual([states(a), states(b)], [['used'], ['lapsed']]);
    assert.equal(bridgeStore.prune({ now: at(DAY) }).leases, 0, 'inside a day both stay');
    assert.equal(bridgeStore.prune({ now: at(2 * DAY) }).leases, 1);
    assert.deepEqual([states(a), states(b)], [['used'], []], 'the lapsed one leaves; the receipt of a delivery does not');

    // Days later the helper that made the acknowledgement can still learn that it landed.
    clockAt(10 * DAY);
    assert.equal(ack(first, 'posted-a').body.replayed, true);
    assert.equal(ack(first, 'posted-z').body.code, 'ACK_MISMATCH');
    assert.equal(ack(other, 'posted-b').body.code, 'LEASE_NOT_FOUND', 'a lapsed lease is forgotten after a day, and nothing is said about its item');

    // A lease that is live when retention runs is never removed, whatever its age.
    const c = waiting('c', 'operator-needed');
    store.getDb().prepare('UPDATE bridge_outbound SET created_at = ? WHERE outbound_id = ?').run(at(10 * DAY), c);
    const [live] = claim().body.items;
    assert.equal(live.outboundId, c);
    assert.equal(bridgeStore.prune({ now: at(400 * DAY) }).leases, 0);
    assert.deepEqual(states(c), ['live']);

    // The receipt leaves with its item, and the claim once no lease of it is left.
    assert.deepEqual(states(a), [], 'thirty days after delivery the item is removed, and its lease with it');
    assert.equal(bridgeStore.outbound.get(a), null);
  });

  it('retention runs before any helper is heard from, and with the bridge off', async () => {
    // A token revoked long ago, and the one that replaced it.
    const long = at(-200 * DAY);
    const db = store.getDb();
    db.prepare("UPDATE bridge_helper_tokens SET status = 'revoked', revoked_at = ? WHERE status = 'active'").run(long);
    gateway.mintHelperToken();
    assert.equal(bridgeStore.settings.isEnabled(), false);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bridge_helper_tokens').get().n, 2);
    await gateway.tick();
    assert.deepEqual(db.prepare('SELECT status FROM bridge_helper_tokens').all().map((t) => t.status), ['active'],
      'the first pass removes what a revoked token left behind, with no request needed to cause it');
  });
});
