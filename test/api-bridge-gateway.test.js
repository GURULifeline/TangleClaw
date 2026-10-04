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
const { setLevel, setConsoleStream } = require('../lib/logger');

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
 * Collect what waits, as the helper does: every item comes under a lease.
 * @param {object} [headers] - Request headers; the helper's by default.
 * @returns {Promise<{status: number, body: object}>}
 */
function claim(headers = asHelper()) {
  return call('POST', '/api/bridge/helper/outbound/claim', { headers, body: { limit: 20 } });
}

/**
 * Acknowledge a claimed item under its lease.
 * @param {{outboundId: number, leaseId: string}} item - A claimed item.
 * @param {string} deliveredRef - The chat's id for the post.
 * @returns {Promise<{status: number, body: object}>}
 */
function ackItem(item, deliveredRef) {
  return call('POST', `/api/bridge/helper/outbound/${item.outboundId}/ack`, { headers: asHelper(), body: { leaseId: item.leaseId, parts: [deliveredRef], partCount: 1 } });
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
 * @param {object} [over] - Environment overrides.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function tc(args, over = {}) {
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TANGLECLAW_API: origin, TANGLECLAW_ROLE: 'master',
    [handoff.CREDENTIAL_ENV]: masterCredential, ...over
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
        getMasterMedusaStatus: () => ({ workspaceId: 'master-ws' }),
        masterListenerEnabled: () => true
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
    assert.deepEqual((await claim()).body.items, [],
      'a held reply is not handed to the helper');

    const read = await call('GET', `/api/bridge/master/routes/${routeId}`, { headers: asMaster() });
    assert.equal(read.body.route.state, 'reply-held');
    assert.deepEqual(read.body.bodies.map((b) => b.role), ['inbound', 'reply']);

    const released = await masterWrites(routeId, 'release', { expectedVersion: read.body.route.version });
    assert.deepEqual([released.status, released.body.route.state], [200, 'released']);

    const out = await claim();
    assert.equal(out.body.items.length, 1);
    const item = out.body.items[0];
    assert.deepEqual([item.kind, item.text, item.sourceLabel], ['reply', 'yes, all green', `Project Master, relaying ${alpha.project.name}`]);
    assert.equal(item.inReplyTo.channelId, ALLOWED.channelId);

    const ack = await ackItem(item, 'posted-1');
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
    const item = (await claim()).body.items[0];
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
    assert.equal((await claim()).body.items.length >= 1, true);
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

  it('withdrawing a route\'s answer before it is posted closes the route and clears its text', async () => {
    /**
     * The operator writes, and the Master answers: a released route and its one unposted answer.
     * @param {string} text - The answer.
     * @returns {Promise<{routeId: string, itemId: number}>}
     */
    const answered = async (text) => {
      const routeId = (await operatorSays(`m${++seq}`, 'a question for the Master')).body.routeId;
      const done = await masterWrites(routeId, 'answer', { expectedVersion: bridgeStore.routes.get(routeId).version, text });
      assert.equal(done.body.route.state, 'released');
      const item = store.getDb().prepare("SELECT outbound_id FROM bridge_outbound WHERE route_id = ? AND kind = 'reply'").get(routeId);
      return { routeId, itemId: item.outbound_id };
    };
    const closures = (routeId) => bridgeStore.audit.forRoute(routeId).filter((a) => a.op === 'answer-withdrawn');

    // By the Master, with its command.
    const one = await answered('An answer the Master thinks better of.');
    assert.ok(bridgeStore.routes.body(one.routeId, 'answer').text, 'precondition: the answer\'s text is held');
    const gone = await tc(['bridge', 'withdraw', String(one.itemId)]);
    assert.equal(gone.code, 0, gone.stderr);
    const route = bridgeStore.routes.get(one.routeId);
    assert.deepEqual([route.state, route.closedBy], ['closed', 'master'], 'nothing more is coming for it, so it does not stay released');
    for (const role of ['inbound', 'answer']) {
      const body = bridgeStore.routes.body(one.routeId, role);
      assert.ok(!body || body.text === null, `${role} text is cleared`);
    }
    assert.deepEqual(closures(one.routeId).map((a) => [a.actor, a.outcome, a.detail.outboundId, a.masterGeneration]), [['master', 'applied', one.itemId, masterGeneration]]);
    assert.deepEqual([bridgeStore.outbound.get(one.itemId).state, bridgeStore.outbound.get(one.itemId).dropCode], ['dropped', 'withdrawn']);
    // The Master cannot answer it again: the operator writes again to be answered.
    const late = await masterWrites(one.routeId, 'answer', { expectedVersion: route.version, text: 'second thoughts' });
    assert.equal(late.status, 409);

    // By the signed-in operator, the same.
    const two = await answered('An answer the operator stops.');
    const stopped = await bridgeApi.handle(bridgeApi.routeFor('POST', '/api/bridge/operator/outbound/:outboundId/withdraw'),
      { req: SIGNED_IN, headers: SIGNED_IN.headers, params: { outboundId: String(two.itemId) }, body: { requestId: `req-op-withdraw-${++seq}-00` } });
    assert.equal(stopped.status, 200);
    assert.deepEqual([bridgeStore.routes.get(two.routeId).state, bridgeStore.routes.get(two.routeId).closedBy], ['closed', 'operator']);
    assert.deepEqual(closures(two.routeId).map((a) => [a.actor, a.proof, a.detail.user]), [['operator', 'verified-session', 'rosie']], 'on the record with who did it');

    // Withdrawing something that is not a route's answer closes no route.
    const three = await answered('An answer that is left alone.');
    const text = 'a notice of its own';
    const notice = bridgeStore.outbound.enqueue({
      idemKey: `notify:operator-needed:lone-${++seq}`, kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw', text, digest: bridgeStore.digest(text)
    }).outboundId;
    assert.equal((await tc(['bridge', 'withdraw', String(notice)])).code, 0);
    assert.equal(bridgeStore.routes.get(three.routeId).state, 'released');
    assert.deepEqual(closures(three.routeId), []);

    // A circuit reset that withdraws what it caught closes the routes of the answers among them.
    const claimed = (await claim()).body.items.find((i) => i.outboundId === three.itemId);
    const reported = await call('POST', `/api/bridge/helper/outbound/${three.itemId}/failure`, { headers: asHelper(), body: { leaseId: claimed.leaseId, reason: 'chat-channel-missing' } });
    assert.equal(reported.body.circuit.opened, true);
    assert.equal((await tc(['bridge', 'reset', '--withdraw'])).code, 0);
    assert.deepEqual([bridgeStore.routes.get(three.routeId).state, bridgeStore.routes.get(three.routeId).closedBy, closures(three.routeId).length], ['closed', 'master', 1]);
    // And one that puts them back leaves the route waiting for its answer to post.
    const four = await answered('An answer that is put back.');
    const again = (await claim()).body.items.find((i) => i.outboundId === four.itemId);
    await call('POST', `/api/bridge/helper/outbound/${four.itemId}/failure`, { headers: asHelper(), body: { leaseId: again.leaseId, reason: 'chat-channel-missing' } });
    assert.equal((await tc(['bridge', 'reset', '--requeue'])).code, 0);
    assert.equal(bridgeStore.routes.get(four.routeId).state, 'released');
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
    const items = (await claim()).body.items
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
    const item = (await claim()).body.items
      .find((i) => i.kind === 'reply' && i.inReplyTo.externalId === externalId);
    const ack = () => ackItem(item, 'posted-9');
    assert.deepEqual([(await ack()).body.replayed, (await ack()).body.replayed], [false, true]);
    assert.equal(bridgeStore.routes.get(routeId).state, 'closed');
    assert.equal(bridgeStore.audit.forRoute(routeId).filter((a) => a.op === 'delivered').length, 1);
    const other = await ackItem(item, 'posted-10');
    assert.equal(other.body.code, 'ACK_MISMATCH');
  });

  it('a claim is named by its nonce: asking again returns the same leases, and a changed request is refused', async () => {
    const accepted = await operatorSays(`m${++seq}`, 'hello');
    const routeId = accepted.body.routeId;
    await masterWrites(routeId, 'answer', { expectedVersion: bridgeStore.routes.get(routeId).version, text: 'hi' });
    const headers = asHelper();
    const first = await call('POST', '/api/bridge/helper/outbound/claim', { headers, body: { limit: 20 } });
    const again = await call('POST', '/api/bridge/helper/outbound/claim', { headers, body: { limit: 20 } });
    assert.deepEqual([first.status, first.body.replayed, again.status, again.body.replayed], [200, false, 200, true]);
    assert.ok(first.body.items.length >= 1);
    assert.deepEqual(again.body.items, first.body.items);
    for (const item of first.body.items) assert.match(item.leaseId, /^bol_[A-Za-z0-9_-]{22}$/);

    const changed = await call('POST', '/api/bridge/helper/outbound/claim', { headers, body: { limit: 5 } });
    assert.deepEqual([changed.status, changed.body.code], [409, 'NONCE_REUSED']);
    const asInbound = await call('POST', '/api/bridge/helper/inbound', { headers, body: { externalId: `m${++seq}`, ...ALLOWED, text: 'x' } });
    assert.equal(asInbound.body.code, 'NONCE_REUSED', 'a claim\'s nonce is spent for every other write');
    const noNonce = await call('POST', '/api/bridge/helper/outbound/claim', { headers: { [bridgeApi.HELPER_TOKEN_HEADER]: helperToken }, body: {} });
    assert.deepEqual([noNonce.status, noNonce.body.code], [400, 'NONCE_REQUIRED']);
    const badLimit = await call('POST', '/api/bridge/helper/outbound/claim', { headers: asHelper(), body: { limit: 500 } });
    assert.deepEqual([badLimit.status, badLimit.body.code], [400, 'BAD_CLAIM']);

    const reading = await call('GET', '/api/bridge/helper/outbound', { headers: asHelper() });
    assert.equal(reading.status, 404, 'there is no way to read the mailbox without claiming from it');
  });

  it('an acknowledgement over the route needs its lease, from the token that holds it', async () => {
    const accepted = await operatorSays(`m${++seq}`, 'hello');
    const routeId = accepted.body.routeId;
    await masterWrites(routeId, 'answer', { expectedVersion: bridgeStore.routes.get(routeId).version, text: 'hi' });
    const externalId = bridgeStore.routes.get(routeId).externalId;
    const item = (await claim()).body.items.find((i) => i.kind === 'reply' && i.inReplyTo.externalId === externalId);
    const post = (body) => call('POST', `/api/bridge/helper/outbound/${item.outboundId}/ack`, { headers: asHelper(), body });

    const bare = await post({ parts: ['posted-20'], partCount: 1 });
    assert.deepEqual([bare.status, bare.body.code], [400, 'LEASE_REQUIRED']);
    const oneId = await post({ deliveredRef: 'posted-20', leaseId: item.leaseId });
    assert.deepEqual([oneId.status, oneId.body.code], [400, 'BAD_ACK'], 'an acknowledgement always gives every part and the count');
    const wrong = await post({ parts: ['posted-20'], partCount: 1, leaseId: 'bol_nosuchlease00000000000' });
    assert.deepEqual([wrong.status, wrong.body.code], [404, 'LEASE_NOT_FOUND']);
    assert.equal(bridgeStore.routes.get(routeId).state, 'released', 'neither closed the route');

    // The operator replaces the token: what the old one held is not the new one's to acknowledge.
    helperToken = (await asOperator('POST', '/api/bridge/operator/helper-token')).body.token;
    const stolen = await post({ parts: ['posted-20'], partCount: 1, leaseId: item.leaseId });
    assert.deepEqual([stolen.status, stolen.body.code], [403, 'LEASE_NOT_YOURS']);
    const mine = (await claim()).body.items.find((i) => i.outboundId === item.outboundId);
    assert.equal((await ackItem(mine, 'posted-20')).status, 200);
    assert.equal(bridgeStore.routes.get(routeId).state, 'closed');
  });

  it('records every part over the route, and a reply to any of them is the Master\'s to read as a reply to that item', async () => {
    const text = 'Milestone: the suite is green.';
    const id = bridgeStore.outbound.enqueue({
      idemKey: `notify:operator-needed:parts-${++seq}`, kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw',
      text, digest: bridgeStore.digest(text)
    }).outboundId;
    const item = (await claim()).body.items.find((i) => i.outboundId === id);
    const parts = [`p${++seq}a`, `p${seq}b`, `p${seq}c`];
    const post = (body, headers = asHelper()) => call('POST', `/api/bridge/helper/outbound/${id}/ack`, { headers, body });

    const partial = await post({ leaseId: item.leaseId, parts: parts.slice(0, 2), partCount: 3 });
    assert.deepEqual([partial.status, partial.body.code], [400, 'BAD_ACK']);
    const noToken = await post({ leaseId: item.leaseId, parts, partCount: 3 }, { [bridgeApi.HELPER_NONCE_HEADER]: crypto.randomBytes(16).toString('hex') });
    assert.deepEqual([noToken.status, noToken.body.code], [401, 'HELPER_TOKEN_REQUIRED']);
    assert.equal((await post({ leaseId: item.leaseId, parts, partCount: 3 }, asMaster())).status, 401, 'the Master\'s credential does not acknowledge');
    assert.equal(bridgeStore.outbound.get(id).state, 'ready');

    const done = await post({ leaseId: item.leaseId, parts, partCount: 3 });
    assert.deepEqual([done.status, done.body.replayed, done.body.parts], [200, false, 3]);
    assert.equal((await post({ leaseId: item.leaseId, parts, partCount: 3 })).body.replayed, true);
    assert.equal((await post({ leaseId: item.leaseId, parts: [parts[0]], partCount: 1 })).body.code, 'ACK_MISMATCH');

    // The operator replies to the middle part.
    const replyId = `m${++seq}`;
    const reply = await call('POST', '/api/bridge/helper/inbound', { headers: asHelper(), body: { externalId: replyId, ...ALLOWED, replyToExternalId: parts[1], text: 'who needs me?' } });
    assert.equal(reply.status, 202);
    const read = await call('GET', `/api/bridge/master/routes/${reply.body.routeId}`, { headers: asMaster() });
    assert.deepEqual([read.body.route.resolvedBy, read.body.route.destination.kind], ['outbound-correlation', 'master']);
    assert.deepEqual(read.body.route.replyContext, {
      repliedExternalId: parts[1], canonicalExternalId: parts[0], outboundId: id, partIndex: 1, partCount: 3,
      kind: 'notification', notifyType: 'operator-needed', routeId: null, candidateId: null, candidateKind: null
    });
    assert.equal(read.body.bodies.find((b) => b.role === 'inbound').text, 'who needs me?');
    assert.equal(hub.fromGateway().length, 0, 'it went to no session');

    const shown = await tc(['bridge', 'read', reply.body.routeId]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, new RegExp(`answers posted operator-needed \\(item ${id}, part 2 of 3, message ${parts[1]}, first ${parts[0]}\\)`));

    // Somebody else replying to the same message is refused before anything is recorded.
    const stranger = await call('POST', '/api/bridge/helper/inbound', {
      headers: asHelper(), body: { externalId: `m${++seq}`, ...ALLOWED, authorId: 'stranger', replyToExternalId: parts[1], text: 'me too' }
    });
    assert.deepEqual([stranger.status, stranger.body.code], [403, 'NOT_ALLOWLISTED']);
  });

  it('closing a route withdraws its unposted answer, but not while the helper holds it', async () => {
    const realNow = gateway._deps.now;
    try {
      const accepted = await operatorSays(`m${++seq}`, 'hello');
      const routeId = accepted.body.routeId;
      await masterWrites(routeId, 'answer', { expectedVersion: bridgeStore.routes.get(routeId).version, text: 'an answer the Master thinks better of' });
      const externalId = bridgeStore.routes.get(routeId).externalId;
      const item = (await claim()).body.items.find((i) => i.kind === 'reply' && i.inReplyTo.externalId === externalId);
      const version = () => bridgeStore.routes.get(routeId).version;

      const early = await masterWrites(routeId, 'close', { expectedVersion: version() });
      assert.deepEqual([early.status, early.body.code, early.body.route.state], [409, 'OUTBOUND_IN_FLIGHT', 'released']);
      assert.equal(bridgeStore.outbound.get(item.outboundId).state, 'ready', 'the helper may be posting it at this moment');

      // The lease lapses with nothing posted. Now the close goes through, and takes the answer with it.
      const after = Date.now() + bridgeStore.LEASE_MS + 1000;
      gateway._deps.now = () => new Date(after).toISOString();
      const unposted = store.getDb().prepare("SELECT COUNT(*) AS n FROM bridge_outbound WHERE route_id = ? AND state = 'ready'").get(routeId).n;
      const closed = await masterWrites(routeId, 'close', { expectedVersion: version() });
      assert.deepEqual([closed.status, closed.body.route.state], [200, 'closed']);
      const withdrawn = bridgeStore.outbound.get(item.outboundId);
      assert.deepEqual([withdrawn.state, withdrawn.dropCode, withdrawn.text], ['dropped', 'withdrawn', null]);
      assert.equal(bridgeStore.audit.forRoute(routeId).find((a) => a.op === 'close' && a.outcome === 'applied').detail.withdrawn, unposted,
        'everything of the route that was not yet posted, the answer and any notice with it');
      assert.equal(store.getDb().prepare("SELECT COUNT(*) AS n FROM bridge_outbound WHERE route_id = ? AND state = 'ready'").get(routeId).n, 0);

      // A helper that posts it after all cannot say so, and it is never handed over again.
      const late = await ackItem(item, 'posted-late');
      assert.deepEqual([late.status, late.body.code], [409, 'LEASE_LAPSED'], 'its lease lapsed; it is not told the answer was withdrawn');
      assert.equal((await claim()).body.items.some((i) => i.outboundId === item.outboundId), false);
    } finally {
      gateway._deps.now = realNow;
    }
  });

  it('closing a route does not unsend what was delivered', async () => {
    const accepted = await operatorSays(`m${++seq}`, '@nobody-by-that-name hello');
    const routeId = accepted.body.routeId;
    assert.equal(bridgeStore.routes.get(routeId).state, 'awaiting-master');
    // Its status or failure notices, if any were posted, are history.
    const text = 'Your message is waiting.';
    const id = bridgeStore.outbound.enqueue({ idemKey: `route:${routeId}:test-failure`, kind: 'failure', routeId, sourceLabel: 'TangleClaw', text, digest: bridgeStore.digest(text) }).outboundId;
    const item = (await claim()).body.items.find((i) => i.outboundId === id);
    assert.equal((await ackItem(item, `posted-${++seq}`)).status, 200);
    const closed = await masterWrites(routeId, 'close', { expectedVersion: bridgeStore.routes.get(routeId).version });
    assert.equal(closed.status, 200);
    assert.equal(bridgeStore.outbound.get(id).state, 'delivered');
  });

  it('the Master sees what was set aside and decides, over its own routes and with `tc bridge`', async () => {
    const make = (name) => {
      const text = `notice ${name}`;
      return bridgeStore.outbound.enqueue({
        idemKey: `notify:operator-needed:${name}-${++seq}`, kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw', text, digest: bridgeStore.digest(text)
      }).outboundId;
    };
    const [a, b] = [make('a'), make('b')];
    const items = (await claim()).body.items;
    const report = (id, body) => call('POST', `/api/bridge/helper/outbound/${id}/failure`, { headers: asHelper(), body });
    const lease = (id) => items.find((i) => i.outboundId === id).leaseId;

    const unknown = await report(a, { leaseId: lease(a), reason: 'discard' });
    assert.deepEqual([unknown.status, unknown.body.code], [400, 'BAD_FAILURE'], 'the helper has no way to discard');
    assert.equal((await report(a, { leaseId: lease(a), reason: 'rejected-by-chat' }, asMaster())).status, 200);
    const part = await call('POST', `/api/bridge/helper/outbound/${b}/parts`, { headers: asHelper(), body: { leaseId: lease(b), partIndex: 0, partCount: 2, externalId: `p${++seq}x` } });
    assert.deepEqual([part.status, part.body.replayed], [200, false]);
    assert.equal((await report(b, { leaseId: lease(b), reason: 'part-conflict' })).body.state, 'blocked');
    for (const [method, apiPath] of [['POST', `/api/bridge/helper/outbound/${a}/failure`], ['POST', `/api/bridge/helper/outbound/${a}/parts`]]) {
      assert.equal((await call(method, apiPath, { headers: asMaster(), body: { leaseId: lease(a) } })).status, 401, 'the helper\'s routes are the helper\'s');
    }

    const blocked = await call('GET', '/api/bridge/master/outbound/blocked', { headers: asMaster() });
    const mine = blocked.body.items.filter((i) => [a, b].includes(i.outboundId));
    assert.deepEqual(mine.map((i) => [i.outboundId, i.notifyType, i.blockCode, i.attempts, i.partsPosted]),
      [[a, 'operator-needed', 'rejected-by-chat', 1, 0], [b, 'operator-needed', 'part-conflict', 1, 1]]);
    assert.ok(!JSON.stringify(blocked.body).includes('notice a'), 'what is set aside is listed without its text');

    const listed = await tc(['bridge', 'blocked']);
    assert.match(listed.stdout, new RegExp(`item ${a}  operator-needed  rejected-by-chat  handed over 1 time\\(s\\), 0 part\\(s\\) posted`));
    const back = await tc(['bridge', 'requeue', String(a)]);
    assert.deepEqual([back.code, back.stdout], [0, `Item ${a} is back in the mailbox for the helper.\n`]);
    assert.equal(bridgeStore.outbound.get(a).state, 'ready');
    const gone = await tc(['bridge', 'withdraw', String(b), '--request-id', 'req-withdraw-tc-0001']);
    assert.deepEqual([gone.code, gone.stdout], [0, `Item ${b} is withdrawn and will not be posted.\n`]);
    const again = await tc(['bridge', 'withdraw', String(b), '--request-id', 'req-withdraw-tc-0001']);
    assert.match(again.stdout, /already applied by an earlier use of this request id/);
    const refused = await tc(['bridge', 'requeue', String(b)]);
    assert.deepEqual([refused.code, /NOT_BLOCKED/.test(refused.stderr)], [2, true]);

    // The helper cannot make either decision, and neither can a session's or nobody's request.
    for (const headers of [asHelper(), {}]) {
      for (const what of ['requeue', 'withdraw']) {
        const r = await call('POST', `/api/bridge/master/outbound/${a}/${what}`, { headers, body: { requestId: `req-x-${++seq}-0000` } });
        assert.equal(r.status, 401, what);
      }
    }
    // The operator can, signed in.
    const again2 = (await claim()).body.items.find((i) => i.outboundId === a);
    await report(a, { leaseId: again2.leaseId, reason: 'rejected-by-chat' });
    const byOperator = await asOperator('POST', '/api/bridge/operator/outbound/:outboundId/withdraw', { params: { outboundId: String(a) }, body: { requestId: `req-op-${++seq}-0000` } });
    assert.deepEqual([byOperator.status, byOperator.body.item.state], [200, 'dropped']);
    const ambient = await bridgeApi.handle(bridgeApi.routeFor('POST', '/api/bridge/operator/outbound/:outboundId/requeue'),
      { req: AMBIENT, headers: AMBIENT.headers, params: { outboundId: String(a) }, body: { requestId: `req-op-${++seq}-0000` } });
    assert.equal(ambient.status, 403, 'a dashboard-shaped request on an open gate decides nothing');
  });

  it('a closed chat stops every claim over the route until the Master or the operator resets it', async () => {
    const text = 'notice for a closed chat';
    const id = bridgeStore.outbound.enqueue({
      idemKey: `notify:operator-needed:circuit-${++seq}`, kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw', text, digest: bridgeStore.digest(text)
    }).outboundId;
    const item = (await claim()).body.items.find((i) => i.outboundId === id);
    const reported = await call('POST', `/api/bridge/helper/outbound/${id}/failure`, { headers: asHelper(), body: { leaseId: item.leaseId, reason: 'chat-channel-missing' } });
    assert.deepEqual([reported.status, reported.body.state, reported.body.circuit.opened], [200, 'blocked', true]);
    const episodeId = reported.body.circuit.episodeId;

    for (const headers of [asHelper(), asHelper()]) {
      const blocked = await claim(headers);
      assert.deepEqual([blocked.status, blocked.body.code, blocked.body.episodeId, blocked.body.reason], [409, 'BRIDGE_CONFIGURATION_BLOCKED', episodeId, 'chat-channel-missing']);
    }
    // The operator and the Master both see it where they look, with no chat needed to tell them.
    const forOperator = await asOperator('GET', '/api/bridge/operator/status');
    assert.deepEqual([forOperator.body.configurationCircuit.episodeId, forOperator.body.configurationCircuit.reason], [episodeId, 'chat-channel-missing']);
    const shown = await tc(['bridge', 'status']);
    assert.match(shown.stdout, new RegExp(`CONFIGURATION CIRCUIT OPEN, episode ${episodeId}, since .* \\(chat-channel-missing\\)`));
    assert.match(shown.stdout, new RegExp(`a release is not a delivery\\. You have not been told of it by message\\. NOT YET ACKNOWLEDGED: tell the operator, then \`tc bridge circuit ack ${episodeId}\``));

    // The Master takes it up. Nobody else can say it has.
    const ackAs = (headers) => call('POST', `/api/bridge/master/circuit/${episodeId}/ack`, { headers, body: {} });
    assert.equal((await ackAs(asHelper())).status, 401);
    assert.equal((await ackAs({})).status, 401);
    assert.equal(bridgeStore.circuit.open().masterAckedAt, null);
    const acked = await tc(['bridge', 'circuit', 'ack', String(episodeId)]);
    assert.deepEqual([acked.code, /^Configuration episode \d+ acknowledged\. It stays open until it is reset/.test(acked.stdout)], [0, true]);
    assert.match((await tc(['bridge', 'circuit', 'ack', String(episodeId)])).stdout, /\(it already was\)/);
    const wrong = await tc(['bridge', 'circuit', 'ack', String(episodeId + 50)]);
    assert.deepEqual([wrong.code, /CIRCUIT_NOT_OPEN/.test(wrong.stderr)], [2, true]);
    assert.match((await tc(['bridge', 'status'])).stdout, /Acknowledged 20\d\d-/);
    // The acknowledgement was that Master's. One launched since sees the
    // episode as its own to take up, is told so, and acknowledges for itself.
    const firstGeneration = masterGeneration;
    const relaunched = handoff.mintCredential();
    masterGeneration = bridgeStore.masterCredentials.mint(relaunched.hash);
    bridgeStore.masterCredentials.activate(masterGeneration, relaunched.hash);
    masterCredential = relaunched.credential;
    assert.match((await tc(['bridge', 'status'])).stdout, /You have not been told of it by message\. NOT YET ACKNOWLEDGED by you/, 'what its predecessor was told is not what it was told');
    bridgeStore.circuit.noteMasterTold(episodeId, masterGeneration, { at: '2026-10-04T09:00:00.000Z' });
    const successor = (await tc(['bridge', 'status'])).stdout;
    assert.match(successor, /You were last told 2026-10-04T09:00:00\.000Z\. NOT YET ACKNOWLEDGED by you \(an earlier Master did\): tell the operator/);
    assert.ok(!/Acknowledged 20/.test(successor));
    assert.match((await tc(['bridge', 'circuit', 'ack', String(episodeId)])).stdout, /^Configuration episode \d+ acknowledged\. It stays open/);
    assert.deepEqual([bridgeStore.circuit.open().masterAckedGeneration, masterGeneration > firstGeneration], [masterGeneration, true]);
    assert.match((await tc(['bridge', 'status'])).stdout, /You were last told 2026-10-04T09:00:00\.000Z\. Acknowledged 20\d\d-/);
    assert.equal((await claim()).body.code, 'BRIDGE_CONFIGURATION_BLOCKED', 'acknowledging it does not open the queue');

    // Only the Master or a signed-in operator resets it.
    const reset = (headers, body) => call('POST', '/api/bridge/master/circuit/reset', { headers, body });
    assert.equal((await reset(asHelper(), { requestId: `req-r-${++seq}-0000`, decision: 'requeue' })).status, 401);
    assert.equal((await reset({}, { requestId: `req-r-${++seq}-0000`, decision: 'requeue' })).status, 401);
    const ambient = await bridgeApi.handle(bridgeApi.routeFor('POST', '/api/bridge/operator/circuit/reset'),
      { req: AMBIENT, headers: AMBIENT.headers, params: {}, body: { requestId: `req-r-${++seq}-0000`, decision: 'requeue' } });
    assert.equal(ambient.status, 403);
    assert.equal((await reset(asMaster(), { requestId: `req-r-${++seq}-0000` })).body.code, 'DECISION_REQUIRED');
    assert.equal((await reset(asMaster(), { requestId: `req-r-${++seq}-0000`, decision: 'ignore' })).body.code, 'DECISION_REQUIRED');
    assert.equal(bridgeStore.circuit.open().episodeId, episodeId, 'none of those closed it');

    const usage = await tc(['bridge', 'reset']);
    assert.equal(usage.code, 1);
    const done = await tc(['bridge', 'reset', '--requeue']);
    assert.deepEqual([done.code, done.stdout], [0, `Configuration circuit reset: episode ${episodeId} is closed, 1 item(s) put back.\n`]);
    assert.equal(bridgeStore.circuit.open(), null);
    const again = (await claim()).body.items.find((i) => i.outboundId === id);
    assert.ok(again, 'and the item is handed over again');
    // The operator, signed in, has the same reset: a second episode, withdrawn this time.
    await call('POST', `/api/bridge/helper/outbound/${id}/failure`, { headers: asHelper(), body: { leaseId: again.leaseId, reason: 'chat-permission-denied' } });
    const second = bridgeStore.circuit.open().episodeId;
    assert.equal(second > episodeId, true);
    const byOperator = await asOperator('POST', '/api/bridge/operator/circuit/reset', { params: {}, body: { requestId: `req-r-${++seq}-0000`, decision: 'withdraw' } });
    assert.deepEqual([byOperator.status, byOperator.body.items, byOperator.body.episode.episodeId, byOperator.body.episode.closedBy, byOperator.body.episode.decision],
      [200, 1, second, 'operator', 'withdraw']);
    assert.deepEqual([bridgeStore.outbound.get(id).state, bridgeStore.outbound.get(id).dropCode], ['dropped', 'withdrawn']);
    const audited = store.getDb().prepare("SELECT proof, detail_json FROM bridge_audit WHERE op = 'circuit-reset' AND actor = 'operator' AND outcome = 'applied'").all();
    assert.deepEqual(audited.map((r) => [r.proof, JSON.parse(r.detail_json).user, JSON.parse(r.detail_json).episodeId]), [['verified-session', 'rosie', second]]);
    const none = await tc(['bridge', 'reset', '--withdraw']);
    assert.deepEqual([none.code, /CIRCUIT_NOT_OPEN/.test(none.stderr)], [2, true]);
    assert.doesNotMatch((await tc(['bridge', 'status'])).stdout, /CIRCUIT/);
  });

  it('refuses over the route, for good, an acknowledgement of an item that was let go, without saying what became of it', async () => {
    const realNow = gateway._deps.now;
    const week = bridgeStore.EXPIRY_MS.notification['operator-needed'];
    try {
      // A notification one minute short of its limit when the helper claims it.
      const created = new Date(Date.now() - week + 60000).toISOString();
      const text = 'A session needs the operator.';
      const id = bridgeStore.outbound.enqueue({
        idemKey: `notify:operator-needed:late-${++seq}`, kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw',
        text, digest: bridgeStore.digest(text), at: created
      }).outboundId;
      const held = (await claim()).body.items.find((i) => i.outboundId === id);
      assert.equal(held.text, text);

      // Its lease lapses, the limit passes, and the next claim lets it go.
      const after = Date.now() + 60000 + bridgeStore.LEASE_MS + 1000;
      gateway._deps.now = () => new Date(after).toISOString();
      assert.equal((await claim()).body.items.some((i) => i.outboundId === id), false, 'it is not handed over again');
      assert.equal(bridgeStore.outbound.get(id).state, 'dropped');

      for (const attempt of [1, 2]) {
        const late = await ackItem(held, 'posted-late');
        assert.deepEqual([late.status, late.body.code], [409, 'LEASE_LAPSED'], `attempt ${attempt}`);
      }
      assert.deepEqual([bridgeStore.outbound.get(id).state, bridgeStore.outbound.get(id).deliveredRef], ['dropped', null]);
    } finally {
      gateway._deps.now = realNow;
    }
  });

  describe('who may call what', () => {
    it('the helper routes answer only the active helper token, with a fresh nonce on every write', async () => {
      const body = { externalId: `m${++seq}`, ...ALLOWED, text: 'hello' };
      for (const headers of [{}, asHelper({ [bridgeApi.HELPER_TOKEN_HEADER]: 'bht_wrong' }), asMaster(), operatorHeaders(server)]) {
        const r = await call('POST', '/api/bridge/helper/inbound', { headers, body });
        assert.deepEqual([r.status, r.body.code], [401, 'HELPER_TOKEN_REQUIRED']);
        assert.equal((await claim(headers)).status, 401);
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

    it('a credential is taken only from a request made directly from this machine', async () => {
      const routeId = (await operatorSays(`m${++seq}`, 'hello')).body.routeId;
      // Through a proxy: the headers one leaves behind are enough to refuse, whatever credential comes with them.
      for (const proxied of [{ 'x-forwarded-for': '203.0.113.9' }, { forwarded: 'for=203.0.113.9' }, { via: '1.1 caddy' }, { 'x-real-ip': '203.0.113.9' }, { 'x-forwarded-proto': 'https' }]) {
        const asM = await call('GET', '/api/bridge/master/status', { headers: { ...asMaster(), ...proxied } });
        const asH = await call('POST', '/api/bridge/helper/outbound/claim', { headers: { ...asHelper(), ...proxied }, body: {} });
        assert.deepEqual([asM.status, asM.body.code, asH.status, asH.body.code], [403, 'LOOPBACK_REQUIRED', 403, 'LOOPBACK_REQUIRED'], Object.keys(proxied)[0]);
      }
      // From another machine: judged on the socket, before the credential is looked at.
      const remote = (address) => ({ socket: { remoteAddress: address }, headers: {} });
      for (const address of ['203.0.113.9', '10.0.0.5', '::ffff:10.0.0.5', undefined]) {
        const m = await bridgeApi.handle(bridgeApi.routeFor('GET', '/api/bridge/master/routes/:routeId'), { req: remote(address), headers: asMaster(), params: { routeId } });
        const h = await bridgeApi.handle(bridgeApi.routeFor('POST', '/api/bridge/helper/inbound'), { req: remote(address), headers: asHelper(), body: { externalId: `m${++seq}`, ...ALLOWED, text: 'x' } });
        assert.deepEqual([m.status, m.body.code, h.status, h.body.code], [403, 'LOOPBACK_REQUIRED', 403, 'LOOPBACK_REQUIRED'], String(address));
      }
      for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
        const m = await bridgeApi.handle(bridgeApi.routeFor('GET', '/api/bridge/master/status'), { req: remote(address), headers: asMaster() });
        assert.equal(m.status, 200, address);
      }
      assert.ok(bridgeStore.masterCredentials.live(), 'a refused request spends nothing: the credential is still live');

      // `tc` does not send the credential anywhere but this machine in the first place.
      const away = await tc(['bridge', 'status'], { TANGLECLAW_API: 'http://tc.example.invalid:3102' });
      assert.deepEqual([away.code, away.stdout], [2, '']);
      assert.match(away.stderr, /works only against the TangleClaw server on this machine.*The credential was not sent/);
      assert.ok(!away.stderr.includes(masterCredential));
    });

    it('a Master that tmux says is gone loses its credential on the spot; an unanswered probe changes nothing', async () => {
      const master = gateway._deps.master();
      const withLiveness = (liveness) => { gateway._deps.master = () => ({ ...master, masterLiveness: () => liveness }); };
      try {
        withLiveness({ live: false, answered: false, cause: 'tmux did not answer' });
        assert.equal((await call('GET', '/api/bridge/master/status', { headers: asMaster() })).status, 200, 'tmux not answering is not the Master being gone');
        assert.ok(bridgeStore.masterCredentials.live());

        withLiveness({ live: false, answered: true, cause: null });
        const refused = await call('GET', '/api/bridge/master/status', { headers: asMaster() });
        assert.deepEqual([refused.status, refused.body.code], [401, 'BRIDGE_CREDENTIAL_REQUIRED']);
        assert.equal(bridgeStore.masterCredentials.live(), null, 'and the credential is revoked');
        const why = store.getDb().prepare("SELECT revoke_reason FROM bridge_master_credentials WHERE status = 'revoked' ORDER BY generation DESC LIMIT 1").get();
        assert.equal(why.revoke_reason, 'master-not-live');

        // Even if a Master appears again, that credential is spent: a new Master gets a new one.
        withLiveness({ live: true, answered: true, cause: null });
        assert.equal((await call('GET', '/api/bridge/master/status', { headers: asMaster() })).status, 401);
      } finally {
        gateway._deps.master = () => master;
      }
    });

    it('the bridge is not enabled while the Master could not be told of a message', async () => {
      const master = gateway._deps.master();
      try {
        await asOperator('POST', '/api/bridge/operator/disable');
        gateway._deps.master = () => ({ ...master, masterListenerEnabled: () => false, getMasterMedusaStatus: () => ({ state: 'off', workspaceId: null }) });
        const refused = await asOperator('POST', '/api/bridge/operator/enable');
        assert.deepEqual([refused.status, refused.body.code], [409, 'MASTER_LISTENER_OFF']);
        assert.equal(bridgeStore.settings.isEnabled(), false);
        const status = await asOperator('GET', '/api/bridge/operator/status');
        assert.deepEqual(status.body.masterListener, { enabled: false, state: 'off' });

        gateway._deps.master = () => ({ ...master, getMasterMedusaStatus: () => ({ state: 'listening', workspaceId: 'master-ws' }) });
        assert.equal((await asOperator('POST', '/api/bridge/operator/enable')).status, 200);
        const after = await asOperator('GET', '/api/bridge/operator/status');
        assert.deepEqual(after.body.masterListener, { enabled: true, state: 'listening' });
        // Counts and the oldest arrival, without a word of anything anyone wrote.
        const waiting = await operatorSays(`m${++seq}`, 'a message whose text status never shows');
        const now = await asOperator('GET', '/api/bridge/operator/status');
        assert.equal(Object.values(now.body.openRoutesByState).reduce((a, b) => a + b, 0), now.body.openRoutes);
        assert.ok(now.body.openRoutesByState[bridgeStore.routes.get(waiting.body.routeId).state] >= 1);
        assert.match(now.body.oldestOpenRouteAt, /^20\d\d-\d\d-\d\dT/);
        assert.ok(!JSON.stringify(now.body).includes('status never shows'));
        assert.equal(Number.isInteger(after.body.routesMasterNotTold), true);
      } finally {
        gateway._deps.master = () => master;
      }
    });

    it('the dashboard\'s bridge panel is served, and its status route tells a caller with no account session nothing', async () => {
      const script = await fetch(`${origin}/operator-bridge-panel.js`);
      assert.equal(script.status, 200);
      assert.match(script.headers.get('content-type'), /javascript/);
      assert.match(await script.text(), /tcMountOperatorBridge/);

      // Over HTTP, as a browser on this install would ask: same-origin, and no account session.
      for (const headers of [{}, operatorHeaders(server)]) {
        const res = await call('GET', '/api/bridge/operator/status', { headers });
        assert.deepEqual([res.status, res.body.code], [403, 'OPERATOR_SESSION_REQUIRED']);
        assert.deepEqual(Object.keys(res.body).sort(), ['code', 'error'], 'a refusal, and nothing of the bridge');
        for (const write of [['POST', 'enable'], ['POST', 'disable'], ['POST', 'helper-token'], ['DELETE', 'helper-token'], ['POST', 'candidate-primer'], ['POST', 'circuit/reset'], ['POST', 'outbound/1/withdraw']]) {
          const refused = await call(write[0], `/api/bridge/operator/${write[1]}`, { headers, body: { primed: true, requestId: 'req-unsigned-0001', decision: 'withdraw' } });
          assert.equal(refused.status, 403, write.join(' '));
          assert.ok(!JSON.stringify(refused.body).includes('bht_'), 'no token is minted for it');
        }
      }
      assert.equal(bridgeStore.settings.isEnabled(), true, 'and none of it changed anything');

      // What the panel draws from: the items set aside by id and reason, and the primer as it was set.
      const signedIn = (await asOperator('GET', '/api/bridge/operator/status')).body;
      assert.deepEqual([Array.isArray(signedIn.setAsideItems), signedIn.setAsideItems.length, signedIn.candidatePrimerSetting], [true, signedIn.setAside, false]);
      bridgeStore.settings.set('candidates.primed', 'true');
      await asOperator('POST', '/api/bridge/operator/disable');
      const off = (await asOperator('GET', '/api/bridge/operator/status')).body;
      assert.deepEqual([off.candidatesPrimed, off.candidatePrimerSetting], [false, true], 'not in effect while disabled, and still set');
      bridgeStore.settings.set('candidates.primed', 'false');
      assert.equal((await asOperator('GET', '/api/bridge/operator/status')).body.candidatePrimerSetting, false);
    });

    it('preflight answers the helper in yes, no and a closed word, changes nothing, and is asked sparingly', async () => {
      bridgeApi._resetRateLimits();
      const ask = (body, headers = { [bridgeApi.HELPER_TOKEN_HEADER]: helperToken }) => call('POST', '/api/bridge/helper/preflight', { headers, body });
      const nonces = () => store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_nonces').get().n;
      const audits = () => store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_audit').get().n;
      const before = [nonces(), audits()];

      const right = await ask(ALLOWED);
      assert.deepEqual([right.status, right.body], [200, { tokenLive: true, bridgeEnabled: true, allowlistSet: true, allowlistMatch: true, circuit: 'closed' }]);
      // One answer for all three ids together: it does not say which differs.
      for (const wrong of [{ ...ALLOWED, authorId: 'someone' }, { ...ALLOWED, channelId: 'elsewhere' }, { authorId: ALLOWED.authorId }, {}]) {
        assert.equal((await ask(wrong)).body.allowlistMatch, false);
      }
      assert.deepEqual([nonces(), audits()], before, 'it takes no nonce and writes nothing');
      assert.ok(!JSON.stringify(right.body).includes(ALLOWED.channelId), 'and gives back no id');

      // It is the helper's alone, from this machine, and still answers while the bridge is off.
      assert.equal((await ask(ALLOWED, {})).status, 401);
      assert.equal((await ask(ALLOWED, asMaster())).status, 401);
      assert.equal((await ask(ALLOWED, { [bridgeApi.HELPER_TOKEN_HEADER]: helperToken, 'x-forwarded-for': '203.0.113.9' })).body.code, 'LOOPBACK_REQUIRED');
      await asOperator('POST', '/api/bridge/operator/disable');
      bridgeApi._resetRateLimits();
      assert.equal((await ask(ALLOWED)).body.bridgeEnabled, false);

      // Six a minute from one token, then refused.
      const rest = [];
      for (let i = 0; i < 6; i++) rest.push((await ask(ALLOWED)).status);
      assert.deepEqual(rest, [200, 200, 200, 200, 200, 429]);
      assert.equal((await ask(ALLOWED)).body.code, 'RATE_LIMITED');
      bridgeApi._resetRateLimits();
    });

    it('one caller gone wrong cannot flood the bridge: each class of route has a bound', async () => {
      bridgeApi._resetRateLimits();
      assert.deepEqual(Object.fromEntries(Object.entries(bridgeApi.RATE_LIMITS).map(([name, limit]) => [name, limit.perMinute])), { helper: 600, inbound: 120, preflight: 6, candidate: 12 });
      for (const entry of bridgeApi.ROUTES) {
        const expected = entry.path.startsWith('/api/bridge/helper/') ? (entry.path.endsWith('/preflight') ? 'preflight' : (entry.path.endsWith('/inbound') ? 'inbound' : 'helper'))
          : (entry.principal === 'session' ? 'candidate' : undefined);
        assert.equal(entry.rate, expected, `${entry.method} ${entry.path}`);
      }
      // The bound is per caller and per minute of the gateway's clock.
      const realNow = gateway._deps.now;
      try {
        let t = Date.now();
        gateway._deps.now = () => new Date(t).toISOString();
        const claimOnce = () => call('POST', '/api/bridge/helper/outbound/claim', { headers: asHelper(), body: {} });
        for (let i = 0; i < 600; i++) assert.equal((await claimOnce()).status, 200, `claim ${i + 1} of the minute's 600`);
        assert.equal((await claimOnce()).status, 429);

        // A request over the bound is refused before anything is written for
        // it: no nonce is recorded, so the same request is good a minute on,
        // and the refusals are logged once for the caller, not once each.
        const nonces = () => store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_nonces').get().n;
        const lines = [];
        const nonce = crypto.randomBytes(16).toString('hex');
        const ackOnce = () => call('POST', '/api/bridge/helper/outbound/999999/ack',
          { headers: asHelper({ [bridgeApi.HELPER_NONCE_HEADER]: nonce }), body: { leaseId: 'l'.repeat(32), parts: ['1'], partCount: 1 } });
        const before = nonces();
        setLevel('warn');
        setConsoleStream({ write: (s) => { lines.push(String(s)); return true; } });
        try {
          for (let i = 0; i < 3; i++) assert.deepEqual([(await ackOnce()).status, nonces()], [429, before]);
        } finally {
          setConsoleStream(null);
          setLevel('error');
        }
        assert.equal(lines.filter((l) => l.includes('RATE_LIMITED')).length, 0, 'the 601st request was the one logged; these three were not');

        // The operator's messages have a bucket of their own: the helper's other traffic cannot spend it.
        assert.equal((await operatorSays(`m${++seq}`, 'still heard')).status, 202);

        t += 60001;
        setLevel('warn');
        setConsoleStream({ write: (s) => { lines.push(String(s)); return true; } });
        try {
          const unspent = nonces();
          const taken = await ackOnce();
          assert.ok(taken.status !== 429 && taken.body.code !== 'NONCE_REUSED', `a minute on its nonce is still its own: ${taken.status} ${taken.body.code}`);
          assert.equal(nonces(), unspent + 1);
          assert.equal((await ackOnce()).body.code, 'NONCE_REUSED');
          for (let i = 0; i < 600; i++) await claimOnce();
          assert.equal((await claimOnce()).status, 429);
          assert.equal((await claimOnce()).status, 429);
        } finally {
          setConsoleStream(null);
          setLevel('error');
        }
        assert.equal(lines.filter((l) => l.includes('RATE_LIMITED')).length, 1, 'a minute on, the caller is logged once more, and once only');

        // The inbound bucket has its own bound.
        t += 60001;
        const statuses = [];
        for (let i = 0; i < 121; i++) statuses.push((await call('POST', '/api/bridge/helper/inbound', { headers: asHelper(), body: { externalId: 'same-one', ...ALLOWED, text: 'again' } })).status);
        assert.deepEqual([statuses.slice(0, 120).every((s) => s !== 429), statuses[120]], [true, 429]);
        assert.equal((await claimOnce()).status, 200, 'and spending it does not spend the other');

        // A caller that has gone quiet is forgotten once the table is large.
        t += 60001;
        bridgeApi._resetRateLimits();
        for (let i = 0; i < bridgeApi.ADMITTED_SWEEP_AT; i++) bridgeApi._admitted.set(`helper:gone-${i}`, [t - 60001]);
        bridgeApi._admitted.set('helper:recent', [t - 1000]);
        assert.equal((await claimOnce()).status, 200);
        assert.deepEqual([...bridgeApi._admitted.keys()].filter((k) => k.startsWith('helper:gone-')), []);
        assert.ok(bridgeApi._admitted.has('helper:recent'), 'a caller seen in the last minute is kept');
      } finally {
        gateway._deps.now = realNow;
        bridgeApi._resetRateLimits();
      }
    });

    it('telling every pane of `tc candidate` is the operator\'s switch, and only while the bridge is on', async () => {
      const primer = require('../lib/ecosystem-primer');
      const pane = { projectId: 77, projectName: 'Some-Project', apiOrigin: 'http://localhost:3102', operatorHost: 'example-host.tail0000.ts.net' };
      const named = () => primer.buildEcosystemPrimerSection(pane).join('\n').includes('`candidate`');
      const set = (primed, req) => bridgeApi.handle(bridgeApi.routeFor('POST', '/api/bridge/operator/candidate-primer'),
        { req: req || SIGNED_IN, headers: (req || SIGNED_IN).headers, body: { primed } });
      assert.deepEqual([bridgeApi.candidatesPrimed(), named()], [false, false], 'off until somebody switches it on');

      assert.equal((await set(true, AMBIENT)).status, 403, 'a dashboard-shaped request on an open gate switches nothing');
      assert.equal((await set('yes')).body.code, 'BAD_PRIMER');
      await asOperator('POST', '/api/bridge/operator/disable');
      assert.deepEqual([(await set(true)).status, (await set(true)).body.code], [409, 'BRIDGE_DISABLED']);
      assert.equal((await asOperator('POST', '/api/bridge/operator/enable')).status, 200);

      const on = await set(true);
      assert.deepEqual([on.status, on.body.candidatesPrimed, bridgeApi.candidatesPrimed(), named()], [200, true, true, true],
        'the server reads the switch each time a pane\'s instructions are written');
      const told = (await asOperator('GET', '/api/bridge/operator/status')).body;
      assert.deepEqual([told.candidatesPrimed, told.candidatePrimerOmitted], [true, null]);
      // The switch is what the operator asked for. A pane whose section ran
      // over its cap was not told, and status says so: when, which project,
      // how long and against what cap, and none of the section's text.
      const long = { ...pane, projectId: 91, apiOrigin: `${pane.apiOrigin}/${'x'.repeat(60)}` };
      assert.ok(!primer.buildEcosystemPrimerSection(long).join('\n').includes('`candidate`'));
      const omitted = (await asOperator('GET', '/api/bridge/operator/status')).body.candidatePrimerOmitted;
      assert.deepEqual([omitted.projectId, omitted.switches, omitted.cap, omitted.length > 2820, Object.keys(omitted).sort()],
        [91, ['bridge-candidates'], 2820, true, ['at', 'cap', 'length', 'projectId', 'switches']]);
      assert.match(omitted.at, /^20\d\d-\d\d-\d\dT/);

      // Switching the bridge off takes the verb out of the list with it, and switching it back on brings it back.
      await asOperator('POST', '/api/bridge/operator/disable');
      assert.deepEqual([bridgeApi.candidatesPrimed(), named()], [false, false]);
      await asOperator('POST', '/api/bridge/operator/enable');
      assert.equal(named(), true);
      assert.deepEqual([(await set(false)).body.candidatesPrimed, named()], [false, false]);
      const audited = store.getDb().prepare("SELECT op, proof, detail_json FROM bridge_audit WHERE op LIKE 'candidate-primer-%' ORDER BY audit_seq").all();
      assert.deepEqual(audited.map((r) => [r.op, r.proof, JSON.parse(r.detail_json).user]),
        [['candidate-primer-on', 'verified-session', 'rosie'], ['candidate-primer-off', 'verified-session', 'rosie']]);
    });

    it('the Master credential opens neither the helper routes nor the operator routes', async () => {
      assert.equal((await claim(asMaster())).status, 401);
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
      assert.equal((await claim()).body.code, 'BRIDGE_DISABLED');
      for (const op of ['route', 'answer', 'release', 'pin']) {
        assert.equal((await masterWrites(routeId, op, { expectedVersion: 1, to: 'master', text: 'x' })).body.code, 'BRIDGE_DISABLED', op);
      }
      const closed = await masterWrites(routeId, 'close', { expectedVersion: bridgeStore.routes.get(routeId).version });
      assert.equal(closed.body.route.state, 'closed', 'a held message can still be let go while the bridge is off');
    });
  });
});
