'use strict';

// #2031 (ADR 0023 Decisions 21 and 23): what the helper may write about an
// item, and what becomes of an item it cannot post. Every such write is bound
// to the lease and the token first, and a caller that is not bound learns
// nothing of the item. Each posted message is recorded the moment it is
// reported, and a later claim says which are already posted. An
// acknowledgement seals only a whole set. A failure is reported with a reason
// from a closed list: one a retry may fix leaves the item waiting, one it will
// not sets the item aside and tells the operator, and only the Project Master
// or the operator can put it back or withdraw it. The helper discards nothing.

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
const { FAILURE_REASONS } = require('../lib/bridge-schema');

const DAY = 24 * 60 * 60 * 1000;
const T0 = '2026-10-04T00:00:00.000Z';
const LEASE = bridgeStore.LEASE_MS;

let tmpDir;
let realNow;
let helper;
let seq;

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
 * @returns {number} Its id.
 */
function waiting(name) {
  const text = `notice ${name}`;
  return bridgeStore.outbound.enqueue({
    idemKey: `notify:operator-needed:${name}`, kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw',
    text, digest: bridgeStore.digest(text), at: T0
  }).outboundId;
}

/**
 * Claim as the helper.
 * @param {object} [options] - `nonce`, `as` (another token).
 * @returns {object[]} The claimed items.
 */
function claim(options = {}) {
  return gateway.claimOutbound(options.as || helper, options.nonce || `decisions-nonce-${String(++seq).padStart(6, '0')}`, { limit: 20 }).body.items;
}

/**
 * Report one posted part.
 * @param {object} item - A claimed item.
 * @param {number} partIndex - Which part.
 * @param {number} partCount - Of how many.
 * @param {string} externalId - The chat's id for it.
 * @param {object} [as] - Another token.
 * @returns {{status: number, body: object}}
 */
function part(item, partIndex, partCount, externalId, as = helper) {
  return gateway.recordPart(item.outboundId, { leaseId: item.leaseId, tokenId: as.tokenId, partIndex, partCount, externalId });
}

/**
 * Seal an item.
 * @param {object} item - A claimed item.
 * @param {string[]} parts - Every part's id, in order.
 * @param {object} [as] - Another token.
 * @returns {{status: number, body: object}}
 */
function seal(item, parts, as = helper) {
  return gateway.acknowledgeOutbound(item.outboundId, undefined, { leaseId: item.leaseId, tokenId: as.tokenId, parts, partCount: parts.length });
}

/**
 * Report a failure.
 * @param {object} item - A claimed item.
 * @param {string} reason - Why.
 * @param {object} [over] - `parts`, `partCount`, `as`.
 * @returns {{status: number, body: object}}
 */
function fail(item, reason, over = {}) {
  return gateway.reportFailure(item.outboundId, {
    leaseId: item.leaseId, tokenId: (over.as || helper).tokenId, reason, parts: over.parts, partCount: over.partCount
  });
}

/**
 * Decide about an item, as the Project Master.
 * @param {('outbound-requeue'|'outbound-withdraw')} op - The decision.
 * @param {number} outboundId - The item.
 * @param {object} [over] - `requestId`, `actor`.
 * @returns {object}
 */
function decide(op, outboundId, over = {}) {
  return bridgeStore.applyOutboundWrite({
    op, outboundId, requestId: over.requestId || `req-decide-${++seq}-0000`, actor: over.actor || 'master',
    proof: over.actor === 'operator' ? 'verified-session' : 'master-launch', masterGeneration: over.actor === 'operator' ? null : 1,
    at: gateway._deps.now()
  });
}

/**
 * An item's state and why it is set aside.
 * @param {number} id - Item id.
 * @returns {Array}
 */
function standing(id) {
  const item = bridgeStore.outbound.get(id);
  return [item.state, item.blockCode];
}

describe('bridge: what the helper may write about an item, and what becomes of one it cannot post (#2031)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bridge-decisions-'));
    store._setBasePath(tmpDir);
    store.init();
    realNow = gateway._deps.now;
    gateway._reset();
    seq = 0;
    clockAt(0);
    helper = { tokenId: gateway.mintHelperToken().tokenId };
  });

  afterEach(() => {
    gateway._deps.now = realNow;
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('bound before anything is said', () => {
    it('every write about an item answers a caller that does not hold its lease the same way, whatever became of the item', () => {
      const ids = ['waiting', 'delivered', 'blocked', 'dropped'].map((name) => waiting(name));
      const items = claim();
      const other = { tokenId: 'bht_another' };
      assert.equal(seal(items[1], ['d100']).status, 200);
      assert.equal(fail(items[2], 'rejected-by-chat').body.state, 'blocked');
      clockAt(8 * DAY);
      bridgeStore.expire({ now: at(8 * DAY) });
      assert.deepEqual(ids.map((id) => standing(id)[0]), ['dropped', 'delivered', 'dropped', 'dropped']);

      const writes = (item, as, leaseId = item.leaseId) => [
        seal({ ...item, leaseId }, ['d900'], as), part({ ...item, leaseId }, 0, 1, 'd900', as), fail({ ...item, leaseId }, 'transient', { as })
      ].map((r) => [r.status, r.body.code]);
      for (const item of items) {
        assert.deepEqual(writes(item, other), Array(3).fill([403, 'LEASE_NOT_YOURS']), `another token, item ${item.outboundId}`);
        assert.deepEqual(writes(item, helper, 'bol_nosuchlease00000000000'), Array(3).fill([404, 'LEASE_NOT_FOUND']), `no such lease, item ${item.outboundId}`);
        assert.deepEqual(writes(item, helper, items[(items.indexOf(item) + 1) % 4].leaseId), Array(3).fill([404, 'LEASE_NOT_FOUND']), 'another item\'s lease');
      }
      assert.deepEqual(writes({ outboundId: 9999, leaseId: items[0].leaseId }, helper), Array(3).fill([404, 'LEASE_NOT_FOUND']), 'an item that never was');
      for (const bad of [null, 'short', 12]) {
        assert.deepEqual(writes(items[0], helper, bad), Array(3).fill([400, 'LEASE_REQUIRED']));
      }
    });

    it('the lease that delivered an item can always learn that it landed; no other lease can', () => {
      const id = waiting('a');
      const [first] = claim();
      clockAt(LEASE + 1);
      const [second] = claim();
      assert.equal(second.outboundId, id);
      assert.equal(seal(second, ['d100']).body.replayed, false);
      // The earlier lease is this token's and this item's, and still on record. It did not deliver the item, so it cannot repeat the delivery.
      assert.deepEqual([seal(first, ['d100']).status, seal(first, ['d100']).body.code], [409, 'LEASE_LAPSED']);

      clockAt(20 * DAY);
      bridgeStore.prune({ now: at(20 * DAY) });
      assert.equal(seal(second, ['d100']).body.replayed, true, 'twenty days on, the receipt still answers');
      assert.equal(seal(second, ['d101']).body.code, 'ACK_MISMATCH');
      assert.equal(seal(first, ['d100']).body.code, 'LEASE_NOT_FOUND', 'the lapsed lease is forgotten, and says nothing');
    });
  });

  describe('the lease window', () => {
    it('is judged by the lease\'s own expiry, whether or not anything has yet marked the lease lapsed', () => {
      const id = waiting('a');
      const [item] = claim();
      const ack = (ms) => ({ leaseId: item.leaseId, tokenId: helper.tokenId, at: at(ms) });
      const state = () => store.getDb().prepare('SELECT state FROM bridge_outbound_leases WHERE lease_id = ?').get(item.leaseId).state;

      assert.equal(bridgeStore.outbound.ackVerdict(id, ['d100'], ack(LEASE)), 'deliverable', 'at exactly the end of the window');
      // One millisecond later nothing has swept the lease yet: it still reads live, and is refused all the same.
      assert.equal(state(), 'live');
      assert.equal(bridgeStore.outbound.ackVerdict(id, ['d100'], ack(LEASE + 1)), 'lease-lapsed');
      assert.equal(bridgeStore.parts.receipt(id, { index: 0, count: 1, externalId: 'd100' }, ack(LEASE + 1)), 'lease-lapsed');
      assert.equal(bridgeStore.outbound.markDelivered(id, ['d100'], ack(LEASE + 1)).outcome, 'lease-lapsed');
      assert.deepEqual([state(), bridgeStore.outbound.get(id).state, bridgeStore.parts.forItem(id)], ['live', 'ready', []]);
    });
  });

  describe('recording a posted part at once', () => {
    it('records parts in order, tells a later claim which are posted, and seals only the whole set', () => {
      const id = waiting('a');
      const [item] = claim();
      assert.deepEqual([item.postedParts, item.partCount, item.attempts], [[], null, 1]);
      assert.deepEqual(part(item, 0, 3, 'd100').body, { outboundId: id, partIndex: 0, partCount: 3, replayed: false });
      assert.equal(part(item, 0, 3, 'd100').body.replayed, true, 'the same part again changes nothing');
      assert.equal(part(item, 1, 3, 'd101').status, 200);
      assert.deepEqual(bridgeStore.parts.find('d101').partIndex, 1, 'a reply to it resolves from this moment');
      assert.equal(standing(id)[0], 'ready', 'two of three is not delivered');

      const refusals = [
        [part(item, 0, 3, 'd199'), 409, 'PART_MISMATCH'], [part(item, 2, 4, 'd102'), 409, 'PART_MISMATCH'],
        [part(item, 2, 3, 'd100'), 409, 'PART_ID_COLLISION'],
        [seal(item, ['d100', 'd101']), 409, 'PART_MISMATCH'], [seal(item, ['d100', 'd199', 'd102']), 409, 'PART_MISMATCH'],
        [seal(item, ['d100']), 409, 'PART_MISMATCH'], [seal(item, ['d100', 'd101', 'd102', 'd103']), 409, 'PART_MISMATCH']
      ];
      for (const [result, status, code] of refusals) assert.deepEqual([result.status, result.body.code], [status, code]);
      assert.deepEqual([standing(id)[0], bridgeStore.parts.forItem(id)], ['ready', ['d100', 'd101']], 'none of them changed anything');

      // The lease lapses with the last part unposted. Whoever claims next is told where to carry on.
      clockAt(LEASE + 1);
      assert.equal(part(item, 2, 3, 'd102').body.code, 'LEASE_LAPSED');
      const [again] = claim();
      assert.deepEqual([again.outboundId, again.postedParts, again.partCount, again.attempts], [id, ['d100', 'd101'], 3, 2]);
      assert.equal(part(again, 2, 3, 'd102').status, 200);
      assert.equal(seal(again, ['d100', 'd101', 'd102']).body.replayed, false);
      assert.deepEqual([standing(id)[0], bridgeStore.outbound.get(id).deliveredRef], ['delivered', 'd100']);
      assert.equal(part(again, 2, 3, 'd102').body.code, 'OUTBOUND_DELIVERED', 'a sealed item takes no more parts');
    });

    it('a part out of order, or one that is not a part, is refused and records nothing', () => {
      const id = waiting('a');
      const [item] = claim();
      assert.deepEqual([part(item, 1, 3, 'd101').status, part(item, 1, 3, 'd101').body.code], [409, 'PART_OUT_OF_ORDER']);
      for (const [index, count, externalId] of [[-1, 3, 'd1'], [3, 3, 'd1'], [0, 0, 'd1'], [0, bridgeStore.MAX_PARTS + 1, 'd1'], [0.5, 3, 'd1'], [0, 3, 'bad id!'], [0, 3, undefined], ['0', 3, 'd1']]) {
        assert.equal(part(item, index, count, externalId).body.code, 'BAD_PART', JSON.stringify([index, count, externalId]));
      }
      assert.deepEqual(bridgeStore.parts.forItem(id), []);
    });

    it('counts a hand-over once for each lease issued, and never for a claim repeated under its nonce', () => {
      const id = waiting('a');
      const attempts = () => bridgeStore.outbound.get(id).attempts;
      const leases = () => store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_outbound_leases WHERE outbound_id = ?').get(id).n;
      assert.equal(attempts(), 0);
      claim({ nonce: 'decisions-nonce-repeat1' });
      for (let i = 0; i < 3; i++) assert.equal(claim({ nonce: 'decisions-nonce-repeat1' })[0].attempts, 1, 'a repeat hands nothing over');
      assert.deepEqual([attempts(), leases()], [1, 1]);
      claim();
      assert.equal(attempts(), 1, 'a claim that finds it held hands nothing over either');
      for (let round = 2; round <= 4; round++) {
        clockAt(round * (LEASE + 1));
        assert.equal(claim()[0].attempts, round);
        assert.deepEqual([attempts(), leases()], [round, round], 'the count is the number of leases ever issued for the item');
      }
    });
  });

  describe('reporting a failure', () => {
    it('takes a reason from its closed list and no other', () => {
      waiting('a');
      const [item] = claim();
      assert.deepEqual([...FAILURE_REASONS.retryable, ...FAILURE_REASONS.blocking],
        ['transient', 'outcome-unknown', 'rejected-by-chat', 'chat-configuration', 'outcome-unverifiable', 'part-conflict']);
      for (const reason of ['discard', 'delete', '', undefined, 'Discord said: no', 'TRANSIENT']) {
        const refused = fail(item, reason);
        assert.deepEqual([refused.status, refused.body.code], [400, 'BAD_FAILURE'], String(reason));
      }
      for (const over of [{ parts: ['d1', 'd1'], partCount: 2 }, { parts: ['d1'] }, { parts: ['d1', 'd2'], partCount: 1 }, { parts: 'd1', partCount: 1 }, { parts: ['bad id!'], partCount: 1 }]) {
        assert.equal(fail(item, 'transient', over).body.code, 'BAD_FAILURE', JSON.stringify(over));
      }
      assert.equal(store.getDb().prepare("SELECT COUNT(*) AS n FROM bridge_audit WHERE op = 'helper-failure'").get().n, 0);
    });

    it('a failure a retry may fix leaves the item waiting under its lease, on the record', () => {
      const id = waiting('a');
      const [item] = claim();
      for (const reason of FAILURE_REASONS.retryable) {
        assert.deepEqual(fail(item, reason).body, { outboundId: id, state: 'ready', reason });
      }
      assert.deepEqual(standing(id), ['ready', null]);
      assert.equal(store.getDb().prepare('SELECT state FROM bridge_outbound_leases WHERE lease_id = ?').get(item.leaseId).state, 'live');
      assert.equal(bridgeStore.outbound.ready().length, 1, 'and nothing is raised with the operator');
      assert.equal(seal(item, ['d100']).status, 200, 'the helper can still post it');
      const audit = store.getDb().prepare("SELECT actor, proof, outcome, detail_json FROM bridge_audit WHERE op = 'helper-failure' ORDER BY audit_seq").all();
      assert.deepEqual(audit.map((a) => [a.actor, a.proof, a.outcome, JSON.parse(a.detail_json).reason]),
        [['helper', 'helper-token', 'retryable', 'transient'], ['helper', 'helper-token', 'retryable', 'outcome-unknown']]);
    });

    it('a failure a retry will not fix sets the item aside, records the parts that posted, and tells the operator once', () => {
      for (const [index, reason] of FAILURE_REASONS.blocking.entries()) {
        const id = waiting(`item-${index}`);
        const [item] = claim();
        assert.deepEqual(fail(item, reason, { parts: ['a', 'b'].map((p) => `d${index}${p}`), partCount: 3 }).body, { outboundId: id, state: 'blocked', reason });
        assert.deepEqual(standing(id), ['blocked', reason]);
        assert.equal(bridgeStore.outbound.get(id).text, `notice item-${index}`, 'its text is kept: nothing is discarded');
        assert.deepEqual(bridgeStore.parts.forItem(id), [`d${index}a`, `d${index}b`]);
        assert.equal(store.getDb().prepare('SELECT state FROM bridge_outbound_leases WHERE lease_id = ?').get(item.leaseId).state, 'lapsed');

        // Reporting it again, or anything else about it, changes nothing.
        for (const again of [fail(item, reason), fail(item, 'transient'), seal(item, [`d${index}a`, `d${index}b`, `d${index}c`]), part(item, 2, 3, `d${index}c`)]) {
          assert.deepEqual([again.status, again.body.code], [409, 'OUTBOUND_BLOCKED']);
        }
        const notices = bridgeStore.outbound.ready();
        assert.deepEqual(notices.map((n) => [n.kind, n.notifyType, n.sourceLabel, n.text, n.idemKey]),
          [['notification', 'operator-needed', 'TangleClaw', gateway.BLOCKED_NOTICE, `outbound-blocked:${id}:1`]]);
        // The helper posts the notice, and the item it is about is not handed over with it.
        const [notice] = claim();
        assert.equal(notice.outboundId, notices[0].outboundId);
        assert.equal(seal(notice, [`n${index}`]).status, 200);
        clockAt((index + 1) * (LEASE + 1));
        assert.deepEqual(claim(), [], 'an item set aside is handed to nobody');
      }
    });

    it('the notice that something was set aside is never itself set aside', () => {
      const id = waiting('a');
      fail(claim()[0], 'chat-configuration');
      const [notice] = claim();
      assert.deepEqual(fail(notice, 'chat-configuration').body, { outboundId: notice.outboundId, state: 'ready', reason: 'chat-configuration' });
      assert.deepEqual([standing(notice.outboundId), standing(id)], [['ready', null], ['blocked', 'chat-configuration']]);
      assert.equal(bridgeStore.outbound.ready().length, 1, 'and no notice is raised about the notice');
      assert.equal(seal(notice, ['d100']).status, 200, 'it is posted as soon as the helper can');
    });

    it('a refused part undoes the whole report', () => {
      const [a, b] = [waiting('a'), waiting('b')];
      const [first, second] = claim();
      assert.equal(part(first, 0, 1, 'd100').status, 200);
      const refused = fail(second, 'rejected-by-chat', { parts: ['d200', 'd100'], partCount: 3 });
      assert.deepEqual([refused.status, refused.body.code], [409, 'PART_ID_COLLISION']);
      assert.deepEqual([standing(b), bridgeStore.parts.forItem(b)], [['ready', null], []], 'nothing of it was recorded, and the item is not set aside');
      assert.equal(standing(a)[0], 'ready');
    });
  });

  describe('deciding what becomes of an item set aside', () => {
    it('putting it back hands it over again, with the parts already posted', () => {
      const id = waiting('a');
      fail(claim()[0], 'rejected-by-chat', { parts: ['d100'], partCount: 2 });
      const back = decide('outbound-requeue', id, { requestId: 'req-requeue-0001' });
      assert.deepEqual([back.outcome, back.replayed, back.item.state, back.item.blockCode], ['applied', false, 'ready', null]);
      assert.deepEqual(decide('outbound-requeue', id, { requestId: 'req-requeue-0001' }).replayed, true, 'the same request again changes nothing');
      assert.equal(decide('outbound-requeue', id).outcome, 'not-blocked');

      const item = claim().find((i) => i.outboundId === id);
      assert.deepEqual([item.postedParts, item.partCount, item.attempts, item.text], [['d100'], 2, 2, 'notice a']);
      assert.equal(part(item, 1, 2, 'd101').status, 200);
      assert.equal(seal(item, ['d100', 'd101']).status, 200);
      // Set aside a second time, it raises a second notice: each is for one hand-over.
      const other = waiting('b');
      fail(claim().find((i) => i.outboundId === other), 'rejected-by-chat');
      decide('outbound-requeue', other);
      clockAt(LEASE + 1);
      fail(claim().find((i) => i.outboundId === other), 'rejected-by-chat');
      const keys = store.getDb().prepare("SELECT idem_key FROM bridge_outbound WHERE idem_key LIKE 'outbound-blocked:%' ORDER BY outbound_id").all().map((r) => r.idem_key);
      assert.deepEqual(keys, [`outbound-blocked:${id}:1`, `outbound-blocked:${other}:1`, `outbound-blocked:${other}:2`]);
    });

    it('withdrawing it is final, drops its text, and is the Master\'s or the operator\'s alone', () => {
      const [a, b] = [waiting('a'), waiting('b')];
      const items = claim();
      fail(items[0], 'rejected-by-chat');
      fail(items[1], 'chat-configuration');
      const byMaster = decide('outbound-withdraw', a);
      const byOperator = decide('outbound-withdraw', b, { actor: 'operator' });
      for (const [result, id] of [[byMaster, a], [byOperator, b]]) {
        assert.deepEqual([result.outcome, result.item.state, result.item.dropCode, result.item.blockCode, result.item.text], ['applied', 'dropped', 'withdrawn', null, null]);
        assert.equal(decide('outbound-requeue', id).outcome, 'not-blocked', 'a withdrawn item cannot be put back');
        assert.equal(decide('outbound-withdraw', id).outcome, 'not-waiting');
      }
      assert.equal(seal(items[0], ['d100']).body.code, 'OUTBOUND_EXPIRED', 'the helper that held it is told it is gone');
      const audit = store.getDb().prepare("SELECT actor, proof, master_generation, outcome FROM bridge_audit WHERE op = 'outbound-withdraw' AND outcome = 'applied' ORDER BY audit_seq").all();
      assert.deepEqual(audit.map((r) => [r.actor, r.proof, r.master_generation]), [['master', 'master-launch', 1], ['operator', 'verified-session', null]]);
      assert.equal(decide('outbound-withdraw', 9999).outcome, 'outbound-not-found');
    });

    it('an item in the helper\'s hands is not withdrawn: the withdrawal waits for the lease to settle', () => {
      const id = waiting('a');
      const [item] = claim();
      const refused = decide('outbound-withdraw', id);
      assert.deepEqual([refused.outcome, refused.item.state], ['outbound-in-flight', 'ready']);
      assert.equal(seal(item, ['d100']).status, 200, 'and the post it was about to make is still good');
      assert.equal(decide('outbound-withdraw', id).outcome, 'not-waiting', 'what is delivered is history');

      const other = waiting('b');
      const [held] = claim();
      assert.equal(decide('outbound-withdraw', other).outcome, 'outbound-in-flight');
      clockAt(LEASE + 1);
      assert.equal(decide('outbound-withdraw', other).outcome, 'applied', 'once the lease has lapsed');
      assert.deepEqual([seal(held, ['d200']).status, seal(held, ['d200']).body.code], [410, 'OUTBOUND_EXPIRED']);
      assert.deepEqual(claim(), [], 'and it is never handed over again');
    });

    it('a request id belongs to one decision about one item', () => {
      const [a, b] = [waiting('a'), waiting('b')];
      const items = claim();
      fail(items[0], 'rejected-by-chat');
      fail(items[1], 'rejected-by-chat');
      assert.equal(decide('outbound-requeue', a, { requestId: 'req-shared-0001' }).outcome, 'applied');
      const reused = decide('outbound-requeue', b, { requestId: 'req-shared-0001' });
      assert.deepEqual([reused.outcome, reused.item.state], ['request-id-reused', 'blocked']);
    });

    it('an item set aside still has a limit, and is let go when it passes', () => {
      const id = waiting('a');
      fail(claim()[0], 'rejected-by-chat');
      assert.equal(bridgeStore.expire({ now: at(7 * DAY) }).outbound, 0, 'at exactly the limit it stays');
      // The item, and the notice raised about it at the same instant.
      assert.equal(bridgeStore.expire({ now: at(7 * DAY + 1) }).outbound, 2);
      assert.deepEqual([bridgeStore.outbound.get(id).state, bridgeStore.outbound.get(id).blockCode, bridgeStore.outbound.get(id).text], ['dropped', null, null]);
      assert.equal(decide('outbound-requeue', id).outcome, 'not-blocked');
    });
  });
});
