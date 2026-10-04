'use strict';

// #2031 (ADR 0023): the operator bridge end to end over HTTP, against the real
// server. An operator message goes in through the helper's route, reaches a
// project's session, comes back held, is released by the Master and is handed
// to the helper; the Hub and the Master pane are stand-ins. Three callers,
// three proofs, and none of them opens another's door.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const bridgeStore = require('../lib/bridge-store');
const bridgeApi = require('../lib/bridge-api');
const gateway = require('../lib/bridge-gateway');
const handoff = require('../lib/bridge-handoff');
const { bindProject, operatorHeaders } = require('./_shared-docs-callers');

const GATEWAY_WS = 'operator-bridge-ws';
const ALLOWED = { authorId: 'author1', spaceId: 'space1', channelId: 'chan1' };

let tmpDir;
let server;
let origin;
let hub;
let realDeps;
let masterCredential;
let masterGeneration;
let helperToken;
let seq = 0;

/** A signed-in operator, as `server.js` annotates the request. */
const SIGNED_IN = { tcSession: { username: 'rosie' }, tcGateState: 'guarding', headers: {} };
/** A dashboard-shaped request on an open gate: the operator in appearance only. */
const AMBIENT = { tcGateActive: false, tcGateState: 'open', headers: { 'sec-fetch-site': 'same-origin' } };

/**
 * One JSON request to the test server.
 * @param {string} method - HTTP method.
 * @param {string} apiPath - Path.
 * @param {object} [options]
 * @param {object} [options.headers] - Extra headers.
 * @param {object} [options.body] - JSON body.
 * @returns {Promise<{status: number, body: object}>}
 */
async function call(method, apiPath, options = {}) {
  const res = await fetch(`${origin}${apiPath}`, {
    method, headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return { status: res.status, body: await res.json() };
}

/**
 * Headers for a helper request, with a fresh nonce.
 * @param {object} [over] - Overrides.
 * @returns {object}
 */
function asHelper(over = {}) {
  return {
    [bridgeApi.HELPER_TOKEN_HEADER]: helperToken,
    [bridgeApi.HELPER_NONCE_HEADER]: crypto.randomBytes(16).toString('hex'),
    ...over
  };
}

/**
 * Headers for a Master request.
 * @returns {object}
 */
function asMaster() {
  return { 'x-tangleclaw-bridge-credential': masterCredential };
}

/**
 * A Master write to a route.
 * @param {string} routeId - Route id.
 * @param {string} op - `route`, `answer`, `release`, `pin` or `close`.
 * @param {object} body - Fields beyond the request id.
 * @returns {Promise<{status: number, body: object}>}
 */
function masterWrites(routeId, op, body) {
  return call('POST', `/api/bridge/master/routes/${routeId}/${op}`, {
    headers: asMaster(), body: { requestId: `req-${op}-${++seq}-0000`, ...body }
  });
}

/**
 * The operator says something in the allowlisted channel.
 * @param {string} externalId - Chat message id.
 * @param {string} text - Message.
 * @returns {Promise<{status: number, body: object}>}
 */
function operatorSays(externalId, text) {
  return call('POST', '/api/bridge/helper/inbound', { headers: asHelper(), body: { externalId, ...ALLOWED, text } });
}

/**
 * A project with a live, launch-bound session and a workspace.
 * @param {string} name - Project name.
 * @returns {{project: object, sessionId: number, workspaceId: string}}
 */
function liveProject(name) {
  const project = store.projects.create({ name, path: path.join(tmpDir, name) });
  const bound = bindProject(project);
  const workspaceId = `${name.toLowerCase()}-ws`;
  hub.workspaces.set(String(bound.sessionId), workspaceId);
  return { project, sessionId: bound.sessionId, workspaceId };
}

/**
 * Record that a session replied over Medusa, and deliver it to the gateway.
 * @param {object} target - What {@link liveProject} returned.
 * @param {string} hubId - The reply's Hub id.
 * @param {string} inReplyTo - The Hub id it answers.
 * @param {string} text - The reply.
 * @returns {void}
 */
function sessionReplies(target, hubId, inReplyTo, text) {
  const at = new Date().toISOString();
  const row = {
    exchange_id: `mx_${hubId}`, request_id: `req-${hubId}`, hub_id: hubId, origin: 'send', tracking: 'untracked',
    sender_project_id: target.project.id, sender_session_id: String(target.sessionId), sender_workspace_id: target.workspaceId,
    sender_verified: 1, sender_proof: 'launch', recipient_workspace_id: GATEWAY_WS, priority: 'normal', reply_required: 0,
    in_reply_to: inReplyTo, created_at: at, state: 'untracked', updated_at: at
  };
  const columns = Object.keys(row);
  store.getDb().prepare(`INSERT INTO medusa_exchanges (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
    .run(...columns.map((c) => row[c]));
  hub.inbox.push({ id: hubId, from: target.workspaceId, message: text });
  gateway.drainInbox();
}

describe('bridge API: the round trip (#2031)', () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-bridge-gw-'));
    store._setBasePath(tmpDir);
    store.init();
    const { createServer } = require('../server');
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    realDeps = { ...gateway._deps };
  });

  after(async () => {
    Object.assign(gateway._deps, realDeps);
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    hub = { sent: [], system: [], inbox: [], workspaces: new Map(), n: 0 };
    Object.assign(gateway._deps, {
      medusa: () => ({
        getStatus: (key) => ({ workspaceId: key === gateway.GATEWAY_KEY ? GATEWAY_WS : (hub.workspaces.get(String(key)) || null), state: 'listening' }),
        getMessages: () => hub.inbox.slice(),
        markHandled: (_key, ids) => { hub.inbox = hub.inbox.filter((m) => !ids.includes(m.id)); },
        sendSystemMessage: async (m) => { hub.system.push(m); return { status: 'received' }; },
        startSession: () => ({ state: 'listening', workspaceId: GATEWAY_WS }),
        stopSession: () => {}
      }),
      medusaSend: () => ({
        sendTracked: async (c) => {
          const id = `hub-${++seq}`;
          hub.sent.push({ ...c, hubId: id });
          return { status: 200, body: { id, exchange: { exchangeId: `mx_${id}` } } };
        }
      }),
      master: () => ({
        masterLiveness: () => ({ live: true, answered: true }),
        ensureMasterSession: () => ({ created: false }),
        getMasterMedusaStatus: () => ({ workspaceId: 'master-ws' })
      })
    });
    gateway._reset();

    const minted = handoff.mintCredential();
    masterGeneration = bridgeStore.masterCredentials.mint(minted.hash);
    bridgeStore.masterCredentials.activate(masterGeneration, minted.hash);
    masterCredential = minted.credential;

    // The operator sets the bridge up, through the operator's own handlers.
    bridgeApi.operatorSwitch(false)({ req: SIGNED_IN });
    assert.equal(bridgeApi.operatorAllowlist({ req: SIGNED_IN, body: ALLOWED }).status, 200);
    helperToken = bridgeApi.operatorMintHelperToken({ req: SIGNED_IN }).body.token;
    assert.equal(bridgeApi.operatorSwitch(true)({ req: SIGNED_IN }).status, 200);
  });

  it('carries a message to a project and its answer back, releasing nothing until the Master does', async () => {
    const alpha = liveProject(`Alpha${++seq}`);
    const accepted = await operatorSays(`m${++seq}`, `@${alpha.project.name} is the build green?`);
    assert.equal(accepted.status, 202);
    const routeId = accepted.body.routeId;
    assert.equal(accepted.body.state, 'routed');
    assert.equal(hub.sent[0].body.to, alpha.workspaceId);

    sessionReplies(alpha, `reply-${++seq}`, hub.sent[0].hubId, 'yes, all green');
    assert.deepEqual((await call('GET', '/api/bridge/helper/outbound', { headers: asHelper() })).body.items, [],
      'a held reply is not handed to the helper');

    const read = await call('GET', `/api/bridge/master/routes/${routeId}`, { headers: asMaster() });
    assert.equal(read.body.route.state, 'reply-held');
    assert.deepEqual(read.body.bodies.map((b) => b.role), ['inbound', 'reply']);

    const released = await masterWrites(routeId, 'release', { expectedVersion: read.body.route.version });
    assert.deepEqual([released.status, released.body.route.state], [200, 'released']);

    const out = await call('GET', '/api/bridge/helper/outbound', { headers: asHelper() });
    assert.equal(out.body.items.length, 1);
    const item = out.body.items[0];
    assert.deepEqual([item.kind, item.text, item.sourceLabel], ['reply', 'yes, all green', `Project Master, relaying ${alpha.project.name}`]);
    assert.equal(item.inReplyTo.channelId, ALLOWED.channelId);

    const ack = await call('POST', `/api/bridge/helper/outbound/${item.outboundId}/ack`, { headers: asHelper(), body: { deliveredRef: 'posted-1' } });
    assert.equal(ack.status, 200);
    const done = bridgeStore.routes.get(routeId);
    assert.deepEqual([done.state, done.closedBy], ['closed', 'gateway']);
    assert.ok(bridgeStore.routes.bodies(routeId).every((b) => b.text === null), 'every body is cleared once the chat has the answer');
    assert.deepEqual(bridgeStore.audit.forRoute(routeId).map((a) => `${a.op}:${a.actor}`),
      ['inbound:helper', 'resolve:gateway', 'dispatch:gateway', 'reply-held:session', 'release:master', 'delivered:helper']);
    assert.equal(bridgeStore.audit.forRoute(routeId).find((a) => a.op === 'release').masterGeneration, masterGeneration);
  });

  it('lets the Master answer an unaddressed message itself, with no session involved', async () => {
    const accepted = await operatorSays(`m${++seq}`, 'what is the fleet doing?');
    const routeId = accepted.body.routeId;
    const answered = await masterWrites(routeId, 'answer', { expectedVersion: bridgeStore.routes.get(routeId).version, text: 'Two sessions are working.' });
    assert.equal(answered.body.route.state, 'released');
    assert.equal(hub.sent.length, 0);
    const item = (await call('GET', '/api/bridge/helper/outbound', { headers: asHelper() })).body.items[0];
    assert.deepEqual([item.kind, item.sourceLabel, item.text], ['reply', 'Project Master', 'Two sessions are working.']);
  });

  it('has the Master route what the gateway could not, and never re-resolves its choice', async () => {
    const alpha = liveProject(`Alpha${++seq}`);
    const accepted = await operatorSays(`m${++seq}`, '@nobody please look at this');
    const routeId = accepted.body.routeId;
    assert.equal(accepted.body.state, 'awaiting-master');

    const bad = await masterWrites(routeId, 'route', { expectedVersion: bridgeStore.routes.get(routeId).version, to: 'no-such-project' });
    assert.equal(bad.body.code, 'UNKNOWN_DESTINATION');

    const routed = await masterWrites(routeId, 'route', { expectedVersion: bridgeStore.routes.get(routeId).version, to: alpha.project.name });
    assert.deepEqual([routed.status, routed.body.route.state, routed.body.route.resolvedBy, routed.body.route.destination.projectId],
      [200, 'routed', 'master', alpha.project.id]);
    assert.equal(hub.sent.length, 1);

    const again = await masterWrites(routeId, 'route', { expectedVersion: bridgeStore.routes.get(routeId).version, to: 'master' });
    assert.equal(again.body.code, 'NOT_AWAITING_MASTER');
  });

  it('refuses a release with nothing held, an unsafe or empty answer, and a second answer', async () => {
    const accepted = await operatorSays(`m${++seq}`, 'hello');
    const routeId = accepted.body.routeId;
    const version = () => bridgeStore.routes.get(routeId).version;
    assert.equal((await masterWrites(routeId, 'release', { expectedVersion: version() })).body.code, 'NO_REPLY_HELD');
    assert.equal((await masterWrites(routeId, 'answer', { expectedVersion: version(), text: '  ' })).body.code, 'ANSWER_REQUIRED');
    assert.equal((await masterWrites(routeId, 'answer', { expectedVersion: version(), text: 'safe‮evil' })).body.code, 'ANSWER_NOT_DISPLAY_SAFE');
    assert.equal((await masterWrites(routeId, 'answer', { expectedVersion: version(), text: 'x'.repeat(8001) })).body.code, 'ANSWER_TOO_LONG');
    assert.equal((await masterWrites(routeId, 'answer', { expectedVersion: version(), text: 'fine' })).status, 200);
    assert.equal((await masterWrites(routeId, 'answer', { expectedVersion: version(), text: 'again' })).body.code, 'NOT_ANSWERABLE');
    assert.equal((await call('GET', '/api/bridge/helper/outbound', { headers: asHelper() })).body.items.length >= 1, true);
  });

  it('lets the Master pin a conversation, and only a conversation', async () => {
    const alpha = liveProject(`Alpha${++seq}`);
    const first = await operatorSays(`m${++seq}`, 'hello');
    const routeId = first.body.routeId;
    const pinned = await masterWrites(routeId, 'pin', { expectedVersion: bridgeStore.routes.get(routeId).version, to: alpha.project.id });
    assert.equal(pinned.status, 200);
    const pin = bridgeStore.pins.list().find((p) => p.conversationKey === ALLOWED.channelId && p.createdBy === 'master');
    assert.deepEqual([pin.scope, pin.destination.projectId], ['conversation', alpha.project.id]);

    const next = await operatorSays(`m${++seq}`, 'and this');
    assert.deepEqual([bridgeStore.routes.get(next.body.routeId).resolvedBy, hub.sent.length], ['pin', 1]);
    assert.equal(bridgeApi.operatorRevokePin({ req: SIGNED_IN, params: { pinId: pin.pinId } }).status, 200);
  });

  describe('who may call what', () => {
    it('the helper routes answer only the active helper token, with a fresh nonce on every write', async () => {
      const body = { externalId: `m${++seq}`, ...ALLOWED, text: 'hello' };
      for (const headers of [{}, asHelper({ [bridgeApi.HELPER_TOKEN_HEADER]: 'bht_wrong' }), asMaster(), operatorHeaders(server)]) {
        const r = await call('POST', '/api/bridge/helper/inbound', { headers, body });
        assert.deepEqual([r.status, r.body.code], [401, 'HELPER_TOKEN_REQUIRED']);
        assert.equal((await call('GET', '/api/bridge/helper/outbound', { headers })).status, 401);
      }
      const noNonce = await call('POST', '/api/bridge/helper/inbound', { headers: { [bridgeApi.HELPER_TOKEN_HEADER]: helperToken }, body });
      assert.equal(noNonce.body.code, 'NONCE_REQUIRED');
      const headers = asHelper();
      assert.equal((await call('POST', '/api/bridge/helper/inbound', { headers, body })).status, 202);
      assert.equal((await call('POST', '/api/bridge/helper/inbound', { headers, body })).body.code, 'NONCE_REUSED');
    });

    it('the helper token opens nothing but the helper routes', async () => {
      for (const [method, apiPath] of [
        ['GET', '/api/bridge/master/status'], ['GET', '/api/bridge/master/routes'],
        ['GET', '/api/bridge/operator/status'], ['POST', '/api/bridge/operator/disable']
      ]) {
        const r = await call(method, apiPath, { headers: asHelper() });
        assert.ok([401, 403].includes(r.status), `${method} ${apiPath} answered ${r.status}`);
      }
    });

    it('the Master credential opens neither the helper routes nor the operator routes', async () => {
      assert.equal((await call('GET', '/api/bridge/helper/outbound', { headers: asMaster() })).status, 401);
      assert.equal((await call('POST', '/api/bridge/operator/enable', { headers: asMaster() })).status, 403);
    });

    it('operator policy needs a signed-in operator: an open gate and a dashboard-shaped request are refused', async () => {
      // Over HTTP on a scratch store the gate is open, so this request is the
      // operator in appearance only.
      for (const [method, apiPath] of [
        ['GET', '/api/bridge/operator/status'], ['POST', '/api/bridge/operator/enable'], ['POST', '/api/bridge/operator/disable'],
        ['POST', '/api/bridge/operator/allowlist'], ['POST', '/api/bridge/operator/helper-token'],
        ['DELETE', '/api/bridge/operator/helper-token'], ['POST', '/api/bridge/operator/aliases'],
        ['DELETE', '/api/bridge/operator/aliases/x'], ['POST', '/api/bridge/operator/pins'], ['DELETE', '/api/bridge/operator/pins/x']
      ]) {
        const r = await call(method, apiPath, { headers: operatorHeaders(server), body: method === 'POST' ? {} : undefined });
        assert.deepEqual([r.status, r.body.code], [403, 'OPERATOR_SESSION_REQUIRED'], `${method} ${apiPath}`);
      }
      assert.equal(bridgeApi.operatorSwitch(false)({ req: AMBIENT }).body.code, 'OPERATOR_SESSION_REQUIRED');
      assert.equal(bridgeStore.settings.isEnabled(), true, 'the refused request changed nothing');
      assert.ok(gateway.verifyHelperToken(helperToken), 'and revoked nothing');
    });

    it('a signed-in operator\'s changes are audited with who made them, and never with a secret', () => {
      const status = bridgeApi.operatorStatus({ req: SIGNED_IN });
      assert.deepEqual([status.status, status.body.enabled, status.body.allowlist], [200, true, ALLOWED]);
      assert.ok(!JSON.stringify(status.body).includes(helperToken));

      assert.equal(bridgeApi.operatorSetAlias({ req: SIGNED_IN, body: { alias: 'Master', to: 'master' } }).body.code, 'ALIAS_RESERVED');
      assert.equal(bridgeApi.operatorSetAlias({ req: SIGNED_IN, body: { alias: 'boss', to: 'master' } }).status, 200);
      assert.equal(bridgeApi.operatorRemoveAlias({ req: SIGNED_IN, params: { alias: 'boss' } }).status, 200);

      const rows = store.getDb().prepare("SELECT * FROM bridge_audit WHERE actor = 'operator'").all();
      assert.ok(rows.length >= 5);
      assert.ok(rows.every((r) => r.proof === 'verified-session' && JSON.parse(r.detail_json).user === 'rosie'));
      const dump = JSON.stringify(rows);
      assert.ok(!dump.includes(helperToken) && !dump.includes(ALLOWED.authorId), 'no token and no chat id in the audit');
    });

    it('cannot be enabled before it has an allowlist and a helper token', () => {
      bridgeApi.operatorSwitch(false)({ req: SIGNED_IN });
      bridgeApi.operatorRevokeHelperToken({ req: SIGNED_IN });
      assert.equal(bridgeApi.operatorSwitch(true)({ req: SIGNED_IN }).body.code, 'HELPER_TOKEN_NOT_SET');
      bridgeStore.settings.set('allow.channel', null);
      assert.equal(bridgeApi.operatorSwitch(true)({ req: SIGNED_IN }).body.code, 'ALLOWLIST_NOT_SET');
      assert.equal(bridgeStore.settings.isEnabled(), false);
    });

    it('a disabled bridge refuses the helper and every Master write', async () => {
      const accepted = await operatorSays(`m${++seq}`, 'hello');
      const routeId = accepted.body.routeId;
      bridgeApi.operatorSwitch(false)({ req: SIGNED_IN });
      assert.equal((await operatorSays(`m${++seq}`, 'hello again')).body.code, 'BRIDGE_DISABLED');
      assert.equal((await call('GET', '/api/bridge/helper/outbound', { headers: asHelper() })).body.code, 'BRIDGE_DISABLED');
      for (const op of ['route', 'answer', 'release', 'pin', 'close']) {
        assert.equal((await masterWrites(routeId, op, { expectedVersion: 1, to: 'master', text: 'x' })).body.code, 'BRIDGE_DISABLED', op);
      }
    });
  });
});
