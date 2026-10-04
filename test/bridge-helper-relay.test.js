'use strict';

// #2031 (ADR 0023): the bridge's Discord helper against the real TangleClaw
// server. Discord is a stand-in served over real HTTP; the bridge's routes,
// store, leases and gateway are the real ones. An operator message goes in
// through the helper and an answer comes back out, posted once and
// acknowledged under its lease. Then each way that can go wrong between the
// post and the acknowledgement: a lost acknowledgement, a restart, a lapsed
// lease, a post whose outcome is unknown, a rejection, a lost claim. In none
// of them is anything posted twice or acknowledged without a post.

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const bridgeStore = require('../lib/bridge-store');
const bridgeApi = require('../lib/bridge-api');
const gateway = require('../lib/bridge-gateway');
const handoff = require('../lib/bridge-handoff');
const { install } = require('./_bridge-hub');
const { startFakeDiscord, fakeWebSocket } = require('./_fake-discord');
const { createBridgeClient, BridgeError } = require('../lib/bridge-helper/bridge-client');
const { createDiscordRest } = require('../lib/bridge-helper/discord-rest');
const { createInbound, REFUSAL_TEXT } = require('../lib/bridge-helper/inbound');
const { createOutbound, settleHeld, classifyAttempt, SettleError, NONCE_WINDOW_MS, LEASE_MARGIN_MS, PART_MAX } = require('../lib/bridge-helper/outbound');
const { openState, nonceFor } = require('../lib/bridge-helper/state');
const { main, EXIT } = require('../lib/bridge-helper/cli');
const { paths, writeConfig } = require('../lib/bridge-helper/config');
const { CODES } = require('../lib/bridge-helper/log');
const { OP } = require('../lib/bridge-helper/discord-gateway');

const IDS = { authorId: '100000000000000001', guildId: '200000000000000002', channelId: '300000000000000003' };
const BOT_ID = '900000000000000009';
const BOT_TOKEN = `${'B'.repeat(24)}.${'c'.repeat(6)}.${'d'.repeat(27)}`;
/** A signed-in operator, as `server.js` annotates the request. */
const SIGNED_IN = { tcSession: { username: 'rosie' }, tcGateState: 'guarding', headers: {} };

let tmpDir;
let server;
let origin;
let hub;
let realDeps;
let discord;
let helperToken;
let masterCredential;
let clock;
let codes;
let stateFile;
let bridge;
let seq = 0;
let messageSeq = 500000000000000000n;

/**
 * The signed-in operator calls one of the operator's routes.
 * @param {string} method - HTTP method.
 * @param {string} apiPath - Declared path.
 * @param {object} [request] - `body`.
 * @returns {Promise<{status: number, body: object}>}
 */
function asOperator(method, apiPath, request = {}) {
  return bridgeApi.handle(bridgeApi.routeFor(method, apiPath), { req: SIGNED_IN, headers: {}, ...request });
}

/**
 * The closed-code log, collected.
 * @param {string} code - Code.
 * @param {object} [fields] - Fields.
 * @returns {void}
 */
function log(code, fields) {
  codes.push([code, fields || {}]);
}

/**
 * The codes logged so far, without their fields.
 * @returns {string[]}
 */
function logged() {
  return codes.map(([code]) => code);
}

/**
 * A MESSAGE_CREATE as Discord delivers it, from the allowlisted operator.
 * @param {string} content - The text.
 * @param {object} [over] - Overrides.
 * @returns {object}
 */
function operatorMessage(content, over = {}) {
  return { id: String(++messageSeq), type: 0, author: { id: IDS.authorId }, guild_id: IDS.guildId, channel_id: IDS.channelId, content, ...over };
}

/**
 * The helper's Discord client, with no real waiting.
 * @returns {object}
 */
function restClient() {
  return createDiscordRest({ token: BOT_TOKEN, api: discord.api, sleep: async () => {}, log });
}

/**
 * The helper's inbound handler.
 * @param {object} [over] - Overrides: `allow`, `bridge`, `sleep`.
 * @returns {Function}
 */
function inbound(over = {}) {
  return createInbound({ allow: IDS, bridge, rest: restClient(), log, sleep: async () => {}, ...over });
}

/**
 * The helper's outbound relay over the state file, as a fresh process would open it.
 * @param {object} [over] - Overrides: `bridge`.
 * @returns {{pass: Function, state: object}}
 */
function outbound(over = {}) {
  const state = openState(stateFile);
  const relay = createOutbound({ channelId: IDS.channelId, bridge, rest: restClient(), state, log, now: () => clock, ...over });
  return { pass: relay.pass, state };
}

/**
 * The operator writes, the helper hands it over, and the Master answers.
 * @param {string} text - The Master's answer.
 * @returns {Promise<{routeId: string, messageId: string, outboundId: number}>}
 */
async function answered(text) {
  const message = operatorMessage(`question ${++seq}`);
  assert.equal(await inbound()(message, { selfId: BOT_ID }), 'inbound-accepted');
  const route = bridgeStore.routes.getByExternalId(message.id);
  const res = await fetch(`${origin}/api/bridge/master/routes/${route.routeId}/answer`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-tangleclaw-bridge-credential': masterCredential },
    body: JSON.stringify({ requestId: `req-answer-${seq}-0000`, expectedVersion: route.version, text })
  });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const item = store.getDb().prepare("SELECT outbound_id FROM bridge_outbound WHERE route_id = ? AND kind = 'reply'").get(route.routeId);
  return { routeId: route.routeId, messageId: message.id, outboundId: item.outbound_id };
}

/**
 * An item's state at the bridge, with the message id it was delivered as.
 * @param {number} outboundId - Item id.
 * @returns {Array}
 */
function atBridge(outboundId) {
  const item = bridgeStore.outbound.get(outboundId);
  return [item.state, item.deliveredRef];
}

/**
 * Discord asks the helper to slow down, twice: a refusal that posted nothing and that a retry may fix.
 * @returns {void}
 */
function discordBusy() {
  discord.script.push({ status: 429, body: { retry_after: 0 } }, { status: 429, body: { retry_after: 0 } });
}

/**
 * The Project Master decides about an item that was set aside, over its own route.
 * @param {number} outboundId - The item.
 * @param {('requeue'|'withdraw')} what - The decision.
 * @returns {Promise<{status: number, body: object}>}
 */
async function masterDecides(outboundId, what) {
  const res = await fetch(`${origin}/api/bridge/master/outbound/${outboundId}/${what}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-tangleclaw-bridge-credential': masterCredential },
    body: JSON.stringify({ requestId: `req-${what}-${++seq}-0000` })
  });
  return { status: res.status, body: await res.json() };
}

/**
 * What the helper posted, apart from the notice that something was set aside.
 * @returns {object[]}
 */
function answersPosted() {
  return discord.posts.filter((p) => !p.content.endsWith(gateway.BLOCKED_NOTICE));
}

/**
 * A bridge client whose named method fails once, after the real call has run.
 * @param {string} method - `claim` or `ack`.
 * @param {object} [options]
 * @param {boolean} [options.before] - Fail before the real call instead.
 * @returns {object}
 */
function losingOnce(method, options = {}) {
  let lost = false;
  return {
    ...bridge,
    [method]: async (...args) => {
      if (lost) return bridge[method](...args);
      lost = true;
      if (!options.before) await bridge[method](...args);
      throw new BridgeError(0, null);
    }
  };
}

describe('bridge helper: the relay against the real server (#2031)', () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bridge-helper-relay-'));
    store._setBasePath(tmpDir);
    store.init();
    const { createServer } = require('../server');
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    realDeps = { ...gateway._deps };
    discord = await startFakeDiscord();
  });

  after(async () => {
    Object.assign(gateway._deps, realDeps);
    if (hub) hub.restore();
    await discord.close();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (hub) hub.restore();
    hub = install();
    clock = Date.now();
    Object.assign(gateway._deps, {
      now: () => new Date(clock).toISOString(),
      master: () => ({
        masterLiveness: () => ({ live: true, answered: true }),
        ensureMasterSession: () => ({ created: false }),
        getMasterMedusaStatus: () => ({ workspaceId: 'master-ws' })
      })
    });
    gateway._reset();
    const minted = handoff.mintCredential();
    const generation = bridgeStore.masterCredentials.mint(minted.hash);
    bridgeStore.masterCredentials.activate(generation, minted.hash);
    masterCredential = minted.credential;

    await asOperator('POST', '/api/bridge/operator/disable');
    const allow = { authorId: IDS.authorId, spaceId: IDS.guildId, channelId: IDS.channelId };
    assert.equal((await asOperator('POST', '/api/bridge/operator/allowlist', { body: allow })).status, 200);
    helperToken = (await asOperator('POST', '/api/bridge/operator/helper-token')).body.token;
    assert.equal((await asOperator('POST', '/api/bridge/operator/enable')).status, 200);
    // Nothing a previous test left waiting is this test's to post.
    store.getDb().exec('DELETE FROM bridge_outbound');
    store.getDb().exec('DELETE FROM bridge_config_circuit');

    bridge = createBridgeClient({ origin, token: helperToken });
    codes = [];
    discord.posts.length = 0;
    discord.reactions.length = 0;
    discord.script.length = 0;
    stateFile = path.join(tmpDir, `helper-${++seq}`, 'state.json');
  });

  afterEach(() => {
    fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
  });

  describe('Discord to TangleClaw', () => {
    it('hands the operator\'s message to the bridge under its Discord id, and says so with a reaction', async () => {
      const first = operatorMessage('is the build green?');
      assert.equal(await inbound()(first, { selfId: BOT_ID }), 'inbound-accepted');
      const route = bridgeStore.routes.getByExternalId(first.id);
      assert.equal(bridgeStore.routes.body(route.routeId, 'inbound').text, 'is the build green?');
      assert.deepEqual([route.context.channelId, route.context.replyToExternalId], [IDS.channelId, null]);
      assert.deepEqual(discord.reactions, [`/channels/${IDS.channelId}/messages/${first.id}/reactions/✅/@me`]);

      // Discord delivers it again after a reconnect: the same route, nothing new.
      const routes = () => store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_routes').get().n;
      const before = routes();
      assert.equal(await inbound()(first, { selfId: BOT_ID }), 'inbound-replayed');
      assert.equal(routes(), before);

      const reply = operatorMessage('and the tests?', { type: 19, message_reference: { message_id: first.id } });
      assert.equal(await inbound()(reply, { selfId: BOT_ID }), 'inbound-accepted');
      assert.equal(bridgeStore.routes.getByExternalId(reply.id).context.replyToExternalId, first.id);
      assert.deepEqual(discord.posts, [], 'an accepted message is answered with a reaction, never a post');
    });

    it('ignores everyone and everywhere else by id, without reading what they wrote', async () => {
      const unread = (over) => {
        const d = operatorMessage('', over);
        Object.defineProperty(d, 'content', { get() { throw new Error('the content was read'); } });
        return d;
      };
      const others = [
        unread({ author: { id: '100000000000000099' } }),
        unread({ guild_id: '200000000000000099' }),
        unread({ channel_id: '300000000000000099' }),
        unread({ author: { id: IDS.authorId, bot: true } }),
        unread({ webhook_id: '700000000000000007' }),
        unread({ author: { id: BOT_ID } }),
        unread({ type: 7 }),
        unread({ id: 'not-an-id' }),
        unread({ author: undefined })
      ];
      const before = store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_routes').get().n;
      const handle = inbound({ bridge: { sendInbound: () => { throw new Error('the bridge was called'); } } });
      for (const d of others) assert.equal(await handle(d, { selfId: BOT_ID }), 'inbound-ignored');
      assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_routes').get().n, before);
      assert.deepEqual([discord.posts, discord.reactions], [[], []], 'and nothing is said back');
      assert.deepEqual(codes, [], 'and nothing is logged: other people\'s traffic does not fill the log');
    });

    it('tells the operator in fixed words when the bridge refuses a message', async () => {
      const cases = [
        [operatorMessage('x'.repeat(8001)), 'INBOUND_TOO_LONG', {}],
        [operatorMessage(''), 'EMPTY_MESSAGE', {}],
        // The helper's own allowlist passes it; the bridge's does not: both must agree.
        [operatorMessage('hello', { channel_id: '300000000000000077' }), 'NOT_ALLOWLISTED', { allow: { ...IDS, channelId: '300000000000000077' } }]
      ];
      for (const [message, key, over] of cases) {
        discord.posts.length = 0;
        assert.equal(await inbound(over)(message, { selfId: BOT_ID }), 'inbound-refused', key);
        assert.equal(discord.posts.length, 1);
        assert.deepEqual([discord.posts[0].content, discord.posts[0].replyTo, discord.posts[0].nonce], [REFUSAL_TEXT[key], message.id, `r${message.id}`], key);
        assert.equal(bridgeStore.routes.getByExternalId(message.id), null);
      }
      assert.deepEqual(discord.reactions, []);

      await asOperator('POST', '/api/bridge/operator/disable');
      discord.posts.length = 0;
      const off = operatorMessage('anyone there?');
      assert.equal(await inbound()(off, { selfId: BOT_ID }), 'inbound-refused');
      assert.equal(discord.posts[0].content, REFUSAL_TEXT.BRIDGE_DISABLED);
      assert.ok(!JSON.stringify(codes).includes('anyone'), 'no text reaches the log');
    });

    it('offers a message to an unreachable TangleClaw three times, then says it was not delivered', async () => {
      let calls = 0;
      const waits = [];
      const down = { sendInbound: async () => { calls += 1; throw new BridgeError(0, null); } };
      const message = operatorMessage('hello');
      assert.equal(await inbound({ bridge: down, sleep: async (ms) => { waits.push(ms); } })(message, {}), 'inbound-transport-failed');
      assert.deepEqual([calls, waits], [3, [2000, 4000]]);
      assert.deepEqual([discord.posts[0].content, discord.posts[0].replyTo], [REFUSAL_TEXT.UNREACHABLE, message.id]);

      // A redirect is not followed and not retried.
      calls = 0;
      const redirecting = { sendInbound: async () => { calls += 1; throw new BridgeError(302, 'REDIRECT_REFUSED'); } };
      assert.equal(await inbound({ bridge: redirecting })(operatorMessage('hello'), {}), 'inbound-transport-failed');
      assert.equal(calls, 1);
      assert.ok(logged().includes('redirect-refused'));
    });

    it('hands messages over one at a time, in the order they arrived', async () => {
      const order = [];
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const slow = {
        sendInbound: async (message) => {
          if (message.text === 'first') await gate;
          order.push(message.text);
          return { status: 202, body: {} };
        }
      };
      const handle = inbound({ bridge: slow });
      const turns = [handle(operatorMessage('first'), {}), handle(operatorMessage('second'), {})];
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(order, [], 'the second waits behind the first');
      release();
      await Promise.all(turns);
      assert.deepEqual(order, ['first', 'second']);
    });
  });

  describe('TangleClaw to Discord', () => {
    it('posts a released answer once, as a reply to the operator\'s message, and acknowledges it under its lease', async () => {
      const { routeId, messageId, outboundId } = await answered('Two sessions are working. @everyone');
      const relay = outbound();
      assert.deepEqual(await relay.pass(), { ok: true, posted: 1, acked: 1, held: 0 });
      assert.equal(discord.posts.length, 1);
      const [post] = discord.posts;
      assert.deepEqual([post.channelId, post.content, post.replyTo, post.allowedMentions],
        [IDS.channelId, '**Project Master**\nTwo sessions are working. @everyone', messageId, { parse: [] }]);
      assert.equal(post.nonce, nonceFor(relay.state.salt, outboundId, 0));

      assert.deepEqual(atBridge(outboundId), ['delivered', post.id], 'the bridge holds Discord\'s own id for the post');
      assert.equal(bridgeStore.routes.get(routeId).state, 'closed');
      const lease = store.getDb().prepare('SELECT state FROM bridge_outbound_leases WHERE outbound_id = ?').get(outboundId);
      assert.equal(lease.state, 'used');
      assert.deepEqual(relay.state.entries(), [], 'nothing is left in the helper\'s record');
      assert.deepEqual(logged().filter((c) => c.startsWith('outbound')), ['outbound-posted', 'outbound-acked']);
      assert.ok(!JSON.stringify(codes).includes('sessions'), 'no text reaches the log');

      assert.deepEqual(await relay.pass(), { ok: true, posted: 0, acked: 0, held: 0 }, 'and a later pass finds nothing to do');
      assert.equal(discord.posts.length, 1);
    });

    it('posts a long answer in parts, in order, and acknowledges it with the first part\'s id', async () => {
      const long = Array.from({ length: 150 }, (_, i) => `line ${i} ${'y'.repeat(40)}`).join('\n');
      const { messageId, outboundId } = await answered(long);
      assert.deepEqual(await outbound().pass(), { ok: true, posted: 1, acked: 1, held: 0 });
      assert.ok(discord.posts.length > 1 && discord.posts.every((p) => Array.from(p.content).length <= PART_MAX));
      assert.equal(discord.posts.map((p) => p.content).join(''), `**Project Master**\n${long}`);
      assert.deepEqual(discord.posts.map((p) => p.replyTo), [messageId, ...discord.posts.slice(1).map(() => null)], 'only the first part is a reply');
      assert.equal(new Set(discord.posts.map((p) => p.nonce)).size, discord.posts.length);
      assert.deepEqual(atBridge(outboundId), ['delivered', discord.posts[0].id]);
      assert.deepEqual(bridgeStore.parts.forItem(outboundId), discord.posts.map((p) => p.id), 'and the bridge has every part\'s id, in order');

      // The operator replies in Discord to the last part: the bridge knows what it answers.
      const last = discord.posts.length - 1;
      const reply = operatorMessage('and the rest?', { type: 19, message_reference: { message_id: discord.posts[last].id } });
      assert.equal(await inbound()(reply, { selfId: BOT_ID }), 'inbound-accepted');
      const context = bridgeStore.routes.getByExternalId(reply.id).replyContext;
      assert.deepEqual([context.outboundId, context.partIndex, context.partCount, context.canonicalExternalId],
        [outboundId, last, discord.posts.length, discord.posts[0].id]);
    });

    it('a lost acknowledgement is made again after a restart, and nothing is posted twice', async () => {
      const { routeId, outboundId } = await answered('the answer');
      const first = outbound({ bridge: losingOnce('ack', { before: true }) });
      assert.deepEqual(await first.pass(), { ok: false, posted: 0, acked: 0, held: 0 });
      assert.deepEqual(atBridge(outboundId), ['ready', null], 'the bridge was never told');
      assert.equal(discord.posts.length, 1);
      assert.equal(first.state.get(outboundId).status, 'posted');

      // A new process opens the same record.
      const second = outbound();
      assert.deepEqual(await second.pass(), { ok: true, posted: 0, acked: 1, held: 0 });
      assert.equal(discord.posts.length, 1, 'it was not posted again');
      assert.deepEqual(atBridge(outboundId), ['delivered', discord.posts[0].id]);
      assert.equal(bridgeStore.routes.get(routeId).state, 'closed');
      assert.deepEqual(second.state.entries(), []);
    });

    it('an acknowledgement that landed but whose answer was lost is settled by repeating it', async () => {
      const { outboundId } = await answered('the answer');
      const first = outbound({ bridge: losingOnce('ack') });
      assert.equal((await first.pass()).ok, false);
      assert.deepEqual(atBridge(outboundId), ['delivered', discord.posts[0].id], 'the bridge has it');
      assert.equal(first.state.get(outboundId).status, 'posted', 'the helper does not know that yet');

      const second = outbound();
      assert.deepEqual(await second.pass(), { ok: true, posted: 0, acked: 1, held: 0 });
      assert.deepEqual([discord.posts.length, second.state.entries()], [1, []]);
    });

    it('a lease that lapses between the post and the acknowledgement costs a second claim, never a second post', async () => {
      const { outboundId } = await answered('the answer');
      const relay = outbound({ bridge: losingOnce('ack', { before: true }) });
      assert.equal((await relay.pass()).ok, false);
      const firstLease = relay.state.get(outboundId).leaseId;

      clock += bridgeStore.LEASE_MS + 1000;
      assert.deepEqual(await relay.pass(), { ok: true, posted: 0, acked: 1, held: 0 });
      assert.equal(discord.posts.length, 1);
      assert.deepEqual(atBridge(outboundId), ['delivered', discord.posts[0].id]);
      const leases = store.getDb().prepare('SELECT lease_id, state FROM bridge_outbound_leases WHERE outbound_id = ? ORDER BY issued_at').all(outboundId);
      assert.deepEqual(leases.map((l) => l.state), ['lapsed', 'used']);
      assert.equal(leases[0].lease_id, firstLease);
      assert.ok(logged().includes('outbound-ack-failed'), 'the old lease was tried and refused first');
    });

    it('a helper that restarts part-way through a claim carries on with it', async () => {
      const one = await answered('first');
      const two = await answered('second');
      // Discord is busy for a moment, and the pass stops with both items in hand.
      discordBusy();
      const first = outbound();
      assert.equal((await first.pass()).ok, false);
      assert.deepEqual(discord.posts, []);
      const nonce = first.state.claim();
      assert.match(nonce, /^[A-Za-z0-9_-]{16,128}$/);

      // A new process: the record names the claim, and the bridge returns its leases.
      const second = outbound();
      assert.equal(second.state.claim(), nonce);
      assert.deepEqual(await second.pass(), { ok: true, posted: 2, acked: 2, held: 0 });
      assert.deepEqual([atBridge(one.outboundId)[0], atBridge(two.outboundId)[0]], ['delivered', 'delivered']);
      assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_outbound_leases').get().n, 2);
    });

    it('a post whose outcome is unknown is retried under the same nonce, and Discord returns the one it made', async () => {
      const { outboundId } = await answered('the answer');
      discord.script.push({ status: 502, lands: true });
      const relay = outbound();
      assert.deepEqual(await relay.pass(), { ok: false, posted: 0, acked: 0, held: 0 });
      assert.equal(discord.posts.length, 1, 'it did post, though the helper cannot know');
      assert.ok(relay.state.get(outboundId).since, 'the attempt is on record as in doubt');
      assert.deepEqual(atBridge(outboundId), ['ready', null]);

      clock += 30000;
      assert.deepEqual(await relay.pass(), { ok: true, posted: 1, acked: 1, held: 0 });
      assert.equal(discord.posts.length, 1, 'the retry made no second message');
      assert.deepEqual(atBridge(outboundId), ['delivered', discord.posts[0].id]);
    });

    it('past the nonce window an unknown outcome is held, the bridge sets the item aside, and the operator is told', async () => {
      const { routeId, outboundId } = await answered('the answer');
      discord.script.push({ status: 502, lands: true });
      const relay = outbound();
      assert.equal((await relay.pass()).ok, false);

      clock += NONCE_WINDOW_MS + 1;
      assert.deepEqual(await relay.pass(), { ok: true, posted: 0, acked: 0, held: 1 });
      assert.equal(relay.state.get(outboundId).status, 'uncertain');
      assert.deepEqual([atBridge(outboundId)[0], bridgeStore.outbound.get(outboundId).blockCode], ['blocked', 'outcome-unverifiable']);
      assert.equal(bridgeStore.routes.get(routeId).state, 'released', 'nothing is acknowledged, and the route stays open');

      // The next passes post the notice that something was set aside, and nothing else.
      for (let i = 0; i < 3; i++) {
        await relay.pass();
        clock += bridgeStore.LEASE_MS + 1000;
      }
      assert.equal(answersPosted().length, 1, 'the answer was not posted again, pass after pass');
      assert.deepEqual(discord.posts.slice(1).map((p) => p.content), [`**TangleClaw**\n${gateway.BLOCKED_NOTICE}`], 'one notice, once');
      assert.equal(logged().filter((c) => c === 'outbound-uncertain').length, 1);

      // The operator looks in the channel, sees it, and says so; the Master puts the item back.
      assert.throws(() => settleHeld(relay.state, outboundId, {}), (err) => err instanceof SettleError && err.code === 'bad-settlement');
      assert.throws(() => settleHeld(relay.state, outboundId, { posted: 'abc' }), { code: 'bad-id' });
      assert.throws(() => settleHeld(relay.state, outboundId + 1000, { repost: true }), { code: 'not-held' });
      assert.deepEqual(settleHeld(relay.state, outboundId, { posted: answersPosted()[0].id }), { part: 2 });
      assert.deepEqual(await relay.pass(), { ok: true, posted: 0, acked: 0, held: 0 }, 'settled, but still set aside at the bridge');
      assert.equal((await masterDecides(outboundId, 'requeue')).status, 200);
      assert.deepEqual(await relay.pass(), { ok: true, posted: 0, acked: 1, held: 0 });
      assert.equal(answersPosted().length, 1);
      assert.deepEqual(atBridge(outboundId), ['delivered', answersPosted()[0].id]);
      assert.equal(bridgeStore.routes.get(routeId).state, 'closed');
      assert.throws(() => settleHeld(relay.state, outboundId, { repost: true }), { code: 'not-held' }, 'a second settlement changes nothing');
    });

    it('an unknown outcome the operator found did not post is posted again under a new nonce', async () => {
      const { outboundId } = await answered('the answer');
      discord.script.push({ status: 502 });
      const relay = outbound();
      assert.equal((await relay.pass()).ok, false);
      clock += NONCE_WINDOW_MS + 1;
      assert.equal((await relay.pass()).held, 1);
      assert.equal(answersPosted().length, 0);

      settleHeld(relay.state, outboundId, { repost: true });
      assert.equal((await masterDecides(outboundId, 'requeue')).status, 200);
      await relay.pass();
      assert.deepEqual(answersPosted().map((p) => p.nonce), [nonceFor(relay.state.salt, outboundId, 0, 1)]);
      assert.deepEqual(atBridge(outboundId), ['delivered', answersPosted()[0].id]);
    });

    it('an item Discord rejects is set aside at the bridge, the ones after it keep moving, and the helper discards nothing', async () => {
      const bad = await answered('the one Discord refuses');
      const good = await answered('the one after it');
      discord.script.push({ status: 400, body: { code: 50035 } });
      const relay = outbound();
      assert.deepEqual(await relay.pass(), { ok: true, posted: 1, acked: 1, held: 0 });
      assert.deepEqual(discord.posts.map((p) => p.content), ['**Project Master**\nthe one after it']);
      assert.deepEqual([atBridge(bad.outboundId)[0], atBridge(good.outboundId)[0]], ['blocked', 'delivered']);
      assert.equal(bridgeStore.outbound.get(bad.outboundId).blockCode, 'rejected-by-chat');
      assert.equal(bridgeStore.outbound.get(bad.outboundId).text, 'the one Discord refuses', 'its text is still held: nothing was discarded');
      assert.equal(bridgeStore.routes.get(bad.routeId).state, 'released');
      assert.equal(relay.state.get(bad.outboundId), undefined, 'the helper keeps nothing: the bridge holds the item');

      // The operator is told, once; and the item is handed to nobody until someone decides.
      assert.deepEqual(await relay.pass(), { ok: true, posted: 1, acked: 1, held: 0 });
      assert.equal(discord.posts[1].content, `**TangleClaw**\n${gateway.BLOCKED_NOTICE}`);
      clock += bridgeStore.LEASE_MS + 1000;
      assert.deepEqual(await relay.pass(), { ok: true, posted: 0, acked: 0, held: 0 });

      // The Master puts it back, and this time Discord takes it.
      assert.equal((await masterDecides(bad.outboundId, 'requeue')).status, 200);
      assert.deepEqual(await relay.pass(), { ok: true, posted: 1, acked: 1, held: 0 });
      assert.equal(atBridge(bad.outboundId)[0], 'delivered');
      assert.equal(discord.posts.length, 3);
    });

    it('a chat that is closed to the bot stops everything at once: one item set aside, one episode, nothing more claimed or posted', async () => {
      const one = await answered('first');
      const two = await answered('second');
      discord.script.push({ status: 403, body: { code: 50013 } });
      const relay = outbound();
      assert.deepEqual(await relay.pass(), { ok: false, posted: 0, acked: 0, held: 0 });
      assert.deepEqual(discord.posts, [], 'the second was not tried');
      assert.deepEqual([atBridge(one.outboundId)[0], bridgeStore.outbound.get(one.outboundId).blockCode, atBridge(two.outboundId)[0]],
        ['blocked', 'chat-permission-denied', 'ready']);
      const episode = bridgeStore.circuit.open();
      assert.deepEqual([episode.reason, episode.outboundId], ['chat-permission-denied', one.outboundId]);
      assert.equal(relay.state.get(one.outboundId), undefined, 'the bridge holds the item; the helper keeps nothing');

      // Pass after pass the helper asks, is told the same thing, and nothing moves.
      const before = store.getDb().prepare('SELECT * FROM bridge_outbound ORDER BY outbound_id').all();
      const leases = store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_outbound_leases').get().n;
      codes.length = 0;
      for (let i = 0; i < 3; i++) {
        assert.deepEqual(await relay.pass(), { ok: false, posted: 0, acked: 0, held: 0 });
        clock += bridgeStore.LEASE_MS + 1000;
      }
      assert.deepEqual(logged(), ['bridge-configuration-blocked', 'bridge-configuration-blocked', 'bridge-configuration-blocked']);
      assert.deepEqual(discord.posts, [], 'nothing is posted, the episode\'s own notice included');
      assert.deepEqual(store.getDb().prepare('SELECT * FROM bridge_outbound ORDER BY outbound_id').all(), before, 'no queued item was touched');
      assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_outbound_leases').get().n, leases, 'and no lease was issued');
      assert.equal(bridgeStore.circuit.open().episodeId, episode.episodeId, 'and it is still the one episode');

      // The channel is put right and the Master resets the circuit: both answers go out, once each.
      const res = await fetch(`${origin}/api/bridge/master/circuit/reset`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-tangleclaw-bridge-credential': masterCredential },
        body: JSON.stringify({ requestId: `req-reset-${++seq}-0000`, decision: 'requeue' })
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await relay.pass(), { ok: true, posted: 2, acked: 2, held: 0 });
      assert.deepEqual(discord.posts.map((p) => p.content).sort(), ['**Project Master**\nfirst', '**Project Master**\nsecond']);
      assert.deepEqual([atBridge(one.outboundId)[0], atBridge(two.outboundId)[0]], ['delivered', 'delivered']);
    });

    it('a bare 403 is the bot not being allowed: it opens the circuit, code or no code', async () => {
      const one = await answered('first');
      discord.script.push({ status: 403, body: {} });
      assert.deepEqual(await outbound().pass(), { ok: false, posted: 0, acked: 0, held: 0 });
      assert.deepEqual([atBridge(one.outboundId)[0], bridgeStore.outbound.get(one.outboundId).blockCode, bridgeStore.circuit.open().reason],
        ['blocked', 'chat-permission-denied', 'chat-permission-denied']);
      assert.deepEqual(discord.posts, []);
    });

    it('a 404 for an answer is tried once more by itself; only if that fails too is the channel taken to be gone', async () => {
      // The message it answers is gone, by Discord's code or with none: one retry, unthreaded, and it posts.
      for (const refusal of [{ status: 404, body: { code: 10008 } }, { status: 400, body: { code: 160002 } }, { status: 404, body: {} }]) {
        discord.posts.length = 0;
        const { outboundId } = await answered('the answer');
        discord.script.push(refusal);
        const calls = discord.calls();
        assert.deepEqual(await outbound().pass(), { ok: true, posted: 1, acked: 1, held: 0 }, JSON.stringify(refusal));
        assert.equal(discord.calls() - calls, 2, 'the threaded attempt, and exactly one more');
        assert.deepEqual(discord.posts.map((p) => [p.content, p.replyTo]), [['**Project Master**\nthe answer', null]]);
        assert.deepEqual([atBridge(outboundId)[0], bridgeStore.circuit.open()], ['delivered', null]);
      }
      assert.equal(logged().filter((c) => c === 'outbound-reply-target-missing').length, 3);

      // Threaded and unthreaded both 404: it is the channel. One retry, no more, and the circuit opens.
      discord.posts.length = 0;
      const gone = await answered('into the void');
      discord.script.push({ status: 404, body: {} }, { status: 404, body: {} });
      const calls = discord.calls();
      assert.deepEqual(await outbound().pass(), { ok: false, posted: 0, acked: 0, held: 0 });
      assert.equal(discord.calls() - calls, 2);
      assert.deepEqual([atBridge(gone.outboundId)[0], bridgeStore.outbound.get(gone.outboundId).blockCode, bridgeStore.circuit.open().reason],
        ['blocked', 'chat-channel-missing', 'chat-channel-missing']);
      assert.deepEqual(discord.posts, []);
    });

    it('a 404 for a post that answers nothing is the channel itself, and is not retried', async () => {
      const text = 'A session needs the operator.';
      const id = bridgeStore.outbound.enqueue({
        idemKey: `notify:operator-needed:void-${++seq}`, kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw',
        text, digest: bridgeStore.digest(text), at: new Date(clock).toISOString()
      }).outboundId;
      discord.script.push({ status: 404, body: {} });
      const calls = discord.calls();
      assert.deepEqual(await outbound().pass(), { ok: false, posted: 0, acked: 0, held: 0 });
      assert.equal(discord.calls() - calls, 1, 'there is no reply target to drop, so nothing to retry');
      assert.deepEqual([atBridge(id)[0], bridgeStore.outbound.get(id).blockCode, bridgeStore.circuit.open().reason], ['blocked', 'chat-channel-missing', 'chat-channel-missing']);
    });

    it('a refusal it cannot place, or an answer with no message in it, is never taken for a post', async () => {
      const odd = await answered('first');
      const next = await answered('second');
      discord.script.push({ status: 418, body: {} });
      assert.deepEqual(await outbound().pass(), { ok: true, posted: 1, acked: 1, held: 0 });
      assert.deepEqual([atBridge(odd.outboundId)[0], bridgeStore.outbound.get(odd.outboundId).blockCode], ['blocked', 'outcome-unverifiable'], 'set aside, not retried on a guess');
      assert.deepEqual([logged().includes('outbound-unplaceable'), outbound().state.get(odd.outboundId)], [true, undefined], 'logged as its own case, and the helper holds nothing');
      assert.deepEqual([atBridge(next.outboundId)[0], bridgeStore.circuit.open()], ['delivered', null], 'the next item moves, and the channel is not blamed');

      // Discord answers 200 with nothing that is a message id.
      store.getDb().exec("DELETE FROM bridge_outbound WHERE state = 'ready'");
      const blank = await answered('third');
      discord.script.push({ status: 200, body: { id: 'not-an-id' } });
      const relay = outbound();
      await relay.pass();
      assert.deepEqual(atBridge(blank.outboundId), ['ready', null], 'it is not delivered');
      assert.deepEqual(bridgeStore.parts.forItem(blank.outboundId), [], 'and no part is recorded for it');
      assert.ok(relay.state.get(blank.outboundId).since, 'the attempt stays on record as in doubt');
      clock += 30000;
      discord.posts.length = 0;
      assert.deepEqual(await relay.pass(), { ok: true, posted: 1, acked: 1, held: 0 }, 'the next pass settles it under the same nonce');
      assert.deepEqual([discord.posts.length, atBridge(blank.outboundId)[0]], [1, 'delivered']);
    });

    it('judges every attempt in one place, by what Discord\'s answer can only mean for a post to one fixed channel', () => {
      const is = (sent, status, discordCode, fresh, threaded) => {
        const v = classifyAttempt({ sent, status, discordCode, fresh, threaded });
        return v.reason ? `${v.kind}:${v.reason}` : v.kind;
      };
      // [sent, status, code, first attempt for the part, named a message to reply to] -> verdict
      const table = [
        // Discord may have acted: in doubt, whatever else is true.
        ['unknown', 502, null, true, true, 'unknown'], ['unknown', 0, null, true, false, 'unknown'], ['unknown', 502, null, false, true, 'unknown'],
        ['unknown', 404, null, true, true, 'unknown'], ['unknown', 403, 50013, true, false, 'unknown'],
        // Not reached, redirected or rate-limited: try again later. Never the circuit.
        ['no', 0, null, true, true, 'transient'], ['no', 302, null, true, false, 'transient'], ['no', 429, null, true, true, 'transient'],
        ['no', 429, null, false, false, 'transient'], ['no', 0, null, false, true, 'transient'],
        // Discord's own configuration codes, and a refused token.
        ['no', 404, 10003, true, true, 'circuit:chat-channel-missing'], ['no', 404, 10004, true, false, 'circuit:chat-guild-missing'],
        ['no', 403, 50001, true, true, 'circuit:chat-permission-denied'], ['no', 403, 50013, true, false, 'circuit:chat-permission-denied'],
        ['no', 401, null, true, true, 'circuit:chat-auth-refused'], ['no', 401, 0, true, false, 'circuit:chat-auth-refused'],
        // A reply target that is gone: one more try by itself, only where there was one.
        ['no', 404, 10008, true, true, 'retry-unthreaded'], ['no', 400, 160002, true, true, 'retry-unthreaded'],
        ['no', 404, 10008, false, true, 'retry-unthreaded'], ['no', 404, 10008, true, false, 'unplaceable'], ['no', 400, 160002, true, false, 'unplaceable'],
        // A 403 or 404 with no code.
        ['no', 403, null, true, true, 'circuit:chat-permission-denied'], ['no', 403, 0, true, false, 'circuit:chat-permission-denied'],
        ['no', 404, null, true, true, 'retry-unthreaded'], ['no', 404, 0, true, true, 'retry-unthreaded'], ['no', 404, null, false, true, 'retry-unthreaded'],
        ['no', 404, null, true, false, 'circuit:chat-channel-missing'], ['no', 404, 0, true, false, 'circuit:chat-channel-missing'],
        // A 403 or 404 with a code this table does not know: the item's, never the channel's.
        ['no', 403, 40001, true, true, 'unplaceable'], ['no', 403, 40001, true, false, 'unplaceable'],
        ['no', 404, 10007, true, true, 'unplaceable'], ['no', 404, 10007, true, false, 'unplaceable'],
        // The item's own content, and anything else.
        ['no', 400, 50035, true, true, 'rejected'], ['no', 400, null, true, false, 'rejected'],
        ['no', 418, null, true, true, 'unplaceable'], ['no', 409, 0, true, false, 'unplaceable'], ['no', 422, 12345, true, false, 'unplaceable'],
        // The same definite refusals while an earlier attempt is in doubt: they settle nothing.
        ['no', 400, 50035, false, false, 'uncertain'], ['no', 401, null, false, true, 'uncertain'], ['no', 403, null, false, false, 'uncertain'],
        ['no', 403, 50013, false, true, 'uncertain'], ['no', 404, null, false, false, 'uncertain'], ['no', 404, 10003, false, true, 'uncertain'],
        ['no', 404, 10007, false, false, 'uncertain'], ['no', 418, null, false, true, 'uncertain'], ['no', 404, 10008, false, false, 'uncertain']
      ];
      for (const [sent, status, code, fresh, threaded, verdict] of table) {
        assert.equal(is(sent, status, code, fresh, threaded), verdict, JSON.stringify([sent, status, code, fresh, threaded]));
      }
      // The set is closed, and nothing in it is "posted".
      const kinds = new Set();
      for (const sent of ['no', 'unknown', undefined]) {
        for (const status of [0, 200, 302, 400, 401, 403, 404, 409, 429, 500, 502]) {
          for (const code of [null, undefined, 0, 10003, 10008, 50013, 99999]) {
            for (const fresh of [true, false]) for (const threaded of [true, false]) kinds.add(classifyAttempt({ sent, status, discordCode: code, fresh, threaded }).kind);
          }
        }
      }
      assert.deepEqual([...kinds].sort(), ['circuit', 'rejected', 'retry-unthreaded', 'transient', 'uncertain', 'unknown', 'unplaceable']);
    });

    it('a retry by itself that ends in doubt is settled by the next pass under the same nonce: one post', async () => {
      const { outboundId } = await answered('the answer');
      // The reply target is gone (a bare 404); the unthreaded retry lands, but its answer is lost.
      discord.script.push({ status: 404, body: {} }, { status: 502, lands: true });
      const relay = outbound();
      const calls = discord.calls();
      assert.deepEqual(await relay.pass(), { ok: false, posted: 0, acked: 0, held: 0 });
      assert.equal(discord.calls() - calls, 2);
      assert.equal(discord.posts.length, 1, 'it did post, though the helper cannot know');
      const entry = relay.state.get(outboundId);
      assert.deepEqual([Boolean(entry.since), entry.unthreaded, entry.parts], [true, 0, []], 'the attempt is in doubt, and the part stays unthreaded');
      assert.deepEqual([atBridge(outboundId)[0], bridgeStore.circuit.open()], ['ready', null]);

      clock += 30000;
      assert.deepEqual(await relay.pass(), { ok: true, posted: 1, acked: 1, held: 0 });
      assert.equal(discord.calls() - calls, 3, 'one more call: by itself, not as a reply again');
      assert.deepEqual(discord.posts.map((p) => [p.content, p.replyTo, p.nonce]), [['**Project Master**\nthe answer', null, nonceFor(relay.state.salt, outboundId, 0)]]);
      assert.deepEqual(atBridge(outboundId), ['delivered', discord.posts[0].id]);
    });

    it('a 403 or 404 with a code it does not know is this item\'s problem, never the channel\'s', async () => {
      for (const refusal of [{ status: 403, body: { code: 40001 } }, { status: 404, body: { code: 10007 } }]) {
        const odd = await answered('first');
        const next = await answered('second');
        discord.script.push(refusal);
        codes.length = 0;
        assert.deepEqual(await outbound().pass(), { ok: true, posted: 1, acked: 1, held: 0 }, JSON.stringify(refusal));
        assert.deepEqual([atBridge(odd.outboundId)[0], bridgeStore.outbound.get(odd.outboundId).blockCode, atBridge(next.outboundId)[0], bridgeStore.circuit.open()],
          ['blocked', 'outcome-unverifiable', 'delivered', null]);
        assert.deepEqual(codes.filter(([c]) => c === 'outbound-unplaceable').map(([, f]) => f.status), [refusal.status]);
        store.getDb().exec("DELETE FROM bridge_outbound WHERE state = 'ready'");
      }
    });

    it('a definite refusal while an earlier attempt is in doubt settles nothing: the item is held as uncertain', async () => {
      for (const refusal of [{ status: 403, body: {} }, { status: 404, body: { code: 10003 } }, { status: 401, body: {} }, { status: 400, body: { code: 50035 } }]) {
        discord.posts.length = 0;
        const { outboundId } = await answered('the answer');
        discord.script.push({ status: 502, lands: true }, refusal);
        const relay = outbound();
        assert.equal((await relay.pass()).ok, false);
        clock += 30000;
        const pass = await relay.pass();
        assert.deepEqual([pass.ok, pass.held], [true, 1], JSON.stringify(refusal));
        assert.equal(relay.state.get(outboundId).status, 'uncertain');
        assert.deepEqual([atBridge(outboundId)[0], bridgeStore.outbound.get(outboundId).blockCode, bridgeStore.circuit.open()], ['blocked', 'outcome-unverifiable', null],
          'not the circuit, not a retry, and not delivered');
        assert.equal(answersPosted().length, 1, 'the answer is in the channel once; only the notice that it was set aside follows it');
        clock += bridgeStore.LEASE_MS + 1000;
        fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
        store.getDb().exec("DELETE FROM bridge_outbound WHERE state IN ('ready','blocked')");
      }
    });

    it('a refusal a retry may fix holds nothing and sets nothing aside', async () => {
      const one = await answered('first');
      discordBusy();
      const relay = outbound();
      assert.deepEqual(await relay.pass(), { ok: false, posted: 0, acked: 0, held: 0 });
      assert.equal(atBridge(one.outboundId)[0], 'ready');
      assert.equal(relay.state.get(one.outboundId).since, undefined, 'Discord did not act, so nothing is in doubt');
      const reported = store.getDb().prepare("SELECT outcome, detail_json FROM bridge_audit WHERE op = 'helper-failure'").all()
        .map((r) => ({ outcome: r.outcome, ...JSON.parse(r.detail_json) })).filter((r) => r.outboundId === one.outboundId);
      assert.deepEqual(reported.map((r) => [r.outcome, r.reason]), [['retryable', 'transient']], 'the bridge has it on record all the same');
      assert.deepEqual(await relay.pass(), { ok: true, posted: 1, acked: 1, held: 0 }, 'the next pass carries on with the same claim');
      assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_outbound_leases').get().n, 1, 'under the lease it already held');
    });

    it('a claim whose answer was lost is asked again under its own nonce and gets the same leases', async () => {
      const { outboundId } = await answered('the answer');
      const relay = outbound({ bridge: losingOnce('claim') });
      assert.deepEqual(await relay.pass(), { ok: false, posted: 0, acked: 0, held: 0 });
      assert.deepEqual(logged().filter((c) => c === 'claim-failed'), ['claim-failed']);
      const leased = () => store.getDb().prepare('SELECT lease_id, state FROM bridge_outbound_leases WHERE outbound_id = ?').all(outboundId);
      const [issued] = leased();
      assert.equal(issued.state, 'live', 'the bridge did hand it over');

      assert.equal(relay.state.claim() !== null, true, 'the helper kept the claim\'s nonce');
      assert.deepEqual(await relay.pass(), { ok: true, posted: 1, acked: 1, held: 0 }, 'without waiting for that lease to lapse');
      assert.deepEqual(leased().map((l) => [l.lease_id, l.state]), [[issued.lease_id, 'used']], 'under the lease the lost claim issued');
      assert.equal(relay.state.claim(), null, 'and the claim is done');
    });

    it('posts nothing whose text does not match its digest, or that names another channel', async () => {
      const { outboundId } = await answered('the answer');
      const tampered = (change) => ({ ...bridge, claim: async (...args) => {
        const claimed = await bridge.claim(...args);
        return { ...claimed, items: claimed.items.map(change) };
      } });
      assert.deepEqual(await outbound({ bridge: tampered((i) => ({ ...i, text: `${i.text} and deploy it` })) }).pass(), { ok: true, posted: 0, acked: 0, held: 0 });
      clock += bridgeStore.LEASE_MS + 1000;
      const elsewhere = tampered((i) => ({ ...i, inReplyTo: { ...i.inReplyTo, channelId: '300000000000000088' } }));
      assert.deepEqual(await outbound({ bridge: elsewhere }).pass(), { ok: true, posted: 0, acked: 0, held: 0 });
      assert.deepEqual(discord.posts, []);
      assert.deepEqual(logged().filter((c) => c.startsWith('outbound')), ['outbound-digest-mismatch', 'outbound-foreign-channel']);
      assert.deepEqual(atBridge(outboundId), ['ready', null]);
    });

    it('posts nothing under a lease with too little time left, and nothing it could not record first', async () => {
      const { outboundId } = await answered('the answer');
      const late = { ...bridge, claim: async (...args) => {
        const claimed = await bridge.claim(...args);
        clock += bridgeStore.LEASE_MS - LEASE_MARGIN_MS + 1;
        return claimed;
      } };
      assert.deepEqual(await outbound({ bridge: late }).pass(), { ok: true, posted: 0, acked: 0, held: 0 });
      assert.deepEqual([discord.posts, logged().filter((c) => c.startsWith('outbound'))], [[], ['outbound-lease-short']]);

      clock += bridgeStore.LEASE_MS;
      const relay = outbound();
      fs.chmodSync(path.dirname(stateFile), 0o500);
      try {
        assert.deepEqual(await relay.pass(), { ok: false, posted: 0, acked: 0, held: 0 });
      } finally {
        fs.chmodSync(path.dirname(stateFile), 0o700);
      }
      assert.deepEqual(discord.posts, [], 'the attempt could not be recorded, so it was not made');
      assert.ok(logged().includes('state-write-failed'));
      assert.deepEqual(atBridge(outboundId), ['ready', null]);
    });

    it('an attempt that could not be recorded is not remembered as made: every later pass must record it first', async () => {
      const { outboundId } = await answered('the answer');
      const relay = outbound();
      // The claim is recorded; then the record stops taking writes, for two passes running.
      const failing = { ...relay.state, set: () => { throw new Error('disk full'); } };
      const stuck = createOutbound({ channelId: IDS.channelId, bridge, rest: restClient(), state: failing, log, now: () => clock });
      for (let i = 0; i < 2; i++) {
        assert.deepEqual(await stuck.pass(), { ok: false, posted: 0, acked: 0, held: 0 }, `pass ${i + 1}`);
        assert.deepEqual(discord.posts, [], `pass ${i + 1}: nothing is posted that is not on disk first`);
      }
      assert.equal(relay.state.get(outboundId), undefined, 'and nothing was recorded');
      assert.equal(logged().filter((c) => c === 'state-write-failed').length, 2);

      // The record takes writes again: one post, one acknowledgement.
      failing.set = relay.state.set;
      assert.deepEqual(await stuck.pass(), { ok: true, posted: 1, acked: 1, held: 0 });
      assert.equal(discord.posts.length, 1);
      assert.deepEqual(atBridge(outboundId), ['delivered', discord.posts[0].id]);
    });

    it('a part that posted is remembered while the helper runs, even when recording it failed', async () => {
      const { outboundId } = await answered('the answer');
      const relay = outbound();
      let writes = 0;
      // The write before the post succeeds; the write after it fails once.
      const flaky = { ...relay.state, set: (id, entry) => { writes += 1; if (writes === 2) throw new Error('disk full'); relay.state.set(id, entry); } };
      const helper = createOutbound({ channelId: IDS.channelId, bridge, rest: restClient(), state: flaky, log, now: () => clock });
      assert.deepEqual(await helper.pass(), { ok: false, posted: 0, acked: 0, held: 0 });
      assert.equal(discord.posts.length, 1, 'it posted');
      assert.deepEqual(relay.state.get(outboundId).parts, [], 'and the record does not say so');

      assert.deepEqual(await helper.pass(), { ok: true, posted: 0, acked: 1, held: 0 });
      assert.equal(discord.posts.length, 1, 'the running helper did not post it again');
      assert.deepEqual(atBridge(outboundId), ['delivered', discord.posts[0].id]);
    });

    it('stops asking when its lease is no longer its own and the bridge already has every part', async () => {
      const { outboundId } = await answered('the answer');
      const relay = outbound({ bridge: losingOnce('ack') });
      assert.equal((await relay.pass()).ok, false);
      assert.deepEqual(atBridge(outboundId), ['delivered', discord.posts[0].id], 'the bridge has it; the helper does not know');

      // The operator replaces the token. The new one is told only that the lease is not its own.
      helperToken = (await asOperator('POST', '/api/bridge/operator/helper-token')).body.token;
      bridge = createBridgeClient({ origin, token: helperToken });
      const later = outbound();
      codes.length = 0;
      assert.deepEqual(await later.pass(), { ok: true, posted: 0, acked: 0, held: 0 });
      assert.deepEqual(codes.filter(([c]) => c.startsWith('outbound')), [['outbound-ack-failed', { outboundId, status: 403 }]]);
      assert.deepEqual(later.state.entries(), [], 'the bridge holds every part, so the helper\'s record adds nothing and is let go');
      assert.equal(discord.posts.length, 1);
      assert.deepEqual(await later.pass(), { ok: true, posted: 0, acked: 0, held: 0 }, 'and it does not ask again');
    });

    it('drops a claim in progress when the helper token was replaced, and collects under the new one', async () => {
      const { outboundId } = await answered('the answer');
      discordBusy();
      const before = outbound();
      assert.equal((await before.pass()).ok, false);
      const stale = before.state.claim();

      // The operator replaces the token; the old one's leases lapse at once.
      helperToken = (await asOperator('POST', '/api/bridge/operator/helper-token')).body.token;
      bridge = createBridgeClient({ origin, token: helperToken });
      const relay = outbound();
      assert.equal(relay.state.claim(), stale);
      assert.deepEqual(await relay.pass(), { ok: true, posted: 1, acked: 1, held: 0 });
      assert.deepEqual(atBridge(outboundId), ['delivered', discord.posts[0].id]);
      assert.deepEqual(logged().filter((c) => c === 'claim-failed'), [], 'a nonce that is no longer its own is not a failure to reach the bridge');
      assert.equal(relay.state.claim(), null);
    });

    it('a helper that lost its own record carries on after the parts the bridge already has, without posting any twice', async () => {
      const long = Array.from({ length: 150 }, (_, i) => `line ${i} ${'y'.repeat(40)}`).join('\n');
      const { messageId, outboundId } = await answered(long);
      // The first part posts and is reported; then Discord is busy and the pass stops.
      const first = outbound();
      let posts = 0;
      const stopsAfterOne = { ...restClient(), createMessage: async (...args) => {
        if (posts >= 1) { discordBusy(); }
        posts += 1;
        return restClient().createMessage(...args);
      } };
      const helper = createOutbound({ channelId: IDS.channelId, bridge, rest: stopsAfterOne, state: first.state, log, now: () => clock });
      assert.deepEqual(await helper.pass(), { ok: false, posted: 0, acked: 0, held: 0 });
      assert.equal(discord.posts.length, 1);
      assert.deepEqual(bridgeStore.parts.forItem(outboundId), [discord.posts[0].id], 'the bridge has the first part already');
      assert.equal(atBridge(outboundId)[0], 'ready', 'and the item is not delivered on one part');

      // A reply to that one part is known for what it answers, before the item is complete.
      const early = operatorMessage('wait, what?', { type: 19, message_reference: { message_id: discord.posts[0].id } });
      assert.equal(await inbound()(early, { selfId: BOT_ID }), 'inbound-accepted');
      assert.equal(bridgeStore.routes.getByExternalId(early.id).replyContext.outboundId, outboundId);

      // The helper's own record is lost entirely; the lease lapses; a new helper claims the item.
      fs.rmSync(path.dirname(stateFile), { recursive: true, force: true });
      clock += bridgeStore.LEASE_MS + 1000;
      discord.script.length = 0;
      const fresh = outbound();
      assert.deepEqual(fresh.state.entries(), []);
      assert.deepEqual(await fresh.pass(), { ok: true, posted: 1, acked: 1, held: 0 });
      assert.equal(discord.posts.map((p) => p.content).join(''), `**Project Master**\n${long}`, 'every part once, in order');
      assert.deepEqual(bridgeStore.parts.forItem(outboundId), discord.posts.map((p) => p.id));
      assert.deepEqual(atBridge(outboundId), ['delivered', discord.posts[0].id]);
      assert.equal(discord.posts[0].replyTo, messageId);
      assert.equal(bridgeStore.outbound.get(outboundId).attempts, 2, 'handed over twice');
    });

    it('a part the helper posted and could not report is reported before anything more is posted', async () => {
      const long = Array.from({ length: 150 }, (_, i) => `line ${i} ${'y'.repeat(40)}`).join('\n');
      const { outboundId } = await answered(long);
      const relay = outbound({ bridge: losingOnce('part', { before: true }) });
      assert.deepEqual(await relay.pass(), { ok: false, posted: 0, acked: 0, held: 0 });
      assert.equal(discord.posts.length, 1);
      assert.deepEqual(bridgeStore.parts.forItem(outboundId), [], 'the bridge was never told');
      assert.deepEqual(relay.state.get(outboundId).parts, [discord.posts[0].id], 'the helper\'s own record has it');

      assert.deepEqual(await relay.pass(), { ok: true, posted: 1, acked: 1, held: 0 });
      assert.equal(discord.posts.map((p) => p.content).join(''), `**Project Master**\n${long}`, 'the first part was not posted again');
      assert.deepEqual(bridgeStore.parts.forItem(outboundId), discord.posts.map((p) => p.id));
    });

    it('when the bridge\'s record of an item disagrees with the helper\'s, the item is set aside and nothing more is posted', async () => {
      const { outboundId } = await answered('the answer');
      const relay = outbound({ bridge: losingOnce('part', { before: true }) });
      assert.equal((await relay.pass()).ok, false);
      // Something else is recorded as this item's first part meanwhile.
      bridgeStore.parts.insert(outboundId, 0, 1, '400000000000000999', new Date(clock).toISOString());
      await relay.pass();
      assert.deepEqual([atBridge(outboundId)[0], bridgeStore.outbound.get(outboundId).blockCode], ['blocked', 'part-conflict']);
      assert.equal(answersPosted().length, 1, 'the answer is not posted again, and not sealed on a record that is not the helper\'s');
      assert.ok(logged().includes('outbound-part-conflict'));
      assert.deepEqual(relay.state.entries(), [], 'the bridge holds the item now; the helper keeps nothing');
    });

    it('stops asking under a lease that is spent, when the item will never come back', async () => {
      // An answer that takes exactly two messages.
      const long = Array.from({ length: 60 }, (_, i) => `line ${i} ${'y'.repeat(40)}`).join('\n');
      const { routeId, outboundId } = await answered(long);
      // Both parts post, but the bridge is never told of the second, nor of the whole.
      let reports = 0;
      const total = () => bridgeStore.parts.forItem(outboundId).length;
      const deaf = { ...bridge,
        part: async (...args) => { reports += 1; if (reports > 1) throw new BridgeError(0, null); return bridge.part(...args); },
        ack: async () => { throw new BridgeError(0, null); } };
      const relay = outbound({ bridge: deaf });
      assert.equal((await relay.pass()).ok, false);
      assert.deepEqual([total(), discord.posts.length], [1, 2], 'two parts are in the channel; the bridge knows of one');
      assert.deepEqual([relay.state.get(outboundId).status, relay.state.get(outboundId).parts.length], ['posted', 2]);

      // The Master closes the route once the lease has lapsed: the item is withdrawn and will never be handed over again.
      clock += bridgeStore.LEASE_MS + 1000;
      const res = await fetch(`${origin}/api/bridge/master/routes/${routeId}/close`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-tangleclaw-bridge-credential': masterCredential },
        body: JSON.stringify({ requestId: `req-close-${++seq}-0000`, expectedVersion: bridgeStore.routes.get(routeId).version })
      });
      assert.equal(res.status, 200);
      assert.equal(atBridge(outboundId)[0], 'dropped');

      const later = outbound();
      codes.length = 0;
      await later.pass();
      assert.equal(logged().filter((c) => c === 'outbound-ack-failed').length, 1, 'it asks once more, and is told only that its lease is not live');
      assert.equal(later.state.get(outboundId).leaseId, undefined, 'so it puts that lease down');
      codes.length = 0;
      for (let i = 0; i < 3; i++) await later.pass();
      assert.deepEqual(logged().filter((c) => c.startsWith('outbound')), [], 'and does not ask again, pass after pass');
      assert.equal(later.state.get(outboundId).parts.length, 2, 'what it posted stays on its record');
      assert.equal(discord.posts.length, 2, 'and nothing more is posted');
    });

    it('lets go of its record when the bridge has let the item go', async () => {
      const text = 'A session needs the operator.';
      const week = bridgeStore.EXPIRY_MS.notification['operator-needed'];
      const id = bridgeStore.outbound.enqueue({
        idemKey: `notify:operator-needed:helper-${++seq}`, kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw',
        text, digest: bridgeStore.digest(text), at: new Date(clock - week + 60000).toISOString()
      }).outboundId;
      const relay = outbound({ bridge: losingOnce('ack', { before: true }) });
      assert.equal((await relay.pass()).ok, false);
      assert.deepEqual(discord.posts.map((p) => [p.content, p.replyTo]), [['**TangleClaw**\nA session needs the operator.', null]]);

      // The lease lapses and the limit passes before the helper gets through.
      clock += 60000 + bridgeStore.LEASE_MS + 1000;
      gateway.claimOutbound({ tokenId: bridgeStore.helperTokens.active().tokenId }, 'expiry-pass-nonce-0001');
      assert.equal(atBridge(id)[0], 'dropped');
      assert.deepEqual(await relay.pass(), { ok: true, posted: 0, acked: 0, held: 0 });
      assert.ok(logged().includes('outbound-ack-failed'), 'it is told its lease lapsed, not what became of the item');
      assert.deepEqual(relay.state.entries(), [], 'the helper does not keep trying');
      assert.equal(discord.posts.length, 1);
    });
  });

  describe('the helper process, end to end', () => {
    /**
     * Wait for something to become true, checking between event-loop turns.
     * @param {function(): *} check - Returns a truthy value once it holds.
     * @param {string} what - What is being waited for, for the failure message.
     * @returns {Promise<*>} What `check` returned.
     */
    async function until(check, what) {
      const deadline = Date.now() + 10000;
      for (;;) {
        const value = check();
        if (value) return value;
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }

    it('run relays a message in and its answer out, logs only closed codes, and stops cleanly', async () => {
      const home = path.join(tmpDir, `home-${++seq}`);
      writeConfig(paths(home).config, { baseUrl: origin, ...IDS, pollSeconds: 5 });
      const ws = fakeWebSocket();
      const lines = [];
      const sleeps = [];
      const cleared = [];
      let stop;
      const exit = main(['run'], {
        home, repoDir: path.join(__dirname, '..'), nodePath: process.execPath, uid: 501, pid: process.pid,
        out: () => {}, errLine: (line) => lines.push(line), stdin: null, launchctl: async () => 0,
        onStop: (fn) => { stop = fn; },
        secrets: { readSecret: async (name) => ({ bot: BOT_TOKEN, helper: helperToken }[name]) },
        WebSocket: ws.WebSocket, discordApi: discord.api,
        isAlive: () => false,
        timers: { setTimeout: (resolve, ms) => sleeps.push({ ms, resolve }), clearTimeout: (id) => cleared.push(id) }
      });

      // Discord says hello; the helper identifies; the session is ready.
      const socket = await until(() => ws.sockets[0], 'the Gateway connection');
      assert.equal(socket.url, 'wss://gateway.fake.invalid/?v=10&encoding=json', 'at the address Discord named');
      socket.receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
      assert.equal(socket.sent[0].op, OP.IDENTIFY);
      socket.receive({ op: OP.DISPATCH, t: 'READY', s: 1, d: { session_id: 's', resume_gateway_url: 'wss://resume.fake.invalid', user: { id: BOT_ID } } });

      // The operator writes; a stranger writes too.
      const message = operatorMessage('what is the fleet doing?');
      socket.receive({ op: OP.DISPATCH, t: 'MESSAGE_CREATE', s: 2, d: operatorMessage('let me in', { author: { id: '100000000000000099' } }) });
      socket.receive({ op: OP.DISPATCH, t: 'MESSAGE_CREATE', s: 3, d: message });
      const route = await until(() => bridgeStore.routes.getByExternalId(message.id), 'the route');
      await until(() => discord.reactions.length === 1, 'the reaction');
      assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_routes WHERE author_id = ?').get('100000000000000099').n, 0);

      // The Master answers; the helper's next pass posts it and acknowledges it.
      const res = await fetch(`${origin}/api/bridge/master/routes/${route.routeId}/answer`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-tangleclaw-bridge-credential': masterCredential },
        body: JSON.stringify({ requestId: `req-answer-e2e-${seq}`, expectedVersion: bridgeStore.routes.get(route.routeId).version, text: 'Two sessions are working.' })
      });
      assert.equal(res.status, 200);
      const waiting = await until(() => sleeps.find((s) => s.ms === 5000), 'the helper to finish a pass');
      waiting.resolve();
      await until(() => bridgeStore.routes.get(route.routeId).state === 'closed', 'the route to close');
      assert.deepEqual(discord.posts.map((p) => [p.content, p.replyTo]), [['**Project Master**\nTwo sessions are working.', message.id]]);

      // The first pass wrote a snapshot before the session was ready; the one after says so.
      const snapshot = await until(() => {
        try {
          const read = JSON.parse(fs.readFileSync(paths(home).status, 'utf8'));
          return read.gateway.state === 'ready' ? read : null;
        } catch {
          return null;
        }
      }, 'a status snapshot taken once the Gateway was ready');
      assert.deepEqual([snapshot.pid, snapshot.gateway.state, snapshot.lastPassOk], [process.pid, 'ready', true]);
      assert.equal(fs.readFileSync(paths(home).lock, 'utf8'), `${process.pid}\n`);

      await until(() => sleeps.length === 2, 'the helper to wait for its next pass');
      stop();
      assert.equal(await exit, EXIT.ok);
      assert.deepEqual(cleared, [2], 'the wait in progress is cancelled, so nothing outlives the stop');
      assert.equal(socket.closedWith, 1000);
      assert.equal(fs.existsSync(paths(home).lock), false, 'the lock is given back');

      const records = lines.map((line) => JSON.parse(line));
      for (const record of records) assert.ok(Object.prototype.hasOwnProperty.call(CODES, record.code) && record.code !== 'unknown-code', record.code);
      assert.deepEqual(records.map((r) => r.code).filter((c) => !c.startsWith('gateway')),
        ['helper-start', 'inbound-accepted', 'outbound-posted', 'outbound-acked', 'helper-stop']);
      const everything = lines.join('\n');
      for (const secret of [BOT_TOKEN, helperToken, 'fleet', 'sessions', 'let me in', '100000000000000099']) assert.ok(!everything.includes(secret), secret);
    });
  });
});
