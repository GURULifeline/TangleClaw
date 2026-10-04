'use strict';

// #2031 (ADR 0023): the operator bridge's gateway, driven through its real
// store and real project, session and launch rows; only the Hub, the Master
// pane and the clock are stand-ins. A message goes in from the helper, to its
// destination, and comes back held; nothing a destination says is relayed
// until Master releases it; and only the exact session the message was sent to
// can answer it.

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
const { bindProject } = require('./_shared-docs-callers');

const GATEWAY_WS = 'operator-bridge-ws';
const MASTER_WS = 'master-ws';
const ALLOWED = { authorId: 'author1', spaceId: 'space1', channelId: 'chan1' };

let tmpDir;
let clock;
let hub;
let masterState;
let realDeps;

/**
 * A stand-in for the Hub and the listeners: records what was sent, holds the
 * gateway's inbox, and gives each session a workspace.
 * @returns {object}
 */
function fakeHub() {
  const state = { sent: [], system: [], inbox: [], handled: [], workspaces: new Map(), nextId: 1, failSend: null };
  state.medusa = {
    getStatus: (key) => ({
      workspaceId: key === gateway.GATEWAY_KEY ? GATEWAY_WS : (state.workspaces.get(String(key)) || null), state: 'listening'
    }),
    getMessages: () => state.inbox.slice(),
    markHandled: (_key, ids) => {
      state.handled.push(...ids);
      state.inbox = state.inbox.filter((m) => !ids.includes(m.id));
    },
    sendSystemMessage: async (m) => { state.system.push(m); return { status: 'received', id: `sys-${state.nextId++}`, to: m.to }; },
    startSession: () => ({ state: 'listening', workspaceId: GATEWAY_WS }),
    stopSession: () => {}
  };
  state.medusaSend = {
    sendTracked: async (call) => {
      if (state.failSend) return state.failSend;
      const id = `hub-${state.nextId++}`;
      state.sent.push({ ...call, hubId: id });
      return { status: 200, body: { status: 'received', id, to: call.body.to, exchange: { exchangeId: `mx_${id}` } } };
    }
  };
  return state;
}

/**
 * Record, as the server would, that a session sent a Medusa message, and put
 * the message in the gateway's inbox.
 * @param {object} reply
 * @param {string} reply.hubId - The reply's Hub id.
 * @param {string} reply.inReplyTo - The Hub id it answers.
 * @param {number} reply.projectId - Sending project.
 * @param {number} reply.sessionId - Sending session.
 * @param {string} reply.workspaceId - Sending workspace.
 * @param {string} [reply.text] - Reply body.
 * @param {object} [over] - Overrides for the exchange row.
 * @returns {void}
 */
function sessionReplies(reply, over = {}) {
  const row = {
    exchange_id: `mx_${reply.hubId}`, request_id: `req-${reply.hubId}`, hub_id: reply.hubId, origin: 'send', tracking: 'untracked',
    sender_project_id: reply.projectId, sender_session_id: String(reply.sessionId), sender_workspace_id: reply.workspaceId,
    sender_verified: 1, sender_proof: 'launch', recipient_workspace_id: GATEWAY_WS, priority: 'normal', reply_required: 0,
    in_reply_to: reply.inReplyTo, created_at: clock, state: 'untracked', updated_at: clock, ...over
  };
  const columns = Object.keys(row);
  store.getDb().prepare(
    `INSERT INTO medusa_exchanges (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
  ).run(...columns.map((c) => row[c]));
  hub.inbox.push({ id: reply.hubId, from: reply.workspaceId, message: reply.text ?? 'the answer' });
}

/**
 * A project with a live, launch-bound session and a workspace.
 * @param {string} name - Project name.
 * @returns {{project: object, sessionId: number, launchId: string, workspaceId: string}}
 */
function liveProject(name) {
  const project = store.projects.create({ name, path: path.join(tmpDir, name) });
  const bound = bindProject(project);
  const workspaceId = `${name.toLowerCase()}-ws`;
  hub.workspaces.set(String(bound.sessionId), workspaceId);
  return { project, sessionId: bound.sessionId, launchId: bound.launchId, workspaceId };
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
    hub = fakeHub();
    masterState = { live: true, ensures: 0, ensureError: null };
    realDeps = { ...gateway._deps };
    let n = 0;
    Object.assign(gateway._deps, {
      medusa: () => hub.medusa,
      medusaSend: () => hub.medusaSend,
      master: () => ({
        masterLiveness: () => ({ live: masterState.live, answered: true, cause: null }),
        ensureMasterSession: () => {
          masterState.ensures += 1;
          if (masterState.ensureError) return { created: false, error: masterState.ensureError };
          masterState.live = true;
          return { created: true };
        },
        getMasterMedusaStatus: () => ({ workspaceId: MASTER_WS })
      }),
      now: () => clock,
      id: (prefix) => `${prefix}_${++n}`
    });
    gateway._reset();
    bridgeStore.settings.set('enabled', 'true');
    bridgeStore.settings.set('allow.author', ALLOWED.authorId);
    bridgeStore.settings.set('allow.space', ALLOWED.spaceId);
    bridgeStore.settings.set('allow.channel', ALLOWED.channelId);
  });

  afterEach(() => {
    Object.assign(gateway._deps, realDeps);
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
      assert.equal(hub.sent.length, 0);
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
      assert.equal(hub.sent.length, 1);
      const call = hub.sent[0];
      assert.equal(call.body.to, alpha.workspaceId);
      assert.ok(call.body.message.startsWith(gateway.FENCE_LINE));
      assert.equal(call.body.replyRequired, true);
      assert.equal(call.body.priority, undefined, 'never blocking or critical');
      assert.deepEqual(call.caller, { kind: 'system' });
      const proof = bridgeStore.proofs.byHubId(call.hubId);
      assert.deepEqual([proof.direction, proof.senderProof, proof.targetWorkspaceId, proof.targetSessionId, proof.targetLaunchId],
        ['to-target', 'gateway', alpha.workspaceId, alpha.sessionId, alpha.launchId]);
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
      assert.equal(hub.sent.length, 0);
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
      sessionReplies({ hubId: 'reply-1', inReplyTo: hub.sent[0].hubId, projectId: alpha.project.id, sessionId: alpha.sessionId, workspaceId: alpha.workspaceId, text: 'all green' });
      assert.deepEqual(gateway.drainInbox(), { held: 1, dropped: 0, waiting: 0 });

      const route = bridgeStore.routes.get(r.body.routeId);
      assert.equal(route.state, 'reply-held');
      assert.equal(bridgeStore.routes.body(route.routeId, 'reply').text, 'all green');
      assert.deepEqual(gateway.outboundForHelper(), [], 'nothing reaches the helper before Master releases it');
      assert.deepEqual(hub.handled, ['reply-1']);
      assert.match(hub.system[hub.system.length - 1].message, /reply held for your release/);
      const audit = bridgeStore.audit.forRoute(route.routeId).pop();
      assert.deepEqual([audit.op, audit.actor, audit.proof], ['reply-held', 'session', 'launch']);
    });

    it('captures a reply once, however often it is seen', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha status?');
      const reply = { hubId: 'reply-1', inReplyTo: hub.sent[0].hubId, projectId: alpha.project.id, sessionId: alpha.sessionId, workspaceId: alpha.workspaceId };
      sessionReplies(reply);
      gateway.drainInbox();
      hub.inbox.push({ id: 'reply-1', from: alpha.workspaceId, message: 'the answer' });
      gateway.drainInbox();
      const route = bridgeStore.routes.get(r.body.routeId);
      assert.equal(route.version, 4, 'resolve, dispatch, reply-held: no fourth write');
      assert.equal(bridgeStore.audit.forRoute(route.routeId).filter((a) => a.op === 'reply-held').length, 1);
    });

    it('drops what does not prove itself, each for its own reason, and holds nothing', async () => {
      const alpha = liveProject('Alpha');
      const beta = liveProject('Beta');
      const r = await operatorSays('m1', '@alpha status?');
      const asked = hub.sent[0].hubId;
      const good = { inReplyTo: asked, projectId: alpha.project.id, sessionId: alpha.sessionId, workspaceId: alpha.workspaceId };

      // A second live session of the SAME project, verified and launch-bound.
      const sibling = bindProject(alpha.project);
      hub.workspaces.set(String(sibling.sessionId), 'alpha-sibling-ws');

      sessionReplies({ ...good, hubId: 'x1' }, { sender_verified: 0 });
      sessionReplies({ ...good, hubId: 'x2' }, { sender_proof: 'ambient-open' });
      sessionReplies({ ...good, hubId: 'x3' }, { recipient_workspace_id: 'someone-else' });
      sessionReplies({ ...good, hubId: 'x4', inReplyTo: 'not-ours' });
      sessionReplies({ ...good, hubId: 'x5' }, { in_reply_to: null });
      sessionReplies({ ...good, hubId: 'x6', projectId: beta.project.id, sessionId: beta.sessionId, workspaceId: beta.workspaceId });
      sessionReplies({ ...good, hubId: 'x7', sessionId: sibling.sessionId, workspaceId: 'alpha-sibling-ws' });
      sessionReplies({ ...good, hubId: 'x8', workspaceId: 'alpha-other-ws' });
      sessionReplies({ ...good, hubId: 'x9', text: '   ' });
      hub.inbox.push({ id: 'sys-1', from: 'system', message: 'an escalation notice' });

      assert.deepEqual(gateway.drainInbox(), { held: 0, dropped: 10, waiting: 0 });
      assert.equal(bridgeStore.routes.get(r.body.routeId).state, 'routed');
      assert.equal(bridgeStore.routes.body(r.body.routeId, 'reply'), null);
      assert.equal(hub.inbox.length, 0, 'a dropped message is not left to be judged again');
      assert.deepEqual(gateway.outboundForHelper(), []);
    });

    it('does not accept a reply from the target after its session was relaunched', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha status?');
      // The same session row now runs under a different launch.
      store.getDb().prepare('UPDATE launch_sequences SET launch_id = ? WHERE session_id = ?').run('a-newer-launch', alpha.sessionId);
      sessionReplies({ hubId: 'reply-1', inReplyTo: hub.sent[0].hubId, projectId: alpha.project.id, sessionId: alpha.sessionId, workspaceId: alpha.workspaceId });
      assert.equal(gateway.drainInbox().dropped, 1);
      assert.equal(bridgeStore.routes.get(r.body.routeId).state, 'routed');
    });

    it('waits for a reply whose sender row has not been written yet, then gives up in bounded time', async () => {
      const alpha = liveProject('Alpha');
      await operatorSays('m1', '@alpha status?');
      hub.inbox.push({ id: 'early', from: alpha.workspaceId, message: 'the answer' });
      assert.deepEqual(gateway.drainInbox(), { held: 0, dropped: 0, waiting: 1 });
      assert.equal(hub.inbox.length, 1, 'left in the inbox to be judged again');
      later(11 * 60 * 1000);
      assert.equal(gateway.drainInbox().dropped, 1);
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
      const items = gateway.outboundForHelper();
      assert.deepEqual(items.map((i) => i.kind), ['failure']);
      assert.equal(items[0].inReplyTo.externalId, 'm1');
      assert.ok(project.id);
    });

    it('turns a delivery failure on the exchange into one notice and a decision for Master', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha hello');
      const sent = hub.sent[0];
      sessionReplies({ hubId: sent.hubId, inReplyTo: null, projectId: null, sessionId: 0, workspaceId: GATEWAY_WS },
        { state: 'undeliverable', sender_verified: 1, sender_proof: 'system', recipient_workspace_id: alpha.workspaceId, in_reply_to: null });
      hub.inbox = [];
      const first = await gateway.tick();
      const second = await gateway.tick();
      assert.deepEqual([first.failed, second.failed], [1, 0]);
      const route = bridgeStore.routes.get(r.body.routeId);
      assert.deepEqual([route.state, route.failureCode], ['awaiting-master', 'exchange-undeliverable']);
      assert.equal(gateway.outboundForHelper().filter((i) => i.kind === 'failure').length, 1);
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
      const items = gateway.outboundForHelper();
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
      assert.deepEqual(gateway.outboundForHelper().map((i) => [i.kind, i.text]),
        [['status', 'Your message is queued: the Project Master is not available right now.']]);

      masterState.ensureError = null;
      later(60 * 1000);
      await gateway.tick();
      assert.equal(bridgeStore.routes.get(r.body.routeId).state, 'awaiting-master');
      assert.equal(hub.system.length, 1, 'Master is told once it is back');
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
      assert.equal(hub.sent.length, 1);
      await gateway.tick();
      assert.equal(hub.sent.length, 1, 'a second pass does not send it again');
      assert.ok(alpha.sessionId);
    });

    it('does nothing at all while disabled', async () => {
      bridgeStore.routes.accept({ routeId: 'rt_x', externalId: 'm9', ...ALLOWED, text: 'hello', digest: 'a'.repeat(64), at: clock });
      bridgeStore.settings.set('enabled', 'false');
      later(60 * 60 * 1000);
      assert.deepEqual(await gateway.tick(), { advanced: 0, failed: 0, pendingNotices: 0 });
      assert.equal(bridgeStore.routes.get('rt_x').state, 'accepted');
      assert.equal(hub.system.length + hub.sent.length + masterState.ensures, 0);
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
      const [item] = gateway.outboundForHelper();
      assert.deepEqual([gateway.acknowledgeOutbound(item.outboundId, 'posted-1').body.replayed, gateway.acknowledgeOutbound(item.outboundId, 'posted-1').body.replayed], [false, true]);
      assert.equal(gateway.acknowledgeOutbound(item.outboundId, 'posted-2').body.code, 'ACK_MISMATCH');
      assert.equal(gateway.acknowledgeOutbound(9999, 'posted-1').body.code, 'OUTBOUND_NOT_FOUND');
      assert.equal(gateway.acknowledgeOutbound(item.outboundId, 'bad ref!').body.code, 'BAD_ACK');
      assert.deepEqual(gateway.outboundForHelper(), []);
      assert.equal(bridgeStore.outbound.get(item.outboundId).text, null, 'the text is dropped once the chat has it');
      assert.ok(project.id);
    });
  });
});
