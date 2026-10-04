'use strict';

// #2031 (ADR 0023): the operator bridge's gateway, driven through its real
// store, real project, session and launch rows, and the real tracked-send
// path; only the Hub's wire, the Master pane and the clock are stand-ins. A
// message goes in from the helper, to its destination, and comes back held;
// nothing a destination says is relayed until Master releases it; and only the
// exact session the message was sent to can answer it.

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
const { install, GATEWAY_WS, MASTER_WS } = require('./_bridge-hub');

const ALLOWED = { authorId: 'author1', spaceId: 'space1', channelId: 'chan1' };

let tmpDir;
let clock;
let hub;
let masterState;
let realDeps;
let realExchangeNow;

/**
 * A project with a live, launch-bound session and a workspace.
 * @param {string} name - Project name.
 * @returns {{project: object, sessionId: number, launchId: string, workspaceId: string}}
 */
function liveProject(name) {
  return hub.liveProject(name, tmpDir);
}

/**
 * The reason each arrival was dropped, in order.
 * @returns {string[]}
 */
function dropReasons() {
  return gateway.droppedArrivals().recent.map((d) => d.reason);
}

/**
 * An inbound message from the allowlisted operator.
 * @param {string} externalId - Chat message id.
 * @param {string} text - Message text.
 * @param {object} [over] - Field overrides.
 * @returns {Promise<{status: number, body: object}>}
 */
function operatorSays(externalId, text, over = {}) {
  return gateway.acceptInbound({ externalId, ...ALLOWED, text, ...over });
}

/**
 * The helper token in force, minting one when there is none.
 * @returns {{tokenId: string}}
 */
function helper() {
  return bridgeStore.helperTokens.active() || gateway.mintHelperToken();
}

/**
 * What waits to be posted, oldest first, without claiming any of it.
 * @returns {object[]}
 */
function waitingForHelper() {
  return bridgeStore.outbound.ready().map((item) => ({
    outboundId: item.outboundId, kind: item.kind, sourceLabel: item.sourceLabel, text: item.text,
    inReplyTo: item.routeId ? { externalId: bridgeStore.routes.get(item.routeId).externalId } : null
  }));
}

let claimSeq = 0;

/**
 * Collect what waits, as the helper does.
 * @param {object} [options] - `limit`, and `nonce` to repeat a claim.
 * @returns {{status: number, body: object}}
 */
function helperClaims(options = {}) {
  return gateway.claimOutbound(helper(), options.nonce || `claim-nonce-${String(++claimSeq).padStart(8, '0')}`, { limit: options.limit });
}

/**
 * Acknowledge a claimed item under its lease.
 * @param {{outboundId: number, leaseId: string}} item - A claimed item.
 * @param {string} deliveredRef - The chat's id for the post.
 * @returns {{status: number, body: object}}
 */
function helperAcks(item, deliveredRef) {
  return gateway.acknowledgeOutbound(item.outboundId, deliveredRef, { leaseId: item.leaseId, tokenId: helper().tokenId });
}

/**
 * Advance the stand-in clock.
 * @param {number} ms - Milliseconds.
 * @returns {void}
 */
function later(ms) {
  clock = new Date(Date.parse(clock) + ms).toISOString();
}

describe('bridge gateway (#2031)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bridge-gateway-'));
    store._setBasePath(tmpDir);
    store.init();
    clock = '2026-10-04T00:00:00.000Z';
    hub = install();
    masterState = { live: true, ensures: 0, ensureError: null, listening: true };
    realDeps = { ...gateway._deps };
    let n = 0;
    Object.assign(gateway._deps, {
      master: () => ({
        masterLiveness: () => ({ live: masterState.live, answered: true, cause: null }),
        ensureMasterSession: () => {
          masterState.ensures += 1;
          if (masterState.ensureError) return { created: false, error: masterState.ensureError };
          masterState.live = true;
          return { created: true };
        },
        getMasterMedusaStatus: () => ({ workspaceId: masterState.listening ? MASTER_WS : null }),
        masterListenerEnabled: () => true
      }),
      now: () => clock,
      id: (prefix) => `${prefix}_${++n}`
    });
    // One clock for the gateway and for the exchange rows it reads the age of.
    realExchangeNow = exchanges._internal.now;
    exchanges._internal.now = () => new Date(clock);
    gateway._reset();
    bridgeStore.settings.set('enabled', 'true');
    bridgeStore.settings.set('allow.author', ALLOWED.authorId);
    bridgeStore.settings.set('allow.space', ALLOWED.spaceId);
    bridgeStore.settings.set('allow.channel', ALLOWED.channelId);
  });

  afterEach(() => {
    Object.assign(gateway._deps, realDeps);
    exchanges._internal.now = realExchangeNow;
    hub.restore();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('accepting', () => {
    it('accepts nothing while disabled, and stores nothing', async () => {
      bridgeStore.settings.set('enabled', 'false');
      const r = await operatorSays('m1', 'hello');
      assert.deepEqual([r.status, r.body.code], [409, 'BRIDGE_DISABLED']);
      assert.equal(bridgeStore.routes.list().length, 0);
      assert.equal(masterState.ensures, 0, 'a disabled bridge cannot launch the Master');
    });

    it('refuses anyone but the allowlisted author, space and channel, keeping none of the message', async () => {
      for (const over of [{ authorId: 'someone' }, { spaceId: 'elsewhere' }, { channelId: 'other' }]) {
        const r = await operatorSays('m1', 'secret text', over);
        assert.deepEqual([r.status, r.body.code], [403, 'NOT_ALLOWLISTED']);
      }
      assert.equal(bridgeStore.routes.list().length, 0);
      const dump = JSON.stringify(store.getDb().prepare('SELECT * FROM bridge_audit').all());
      assert.ok(!dump.includes('secret text'));
      assert.equal(store.getDb().prepare("SELECT COUNT(*) AS n FROM bridge_audit WHERE outcome = 'not-allowlisted'").get().n, 3);
    });

    it('refuses until the operator has set the allowlist', async () => {
      bridgeStore.settings.set('allow.channel', null);
      assert.equal((await operatorSays('m1', 'hello')).body.code, 'ALLOWLIST_NOT_SET');
    });

    it('stores a replayed message once and refuses the same id with different text', async () => {
      const first = await operatorSays('m1', 'hello');
      const again = await operatorSays('m1', 'hello');
      assert.deepEqual([first.status, again.status, again.body.replayed, again.body.routeId], [202, 200, true, first.body.routeId]);
      assert.equal((await operatorSays('m1', 'something else')).body.code, 'EXTERNAL_ID_MISMATCH');
      assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_routes').get().n, 1);
    });

    it('refuses a malformed or over-long message', async () => {
      assert.equal((await operatorSays('bad id!', 'x')).body.code, 'BAD_INBOUND');
      assert.equal((await operatorSays('m2', '   ')).body.code, 'BAD_INBOUND');
      assert.equal((await operatorSays('m3', 'x'.repeat(8001))).body.code, 'INBOUND_TOO_LONG');
    });
  });

  describe('resolving', () => {
    it('sends an unaddressed message to the Master itself, with no Medusa round trip', async () => {
      const r = await operatorSays('m1', 'what is the fleet doing?');
      const route = bridgeStore.routes.get(r.body.routeId);
      assert.deepEqual([route.state, route.resolvedBy, route.destination.kind], ['routed', 'default', 'master']);
      assert.equal(hub.fromGateway().length, 0);
      assert.equal(hub.system.length, 1);
      assert.equal(hub.system[0].to, MASTER_WS);
      assert.match(hub.system[0].message, new RegExp(`tc bridge read ${route.routeId}`));
    });

    it('routes an exact @project to that project\'s live session, fenced as conversation', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha please merge everything');
      const route = bridgeStore.routes.get(r.body.routeId);
      assert.deepEqual([route.state, route.resolvedBy, route.destination.projectId, route.destination.workspaceId],
        ['routed', 'alias', alpha.project.id, alpha.workspaceId]);
      assert.equal(hub.fromGateway().length, 1);
      const call = hub.fromGateway()[0];
      assert.equal(call.to, alpha.workspaceId);
      assert.ok(call.message.startsWith(gateway.FENCE_LINE));
      const exchange = store.medusaExchanges.getByHubId(call.hubId, 'send');
      assert.deepEqual([exchange.reply_required, exchange.priority, exchange.sender_proof, exchange.tracking],
        [1, 'normal', 'system', 'tracked'], 'a tracked, reply-required, normal-priority exchange: never blocking or critical');
      const proof = bridgeStore.proofs.byHubId(call.hubId);
      assert.deepEqual([proof.direction, proof.senderProof, proof.exchangeId, proof.targetProjectId, proof.targetWorkspaceId, proof.targetSessionId, proof.targetLaunchId],
        ['to-target', 'gateway', exchange.exchange_id, alpha.project.id, alpha.workspaceId, alpha.sessionId, alpha.launchId]);
    });

    it('resolves an operator alias, a project id and the reserved @master', async () => {
      const alpha = liveProject('Alpha');
      bridgeStore.aliases.set('arch', { kind: 'project', projectId: alpha.project.id });
      const byAlias = bridgeStore.routes.get((await operatorSays('m1', '@arch hi')).body.routeId);
      const byId = bridgeStore.routes.get((await operatorSays('m2', `@${alpha.project.id} hi`)).body.routeId);
      const toMaster = bridgeStore.routes.get((await operatorSays('m3', '@Master hi')).body.routeId);
      assert.equal(byAlias.destination.projectId, alpha.project.id);
      assert.equal(byId.destination.projectId, alpha.project.id);
      assert.equal(toMaster.destination.kind, 'master');
    });

    it('never guesses: an unmatched or ambiguous address waits for Master', async () => {
      const alpha = liveProject('Alpha');
      const beta = liveProject('Beta');
      const unknown = bridgeStore.routes.get((await operatorSays('m1', '@nobody hi')).body.routeId);
      assert.deepEqual([unknown.state, unknown.failureCode, unknown.destination], ['awaiting-master', 'address-unresolved', null]);

      // An alias spelled like one project and pointing at another names two destinations.
      bridgeStore.aliases.set('alpha', { kind: 'project', projectId: beta.project.id });
      const ambiguous = bridgeStore.routes.get((await operatorSays('m2', '@alpha hi')).body.routeId);
      assert.deepEqual([ambiguous.state, ambiguous.failureCode], ['awaiting-master', 'address-ambiguous']);
      assert.equal(hub.fromGateway().length, 0);
      assert.ok(alpha.project.id !== beta.project.id);
    });

    it('does not read a chat mention or a mid-sentence @ as an address', async () => {
      liveProject('Alpha');
      const mention = bridgeStore.routes.get((await operatorSays('m1', '<@12345> hello')).body.routeId);
      const middle = bridgeStore.routes.get((await operatorSays('m2', 'ask @alpha about it')).body.routeId);
      assert.equal(mention.resolvedBy, 'default');
      assert.equal(middle.resolvedBy, 'default');
    });

    it('a reply inherits its route; a pin outranks the default; the operator\'s pin outranks Master\'s', async () => {
      const alpha = liveProject('Alpha');
      const beta = liveProject('Beta');
      await operatorSays('m1', '@alpha first');
      const reply = bridgeStore.routes.get((await operatorSays('m2', 'and another thing', { replyToExternalId: 'm1' })).body.routeId);
      assert.deepEqual([reply.resolvedBy, reply.destination.projectId], ['reply-inheritance', alpha.project.id]);

      bridgeStore.pins.setConversation({ pinId: 'p1', conversationKey: 'chan1', destination: { kind: 'project', projectId: alpha.project.id }, masterGeneration: 1 });
      const pinned = bridgeStore.routes.get((await operatorSays('m3', 'unaddressed')).body.routeId);
      assert.deepEqual([pinned.resolvedBy, pinned.destination.projectId], ['pin', alpha.project.id]);

      bridgeStore.pins.setGlobal({ pinId: 'p2', conversationKey: 'chan1', destination: { kind: 'project', projectId: beta.project.id } });
      const operatorPinned = bridgeStore.routes.get((await operatorSays('m4', 'unaddressed')).body.routeId);
      assert.equal(operatorPinned.destination.projectId, beta.project.id);
    });

    it('a destination fixed on a waiting route is not moved by a later pin', async () => {
      const alpha = liveProject('Alpha');
      const beta = liveProject('Beta');
      const r = await operatorSays('m1', '@alpha first');
      bridgeStore.pins.setGlobal({ pinId: 'p1', conversationKey: null, destination: { kind: 'project', projectId: beta.project.id } });
      await gateway.tick();
      assert.equal(bridgeStore.routes.get(r.body.routeId).destination.projectId, alpha.project.id);
    });
  });

  describe('holding the reply', () => {
    it('holds the destination\'s reply for Master and posts nothing', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha status?');
      const sent = await hub.sessionSends(alpha, { inReplyTo: hub.fromGateway()[0].hubId, text: 'all green' });
      assert.equal(sent.status, 200);
      assert.deepEqual(gateway.drainInbox(), { held: 1, dropped: 0, waiting: 0 });
      await gateway.tick();

      const route = bridgeStore.routes.get(r.body.routeId);
      assert.equal(route.state, 'reply-held');
      assert.equal(bridgeStore.routes.body(route.routeId, 'reply').text, 'all green');
      assert.deepEqual(waitingForHelper(), [], 'nothing reaches the helper before Master releases it');
      assert.deepEqual(hub.handled, [sent.body.id]);
      assert.match(hub.system[hub.system.length - 1].message, /has a reply held for your release/);
      const audit = bridgeStore.audit.forRoute(route.routeId).pop();
      assert.deepEqual([audit.op, audit.actor, audit.proof], ['reply-held', 'session', 'launch']);
      const proof = bridgeStore.proofs.byHubId(sent.body.id);
      assert.deepEqual([proof.direction, proof.senderProof], ['from-target', 'launch']);
    });

    it('captures a reply once, however often it is seen', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha status?');
      const sent = await hub.sessionSends(alpha, { inReplyTo: hub.fromGateway()[0].hubId });
      gateway.drainInbox();
      hub.inbox.push({ id: sent.body.id, from: alpha.workspaceId, message: 'the answer' });
      gateway.drainInbox();
      const route = bridgeStore.routes.get(r.body.routeId);
      assert.equal(route.version, 4, 'resolve, dispatch, reply-held: no fourth write');
      assert.equal(bridgeStore.audit.forRoute(route.routeId).filter((a) => a.op === 'reply-held').length, 1);
    });

    it('does not accept a reply from another live session of the same project', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha status?');
      // Verified, launch-bound, in the right project, answering the right
      // message: everything but being the session it was sent to.
      const target = alpha;
      const sibling = hub.anotherSession(alpha.project);
      const sent = await hub.sessionSends(sibling, { inReplyTo: hub.fromGateway()[0].hubId });
      assert.equal(sent.status, 200, 'the Medusa layer accepts it: both sessions belong to the project');
      assert.equal(gateway.drainInbox().dropped, 1);
      assert.deepEqual(dropReasons(), ['sender-is-another-session']);
      assert.equal(bridgeStore.routes.get(r.body.routeId).state, 'routed');
      assert.ok(target.sessionId !== sibling.sessionId);
    });

    it('does not accept a reply from the target after its session was relaunched', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha status?');
      // The same session row now runs under a different launch.
      store.getDb().prepare('UPDATE launch_sequences SET launch_id = ? WHERE session_id = ?').run('a-newer-launch', alpha.sessionId);
      await hub.sessionSends(alpha, { inReplyTo: hub.fromGateway()[0].hubId });
      assert.equal(gateway.drainInbox().dropped, 1);
      assert.deepEqual(dropReasons(), ['sender-is-another-launch']);
      assert.equal(bridgeStore.routes.get(r.body.routeId).state, 'routed');
    });

    it('drops, each for its own reason, what is not a reply to the message the bridge sent', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha status?');
      const asked = hub.fromGateway()[0].hubId;

      // An ordinary message to the gateway that answers nothing.
      await hub.sessionSends(alpha, { text: 'unprompted' });
      assert.equal(gateway.drainInbox().dropped, 1);
      // A reply addressed to someone else that reached the gateway's inbox anyway.
      const elsewhere = await hub.sessionSends(alpha, { inReplyTo: asked, to: 'some-other-ws', deliver: false });
      hub.inbox.push({ id: elsewhere.body.id, from: alpha.workspaceId, message: 'the answer' });
      assert.equal(gateway.drainInbox().dropped, 1);
      // A watchdog or escalation notice.
      hub.inbox.push({ id: 'sys-9', from: 'system', message: 'an escalation notice' });
      assert.equal(gateway.drainInbox().dropped, 1);
      // Something with no id at all.
      hub.inbox.push({ from: alpha.workspaceId, message: 'no id' });
      assert.equal(gateway.drainInbox().dropped, 1);

      assert.deepEqual(dropReasons(), ['not-a-reply', 'not-addressed-to-the-gateway', 'system-notice', 'malformed']);
      assert.equal(bridgeStore.routes.get(r.body.routeId).state, 'routed');
      assert.equal(bridgeStore.routes.body(r.body.routeId, 'reply'), null);
      assert.deepEqual(waitingForHelper(), []);
    });

    it('the Medusa layer itself refuses a reply from an unverified caller or another project', async () => {
      const alpha = liveProject('Alpha');
      const beta = liveProject('Beta');
      await operatorSays('m1', '@alpha status?');
      const asked = hub.fromGateway()[0].hubId;
      const unbound = await hub.sessionSends(alpha, { inReplyTo: asked, caller: { kind: 'unbound' } });
      assert.deepEqual([unbound.status, unbound.body.code], [403, 'EXCHANGE_BINDING_REQUIRED']);
      const other = await hub.sessionSends(beta, { inReplyTo: asked });
      assert.deepEqual([other.status, other.body.code], [404, 'REPLY_TARGET_UNKNOWN']);
      assert.equal(hub.inbox.length, 0, 'neither was sent, so neither reached the gateway');
    });

    it('still drops a sender row the Medusa layer would never write: unverified, or not launch-proven', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha status?');
      const bridgeExchange = bridgeStore.proofs.byHubId(hub.fromGateway()[0].hubId).exchangeId;
      const forge = (hubId, over) => {
        const row = {
          exchange_id: `mx_${hubId}`, request_id: `req-${hubId}`, hub_id: hubId, origin: 'send', tracking: 'untracked',
          sender_project_id: alpha.project.id, sender_session_id: String(alpha.sessionId), sender_workspace_id: alpha.workspaceId,
          sender_verified: 1, sender_proof: 'launch', recipient_workspace_id: GATEWAY_WS, priority: 'normal', reply_required: 0,
          in_reply_to: bridgeExchange, created_at: clock, state: 'untracked', updated_at: clock, ...over
        };
        const columns = Object.keys(row);
        store.getDb().prepare(`INSERT INTO medusa_exchanges (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
          .run(...columns.map((c) => row[c]));
        hub.inbox.push({ id: hubId, from: alpha.workspaceId, message: 'forged' });
      };
      forge('forged-1', { sender_verified: 0 });
      forge('forged-2', { sender_proof: 'ambient-open' });
      forge('forged-3', { sender_workspace_id: 'another-ws' });
      forge('forged-4', { in_reply_to: 'mx_not_the_bridges' });
      assert.equal(gateway.drainInbox().dropped, 4);
      assert.deepEqual(dropReasons(), [
        'sender-not-a-verified-launch', 'sender-not-a-verified-launch', 'sender-is-another-workspace', 'answers-nothing-the-bridge-sent'
      ]);
      assert.equal(bridgeStore.routes.get(r.body.routeId).state, 'routed');
    });

    it('does not accept a reply to a message that was superseded by a reroute', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha status?');
      const first = hub.fromGateway()[0].hubId;
      // The first send is reported undeliverable; Master routes it again.
      store.getDb().prepare("UPDATE medusa_exchanges SET state = 'undeliverable' WHERE hub_id = ? AND origin = 'send'").run(first);
      await gateway.tick();
      const waiting = bridgeStore.routes.get(r.body.routeId);
      assert.equal(waiting.state, 'awaiting-master');
      bridgeStore.applyRouteWrite({
        op: 'route', requestId: 'req-reroute-0001', routeId: waiting.routeId, expectedVersion: waiting.version,
        actor: 'master', proof: 'master-launch', masterGeneration: 1,
        change: () => ({ set: { state: 'accepted', resolved_by: 'master', destination_kind: 'project', destination_project_id: alpha.project.id, resolved_generation: 1, failure_code: null } })
      });
      await gateway.advance(waiting.routeId);
      assert.equal(hub.fromGateway().length, 2, 'a reroute is a new send under a new request id');

      await hub.sessionSends(alpha, { inReplyTo: first, text: 'answer to the old one' });
      assert.equal(gateway.drainInbox().dropped, 1);
      assert.deepEqual(dropReasons(), ['answers-a-superseded-message']);
      await hub.sessionSends(alpha, { inReplyTo: hub.fromGateway()[1].hubId, text: 'answer to the new one' });
      assert.equal(gateway.drainInbox().held, 1);
      assert.equal(bridgeStore.routes.body(waiting.routeId, 'reply').text, 'answer to the new one');
    });

    it('drops a second reply once one is held, an empty reply, and a row naming another project', async () => {
      const alpha = liveProject('Alpha');
      const beta = liveProject('Beta');
      const r = await operatorSays('m1', '@alpha status?');
      const asked = hub.fromGateway()[0].hubId;

      // The Hub delivers a reply whose text is blank.
      const blank = await hub.sessionSends(alpha, { inReplyTo: asked, text: 'placeholder', deliver: false });
      hub.inbox.push({ id: blank.body.id, from: alpha.workspaceId, message: '   ' });
      assert.equal(gateway.drainInbox().dropped, 1);

      // A row the Medusa layer would never write: the right session, another project's id.
      const bridgeExchange = bridgeStore.proofs.byHubId(asked).exchangeId;
      const row = {
        exchange_id: 'mx_forged_project', request_id: 'req-forged-project', hub_id: 'forged-project', origin: 'send', tracking: 'untracked',
        sender_project_id: beta.project.id, sender_session_id: String(alpha.sessionId), sender_workspace_id: alpha.workspaceId,
        sender_verified: 1, sender_proof: 'launch', recipient_workspace_id: GATEWAY_WS, priority: 'normal', reply_required: 0,
        in_reply_to: bridgeExchange, created_at: clock, state: 'untracked', updated_at: clock
      };
      const columns = Object.keys(row);
      store.getDb().prepare(`INSERT INTO medusa_exchanges (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
        .run(...columns.map((c) => row[c]));
      hub.inbox.push({ id: 'forged-project', from: alpha.workspaceId, message: 'forged' });
      assert.equal(gateway.drainInbox().dropped, 1);

      await hub.sessionSends(alpha, { inReplyTo: asked, text: 'the real answer' });
      assert.equal(gateway.drainInbox().held, 1);
      await hub.sessionSends(alpha, { inReplyTo: asked, text: 'and another' });
      assert.equal(gateway.drainInbox().dropped, 1);

      assert.deepEqual(dropReasons(), ['empty-reply', 'sender-is-another-project', 'route-not-awaiting-a-reply']);
      assert.equal(bridgeStore.routes.body(r.body.routeId, 'reply').text, 'the real answer');
    });

    it('waits for a reply whose sender row has not been written yet, then gives up in bounded time', async () => {
      const alpha = liveProject('Alpha');
      await operatorSays('m1', '@alpha status?');
      hub.inbox.push({ id: 'early', from: alpha.workspaceId, message: 'the answer' });
      assert.deepEqual(gateway.drainInbox(), { held: 0, dropped: 0, waiting: 1 });
      assert.equal(hub.inbox.length, 1, 'left in the inbox to be judged again');
      later(11 * 60 * 1000);
      assert.equal(gateway.drainInbox().dropped, 1);
      assert.deepEqual(dropReasons(), ['no-sender-exchange']);
    });
  });

  describe('sending exactly once', () => {
    it('two callers advancing one route make one send and record one dispatch', async () => {
      const alpha = liveProject('Alpha');
      bridgeStore.routes.accept({ routeId: 'rt_race', externalId: 'm9', ...ALLOWED, text: '@alpha once only', digest: bridgeStore.digest('@alpha once only'), at: clock });
      const [a, b] = await Promise.all([gateway.advance('rt_race'), gateway.advance('rt_race'), gateway.tick()]);
      assert.equal(hub.fromGateway().length, 1);
      assert.deepEqual([a.state, b.state], ['routed', 'routed']);
      const audit = bridgeStore.audit.forRoute('rt_race');
      assert.deepEqual(audit.filter((x) => x.outcome === 'applied').map((x) => x.op), ['resolve', 'dispatch']);
      assert.equal(waitingForHelper().length, 0, 'no failure notice for a send that worked');
      assert.ok(alpha.sessionId);
    });

    it('adopts a send that completed before the server stopped, and does not send it again', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha hello');
      const routeId = r.body.routeId;
      const first = hub.fromGateway()[0];
      // The server stopped after the Hub took the message and before the
      // dispatch was recorded: put the route back as it was at that instant.
      const db = store.getDb();
      db.exec('DROP TRIGGER bridge_route_proofs_need_route');
      db.prepare('DELETE FROM bridge_route_proofs WHERE route_id = ?').run(routeId);
      db.prepare("UPDATE bridge_routes SET state = 'accepted', destination_workspace_id = NULL WHERE route_id = ?").run(routeId);
      db.exec('DROP TRIGGER bridge_audit_append_only_delete');
      db.prepare("DELETE FROM bridge_audit WHERE route_id = ? AND op = 'dispatch'").run(routeId);
      gateway._reset();

      await gateway.tick();
      assert.equal(hub.fromGateway().length, 1, 'the message already on the Hub is not sent a second time');
      assert.equal(bridgeStore.routes.get(routeId).state, 'routed');
      assert.equal(bridgeStore.proofs.latestToTarget(routeId).hubId, first.hubId);
      await hub.sessionSends(alpha, { inReplyTo: first.hubId });
      assert.equal(gateway.drainInbox().held, 1, 'and its reply is still recognised');
    });

    it('a pin made while the send was in flight does not lose the dispatch', async () => {
      const alpha = liveProject('Alpha');
      bridgeStore.routes.accept({ routeId: 'rt_pin', externalId: 'm9', ...ALLOWED, text: '@alpha hello', digest: bridgeStore.digest('@alpha hello'), at: clock });
      const realSend = require('../lib/medusa').sendMessage;
      require('../lib/medusa').sendMessage = async (args) => {
        const out = await realSend(args);
        // Master pins the conversation while the gateway waits on the Hub.
        const route = bridgeStore.routes.get('rt_pin');
        bridgeStore.applyRouteWrite({
          op: 'pin', requestId: 'req-pin-000001', routeId: 'rt_pin', expectedVersion: route.version,
          actor: 'master', proof: 'master-launch', masterGeneration: 1, change: () => ({ set: {} })
        });
        return out;
      };
      await gateway.advance('rt_pin');
      const route = bridgeStore.routes.get('rt_pin');
      assert.equal(route.state, 'routed');
      assert.ok(bridgeStore.proofs.latestToTarget('rt_pin'), 'the proof is recorded against the route as it now is');
      assert.equal(waitingForHelper().length, 0);
      assert.ok(alpha.sessionId);
    });

    it('a send whose outcome is unknown is never sent again, by a pass, a restart or the Master', async () => {
      liveProject('Alpha');
      hub.failSend = 'unknown';
      const r = await operatorSays('m1', '@alpha hello');
      const routeId = r.body.routeId;
      hub.failSend = null;
      let route = bridgeStore.routes.get(routeId);
      assert.deepEqual([route.state, route.failureCode, route.destination.kind], ['accepted', 'send-unconfirmed', 'project'],
        'it keeps its destination and its place: unknown is not failed');

      gateway._reset();
      for (let i = 0; i < 3; i++) { later(10 * 60 * 1000); await gateway.tick(); }
      assert.equal(hub.fromGateway().length, 0, 'no pass and no restart sends it');
      route = bridgeStore.routes.get(routeId);
      assert.equal(route.state, 'accepted');
      assert.equal(bridgeStore.audit.forRoute(routeId).filter((a) => a.op === 'send-unconfirmed').length, 1, 'marked once');
      assert.deepEqual(waitingForHelper().map((i) => i.kind).sort(), ['failure', 'status']);
      assert.match(hub.system[0].message, new RegExp(`route ${routeId} is waiting for you`), 'the Master is told');

      // The Master cannot route it again: only a proven failure reopens routing.
      const reroute = bridgeStore.applyRouteWrite({
        op: 'route', requestId: 'req-reroute-0002', routeId, expectedVersion: route.version, actor: 'master', proof: 'master-launch', masterGeneration: 1,
        change: (current) => (current.state !== 'awaiting-master' ? { refuse: 'not-awaiting-master' } : { set: {} })
      });
      assert.equal(reroute.outcome, 'not-awaiting-master');
    });

    it('waits on a send still in flight, then marks it unconfirmed after two minutes, and never sends a second', async () => {
      const alpha = liveProject('Alpha');
      bridgeStore.routes.accept({ routeId: 'rt_flight', externalId: 'm9', ...ALLOWED, text: '@alpha hello', digest: bridgeStore.digest('@alpha hello'), at: clock });
      // The Hub holds the request open: the exchange exists, pending, with no id yet.
      const medusa = require('../lib/medusa');
      const realSend = medusa.sendMessage;
      let release;
      medusa.sendMessage = async (args) => {
        args.beforeHub({ from: 'operator-bridge-ws' });
        await new Promise((resolve) => { release = resolve; });
        throw Object.assign(new Error('the server stopped waiting'), { httpStatus: 502, code: 'BRIDGE_UNREACHABLE' });
      };
      const first = gateway.advance('rt_flight');
      await new Promise((resolve) => setImmediate(resolve));
      medusa.sendMessage = realSend;

      // A restart loses the in-memory lock; the pending exchange is what stops a second send.
      gateway._reset();
      later(gateway.SEND_PENDING_MS - 1000);
      await gateway.tick();
      assert.deepEqual([bridgeStore.routes.get('rt_flight').state, bridgeStore.routes.get('rt_flight').failureCode], ['accepted', null]);
      assert.equal(hub.fromGateway().length, 0, 'still inside the wait: nothing is sent and nothing is declared');

      later(2000);
      await gateway.tick();
      assert.equal(bridgeStore.routes.get('rt_flight').failureCode, 'send-unconfirmed');
      for (let i = 0; i < 3; i++) { later(60 * 60 * 1000); await gateway.tick(); }
      assert.equal(hub.fromGateway().length, 0, 'expiry raises a notice; it does not authorise another send');
      release();
      await first;
      assert.equal(hub.fromGateway().length, 0);
      assert.ok(alpha.sessionId);
    });

    it('when the exchange row cannot take the Hub\'s answer at first, the gateway binds it itself and the reply is held', async () => {
      const alpha = liveProject('Alpha');
      const realBind = exchanges.bindHubId;
      let failures = 1;
      exchanges.bindHubId = (...args) => {
        if (failures-- > 0) throw new Error('database is locked');
        return realBind(...args);
      };
      let r;
      try {
        r = await operatorSays('m1', '@alpha hello');
      } finally {
        exchanges.bindHubId = realBind;
      }
      const routeId = r.body.routeId;
      const sent = hub.fromGateway();
      assert.equal(sent.length, 1);
      assert.deepEqual([bridgeStore.routes.get(routeId).state, bridgeStore.routes.get(routeId).failureCode], ['routed', null]);
      assert.equal(store.medusaExchanges.getByRequestId(`bridge:${routeId}:send1`).hub_id, sent[0].hubId,
        'a routed route always rests on an exchange that carries its Hub id');

      const reply = await hub.sessionSends(alpha, { inReplyTo: sent[0].hubId, text: 'got it' });
      assert.equal(reply.status, 200, 'so the target can reply to it');
      assert.equal(gateway.drainInbox().held, 1);
      assert.equal(hub.fromGateway().length, 1, 'one Hub send');
    });

    it('while the row still cannot be bound the route waits unconfirmed, is not resent, and is recorded as sent once it binds', async () => {
      const alpha = liveProject('Alpha');
      const realBind = exchanges.bindHubId;
      exchanges.bindHubId = () => { throw new Error('database is locked'); };
      let routeId;
      try {
        routeId = (await operatorSays('m1', '@alpha hello')).body.routeId;
        assert.deepEqual([bridgeStore.routes.get(routeId).state, bridgeStore.routes.get(routeId).failureCode], ['accepted', 'send-unconfirmed'],
          'not routed: nothing could reply to it yet');
        gateway._reset();
        later(10 * 60 * 1000);
        await gateway.tick();
        assert.equal(bridgeStore.routes.get(routeId).state, 'accepted');
      } finally {
        exchanges.bindHubId = realBind;
      }
      assert.equal(hub.fromGateway().length, 1);

      // The store recovers. The Hub's answer was kept, across the restart above.
      gateway._reset();
      await gateway.tick();
      const route = bridgeStore.routes.get(routeId);
      assert.deepEqual([route.state, route.failureCode], ['routed', null]);
      const hubId = hub.fromGateway()[0].hubId;
      assert.equal(bridgeStore.proofs.latestToTarget(routeId).hubId, hubId);
      await hub.sessionSends(alpha, { inReplyTo: hubId, text: 'got it' });
      assert.equal(gateway.drainInbox().held, 1);
      assert.equal(hub.fromGateway().length, 1, 'one Hub send and one target delivery, through a failure and two restarts');
    });

    it('when the server stops before the Hub\'s answer is kept, the send stays unconfirmed and is not repeated', async () => {
      liveProject('Alpha');
      const realBind = exchanges.bindHubId;
      exchanges.bindHubId = () => { throw new Error('database is locked'); };
      bridgeStore.routes.accept({ routeId: 'rt_crash', externalId: 'm9', ...ALLOWED, text: '@alpha hello', digest: bridgeStore.digest('@alpha hello'), at: clock });
      // The server stops between the Hub's answer and the gateway keeping it.
      const realAppend = bridgeStore.audit.append;
      bridgeStore.audit.append = (entry) => {
        if (entry.op === 'hub-answer') throw new Error('the server stopped here');
        return realAppend(entry);
      };
      try {
        await gateway.advance('rt_crash').catch(() => {});
      } finally {
        exchanges.bindHubId = realBind;
        bridgeStore.audit.append = realAppend;
      }
      assert.equal(hub.fromGateway().length, 1, 'the message did reach the Hub');
      assert.equal(bridgeStore.routes.get('rt_crash').state, 'accepted');

      gateway._reset();
      for (let i = 0; i < 4; i++) { later(10 * 60 * 1000); await gateway.tick(); }
      assert.equal(hub.fromGateway().length, 1, 'no second send after the restart');
      assert.deepEqual([bridgeStore.routes.get('rt_crash').state, bridgeStore.routes.get('rt_crash').failureCode], ['accepted', 'send-unconfirmed']);
      assert.equal(store.getDb().prepare("SELECT COUNT(*) AS n FROM medusa_exchanges WHERE request_id LIKE 'bridge:rt_crash:%'").get().n, 1,
        'one request id for the attempt, for good');
    });

    it('a recipient that retires does not make an unconfirmed send sendable again', async () => {
      const alpha = liveProject('Alpha');
      hub.failSend = 'unknown';
      const routeId = (await operatorSays('m1', '@alpha hello')).body.routeId;
      hub.failSend = null;
      // The session ends, by the path production takes. That says nothing
      // about whether the first send arrived.
      exchanges.markRecipientRetired(alpha.workspaceId);
      assert.equal(store.medusaExchanges.getByRequestId(`bridge:${routeId}:send1`).state, 'recipient_retired');
      for (let i = 0; i < 3; i++) { later(10 * 60 * 1000); await gateway.tick(); }
      const route = bridgeStore.routes.get(routeId);
      assert.deepEqual([route.state, route.failureCode], ['accepted', 'send-unconfirmed']);
      assert.equal(hub.fromGateway().length, 0);
    });

    it('a routed message whose recipient retires goes back to the Master, and is not resent on its own', async () => {
      const alpha = liveProject('Alpha');
      const routeId = (await operatorSays('m1', '@alpha hello')).body.routeId;
      exchanges.markRecipientRetired(alpha.workspaceId);
      for (let i = 0; i < 3; i++) await gateway.tick();
      const route = bridgeStore.routes.get(routeId);
      assert.deepEqual([route.state, route.failureCode], ['awaiting-master', 'exchange-recipient-retired']);
      assert.equal(hub.fromGateway().length, 1, 'only the Master\'s explicit route makes another send');
    });

    it('a Hub answer the exchange could never store is noted once, not on every pass', async () => {
      liveProject('Alpha');
      const medusa = require('../lib/medusa');
      const realSend = medusa.sendMessage;
      medusa.sendMessage = async (args) => {
        const out = await realSend(args);
        return { ...out, id: 'not a storable id!' };
      };
      let routeId;
      try {
        routeId = (await operatorSays('m1', '@alpha hello')).body.routeId;
      } finally {
        medusa.sendMessage = realSend;
      }
      const exchange = store.medusaExchanges.getByRequestId(`bridge:${routeId}:send1`);
      const facts = () => store.medusaExchanges.facts(exchange.exchange_id).length;
      const before = facts();
      for (let i = 0; i < 5; i++) { later(10 * 60 * 1000); await gateway.tick(); }
      assert.equal(facts(), before, 'no further fact is appended by later passes');
      assert.equal(bridgeStore.audit.forRoute(routeId).filter((a) => a.op === 'hub-answer').length, 0, 'an unstorable id is not kept');
      assert.deepEqual([bridgeStore.routes.get(routeId).state, bridgeStore.routes.get(routeId).failureCode], ['accepted', 'send-unconfirmed']);
    });

    it('a send the Hub refused is proven undelivered, and only then may the Master route it again', async () => {
      const alpha = liveProject('Alpha');
      hub.failSend = 'refused';
      const routeId = (await operatorSays('m1', '@alpha hello')).body.routeId;
      hub.failSend = null;
      const route = bridgeStore.routes.get(routeId);
      assert.deepEqual([route.state, route.failureCode, route.destination], ['awaiting-master', 'exchange-undeliverable', null]);
      bridgeStore.applyRouteWrite({
        op: 'route', requestId: 'req-reroute-0003', routeId, expectedVersion: route.version, actor: 'master', proof: 'master-launch', masterGeneration: 1,
        change: () => ({ set: { state: 'accepted', resolved_by: 'master', destination_kind: 'project', destination_project_id: alpha.project.id, resolved_generation: 1, failure_code: null } })
      });
      await gateway.advance(routeId);
      assert.equal(hub.fromGateway().length, 1, 'a new attempt under a new request id');
      assert.ok(store.medusaExchanges.getByRequestId(`bridge:${routeId}:send2`));
    });
  });

  describe('failure, waiting and the Master', () => {
    it('hands a route back to Master when the target has no live session, and tells the operator once', async () => {
      const project = store.projects.create({ name: 'Offline', path: path.join(tmpDir, 'Offline') });
      const r = await operatorSays('m1', '@offline hello');
      const route = bridgeStore.routes.get(r.body.routeId);
      assert.deepEqual([route.state, route.failureCode, route.destination], ['awaiting-master', 'target-offline', null]);
      await gateway.tick();
      await gateway.tick();
      const items = waitingForHelper();
      assert.deepEqual(items.map((i) => i.kind), ['failure']);
      assert.equal(items[0].inReplyTo.externalId, 'm1');
      assert.ok(project.id);
    });

    it('turns a delivery failure on the exchange into one notice and a decision for Master', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha hello');
      store.getDb().prepare("UPDATE medusa_exchanges SET state = 'undeliverable' WHERE hub_id = ? AND origin = 'send'")
        .run(hub.fromGateway()[0].hubId);
      const first = await gateway.tick();
      const second = await gateway.tick();
      assert.deepEqual([first.failed, second.failed], [1, 0]);
      const route = bridgeStore.routes.get(r.body.routeId);
      assert.deepEqual([route.state, route.failureCode], ['awaiting-master', 'exchange-undeliverable']);
      assert.equal(waitingForHelper().filter((i) => i.kind === 'failure').length, 1);
    });

    it('raises one fixed still-waiting notice after five minutes, and never another', async () => {
      liveProject('Alpha');
      await operatorSays('m1', '@alpha hello');
      later(gateway.PENDING_NOTICE_MS - 1000);
      assert.equal((await gateway.tick()).pendingNotices, 0);
      later(2000);
      assert.equal((await gateway.tick()).pendingNotices, 1);
      later(60 * 60 * 1000);
      assert.equal((await gateway.tick()).pendingNotices, 0);
      const items = waitingForHelper();
      assert.deepEqual(items.map((i) => i.kind), ['status']);
      assert.match(items[0].text, /^Still waiting/);
    });

    it('ensures an absent Master with backoff, queues the route, and tells the operator once', async () => {
      masterState.live = false;
      masterState.ensureError = 'tmux did not answer';
      const r = await operatorSays('m1', '@nobody hello');
      assert.equal(bridgeStore.routes.get(r.body.routeId).state, 'queued-master-unavailable');
      assert.equal(masterState.ensures, 1);
      await gateway.tick();
      await gateway.tick();
      assert.equal(masterState.ensures, 1, 'not retried inside the backoff window');
      later(16 * 1000);
      await gateway.tick();
      assert.equal(masterState.ensures, 2);
      later(16 * 1000);
      await gateway.tick();
      assert.equal(masterState.ensures, 2, 'the window doubled');
      assert.deepEqual(waitingForHelper().map((i) => [i.kind, i.text]),
        [['status', 'Your message is queued: the Project Master is not available right now.']]);

      masterState.ensureError = null;
      later(60 * 1000);
      await gateway.tick();
      assert.equal(bridgeStore.routes.get(r.body.routeId).state, 'awaiting-master');
      assert.equal(hub.system.length, 1, 'Master is told once it is back');
      await gateway.tick();
      assert.equal(hub.system.length, 1, 'and not again for the same state');
    });

    it('carries on after a restart from wherever a route stopped', async () => {
      const alpha = liveProject('Alpha');
      // Accepted and stored, and the server stopped before it could resolve it.
      bridgeStore.routes.accept({
        routeId: 'rt_restart', externalId: 'm9', ...ALLOWED, text: '@alpha after the restart',
        digest: 'a'.repeat(64), at: clock
      });
      gateway._reset();
      const pass = await gateway.tick();
      assert.equal(pass.advanced, 1);
      assert.equal(bridgeStore.routes.get('rt_restart').state, 'routed');
      assert.equal(hub.fromGateway().length, 1);
      await gateway.tick();
      assert.equal(hub.fromGateway().length, 1, 'a second pass does not send it again');
      assert.ok(alpha.sessionId);
    });

    it('does nothing at all while disabled', async () => {
      bridgeStore.routes.accept({ routeId: 'rt_x', externalId: 'm9', ...ALLOWED, text: 'hello', digest: 'a'.repeat(64), at: clock });
      bridgeStore.settings.set('enabled', 'false');
      later(60 * 60 * 1000);
      assert.deepEqual(await gateway.tick(), { advanced: 0, failed: 0, pendingNotices: 0 });
      assert.equal(bridgeStore.routes.get('rt_x').state, 'accepted');
      assert.equal(hub.system.length + hub.fromGateway().length + masterState.ensures, 0);
    });

    it('tells the Master again when a notice could not be sent, and for each new reason', async () => {
      const alpha = liveProject('Alpha');
      hub.systemFails = true;
      const r = await operatorSays('m1', 'unaddressed, so it is the Master\'s');
      assert.equal(hub.system.length, 0);
      assert.equal(bridgeStore.routes.get(r.body.routeId).masterWakeAt, null, 'a notice that failed is not recorded as given');
      hub.systemFails = false;
      await gateway.tick();
      assert.equal(hub.system.length, 1);
      await gateway.tick();
      assert.equal(hub.system.length, 1);

      // A route handed back to the Master after a failure is a new reason.
      const routed = await operatorSays('m2', '@alpha hello');
      store.getDb().prepare("UPDATE medusa_exchanges SET state = 'recipient_retired' WHERE hub_id = ? AND origin = 'send'")
        .run(hub.fromGateway()[0].hubId);
      await gateway.tick();
      assert.equal(bridgeStore.routes.get(routed.body.routeId).state, 'awaiting-master');
      assert.equal(hub.system.length, 2);
      assert.ok(alpha.sessionId);
    });

    it('keeps trying to tell a Master that was away when a reply was held', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha status?');
      masterState.listening = false;
      await hub.sessionSends(alpha, { inReplyTo: hub.fromGateway()[0].hubId });
      gateway.drainInbox();
      await gateway.tick();
      assert.equal(bridgeStore.routes.get(r.body.routeId).state, 'reply-held');
      assert.equal(hub.system.length, 0);
      masterState.listening = true;
      await gateway.tick();
      assert.match(hub.system[0].message, /has a reply held for your release/);
    });

    it('says once per route state that the Master has no listener, not on every pass', async () => {
      masterState.listening = false;
      const logger = require('../lib/logger');
      const lines = [];
      const realWrite = process.stderr.write.bind(process.stderr);
      const realOut = process.stdout.write.bind(process.stdout);
      const capture = (chunk) => { lines.push(String(chunk)); return true; };
      logger.setLevel('warn');
      process.stderr.write = capture;
      process.stdout.write = capture;
      try {
        await operatorSays('m1', 'for the Master');
        for (let i = 0; i < 4; i++) await gateway.tick();
      } finally {
        process.stderr.write = realWrite;
        process.stdout.write = realOut;
        logger.setLevel('error');
      }
      assert.equal(lines.filter((l) => l.includes('it has no Medusa listener')).length, 1);
    });

    it('the pass raises the server notifications and lets go of what nobody collected', async (t) => {
      const bridgeNotify = require('../lib/bridge-notify');
      const alpha = liveProject('Alpha');
      const realNotifyNow = bridgeNotify._deps.now;
      bridgeNotify._deps.now = () => clock;
      t.after(() => { bridgeNotify._deps.now = realNotifyNow; });
      bridgeStore.settings.set(bridgeNotify.ENABLED_AT, clock);
      later(2000);
      store.workloadReceipts.append({
        project_id: alpha.project.id, session_id: alpha.sessionId, launch_id: alpha.launchId, assignment_id: null,
        state: 'blocked', clearance: 'do-not-clear', summary: 'stuck', wait_kind: null, wait_detail: null,
        refs_json: '{}', branch: null, head_sha: null, source: 'tc-cli', received_at: clock
      }, { minIntervalMs: 0, nowMs: Date.parse(clock) });

      const pass = await gateway.tick();
      assert.equal(pass.notifications.workBlocked, 1);
      assert.deepEqual(waitingForHelper().map((i) => [i.kind, i.text, i.inReplyTo]),
        [['notification', 'Alpha reports its work is blocked.', null]]);

      const [fetched] = helperClaims().body.items;
      later(bridgeStore.EXPIRY_MS.notification['work-blocked'] + 60000);
      await gateway.tick();
      assert.deepEqual(waitingForHelper(), [], 'a week-old notification is not handed to a helper that attaches late');
      const expiry = store.getDb().prepare("SELECT * FROM bridge_audit WHERE op = 'expire'").get();
      assert.deepEqual([expiry.actor, expiry.outcome, JSON.parse(expiry.detail_json).outboundId], ['gateway', 'uncollected-expired', fetched.outboundId],
        'what was let go is on the record, by its id');
      assert.equal((await gateway.tick()).notifications.workBlocked, 0, 'and it is not raised again');
      // Being let go is final: a helper that claimed it earlier and posts it
      // now cannot acknowledge it. Its lease lapsed long before the limit passed.
      const late = helperAcks(fetched, 'posted-late');
      assert.deepEqual([late.status, late.body.code], [409, 'LEASE_LAPSED'], 'its lease lapsed long ago, and that is all it is told');
      assert.equal(bridgeStore.outbound.get(fetched.outboundId).state, 'dropped');
    });

    it('tells the Master of an open configuration circuit until the Master says it has taken it up', async () => {
      /**
       * The helper finds the chat closed to it: one item is set aside and an episode opens.
       * @param {string} name - Distinguishes the item.
       * @returns {number} The episode's id.
       */
      const chatCloses = (name) => {
        const text = `notice ${name}`;
        const id = bridgeStore.outbound.enqueue({
          idemKey: `notify:operator-needed:${name}`, kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw', text, digest: bridgeStore.digest(text), at: clock
        }).outboundId;
        const item = helperClaims().body.items.find((i) => i.outboundId === id);
        return gateway.reportFailure(id, { leaseId: item.leaseId, tokenId: helper().tokenId, reason: 'chat-permission-denied' }).body.circuit.episodeId;
      };
      const aboutCircuit = () => hub.system.filter((m) => m.message.includes('configuration circuit'));
      const episode = chatCloses('first');

      assert.equal((await gateway.tick()).circuitTold, true);
      assert.equal(aboutCircuit().length, 1);
      assert.deepEqual([aboutCircuit()[0].to, bridgeStore.circuit.open().masterToldAt], [MASTER_WS, clock]);
      assert.match(aboutCircuit()[0].message, new RegExp(`episode ${episode}, chat-permission-denied\\).*a release is not a delivery.*tc bridge circuit ack ${episode}`));
      assert.ok(!aboutCircuit()[0].message.includes('notice first'), 'the notice carries no text of what was to be posted');

      // Not on every pass: again only after five minutes, and for as long as it goes unacknowledged.
      later(gateway.CIRCUIT_RETELL_MS - 1000);
      assert.equal((await gateway.tick()).circuitTold, false);
      later(1000);
      assert.equal((await gateway.tick()).circuitTold, true);
      assert.equal(aboutCircuit().length, 2);

      assert.deepEqual(bridgeStore.circuit.ack(episode + 1, 7, { at: clock }).outcome, 'not-open', 'only the open episode can be acknowledged');
      const acked = bridgeStore.circuit.ack(episode, 7, { at: clock });
      assert.deepEqual([acked.outcome, acked.episode.masterAckedAt], ['acked', clock]);
      assert.equal(bridgeStore.circuit.ack(episode, 8, { at: clock }).outcome, 'already-acked');
      const audit = store.getDb().prepare("SELECT actor, master_generation, detail_json FROM bridge_audit WHERE op = 'circuit-ack'").all();
      assert.deepEqual(audit.map((r) => [r.actor, r.master_generation, JSON.parse(r.detail_json).episodeId]), [['master', 7, episode]], 'acknowledged once, on the record');
      assert.throws(() => store.getDb().exec('UPDATE bridge_config_circuit SET master_acked_at = NULL, master_acked_generation = NULL'), /fixed once opened/);
      later(10 * gateway.CIRCUIT_RETELL_MS);
      assert.equal((await gateway.tick()).circuitTold, false);
      assert.equal(aboutCircuit().length, 2, 'an acknowledged episode is not told again, however long it stays open');
      assert.equal(bridgeStore.circuit.open().episodeId, episode, 'acknowledging does not close it');

      // A later episode is a new thing to be told of.
      bridgeStore.applyCircuitReset({ requestId: 'req-reset-told-0001', decision: 'withdraw', actor: 'master', proof: 'master-launch', masterGeneration: 7, at: clock });
      const next = chatCloses('second');
      assert.equal((await gateway.tick()).circuitTold, true);
      assert.match(aboutCircuit()[2].message, new RegExp(`episode ${next},`));
    });

    it('a Master with no listener cannot be told of the circuit that way; it is told once it has one', async () => {
      const text = 'notice x';
      const id = bridgeStore.outbound.enqueue({ idemKey: 'notify:operator-needed:x', kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw', text, digest: bridgeStore.digest(text), at: clock }).outboundId;
      const item = helperClaims().body.items.find((i) => i.outboundId === id);
      gateway.reportFailure(id, { leaseId: item.leaseId, tokenId: helper().tokenId, reason: 'chat-channel-missing' });
      masterState.listening = false;
      for (let i = 0; i < 3; i++) assert.equal((await gateway.tick()).circuitTold, false);
      assert.deepEqual([hub.system.filter((m) => m.message.includes('configuration circuit')).length, bridgeStore.circuit.open().masterToldAt], [0, null],
        'it is not recorded as told when it was not');
      masterState.listening = true;
      assert.equal((await gateway.tick()).circuitTold, true);
    });

    it('one route that fails does not hold up the others', async () => {
      liveProject('Alpha');
      bridgeStore.routes.accept({ routeId: 'rt_a', externalId: 'ma', ...ALLOWED, text: '@alpha one', digest: bridgeStore.digest('@alpha one'), at: clock });
      later(1000);
      bridgeStore.routes.accept({ routeId: 'rt_b', externalId: 'mb', ...ALLOWED, text: '@alpha two', digest: bridgeStore.digest('@alpha two'), at: clock });
      const realGet = store.projects.list;
      let thrown = false;
      store.projects.list = (...args) => {
        if (!thrown) { thrown = true; throw new Error('a route that cannot be resolved this pass'); }
        return realGet.apply(store.projects, args);
      };
      try {
        await gateway.tick();
      } finally {
        store.projects.list = realGet;
      }
      assert.equal(bridgeStore.routes.get('rt_a').state, 'accepted');
      assert.equal(bridgeStore.routes.get('rt_b').state, 'routed');
    });

    it('still runs retention while disabled, and lets go of nothing that is open', async () => {
      const old = '2026-01-01T00:00:00.000Z';
      bridgeStore.routes.accept({ routeId: 'rt_old', externalId: 'mo', ...ALLOWED, text: 'old', digest: bridgeStore.digest('old'), at: old });
      const open = bridgeStore.routes.get('rt_old');
      bridgeStore.applyRouteWrite({
        op: 'close', requestId: 'req-old-000001', routeId: 'rt_old', expectedVersion: open.version, actor: 'operator', proof: 'verified-session', at: old,
        change: () => ({ set: { state: 'closed', closed_by: 'operator', closed_at: old }, clearBodies: true })
      });
      bridgeStore.routes.accept({ routeId: 'rt_open', externalId: 'mp', ...ALLOWED, text: 'open', digest: bridgeStore.digest('open'), at: old });
      bridgeStore.settings.set('enabled', 'false');
      await gateway.tick();
      assert.equal(bridgeStore.routes.get('rt_old'), null);
      assert.ok(bridgeStore.routes.get('rt_open'));
    });
  });

  describe('the helper', () => {
    it('verifies only the active token, and a new one revokes the old', () => {
      const first = gateway.mintHelperToken();
      assert.ok(gateway.verifyHelperToken(first.token));
      const second = gateway.mintHelperToken();
      assert.equal(gateway.verifyHelperToken(first.token), null);
      assert.equal(gateway.verifyHelperToken(second.token).tokenId, second.tokenId);
      for (const wrong of [undefined, '', 'bht_short', second.tokenId]) assert.equal(gateway.verifyHelperToken(wrong), null);
      store.close();
      const raw = fs.readFileSync(path.join(tmpDir, 'tangleclaw.db'));
      store._setBasePath(tmpDir);
      store.init();
      assert.ok(!raw.includes(second.token), 'the token is not in the database');
    });

    it('acknowledges an item exactly once, and refuses a different message id for it', async () => {
      const project = store.projects.create({ name: 'Offline', path: path.join(tmpDir, 'Offline') });
      await operatorSays('m1', '@offline hello');
      const [item] = helperClaims().body.items;
      assert.deepEqual([helperAcks(item, 'posted-1').body.replayed, helperAcks(item, 'posted-1').body.replayed], [false, true]);
      assert.equal(helperAcks(item, 'posted-2').body.code, 'ACK_MISMATCH');
      assert.equal(helperAcks({ ...item, outboundId: 9999 }, 'posted-1').body.code, 'LEASE_NOT_FOUND', 'a lease that is not that item\'s says nothing about the item');
      assert.equal(helperAcks(item, 'bad ref!').body.code, 'BAD_ACK');
      assert.deepEqual(waitingForHelper(), []);
      assert.equal(bridgeStore.outbound.get(item.outboundId).text, null, 'the text is dropped once the chat has it');
      assert.ok(project.id);
    });
  });
});
