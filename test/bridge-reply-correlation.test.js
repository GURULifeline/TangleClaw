'use strict';

// #2031 (ADR 0023 Decision 22): what the operator's reply answers. Every
// message the chat confirmed for an item is recorded against that item, so a
// reply to any of them, the first part or the last, is known for what it is.
// A reply to an answer goes where that answer's route went. A reply to a
// milestone or a notification, which has no route, goes to the Master as a
// reply to that item, with what it answers fixed on the route. It is never an
// unaddressed message, it changes nothing about the candidate, and it reaches
// no session directly. The record outlives the item and a restart.

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
const exchanges = require('../lib/medusa-exchanges');
const { install, masterTakesSuggestion, MASTER_WS } = require('./_bridge-hub');
const { bindProject } = require('./_shared-docs-callers');

const ALLOWED = { authorId: 'author1', spaceId: 'space1', channelId: 'chan1' };
const DAY = 24 * 60 * 60 * 1000;

let tmpDir;
let clock;
let hub;
let realDeps;
let realExchangeNow;
let helper;
let seq;

/**
 * Move the clock on.
 * @param {number} ms - How far.
 * @returns {void}
 */
function later(ms) {
  clock = new Date(Date.parse(clock) + ms).toISOString();
}

/**
 * An inbound message from the allowlisted operator.
 * @param {string} externalId - Chat message id.
 * @param {string} text - Message text.
 * @param {object} [over] - Field overrides.
 * @returns {Promise<{status: number, body: object}>}
 */
/**
 * How the gateway came by the destination it suggested for a route. The route itself is routed by the Master.
 * @param {object} route - A route.
 * @returns {string|null}
 */
function suggestedBy(route) {
  return bridgeStore.audit.suggestionFor(route.routeId).by;
}

function operatorWrites(externalId, text, over = {}) {
  return gateway.acceptInbound({ externalId, ...ALLOWED, text, ...over });
}

/**
 * The operator writes, and the Project Master routes the message where the
 * gateway suggested. Every inbound waits for that decision; this file is
 * about what a reply answers, which begins after it.
 * @param {string} externalId - Chat message id.
 * @param {string} text - Message text.
 * @param {object} [over] - Field overrides.
 * @returns {Promise<{status: number, body: object}>}
 */
async function operatorSays(externalId, text, over = {}) {
  const accepted = await operatorWrites(externalId, text, over);
  if (accepted.status !== 202 || !accepted.body.routeId || accepted.body.replayed) return accepted;
  const route = await masterTakesSuggestion(accepted.body.routeId, { at: clock });
  return { status: accepted.status, body: { ...accepted.body, state: route ? route.state : accepted.body.state } };
}

/**
 * Claim everything waiting and acknowledge one item as posted in the given messages.
 * @param {number} outboundId - The item.
 * @param {string[]} partIds - The chat's ids for its messages, in order.
 * @returns {{status: number, body: object}}
 */
function posted(outboundId, partIds) {
  const claimed = gateway.claimOutbound(helper, `claim-nonce-${String(++seq).padStart(8, '0')}`, { limit: 20 }).body.items;
  const item = claimed.find((i) => i.outboundId === outboundId);
  assert.ok(item, `item ${outboundId} was claimed`);
  return gateway.acknowledgeOutbound(outboundId, undefined, { leaseId: item.leaseId, tokenId: helper.tokenId, parts: partIds, partCount: partIds.length });
}

/**
 * A milestone a session offered and the Master approved, waiting for the helper.
 * @param {string} id - Candidate id.
 * @param {string} [kind='milestone'] - Candidate kind.
 * @returns {number} The outbound item's id.
 */
function approvedCandidate(id, kind = 'milestone') {
  const project = store.projects.create({ name: `Source-${id}`, path: path.join(tmpDir, id) });
  const bound = bindProject(project);
  const text = `Milestone ${id} reached.`;
  bridgeStore.candidates.submit({
    candidateId: id, idemKey: `cand:${id}`, kind, sourceProjectId: project.id, sourceLaunchId: bound.launchId, text,
    receipts: [{ kind: 'workload', id: '1', digest: 'a'.repeat(64) }], at: clock
  });
  const result = bridgeStore.applyCandidateWrite({
    op: 'candidate-approve', requestId: `req-approve-${id}`, candidateId: id, expectedVersion: 1, masterGeneration: 1, at: clock,
    change: () => ({ state: 'approved', outbound: { idemKey: `candidate:${id}`, kind: 'candidate', sourceLabel: 'Project Master', text, digest: bridgeStore.digest(text), releasedGeneration: 1 } })
  });
  assert.equal(result.outcome, 'applied');
  return store.getDb().prepare('SELECT outbound_id FROM bridge_outbound WHERE candidate_id = ?').get(id).outbound_id;
}

/**
 * An operator message addressed to a project, answered by the Master.
 * @param {string} externalId - The operator's message id.
 * @param {object} project - The project it is addressed to.
 * @returns {Promise<{routeId: string, outboundId: number}>}
 */
async function answeredRoute(externalId, project) {
  const accepted = await operatorSays(externalId, `@${project.name} how is it going?`);
  const route = bridgeStore.routes.get(accepted.body.routeId);
  const text = 'It is going well.';
  const result = bridgeStore.applyRouteWrite({
    op: 'answer', requestId: `req-answer-${externalId}`, routeId: route.routeId, expectedVersion: route.version, actor: 'master', proof: 'master-launch',
    masterGeneration: 1, at: clock,
    change: () => ({ set: { state: 'released' }, outbound: { idemKey: `route:${route.routeId}:answer`, kind: 'reply', sourceLabel: 'Project Master', text, digest: bridgeStore.digest(text), releasedGeneration: 1 } })
  });
  assert.equal(result.outcome, 'applied');
  const item = store.getDb().prepare("SELECT outbound_id FROM bridge_outbound WHERE route_id = ? AND kind = 'reply'").get(route.routeId);
  return { routeId: route.routeId, outboundId: item.outbound_id };
}

/**
 * A route as it stands after the gateway has carried it as far as it can.
 * @param {{body: {routeId: string}}} accepted - What accepting the message returned.
 * @returns {Promise<object>}
 */
async function carried(accepted) {
  await gateway.advance(accepted.body.routeId);
  return bridgeStore.routes.get(accepted.body.routeId);
}

describe('bridge: what an operator\'s reply answers (#2031)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bridge-reply-'));
    store._setBasePath(tmpDir);
    store.init();
    clock = '2026-10-04T00:00:00.000Z';
    seq = 0;
    hub = install();
    realDeps = { ...gateway._deps };
    let n = 0;
    Object.assign(gateway._deps, {
      master: () => ({
        masterLiveness: () => ({ live: true, answered: true, cause: null }),
        ensureMasterSession: () => ({ created: false }),
        getMasterMedusaStatus: () => ({ workspaceId: MASTER_WS }),
        masterListenerEnabled: () => true
      }),
      now: () => clock,
      id: (prefix) => `${prefix}_${++n}`
    });
    realExchangeNow = exchanges._internal.now;
    exchanges._internal.now = () => new Date(clock);
    gateway._reset();
    bridgeStore.settings.set('enabled', 'true');
    bridgeStore.settings.set('allow.author', ALLOWED.authorId);
    bridgeStore.settings.set('allow.space', ALLOWED.spaceId);
    bridgeStore.settings.set('allow.channel', ALLOWED.channelId);
    helper = { tokenId: gateway.mintHelperToken().tokenId };
  });

  afterEach(() => {
    Object.assign(gateway._deps, realDeps);
    exchanges._internal.now = realExchangeNow;
    hub.restore();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('recording what was posted', () => {
    it('records every message of an item against it, with what the item was, taken from the item', () => {
      const id = approvedCandidate('c1');
      const done = posted(id, ['d100', 'd101', 'd102']);
      assert.deepEqual([done.status, done.body.state, done.body.replayed, done.body.parts], [200, 'delivered', false, 3]);
      assert.equal(bridgeStore.outbound.get(id).deliveredRef, 'd100', 'the first message is the item\'s reference');
      assert.deepEqual(bridgeStore.parts.forItem(id), ['d100', 'd101', 'd102']);
      assert.deepEqual(bridgeStore.parts.find('d101'), {
        externalId: 'd101', canonicalExternalId: 'd100', outboundId: id, partIndex: 1, partCount: 3,
        kind: 'candidate', notifyType: null, routeId: null, candidateId: 'c1', candidateKind: 'milestone', questionId: null
      });
      assert.equal(bridgeStore.parts.find('d999'), null);
    });

    it('a single message is the common case, by either way of naming it', () => {
      const [a, b] = [approvedCandidate('c1'), approvedCandidate('c2')];
      const [item] = gateway.claimOutbound(helper, 'claim-nonce-single-0001', { limit: 1 }).body.items;
      assert.equal(gateway.acknowledgeOutbound(a, 'd200', { leaseId: item.leaseId, tokenId: helper.tokenId }).status, 200);
      assert.equal(posted(b, ['d201']).status, 200);
      assert.deepEqual([bridgeStore.parts.find('d200').partCount, bridgeStore.parts.find('d201').partCount], [1, 1]);
    });

    it('repeating an acknowledgement exactly changes nothing; a different set is refused', () => {
      const id = approvedCandidate('c1');
      const [item] = gateway.claimOutbound(helper, 'claim-nonce-replay-0001').body.items;
      const ack = (parts, partCount = parts.length) => gateway.acknowledgeOutbound(id, undefined, { leaseId: item.leaseId, tokenId: helper.tokenId, parts, partCount });
      assert.equal(ack(['d100', 'd101']).body.replayed, false);
      assert.equal(ack(['d100', 'd101']).body.replayed, true);
      for (const other of [['d100'], ['d101', 'd100'], ['d100', 'd101', 'd102'], ['d100', 'd109']]) {
        const refused = ack(other);
        assert.deepEqual([refused.status, refused.body.code], [409, 'ACK_MISMATCH'], other.join(','));
      }
      assert.deepEqual(bridgeStore.parts.forItem(id), ['d100', 'd101'], 'what was recorded stands');
    });

    it('a set that is not whole delivers nothing', () => {
      const id = approvedCandidate('c1');
      const [item] = gateway.claimOutbound(helper, 'claim-nonce-partial-0001').body.items;
      const ack = (over, ref) => gateway.acknowledgeOutbound(id, ref, { leaseId: item.leaseId, tokenId: helper.tokenId, ...over });
      const invalid = [
        ack({ parts: ['d100', 'd101'], partCount: 3 }), ack({ parts: ['d100', 'd101'] }), ack({ parts: [], partCount: 0 }),
        ack({ parts: ['d100', 'd100'], partCount: 2 }), ack({ parts: ['d100', 'bad id!'], partCount: 2 }), ack({ parts: 'd100', partCount: 1 }),
        ack({ parts: ['d100', 'd101'], partCount: 2 }, 'd101'), ack({ parts: Array.from({ length: bridgeStore.MAX_PARTS + 1 }, (_, i) => `d${i}`), partCount: bridgeStore.MAX_PARTS + 1 }),
        ack({})
      ];
      for (const refused of invalid) assert.deepEqual([refused.status, refused.body.code], [400, 'BAD_ACK']);
      assert.equal(bridgeStore.outbound.get(id).state, 'ready');
      assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_outbound_parts').get().n, 0);
      assert.equal(store.getDb().prepare("SELECT state FROM bridge_outbound_leases WHERE lease_id = ?").get(item.leaseId).state, 'live', 'and the lease is not spent');
    });

    it('a message id the bridge already knows as something else cannot be a part', async () => {
      const [a, b] = [approvedCandidate('c1'), approvedCandidate('c2')];
      await operatorSays('m1', 'hello');
      const claimed = gateway.claimOutbound(helper, 'claim-nonce-collide-0001').body.items;
      const lease = (id) => claimed.find((i) => i.outboundId === id).leaseId;
      const first = gateway.acknowledgeOutbound(a, undefined, { leaseId: lease(a), tokenId: helper.tokenId, parts: ['d100', 'd101'], partCount: 2 });
      assert.equal(first.status, 200);
      const ack = (parts) => gateway.acknowledgeOutbound(b, undefined, { leaseId: lease(b), tokenId: helper.tokenId, parts, partCount: parts.length });
      for (const parts of [['d101'], ['d300', 'd100'], ['m1']]) {
        const refused = ack(parts);
        assert.deepEqual([refused.status, refused.body.code], [409, 'PART_ID_COLLISION'], parts.join(','));
      }
      assert.equal(bridgeStore.outbound.get(b).state, 'ready');
      assert.deepEqual(bridgeStore.parts.forItem(b), [], 'nothing of a refused set is recorded');
      assert.equal(ack(['d300', 'd301']).status, 200);

      const echoed = await operatorSays('d300', 'hello again');
      assert.deepEqual([echoed.status, echoed.body.code], [409, 'EXTERNAL_ID_COLLISION'], 'and an operator message cannot carry a posted message\'s id');
    });

    it('only the lease\'s own token records anything', () => {
      const id = approvedCandidate('c1');
      const [item] = gateway.claimOutbound(helper, 'claim-nonce-token-0001').body.items;
      const stolen = gateway.acknowledgeOutbound(id, undefined, { leaseId: item.leaseId, tokenId: 'bht_another', parts: ['d100', 'd101'], partCount: 2 });
      assert.deepEqual([stolen.status, stolen.body.code], [403, 'LEASE_NOT_YOURS']);
      assert.equal(bridgeStore.parts.find('d100'), null);
    });

    it('the record cannot be rewritten', () => {
      const id = approvedCandidate('c1');
      posted(id, ['d100', 'd101']);
      const db = store.getDb();
      assert.throws(() => db.exec("UPDATE bridge_outbound_parts SET outbound_id = 99 WHERE part_external_id = 'd100'"), /immutable/);
      assert.throws(() => db.exec("INSERT INTO bridge_outbound_parts (part_external_id, outbound_id, part_index, part_count, kind, delivered_at) VALUES ('d100', 1, 0, 1, 'reply', 'x')"), /UNIQUE/);
      assert.throws(() => db.exec(`INSERT INTO bridge_outbound_parts (part_external_id, outbound_id, part_index, part_count, kind, delivered_at) VALUES ('d500', ${id}, 1, 2, 'candidate', 'x')`), /UNIQUE/);
      assert.throws(() => db.exec("INSERT INTO bridge_outbound_parts (part_external_id, outbound_id, part_index, part_count, kind, delivered_at) VALUES ('d501', 9999, 0, 1, 'reply', 'x')"), /needs its item/);
      assert.throws(() => db.exec(`INSERT INTO bridge_outbound_parts (part_external_id, outbound_id, part_index, part_count, kind, delivered_at) VALUES ('d502', ${id}, 2, 2, 'candidate', 'x')`), /CHECK/);
    });
  });

  describe('a reply to a milestone', () => {
    it('goes to the Master as a reply to that milestone, from any of its parts', async () => {
      const id = approvedCandidate('c1');
      posted(id, ['d100', 'd101', 'd102']);
      const candidateBefore = bridgeStore.candidates.get('c1');
      const waitingBefore = bridgeStore.outbound.ready().length;

      for (const [index, part] of [[0, 'd100'], [1, 'd101'], [2, 'd102']]) {
        const route = await carried(await operatorSays(`m${index}`, 'good, what is next?', { replyToExternalId: part }));
        assert.deepEqual([suggestedBy(route), route.destination.kind, route.destination.projectId], ['outbound-correlation', 'master', null], part);
        assert.deepEqual(route.replyContext, {
          repliedExternalId: part, canonicalExternalId: 'd100', outboundId: id, partIndex: index, partCount: 3,
          kind: 'candidate', notifyType: null, routeId: null, candidateId: 'c1', candidateKind: 'milestone', questionId: null
        });
        assert.equal(bridgeStore.routes.body(route.routeId, 'inbound').text, 'good, what is next?', 'the Master can read what was said');
      }
      assert.deepEqual(bridgeStore.candidates.get('c1'), candidateBefore, 'the milestone itself is untouched');
      assert.equal(bridgeStore.outbound.ready().length, waitingBefore, 'and nothing was released again');
      assert.deepEqual(hub.fromGateway(), [], 'the gateway sent no session anything: the Master is told, and reads the route');
    });

    it('is not an unaddressed message: it resolves differently, and a conversation pin does not divert it', async () => {
      const alpha = hub.liveProject('Alpha', tmpDir);
      bridgeStore.pins.setGlobal({ pinId: 'p1', conversationKey: null, destination: { kind: 'project', projectId: alpha.project.id }, at: clock });
      posted(approvedCandidate('c1'), ['d100']);

      const plain = await carried(await operatorSays('m1', 'hello'));
      assert.deepEqual([suggestedBy(plain), plain.destination.kind, plain.replyContext], ['pin', 'project', null]);
      const reply = await carried(await operatorSays('m2', 'hello', { replyToExternalId: 'd100' }));
      assert.deepEqual([suggestedBy(reply), reply.destination.kind, reply.replyContext.candidateId], ['outbound-correlation', 'master', 'c1']);

      // An explicit address still wins, and what the message answers is still on record.
      const addressed = await carried(await operatorSays('m3', '@alpha look at this', { replyToExternalId: 'd100' }));
      assert.deepEqual([suggestedBy(addressed), addressed.destination.projectId, addressed.replyContext.candidateId], ['alias', alpha.project.id, 'c1']);
    });

    it('an explicit address that names nothing, or more than one thing, is not guessed at: the reply waits for the Master, still knowing what it answers', async () => {
      hub.liveProject('Alpha', tmpDir);
      const beta = store.projects.create({ name: 'Beta', path: path.join(tmpDir, 'beta') });
      bridgeStore.aliases.set('beta', { kind: 'master' }, { at: clock });
      posted(approvedCandidate('c1'), ['d100']);

      for (const [id, text, code] of [['m1', '@nobody look at this', 'address-unresolved'], ['m2', '@beta look at this', 'address-ambiguous']]) {
        const route = await carried(await operatorSays(id, text, { replyToExternalId: 'd100' }));
        assert.deepEqual([route.state, route.failureCode, suggestedBy(route), route.destination], ['awaiting-master', code, null, null], text);
        assert.equal(route.replyContext.candidateId, 'c1', 'what it answers is kept either way');
      }
      assert.deepEqual(hub.fromGateway(), [], 'nothing was sent anywhere on a guess');
      assert.ok(beta.id);
    });

    it('tells the Master what the message answers', async () => {
      posted(approvedCandidate('c1'), ['d100']);
      const accepted = await operatorSays('m1', 'thanks', { replyToExternalId: 'd100' });
      await gateway.tick();
      const told = hub.system.filter((m) => m.message.includes(accepted.body.routeId));
      // Told when the route waited for its decision, and again when it was the Master's own to answer: both say what it answers.
      assert.equal(told.length, 2);
      for (const notice of told) {
        assert.match(notice.message, /It is the operator's reply to a posted milestone\./);
        assert.ok(!notice.message.includes('thanks'), 'the notice carries no text of the message');
      }
    });

    it('the same holds for a notification, which has no candidate either', async () => {
      const text = 'Alpha reports its work is blocked.';
      const id = bridgeStore.outbound.enqueue({
        idemKey: 'notify:work-blocked:1', kind: 'notification', notifyType: 'work-blocked', sourceLabel: 'TangleClaw', text, digest: bridgeStore.digest(text), at: clock
      }).outboundId;
      posted(id, ['d100']);
      const route = await carried(await operatorSays('m1', 'which one?', { replyToExternalId: 'd100' }));
      assert.deepEqual([route.destination.kind, route.replyContext.kind, route.replyContext.notifyType, route.replyContext.candidateId],
        ['master', 'notification', 'work-blocked', null]);
    });
  });

  describe('a reply to an answer', () => {
    it('goes where the answer\'s route went, from any of its parts, as it always did from the first', async () => {
      const alpha = hub.liveProject('Alpha', tmpDir);
      const { routeId, outboundId } = await answeredRoute('m1', alpha.project);
      assert.equal(posted(outboundId, ['d100', 'd101', 'd102']).status, 200);
      assert.equal(bridgeStore.routes.get(routeId).state, 'closed');

      for (const [index, part] of [[0, 'd100'], [1, 'd101'], [2, 'd102']]) {
        const route = await carried(await operatorSays(`r${index}`, 'and then?', { replyToExternalId: part }));
        assert.deepEqual([suggestedBy(route), route.destination.kind, route.destination.projectId], ['reply-inheritance', 'project', alpha.project.id], part);
        assert.deepEqual([route.replyContext.routeId, route.replyContext.kind, route.replyContext.partIndex, route.replyContext.candidateId], [routeId, 'reply', index, null]);
      }
      // And a reply to the operator's own earlier message, as before.
      const own = await carried(await operatorSays('r9', 'one more thing', { replyToExternalId: 'm1' }));
      assert.deepEqual([suggestedBy(own), own.destination.projectId, own.replyContext], ['reply-inheritance', alpha.project.id, null]);
    });
  });

  describe('a reply to something the bridge does not know', () => {
    it('is an unaddressed message, as before, with nothing invented about what it answers', async () => {
      posted(approvedCandidate('c1'), ['d100']);
      const route = await carried(await operatorSays('m1', 'hello', { replyToExternalId: 'd999' }));
      assert.deepEqual([suggestedBy(route), route.destination.kind, route.replyContext], ['default', 'master', null]);
      assert.equal(route.context.replyToExternalId, 'd999', 'the reference itself is kept');
      assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_route_reply_context').get().n, 0);
    });

    it('a message from anyone else is refused before anything is recorded, whatever it claims to answer', async () => {
      posted(approvedCandidate('c1'), ['d100']);
      const refused = await operatorSays('m1', 'let me in', { authorId: 'stranger', replyToExternalId: 'd100' });
      assert.deepEqual([refused.status, refused.body.code], [403, 'NOT_ALLOWLISTED']);
      assert.equal(bridgeStore.routes.getByExternalId('m1'), null);
      assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_route_reply_context').get().n, 0);
    });
  });

  describe('how long it lasts', () => {
    it('what a message answers is fixed when it arrives, and a replay does not change it', async () => {
      posted(approvedCandidate('c1'), ['d100', 'd101']);
      const first = await operatorSays('m1', 'thanks', { replyToExternalId: 'd101' });
      const again = await operatorSays('m1', 'thanks', { replyToExternalId: 'd101' });
      assert.deepEqual([first.status, again.status, again.body.routeId, again.body.replayed], [202, 200, first.body.routeId, true]);
      const other = await operatorSays('m1', 'thanks', { replyToExternalId: 'd100' });
      assert.equal(other.body.code, 'EXTERNAL_ID_MISMATCH', 'the same message answering something else is not a replay');
      assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_route_reply_context').get().n, 1);
      assert.throws(() => store.getDb().exec('UPDATE bridge_route_reply_context SET part_index = 0'), /immutable/);
    });

    it('survives a restart, and outlives the item it was a part of', async () => {
      const alpha = hub.liveProject('Alpha', tmpDir);
      const { routeId, outboundId } = await answeredRoute('m1', alpha.project);
      posted(outboundId, ['d100', 'd101']);
      const milestone = approvedCandidate('c1');
      posted(milestone, ['d200', 'd201']);

      store.close();
      store._setBasePath(tmpDir);
      store.init();
      assert.equal(bridgeStore.parts.find('d201').candidateId, 'c1', 'after a restart');

      // A year on: the closed route, its answer, the milestone's item and the candidate are all gone.
      later(400 * DAY);
      bridgeStore.prune({ now: clock });
      bridgeStore.prune({ now: clock });
      assert.equal(bridgeStore.routes.get(routeId), null);
      assert.equal(bridgeStore.outbound.get(outboundId), null);
      assert.equal(bridgeStore.outbound.get(milestone), null);
      assert.equal(bridgeStore.candidates.get('c1'), null);
      assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_outbound_parts').get().n, 4, 'the record of what was posted is still whole');

      const late = await carried(await operatorSays('m9', 'about that milestone', { replyToExternalId: 'd201' }));
      assert.deepEqual([suggestedBy(late), late.destination.kind, late.replyContext.candidateId, late.replyContext.candidateKind, late.replyContext.partIndex],
        ['outbound-correlation', 'master', 'c1', 'milestone', 1]);
      // The answer's route is no longer held, so there is nowhere to inherit: the Master gets it, knowing what it answered.
      const stale = await carried(await operatorSays('m10', 'about that answer', { replyToExternalId: 'd101' }));
      assert.deepEqual([suggestedBy(stale), stale.destination.kind, stale.replyContext.routeId, stale.replyContext.kind], ['outbound-correlation', 'master', routeId, 'reply']);
    });

    it('what a message answers leaves with the message\'s own route, and not before', async () => {
      posted(approvedCandidate('c1'), ['d100']);
      const accepted = await operatorSays('m1', 'thanks', { replyToExternalId: 'd100' });
      const count = () => store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_route_reply_context').get().n;
      later(400 * DAY);
      bridgeStore.prune({ now: clock });
      assert.equal(count(), 1, 'an open route keeps it, whatever its age');
      store.getDb().prepare('DELETE FROM bridge_routes WHERE route_id = ?').run(accepted.body.routeId);
      assert.equal(count(), 0);
    });
  });
});
