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
const { operatorHeaders } = require('./_shared-docs-callers');
const { install } = require('./_bridge-hub');
const { execFile } = require('node:child_process');

const TC_BIN = path.join(__dirname, '..', 'bin', 'tc');
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
  return hub.liveProject(name, tmpDir);
}

/**
 * The session replies over Medusa through the real send path, and the
 * gateway takes the arrival.
 * @param {object} target - What {@link liveProject} returned.
 * @param {string} inReplyTo - The Hub id it answers.
 * @param {string} text - The reply.
 * @returns {Promise<void>}
 */
async function sessionReplies(target, inReplyTo, text) {
  const sent = await hub.sessionSends(target, { inReplyTo, text });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  gateway.drainInbox();
}

/**
 * The signed-in operator calls one of the operator's routes.
 * @param {string} method - HTTP method.
 * @param {string} apiPath - Declared path.
 * @param {object} [request] - `body`, `params`; `req` defaults to the signed-in operator.
 * @returns {Promise<{status: number, body: object}>}
 */
function asOperator(method, apiPath, request = {}) {
  return bridgeApi.handle(bridgeApi.routeFor(method, apiPath), { req: SIGNED_IN, headers: {}, ...request });
}

/**
 * Run the real `bin/tc` as the Master pane would.
 * @param {string[]} args - Arguments.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function tc(args) {
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TANGLECLAW_API: origin, TANGLECLAW_ROLE: 'master',
    [handoff.CREDENTIAL_ENV]: masterCredential
  };
  return new Promise((resolve) => {
    execFile(TC_BIN, args, { env, encoding: 'utf8' }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
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
    if (hub) hub.restore();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (hub) hub.restore();
    hub = install();
    Object.assign(gateway._deps, {
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
    await asOperator('POST', '/api/bridge/operator/disable');
    assert.equal((await asOperator('POST', '/api/bridge/operator/allowlist', { body: ALLOWED })).status, 200);
    helperToken = (await asOperator('POST', '/api/bridge/operator/helper-token')).body.token;
    assert.equal((await asOperator('POST', '/api/bridge/operator/enable')).status, 200);
  });

  it('carries a message to a project and its answer back, releasing nothing until the Master does', async () => {
    const alpha = liveProject(`Alpha${++seq}`);
    const accepted = await operatorSays(`m${++seq}`, `@${alpha.project.name} is the build green?`);
    assert.equal(accepted.status, 202);
    const routeId = accepted.body.routeId;
    assert.equal(accepted.body.state, 'routed');
    assert.equal(hub.fromGateway()[0].to, alpha.workspaceId);

    await sessionReplies(alpha, hub.fromGateway()[0].hubId, 'yes, all green');
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
    assert.equal(hub.fromGateway().length, 0);
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
    assert.equal(hub.fromGateway().length, 1);

    const again = await masterWrites(routeId, 'route', { expectedVersion: bridgeStore.routes.get(routeId).version, to: 'master' });
    assert.equal(again.body.code, 'NOT_AWAITING_MASTER');
  });

  it('refuses a release with nothing held, an unsafe or empty answer, and a second answer', async () => {
    const accepted = await operatorSays(`m${++seq}`, 'hello');
    const routeId = accepted.body.routeId;
    const version = () => bridgeStore.routes.get(routeId).version;
    assert.equal((await masterWrites(routeId, 'release', { expectedVersion: version() })).body.code, 'NO_REPLY_HELD');
    assert.equal((await masterWrites(routeId, 'answer', { expectedVersion: version(), text: '  ' })).body.code, 'ANSWER_REQUIRED');
    assert.equal((await masterWrites(routeId, 'answer', { expectedVersion: version(), text: 'safe\u202Eevil' })).body.code, 'ANSWER_NOT_DISPLAY_SAFE');
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
    assert.deepEqual([bridgeStore.routes.get(next.body.routeId).resolvedBy, hub.fromGateway().length], ['pin', 1]);
    assert.equal((await asOperator('DELETE', '/api/bridge/operator/pins/:pinId', { params: { pinId: pin.pinId } })).status, 200);
  });

  it('the Master drives every routing verb through the real tc', async () => {
    const alpha = liveProject(`Alpha${++seq}`);
    const waiting = (await operatorSays(`m${++seq}`, '@nobody look at this')).body.routeId;
    const version = (id) => String(bridgeStore.routes.get(id).version);

    // A project id on the command line is a number, not a name.
    const routed = await tc(['bridge', 'route', waiting, '--version', version(waiting), '--to', String(alpha.project.id)]);
    assert.equal(routed.code, 0, routed.stderr);
    assert.match(routed.stdout, new RegExp(`is now routed, to project #${alpha.project.id}`));
    assert.equal(hub.fromGateway()[0].to, alpha.workspaceId);

    await sessionReplies(alpha, hub.fromGateway()[0].hubId, 'done');
    const released = await tc(['bridge', 'release', waiting, '--version', version(waiting)]);
    assert.equal(released.code, 0, released.stderr);
    assert.match(released.stdout, /held reply .* is released to the operator as your answer/);

    const own = (await operatorSays(`m${++seq}`, 'a question for the Master')).body.routeId;
    const pinned = await tc(['bridge', 'pin', own, '--version', version(own), '--to', alpha.project.name]);
    assert.equal(pinned.code, 0, pinned.stderr);
    const file = path.join(tmpDir, 'answer.txt');
    fs.writeFileSync(file, 'An answer from a file.');
    const answered = await tc(['bridge', 'answer', own, '--version', version(own), '--text-file', file]);
    assert.equal(answered.code, 0, answered.stderr);
    assert.equal(bridgeStore.routes.body(own, 'answer').text, 'An answer from a file.');

    const usage = await tc(['bridge', 'answer', own, '--version', '1']);
    assert.deepEqual([usage.code, /exactly one of --text or --text-file/.test(usage.stderr)], [1, true]);
    const missing = await tc(['bridge', 'answer', own, '--version', '1', '--text-file', path.join(tmpDir, 'none.txt')]);
    assert.deepEqual([missing.code, /could not read/.test(missing.stderr)], [1, true]);
    const refused = await tc(['bridge', 'answer', own, '--version', version(own), '--text', 'again']);
    assert.deepEqual([refused.code, /NOT_ANSWERABLE/.test(refused.stderr)], [2, true]);
    const noTo = await tc(['bridge', 'route', own, '--version', '1']);
    assert.deepEqual([noTo.code, /needs --to/.test(noTo.stderr)], [1, true]);
  });

  it('a send that could not be confirmed is the Master\'s to answer, and cannot be routed again', async () => {
    const name = liveProject(`Alpha${++seq}`).project.name;
    hub.failSend = 'unknown';
    const routeId = (await operatorSays(`m${++seq}`, `@${name} hello`)).body.routeId;
    hub.failSend = null;
    const version = () => bridgeStore.routes.get(routeId).version;
    assert.deepEqual([bridgeStore.routes.get(routeId).state, bridgeStore.routes.get(routeId).failureCode], ['accepted', 'send-unconfirmed']);

    const reroute = await masterWrites(routeId, 'route', { expectedVersion: version(), to: name });
    assert.deepEqual([reroute.status, reroute.body.code], [409, 'NOT_AWAITING_MASTER']);
    assert.equal(hub.fromGateway().length, 0, 'the Master\'s route does not send it either');

    const answered = await masterWrites(routeId, 'answer', { expectedVersion: version(), text: 'I could not confirm that reached them. I will follow up.' });
    assert.deepEqual([answered.status, answered.body.route.state], [200, 'released']);
    const externalId = bridgeStore.routes.get(routeId).externalId;
    const items = (await call('GET', '/api/bridge/helper/outbound', { headers: asHelper() })).body.items
      .filter((i) => i.inReplyTo && i.inReplyTo.externalId === externalId);
    assert.deepEqual(items.map((i) => i.kind).sort(), ['failure', 'reply'], 'one notice that it is unconfirmed, and one answer');

    // An accepted route with no such mark is still being resolved or sent: not the Master's to answer.
    bridgeStore.routes.accept({ routeId: 'rt_plain', externalId: `m${++seq}`, ...ALLOWED, text: 'x', digest: bridgeStore.digest('x') });
    const plain = await masterWrites('rt_plain', 'answer', { expectedVersion: 1, text: 'too early' });
    assert.deepEqual([plain.status, plain.body.code], [409, 'NOT_ANSWERABLE']);
  });

  it('an acknowledgement and the route\'s close land together, and a repeat changes nothing', async () => {
    const accepted = await operatorSays(`m${++seq}`, 'hello');
    const routeId = accepted.body.routeId;
    await masterWrites(routeId, 'answer', { expectedVersion: bridgeStore.routes.get(routeId).version, text: 'hi' });
    const externalId = bridgeStore.routes.get(routeId).externalId;
    const item = (await call('GET', '/api/bridge/helper/outbound', { headers: asHelper() })).body.items
      .find((i) => i.kind === 'reply' && i.inReplyTo.externalId === externalId);
    const ack = () => call('POST', `/api/bridge/helper/outbound/${item.outboundId}/ack`, { headers: asHelper(), body: { deliveredRef: 'posted-9' } });
    assert.deepEqual([(await ack()).body.replayed, (await ack()).body.replayed], [false, true]);
    assert.equal(bridgeStore.routes.get(routeId).state, 'closed');
    assert.equal(bridgeStore.audit.forRoute(routeId).filter((a) => a.op === 'delivered').length, 1);
    const other = await call('POST', `/api/bridge/helper/outbound/${item.outboundId}/ack`, { headers: asHelper(), body: { deliveredRef: 'posted-10' } });
    assert.equal(other.body.code, 'ACK_MISMATCH');
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
      const ambient = await bridgeApi.handle(bridgeApi.routeFor('POST', '/api/bridge/operator/disable'), { req: AMBIENT, headers: {} });
      assert.equal(ambient.body.code, 'OPERATOR_SESSION_REQUIRED');
      assert.equal(bridgeStore.settings.isEnabled(), true, 'the refused request changed nothing');
      assert.ok(gateway.verifyHelperToken(helperToken), 'and revoked nothing');
    });

    it('a signed-in operator\'s changes are audited with who made them, and never with a secret', async () => {
      const status = await asOperator('GET', '/api/bridge/operator/status');
      assert.deepEqual([status.status, status.body.enabled, status.body.allowlist], [200, true, ALLOWED]);
      assert.deepEqual(status.body.droppedArrivals, { count: 0, recent: [] });
      assert.ok(!JSON.stringify(status.body).includes(helperToken));

      assert.equal((await asOperator('POST', '/api/bridge/operator/aliases', { body: { alias: 'Master', to: 'master' } })).body.code, 'ALIAS_RESERVED');
      assert.equal((await asOperator('POST', '/api/bridge/operator/aliases', { body: { alias: 'boss', to: 'master' } })).status, 200);
      assert.equal((await asOperator('DELETE', '/api/bridge/operator/aliases/:alias', { params: { alias: 'boss' } })).status, 200);

      const rows = store.getDb().prepare("SELECT * FROM bridge_audit WHERE actor = 'operator'").all();
      assert.ok(rows.length >= 5);
      assert.ok(rows.every((r) => r.proof === 'verified-session' && JSON.parse(r.detail_json).user === 'rosie'));
      const dump = JSON.stringify(rows);
      assert.ok(!dump.includes(helperToken) && !dump.includes(ALLOWED.authorId), 'no token and no chat id in the audit');
    });

    it('enabling records when, which is the line no notification looks behind', async () => {
      const bridgeNotify = require('../lib/bridge-notify');
      await asOperator('POST', '/api/bridge/operator/disable');
      const before = new Date().toISOString();
      assert.equal((await asOperator('POST', '/api/bridge/operator/enable')).status, 200);
      const enabledAt = bridgeStore.settings.get(bridgeNotify.ENABLED_AT);
      assert.ok(enabledAt >= before && enabledAt <= new Date().toISOString());
      await asOperator('POST', '/api/bridge/operator/disable');
      await asOperator('POST', '/api/bridge/operator/enable');
      assert.ok(bridgeStore.settings.get(bridgeNotify.ENABLED_AT) >= enabledAt, 'each enable moves it forward');
    });

    it('cannot be enabled before it has an allowlist and a helper token', async () => {
      await asOperator('POST', '/api/bridge/operator/disable');
      await asOperator('DELETE', '/api/bridge/operator/helper-token');
      assert.equal((await asOperator('POST', '/api/bridge/operator/enable')).body.code, 'HELPER_TOKEN_NOT_SET');
      bridgeStore.settings.set('allow.channel', null);
      assert.equal((await asOperator('POST', '/api/bridge/operator/enable')).body.code, 'ALLOWLIST_NOT_SET');
      assert.equal(bridgeStore.settings.isEnabled(), false);
    });

    it('every declared route refuses a caller with no proof, before its handler runs', async () => {
      assert.equal(new Set(bridgeApi.ROUTES.map((r) => `${r.method} ${r.path}`)).size, bridgeApi.ROUTES.length);
      for (const entry of bridgeApi.ROUTES) {
        assert.ok(['master', 'helper', 'operator', 'session'].includes(entry.principal), `${entry.method} ${entry.path} declares its principal`);
        let reached = false;
        const guarded = { ...entry, handler: () => { reached = true; return { status: 200, body: {} }; } };
        const refused = await bridgeApi.handle(guarded, { req: { headers: {} }, headers: {}, params: {}, body: {} });
        assert.ok([401, 403].includes(refused.status), `${entry.method} ${entry.path} answered ${refused.status}`);
        assert.equal(reached, false, `${entry.method} ${entry.path} ran its handler unauthenticated`);
        // And over HTTP, as registered.
        const apiPath = entry.path.replace(/:[A-Za-z]+/g, 'x');
        const http = await call(entry.method, apiPath, { body: entry.method === 'GET' ? undefined : {} });
        assert.ok([401, 403].includes(http.status), `${entry.method} ${apiPath} over HTTP answered ${http.status}`);
      }
    });

    it('a principal\'s proof opens only that principal\'s routes', async () => {
      // A verified project launch: the fourth principal.
      const project = store.projects.create({ name: `Caller${++seq}`, path: path.join(tmpDir, `Caller${seq}`) });
      const sessionHeaders = require('./_shared-docs-callers').bindProject(project).headers;
      const proofs = {
        master: { headers: asMaster(), req: { headers: {} } },
        helper: { headers: asHelper(), req: { headers: {} } },
        operator: { headers: {}, req: SIGNED_IN },
        session: { headers: sessionHeaders, req: { headers: sessionHeaders } }
      };
      for (const entry of bridgeApi.ROUTES) {
        for (const [who, proof] of Object.entries(proofs)) {
          if (who === entry.principal) continue;
          let reached = false;
          const guarded = { ...entry, handler: () => { reached = true; return { status: 200, body: {} }; } };
          await bridgeApi.handle(guarded, { ...proof, headers: who === 'helper' ? asHelper() : proof.headers, params: {}, body: {} });
          assert.equal(reached, false, `${who}'s proof reached ${entry.method} ${entry.path}`);
        }
      }
    });

    it('a disabled bridge refuses the helper and every Master write', async () => {
      const accepted = await operatorSays(`m${++seq}`, 'hello');
      const routeId = accepted.body.routeId;
      await asOperator('POST', '/api/bridge/operator/disable');
      assert.equal((await operatorSays(`m${++seq}`, 'hello again')).body.code, 'BRIDGE_DISABLED');
      assert.equal((await call('GET', '/api/bridge/helper/outbound', { headers: asHelper() })).body.code, 'BRIDGE_DISABLED');
      for (const op of ['route', 'answer', 'release', 'pin']) {
        assert.equal((await masterWrites(routeId, op, { expectedVersion: 1, to: 'master', text: 'x' })).body.code, 'BRIDGE_DISABLED', op);
      }
      const closed = await masterWrites(routeId, 'close', { expectedVersion: bridgeStore.routes.get(routeId).version });
      assert.equal(closed.body.route.state, 'closed', 'a held message can still be let go while the bridge is off');
    });
  });
});
