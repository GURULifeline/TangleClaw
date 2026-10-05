'use strict';

// #2031: the helper's Discord Gateway connection, against a WebSocket the
// test scripts by hand and timers it runs itself. It identifies with the
// three intents the helper needs and no others, keeps the heartbeat, resumes
// a dropped session without identifying again, and stops for good on a close
// a retry cannot fix, so a refused token cannot spend the application's daily
// identify budget.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createGateway, resumeAddress, backoffDelay, INTENTS, OP, FATAL_CLOSES, RESUME_CLOSE, DEFAULT_URL } = require('../lib/bridge-helper/discord-gateway');
const { fakeWebSocket } = require('./_fake-discord');

/** A resume address of the shape Discord really gives: a subdomain of discord.gg. */
const RESUME_URL = 'wss://gateway-us-east1-b.discord.gg';
const BOT_TOKEN = `${'B'.repeat(24)}.${'c'.repeat(6)}.${'d'.repeat(27)}`;

let ws;
let timers;
let codes;
let received;

/**
 * Timers the test runs by hand.
 * @returns {object}
 */
function fakeTimers() {
  const pending = new Map();
  let next = 1;
  const add = (kind) => (fn, ms) => { pending.set(next, { kind, fn, ms }); return next++; };
  const remove = (id) => { pending.delete(id); };
  return {
    setTimeout: add('timeout'), setInterval: add('interval'), clearTimeout: remove, clearInterval: remove,
    /** @returns {Array<{kind: string, ms: number}>} What is waiting. */
    waiting: () => [...pending.values()].map(({ kind, ms }) => ({ kind, ms })),
    /**
     * Fire every timer of one kind once.
     * @param {string} kind - `timeout` or `interval`.
     * @returns {void}
     */
    fire(kind) {
      for (const [id, timer] of [...pending]) {
        if (timer.kind !== kind) continue;
        if (kind === 'timeout') pending.delete(id);
        timer.fn();
      }
    }
  };
}

/**
 * Make a gateway over the fakes.
 * @param {object} [over] - Overrides.
 * @returns {object}
 */
function gateway(over = {}) {
  return createGateway({
    token: BOT_TOKEN, WebSocket: ws.WebSocket, timers, random: () => 0.5,
    log: (code, fields) => codes.push([code, fields || {}]),
    onMessageCreate: (d, ctx) => { received.push([d, ctx]); },
    ...over
  });
}

/**
 * Let queued promise callbacks run.
 * @returns {Promise<void>}
 */
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Bring a gateway to READY on its first socket.
 * @param {object} gw - The gateway.
 * @param {string} [resumeUrl] - What READY names as the resume address.
 * @returns {Promise<object>} The socket.
 */
async function ready(gw, resumeUrl = RESUME_URL) {
  gw.start();
  await settle();
  const socket = ws.sockets[ws.sockets.length - 1];
  socket.receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
  socket.receive({ op: OP.DISPATCH, t: 'READY', s: 1, d: { session_id: 'sess-1', resume_gateway_url: resumeUrl, user: { id: '900000000000000009' } } });
  return socket;
}

describe('bridge helper: the Discord Gateway connection (#2031)', () => {
  beforeEach(() => {
    ws = fakeWebSocket();
    timers = fakeTimers();
    codes = [];
    received = [];
  });

  it('identifies with the three intents the helper needs and nothing else, after asking Discord where to connect', async () => {
    assert.equal(INTENTS, (1 << 0) | (1 << 9) | (1 << 15), 'GUILDS, GUILD_MESSAGES and MESSAGE_CONTENT');
    const gw = gateway({ getUrl: async () => 'wss://gateway.fake.invalid' });
    gw.start();
    await settle();
    assert.equal(ws.sockets[0].url, 'wss://gateway.fake.invalid/?v=10&encoding=json');
    assert.deepEqual(ws.sockets[0].sent, [], 'nothing is sent before Discord says hello');
    ws.sockets[0].receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
    const [identify] = ws.sockets[0].sent;
    assert.deepEqual([identify.op, identify.d.token, identify.d.intents], [OP.IDENTIFY, BOT_TOKEN, 33281]);
    // The bot is how the operator sees the bridge from Discord: it says it is online, and nothing more.
    assert.deepEqual(identify.d.presence, { status: 'online', afk: false, since: null, activities: [] });
    assert.deepEqual(Object.keys(identify.d).sort(), ['intents', 'presence', 'properties', 'token']);
    assert.deepEqual(timers.waiting(), [{ kind: 'timeout', ms: 20000 }], 'the first heartbeat is jittered inside the interval');
    assert.ok(!JSON.stringify(codes).includes(BOT_TOKEN));
  });

  it('refuses a discovered address that is not a wss one and falls back to Discord\'s own', async () => {
    for (const bad of ['ws://plain.fake.invalid', 'https://gateway.fake.invalid', 'not a url', null]) {
      ws = fakeWebSocket();
      const gw = gateway({ getUrl: async () => bad });
      gw.start();
      await settle();
      assert.equal(ws.sockets[0].url, 'wss://gateway.discord.gg/?v=10&encoding=json', String(bad));
      gw.stop();
    }
  });

  it('hands each message to the handler with the bot\'s own id, and keeps the heartbeat', async () => {
    const gw = gateway();
    const socket = await ready(gw);
    assert.deepEqual([gw.status().state, gw.status().resumable], ['ready', true]);
    socket.receive({ op: OP.DISPATCH, t: 'MESSAGE_CREATE', s: 2, d: { id: '500000000000000001', content: 'hello' } });
    await settle();
    assert.deepEqual(received, [[{ id: '500000000000000001', content: 'hello' }, { selfId: '900000000000000009' }]]);

    timers.fire('timeout');
    assert.deepEqual(socket.sent.at(-1), { op: OP.HEARTBEAT, d: 2 }, 'a heartbeat carries the last sequence number');
    socket.receive({ op: OP.HEARTBEAT_ACK });
    timers.fire('interval');
    assert.deepEqual(socket.sent.filter((p) => p.op === OP.HEARTBEAT).length, 2);
    socket.receive({ op: OP.HEARTBEAT });
    assert.deepEqual(socket.sent.at(-1), { op: OP.HEARTBEAT, d: 2 }, 'and Discord\'s own request for one is answered at once');
  });

  it('a handler that fails is logged by code and does not end the connection', async () => {
    const gw = gateway({ onMessageCreate: async () => { throw new Error('the operator said: deploy it'); } });
    const socket = await ready(gw);
    socket.receive({ op: OP.DISPATCH, t: 'MESSAGE_CREATE', s: 2, d: { id: '500000000000000002' } });
    await settle();
    assert.deepEqual(codes.at(-1), ['inbound-handler-failed', {}]);
    assert.equal(gw.status().state, 'ready');
  });

  it('resumes a dropped session at the address Discord gave, without identifying again', async () => {
    const gw = gateway();
    const first = await ready(gw);
    first.receive({ op: OP.DISPATCH, t: 'MESSAGE_CREATE', s: 7, d: { id: '500000000000000003' } });
    first.drop(1006);
    assert.equal(gw.status().state, 'reconnecting');
    assert.deepEqual(codes.at(-1), ['gateway-closed', { closeCode: 1006 }]);
    timers.fire('timeout');
    await settle();
    const second = ws.sockets[1];
    assert.equal(second.url, `${RESUME_URL}/?v=10&encoding=json`);
    second.receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
    assert.deepEqual(second.sent, [{ op: OP.RESUME, d: { token: BOT_TOKEN, session_id: 'sess-1', seq: 7 } }]);
    second.receive({ op: OP.DISPATCH, t: 'RESUMED', s: 8, d: {} });
    assert.deepEqual([gw.status().state, gw.status().reconnectAttempts], ['ready', 0]);
  });

  it('a heartbeat Discord never acknowledged closes the connection in a way that keeps the session', async () => {
    const gw = gateway();
    const socket = await ready(gw);
    timers.fire('timeout');
    timers.fire('interval');
    assert.equal(socket.closedWith, RESUME_CLOSE, 'not 1000 or 1001, which would end the session');
    assert.equal(gw.status().state, 'reconnecting');
    assert.equal(gw.status().resumable, true);
  });

  it('stops for good on a close a retry cannot fix', async () => {
    for (const code of FATAL_CLOSES) {
      ws = fakeWebSocket();
      timers = fakeTimers();
      const gw = gateway();
      const socket = await ready(gw);
      socket.drop(code);
      assert.deepEqual([gw.status().state, gw.status().fatalCloseCode], ['fatal', code]);
      assert.deepEqual(codes.at(-1), ['gateway-fatal', { closeCode: code }]);
      assert.deepEqual(timers.waiting(), [], `no reconnect is scheduled after ${code}`);
      gw.start();
      await settle();
      assert.equal(ws.sockets.length, 1, 'and starting it again does not connect');
    }
    assert.ok(FATAL_CLOSES.has(4004) && FATAL_CLOSES.has(4014), 'a refused token and disallowed intents among them');
  });

  describe('where a session may be resumed', () => {
    const REFUSED = [
      ['a host that only starts with Discord\'s', 'wss://discord.gg.example.com'],
      ['a host that only ends with its letters', 'wss://example-discord.gg'],
      ['the bare domain, which is not the Gateway', 'wss://discord.gg'],
      ['a lookalike subdomain of another domain', 'wss://gateway.discord.gg.evil.example'],
      ['a trailing dot', 'wss://gateway.discord.gg.'],
      ['an IPv4 address', 'wss://203.0.113.7'],
      ['an IPv6 address', 'wss://[2001:db8::1]'],
      ['plain ws', 'ws://gateway.discord.gg'],
      ['https', 'https://gateway.discord.gg'],
      ['a user in the address', 'wss://user@gateway.discord.gg'],
      ['a user and password', 'wss://user:pw@gateway.discord.gg'],
      ['Discord\'s host as the user of another', 'wss://gateway.discord.gg@evil.example'],
      ['a port that is not 443', 'wss://gateway.discord.gg:8443'],
      ['port 80', 'wss://gateway.discord.gg:80'],
      ['an upper-case host', 'wss://Gateway.Discord.GG'],
      ['an empty label', 'wss://a..discord.gg'],
      ['whitespace', 'wss://gateway.discord.gg /']
    ];

    it('accepts the Gateway and its subdomains, with no port or 443, and uses nothing of the path Discord sent', () => {
      assert.equal(resumeAddress('wss://gateway.discord.gg'), 'wss://gateway.discord.gg');
      assert.equal(resumeAddress('wss://gateway.discord.gg/'), 'wss://gateway.discord.gg');
      assert.equal(resumeAddress('wss://gateway.discord.gg:443'), 'wss://gateway.discord.gg');
      assert.equal(resumeAddress('wss://gateway-us-east1-b.discord.gg'), 'wss://gateway-us-east1-b.discord.gg');
      assert.equal(resumeAddress('wss://a.b.discord.gg/?v=9&encoding=etf#x'), 'wss://a.b.discord.gg');
      for (const [why, address] of REFUSED) assert.equal(resumeAddress(address), null, why);
      for (const notAString of [42, null, undefined, {}, ['wss://gateway.discord.gg']]) assert.equal(resumeAddress(notAString), null);
    });

    for (const [why, address] of REFUSED) {
      it(`refuses ${why}: nothing is opened to it, no token and no resume is sent, and the helper identifies afresh at the default`, async () => {
        const gw = gateway();
        const first = await ready(gw, address);
        first.receive({ op: OP.DISPATCH, t: 'MESSAGE_CREATE', s: 7, d: { id: '500000000000000003' } });
        first.drop(1006);
        timers.fire('timeout');
        await settle();
        assert.equal(ws.sockets.length, 2);
        const second = ws.sockets[1];
        assert.equal(second.url, DEFAULT_URL, 'the default Gateway, and no socket to the address READY named');
        assert.ok(ws.sockets.every((sock) => sock.url === DEFAULT_URL));
        assert.deepEqual(codes.at(-1), ['gateway-resume-refused', {}]);
        assert.deepEqual(second.sent, [], 'nothing is sent before Discord says hello');
        second.receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
        assert.equal(second.sent.length, 1);
        assert.equal(second.sent[0].op, OP.IDENTIFY, 'the session was dropped: this is a new one');
        assert.ok(!second.sent.some((p) => p.op === OP.RESUME), 'no resume, anywhere');
        assert.ok(!JSON.stringify(second.sent).includes('sess-1'), 'and the old session id goes nowhere');
        // Dropped for good: a later reconnect has no session to resume either.
        second.drop(1006);
        timers.fire('timeout');
        await settle();
        ws.sockets[2].receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
        assert.equal(ws.sockets[2].sent[0].op, OP.IDENTIFY);
      });
    }

    it('still resumes at the default address when READY named none', async () => {
      const gw = gateway();
      const first = await ready(gw, null);
      first.drop(1006);
      timers.fire('timeout');
      await settle();
      ws.sockets[1].receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
      assert.equal(ws.sockets[1].url, DEFAULT_URL);
      assert.equal(ws.sockets[1].sent[0].op, OP.RESUME);
    });
  });

  it('identifies afresh when Discord says the session cannot be resumed', async () => {
    const gw = gateway();
    const first = await ready(gw);
    first.receive({ op: OP.INVALID_SESSION, d: false });
    assert.equal(gw.status().resumable, false);
    assert.deepEqual(timers.waiting().map((t) => t.kind), ['timeout'], 'on the reconnect backoff, with the heartbeat stopped');
    assert.ok(timers.waiting()[0].ms >= 1000, 'never sooner than a second');
    timers.fire('timeout');
    await settle();
    ws.sockets[1].receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
    assert.equal(ws.sockets[1].sent[0].op, OP.IDENTIFY);
  });

  it('backs off between reconnects, up to a ceiling, and stops when told to', async () => {
    assert.deepEqual([0, 1, 2, 10, 50].map((n) => backoffDelay(n, 1000, 60000, () => 0)), [500, 1000, 2000, 30000, 30000]);
    assert.deepEqual([0, 10].map((n) => backoffDelay(n, 1000, 60000, () => 0.999999)).map(Math.round), [1000, 60000]);

    const gw = gateway();
    const socket = await ready(gw);
    gw.stop();
    assert.equal(socket.closedWith, 1000);
    assert.deepEqual(timers.waiting(), []);
    socket.drop(1000);
    assert.deepEqual(timers.waiting(), [], 'a stopped gateway does not reconnect');
    assert.equal(gw.status().state, 'stopped');
  });
});
