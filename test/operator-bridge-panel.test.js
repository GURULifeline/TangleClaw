'use strict';

// #2031 (ADR 0023): the Operator Bridge panel, run rather than read.
//
// The REAL public/operator-bridge-panel.js is lifted into a sandbox and driven
// two ways: against a scripted `api()`, to pin what it sends and shows, and
// against the real operator handlers on a real store, to pin that the two
// agree. What is held here: only the signed-in operator learns anything of the
// bridge's policy; the helper token is shown once and kept nowhere; every
// control that widens what the bridge does asks first; a write whose answer
// was lost is repeated under its own request id; and rolling back is disable
// first.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { setLevel } = require('../lib/logger');
const { makeDocument, withIdParsingInnerHTML } = require('./_mini-dom');

setLevel('error');

const store = require('../lib/store');
const bridgeStore = require('../lib/bridge-store');
const bridgeApi = require('../lib/bridge-api');
const gateway = require('../lib/bridge-gateway');
const { install } = require('./_bridge-hub');

const PUBLIC = path.join(__dirname, '..', 'public');
const SRC = fs.readFileSync(path.join(PUBLIC, 'operator-bridge-panel.js'), 'utf8');

/** A signed-in operator, as `server.js` annotates the request. */
const SIGNED_IN = { tcSession: { username: 'rosie' }, tcGateState: 'guarding', headers: {} };
/** A dashboard-shaped request on an open gate: the operator in appearance only. */
const AMBIENT = { tcGateActive: false, tcGateState: 'open', headers: { 'sec-fetch-site': 'same-origin' } };
const IDS = { authorId: '100000000000000001', spaceId: '200000000000000002', channelId: '300000000000000003' };

/**
 * Lift the panel script into a sandbox.
 * @param {object} [globals] - Extra globals the script may see.
 * @returns {object} The sandbox, with what the script published.
 */
function lift(globals = {}) {
  const sandbox = { console: { log() {}, error() {}, warn() {} }, ...globals };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox);
  return sandbox;
}

/**
 * A scripted `api()` and `apiMutate()` pair, as the page makes them: a call
 * returns the body, or null with `lastError` and `lastErrorCode` set.
 * @param {function(string, string, object): ({status: number, body: object}|null)} answer - What the server says; null for no answer at all.
 * @returns {{api: Function, apiMutate: Function, calls: Array}}
 */
function scripted(answer) {
  const calls = [];
  const run = async (url, method, body) => {
    calls.push({ url, method, body });
    const res = await answer(url, method, body);
    if (!res) {
      api.lastError = 'Connection lost.';
      api.lastErrorCode = null;
      return null;
    }
    if (res.status >= 400) {
      api.lastError = res.body.error || 'refused';
      api.lastErrorCode = res.body.code || null;
      return null;
    }
    api.lastError = null;
    api.lastErrorCode = null;
    return res.body;
  };
  const api = (url) => run(url, 'GET');
  api.lastError = null;
  api.lastErrorCode = null;
  return { api, apiMutate: (url, method, body) => run(url, method, body), calls };
}

/**
 * A page's `api()` pair wired straight to the real operator handlers.
 * @param {object} req - The HTTP request as `server.js` would have annotated it.
 * @returns {{api: Function, apiMutate: Function, calls: Array}}
 */
function real(req) {
  return scripted((url, method, body) => {
    const entry = bridgeApi.ROUTES.find((r) => r.method === method
      && new RegExp(`^${r.path.replace(/:[A-Za-z]+/g, '([^/]+)')}$`).test(url));
    assert.ok(entry, `the panel called a route that is declared: ${method} ${url}`);
    assert.equal(entry.principal, 'operator', `and it is an operator route: ${method} ${url}`);
    const names = [...entry.path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]);
    const values = new RegExp(`^${entry.path.replace(/:[A-Za-z]+/g, '([^/]+)')}$`).exec(url).slice(1);
    const params = Object.fromEntries(names.map((n, i) => [n, values[i]]));
    return bridgeApi.handle(entry, { req, headers: req.headers, params, body });
  });
}

/**
 * A controller over a given `api()` pair.
 * @param {{api: Function, apiMutate: Function}} wires - The pair.
 * @param {object} [over] - `confirm`, `clipboard`, `randomId`.
 * @returns {{panel: object, asked: string[], copied: string[]}}
 */
function controller(wires, over = {}) {
  const asked = [];
  const copied = [];
  let n = 0;
  const sandbox = lift();
  const panel = sandbox.tcCreateOperatorBridgePanel({
    api: wires.api, apiMutate: wires.apiMutate,
    confirm: (text) => { asked.push(text); return over.confirm ? over.confirm(text) : true; },
    randomId: () => `rand${String(++n).padStart(4, '0')}abcdef`,
    clipboard: over.clipboard === undefined ? { writeText: async (t) => { copied.push(t); } } : over.clipboard
  });
  return { panel, asked, copied, sandbox };
}

describe('the Operator Bridge panel (#2031)', () => {
  let tmpDir;
  let realDeps;
  let hub;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bridge-panel-'));
    store._setBasePath(tmpDir);
    store.init();
    realDeps = { ...gateway._deps };
  });

  after(() => {
    if (hub) hub.restore();
    Object.assign(gateway._deps, realDeps);
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // The Hub is a stand-in: enabling the bridge starts the gateway's listener.
    if (hub) hub.restore();
    hub = install();
    Object.assign(gateway._deps, {
      master: () => ({
        masterLiveness: () => ({ live: true, answered: true }),
        ensureMasterSession: () => ({ created: false }),
        getMasterMedusaStatus: () => ({ state: 'listening', workspaceId: 'master-ws' }),
        masterListenerEnabled: () => true
      })
    });
    gateway._reset();
    const db = store.getDb();
    if (bridgeStore.circuit.open()) {
      bridgeStore.applyCircuitReset({ requestId: `req-clean-${Date.now()}-${Math.random()}`, decision: 'withdraw', actor: 'operator', proof: 'verified-session' });
    }
    db.exec('DELETE FROM bridge_outbound');
    db.exec('DELETE FROM bridge_settings');
    bridgeStore.helperTokens.revoke();
  });

  describe('who it answers', () => {
    it('shows a caller who is not the signed-in operator nothing of the bridge, and offers no control', async () => {
      const signedIn = controller(real(SIGNED_IN));
      await signedIn.panel.load();
      await signedIn.panel.act('allowlist', IDS);
      assert.match(signedIn.panel.html(), new RegExp(IDS.channelId), 'precondition: the operator sees the allowlist');

      const { panel } = controller(real(AMBIENT));
      await panel.load();
      const drawn = panel.html();
      assert.equal(panel.state.status, null);
      assert.deepEqual(panel.state.refused.code, 'OPERATOR_SESSION_REQUIRED');
      assert.match(drawn, /Sign in to see and change it/);
      for (const secret of Object.values(IDS)) assert.ok(!drawn.includes(secret), 'no id of the allowlist');
      assert.deepEqual([...drawn.matchAll(/data-bridge-action="([^"]+)"/g)].map((m) => m[1]), ['refresh'], 'and no control but trying again');

      // Pressing a control anyway changes nothing: the server refuses each one.
      const before = JSON.stringify(bridgeStore.settings.get('enabled'));
      for (const action of ['enable', 'disable', 'mint-token', 'primer-on', 'primer-off']) assert.equal(await panel.act(action), 'failed', action);
      assert.equal(await panel.act('allowlist', IDS), 'failed');
      assert.equal(JSON.stringify(bridgeStore.settings.get('enabled')), before);
      assert.equal(panel.state.token, null);
      assert.equal(bridgeStore.helperTokens.active(), null, 'and no token was made for it');
    });

    it('calls the operator routes and no other', async () => {
      const wires = real(SIGNED_IN);
      const { panel } = controller(wires);
      await panel.load();
      await panel.act('allowlist', IDS);
      await panel.act('mint-token');
      await panel.act('enable');
      await panel.act('primer-on');
      await panel.act('primer-off');
      await panel.act('disable');
      await panel.act('revoke-token');
      assert.ok(wires.calls.length >= 14);
      assert.ok(wires.calls.every((c) => c.url.startsWith('/api/bridge/operator/')), 'every call is under the operator prefix');
      assert.ok(wires.calls.every((c) => !c.url.includes('?')), 'and nothing rides in a query string');
    });
  });

  describe('the helper token', () => {
    it('is shown once, copied only when asked, sent nowhere, kept nowhere, and gone when dismissed', async () => {
      const logged = [];
      const stored = [];
      const wires = real(SIGNED_IN);
      const asked = [];
      const copied = [];
      const storage = { setItem: (...a) => stored.push(a), getItem: () => null };
      const sandbox = lift({
        console: { log: (...a) => logged.push(a), error: (...a) => logged.push(a), warn: (...a) => logged.push(a) },
        localStorage: storage, sessionStorage: storage
      });
      const panel = sandbox.tcCreateOperatorBridgePanel({
        ...wires, confirm: (t) => { asked.push(t); return true; }, randomId: () => 'r'.repeat(16),
        clipboard: { writeText: async (t) => { copied.push(t); } }
      });
      await panel.load();
      assert.equal(await panel.act('mint-token'), 'done');
      const token = panel.state.token;
      assert.match(token, /^bht_/);
      assert.equal(asked.length, 1, 'creating it was asked');
      assert.deepEqual(copied, [], 'nothing is copied until the operator says so');

      const shown = panel.html();
      assert.equal(shown.split(token).length - 1, 1, 'on screen in exactly one place');
      assert.match(shown, /bin\/tc-bridge-helper set-secret helper/, 'with where it goes: the helper\'s own prompt');
      assert.match(shown, /Do not put it in a file, a message or a command line/);

      // It stays out of everything but that one place.
      assert.ok(!JSON.stringify(panel.state.notice).includes(token));
      assert.ok(!JSON.stringify(wires.calls.map((c) => [c.url, c.body])).includes(token), 'no request carries it back, in a URL or a body');
      assert.deepEqual([logged.filter((l) => JSON.stringify(l).includes(token)), stored], [[], []], 'not logged and not stored');
      const status = await wires.api('/api/bridge/operator/status');
      assert.ok(!JSON.stringify(status).includes(token), 'the server does not give it a second time');
      assert.deepEqual(Object.keys(status.helperToken).sort(), ['createdAt', 'tokenId']);

      // It survives a refresh while it is on screen, so the operator is not rushed.
      await panel.act('refresh');
      assert.ok(panel.html().includes(token));
      assert.equal(await panel.act('copy-token'), 'done');
      assert.deepEqual(copied, [token]);
      assert.ok(!panel.state.notice.text.includes(token));

      // Dismissed, it is gone from the page for good.
      assert.equal(await panel.act('dismiss-token'), 'done');
      assert.equal(panel.state.token, null);
      assert.ok(!panel.html().includes(token));
      assert.equal(await panel.act('copy-token'), 'failed', 'there is nothing left to copy');
      assert.deepEqual(copied, [token]);
      // And the token it showed is the one the bridge now accepts.
      assert.ok(gateway.verifyHelperToken(token));
    });

    it('says so when the browser cannot copy, and never fails silently', async () => {
      const none = controller(real(SIGNED_IN), { clipboard: null });
      await none.panel.load();
      await none.panel.act('mint-token');
      assert.equal(await none.panel.act('copy-token'), 'failed');
      assert.match(none.panel.state.notice.text, /copy it by hand/);
      const broken = controller(real(SIGNED_IN), { clipboard: { writeText: async () => { throw new Error('denied'); } } });
      await broken.panel.load();
      await broken.panel.act('mint-token');
      assert.equal(await broken.panel.act('copy-token'), 'failed');
      assert.match(broken.panel.state.notice.text, /did not work/);
      assert.ok(broken.panel.html().includes(broken.panel.state.token), 'the token is still there to copy by hand');
    });

    it('replacing a token says what it costs, and a refused or lost create shows no token', async () => {
      const first = controller(real(SIGNED_IN));
      await first.panel.load();
      await first.panel.act('mint-token');
      assert.match(first.asked[0], /Create the helper token\? Its value is shown once\./);
      await first.panel.act('mint-token');
      assert.match(first.asked[1], /The current one stops working at once/);

      const lost = controller(scripted((url, method) => (method === 'GET' ? { status: 200, body: { enabled: false } } : null)));
      await lost.panel.load();
      assert.equal(await lost.panel.act('mint-token'), 'failed');
      assert.equal(lost.panel.state.token, null);
      assert.ok(!/data-bridge-token-shown/.test(lost.panel.html()));
    });
  });

  describe('asking first', () => {
    it('asks before every control that widens or destroys, and sends nothing when the answer is no', async () => {
      const wires = real(SIGNED_IN);
      const set = controller(wires);
      await set.panel.load();
      await set.panel.act('allowlist', IDS);
      await set.panel.act('mint-token');
      const item = bridgeStore.outbound.enqueue({ idemKey: 'notify:operator-needed:p1', kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw', text: 'x', digest: bridgeStore.digest('x') }).outboundId;

      const { panel, asked } = controller(wires, { confirm: () => false });
      await panel.load();
      const writes = () => wires.calls.filter((c) => c.method !== 'GET').length;
      const before = writes();
      const cases = [
        ['enable', {}, /^Enable the operator bridge\?/],
        ['allowlist', IDS, new RegExp(`exactly this author \\(${IDS.authorId}\\), server \\(${IDS.spaceId}\\) and channel \\(${IDS.channelId}\\)`)],
        ['mint-token', {}, /stops working at once/],
        ['revoke-token', {}, /^Revoke the helper token\?/],
        ['primer-on', {}, /^Tell every session of `tc candidate`/],
        ['circuit-reset', { episodeId: 1, decision: 'withdraw' }, /WITHDRAW what it set aside\? Those items will never be posted\./],
        ['circuit-reset', { episodeId: 1, decision: 'requeue' }, /put what it set aside back in the queue/],
        ['requeue', { outboundId: item }, new RegExp(`^Put item ${item} back`)],
        ['withdraw', { outboundId: item }, new RegExp(`^Withdraw item ${item}\\? It will never be posted\\. If it is a route's answer, that route is closed\\.`)]
      ];
      for (const [action, fields, question] of cases) {
        assert.equal(await panel.act(action, fields), 'declined', action);
        assert.match(asked[asked.length - 1], question, action);
      }
      assert.equal(asked.length, cases.length);
      assert.equal(writes(), before, 'not one write was sent');

      // What makes things safer is not slowed down by a question.
      const quick = controller(wires, { confirm: () => { throw new Error('asked'); } });
      await quick.panel.load();
      assert.equal(await quick.panel.act('disable'), 'done');
      assert.equal(await quick.panel.act('primer-off'), 'done');
      assert.deepEqual(quick.asked, []);
    });

    it('refuses an allowlist that is not three Discord ids before asking or sending anything', async () => {
      const wires = real(SIGNED_IN);
      const { panel, asked } = controller(wires);
      await panel.load();
      const before = wires.calls.length;
      for (const bad of [{ ...IDS, authorId: '' }, { ...IDS, spaceId: 'my-server' }, { ...IDS, channelId: '12' }, { authorId: IDS.authorId }]) {
        assert.equal(await panel.act('allowlist', bad), 'blocked');
      }
      assert.deepEqual([asked.length, wires.calls.length], [0, before]);
      assert.match(panel.state.notice.text, /must be the number Discord shows for it/);
      assert.equal(gateway.allowlist(), null);
      assert.equal(await panel.act('allowlist', IDS), 'done');
      assert.deepEqual(gateway.allowlist(), IDS);
      assert.equal(await panel.act('nonsense'), 'unknown');
    });
  });

  describe('truthful status', () => {
    it('draws what the server says, escaped, and says what is missing', async () => {
      const { panel } = controller(real(SIGNED_IN));
      await panel.load();
      let drawn = panel.html();
      assert.match(drawn, /<strong>disabled<\/strong>/);
      assert.match(drawn, /Allowlist[\s\S]*<strong>not set<\/strong>/);
      assert.match(drawn, /Helper token[\s\S]*<strong>none<\/strong>/);
      assert.match(drawn, /Nothing is set aside\./);
      assert.match(drawn, /data-bridge-action="primer-on" disabled/, 'the primer cannot be switched on while the bridge is off');
      // Enabling is refused by the server until the allowlist and a token exist, and the panel says why.
      assert.equal(await panel.act('enable'), 'failed');
      assert.match(panel.state.notice.text, /Not done: Set the allowlist before enabling the bridge\./);
      assert.match(panel.html(), /ob-failed/);

      await panel.act('allowlist', IDS);
      await panel.act('mint-token');
      await panel.act('dismiss-token');
      assert.equal(await panel.act('enable'), 'done');
      drawn = panel.html();
      assert.match(drawn, /<strong>enabled<\/strong>/);
      assert.match(drawn, /data-bridge-action="disable"/);
      assert.match(drawn, /listener listening/);
      assert.match(drawn, new RegExp(`author ${IDS.authorId}, server ${IDS.spaceId}, channel ${IDS.channelId}`));

      // Whatever the server says is text, never markup.
      const hostile = controller(scripted(() => ({
        status: 200,
        body: {
          enabled: true, allowlist: { authorId: '<img src=x onerror=1>', spaceId: '2', channelId: '3' }, helperToken: null, openRoutes: 0,
          openRoutesByState: { '<b>x</b>': 1 }, waitingForHelper: 0, setAside: 1, masterListener: { enabled: false },
          configurationCircuit: { episodeId: 4, openedAt: 't', reason: '"><script>' },
          setAsideItems: [{ outboundId: 9, kind: 'reply', notifyType: null, blockCode: '<i>', attempts: 1, partsPosted: 0 }],
          candidatesPrimed: true, candidatePrimerOmitted: { projectId: 91, length: 2835, cap: 2820, at: 'then' }, routesMasterNotTold: 2
        }
      })));
      await hostile.panel.load();
      const unsafe = hostile.panel.html();
      assert.ok(!/<img|<script|<b>x|<i>/.test(unsafe), 'nothing from the server becomes an element');
      assert.match(unsafe, /&lt;img src=x onerror=1&gt;/);
      assert.match(unsafe, /listener <strong>off<\/strong>; <strong>2 route\(s\) it has not been told of<\/strong>/);
      assert.match(unsafe, /a session of project 91 was not told<\/strong> \(2835 characters against a cap of 2820, at then\)/);
      assert.match(unsafe, /<strong>OPEN<\/strong>, episode 4 since t/);
      assert.match(unsafe, /data-bridge-action="circuit-reset" data-bridge-episode="4" data-bridge-decision="requeue"/);
      assert.match(unsafe, /data-bridge-action="circuit-reset" data-bridge-episode="4" data-bridge-decision="withdraw"/);
      assert.match(unsafe, /data-bridge-item="9"[\s\S]*data-bridge-action="requeue" data-bridge-item="9"[\s\S]*data-bridge-action="withdraw" data-bridge-item="9"/);
    });

    it('says when the status cannot be read, without pretending the bridge is off', async () => {
      const down = controller(scripted(() => null));
      await down.panel.load();
      assert.match(down.panel.html(), /Could not read the operator bridge: Connection lost\./);
      assert.ok(!/disabled|enabled/.test(down.panel.html()));
    });
  });

  describe('a write that must not happen twice', () => {
    /**
     * Set the bridge up and set one item aside for a reason of its own.
     * @returns {Promise<number>} The item's id.
     */
    async function oneSetAside() {
      const { panel } = controller(real(SIGNED_IN));
      await panel.load();
      await panel.act('allowlist', IDS);
      await panel.act('mint-token');
      const token = panel.state.token;
      await panel.act('enable');
      const id = bridgeStore.outbound.enqueue({ idemKey: `notify:operator-needed:${Date.now()}-${Math.random()}`, kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw', text: 'held', digest: bridgeStore.digest('held') }).outboundId;
      const tokenId = gateway.verifyHelperToken(token).tokenId;
      const claimed = gateway.claimOutbound({ tokenId }, `n${String(id).padStart(20, '0')}`, { limit: 10 }).body.items.find((i) => i.outboundId === id);
      assert.equal(gateway.reportFailure(id, { leaseId: claimed.leaseId, tokenId, reason: 'rejected-by-chat' }).body.state, 'blocked');
      return id;
    }

    it('is sent again under the same request id when its answer was lost, and the server takes it once', async () => {
      const id = await oneSetAside();
      const wires = real(SIGNED_IN);
      const through = wires.apiMutate;
      let lose = 1;
      // The request reaches the server and is applied; its answer does not come back.
      const lossy = {
        api: wires.api,
        apiMutate: async (url, method, body) => {
          const answer = await through(url, method, body);
          if (lose > 0 && /requeue$/.test(url)) {
            lose -= 1;
            wires.api.lastError = 'Connection lost.';
            wires.api.lastErrorCode = null;
            return null;
          }
          return answer;
        }
      };
      const { panel } = controller(lossy);
      await panel.load();
      assert.match(panel.html(), new RegExp(`item ${id}: operator-needed, rejected-by-chat, handed over 1 time\\(s\\), 0 part\\(s\\) posted`));

      assert.equal(await panel.act('requeue', { outboundId: id }), 'failed');
      assert.match(panel.state.notice.text, /Press it again to retry the same request\./);
      assert.equal(bridgeStore.outbound.get(id).state, 'ready', 'the server did apply it');
      assert.equal(await panel.act('requeue', { outboundId: id }), 'done');
      const sent = wires.calls.filter((c) => /requeue$/.test(c.url)).map((c) => c.body.requestId);
      assert.equal(sent.length, 2);
      assert.equal(sent[0], sent[1], 'the retry carried the id of the request it repeats');
      assert.match(sent[0], /^op-rand0001abcdef$/);
      assert.equal(store.getDb().prepare("SELECT COUNT(*) AS n FROM bridge_audit WHERE op = 'outbound-requeue' AND outcome = 'applied'").get().n, 1, 'applied once');

      // Once the server has answered, the next press is a new request.
      const again = await oneSetAside();
      await panel.load();
      assert.equal(await panel.act('withdraw', { outboundId: again }), 'done');
      assert.equal(await panel.act('withdraw', { outboundId: again }), 'failed', 'already withdrawn: the server says so');
      const withdraws = wires.calls.filter((c) => /withdraw$/.test(c.url)).map((c) => c.body.requestId);
      assert.notEqual(withdraws[0], withdraws[1], 'a refusal settled the first, so the second is its own request');
      assert.match(panel.state.notice.text, /^Not done: /);
      assert.ok(!/retry the same request/.test(panel.state.notice.text));
    });

    it('resets the circuit only with a stated decision, once', async () => {
      await oneSetAside();
      const wires = real(SIGNED_IN);
      const token = bridgeStore.helperTokens.active().tokenId;
      const id = bridgeStore.outbound.enqueue({ idemKey: `notify:operator-needed:c-${Date.now()}`, kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw', text: 'caught', digest: bridgeStore.digest('caught') }).outboundId;
      const claimed = gateway.claimOutbound({ tokenId: token }, `c${String(id).padStart(20, '0')}`, { limit: 10 }).body.items.find((i) => i.outboundId === id);
      const episode = gateway.reportFailure(id, { leaseId: claimed.leaseId, tokenId: token, reason: 'chat-permission-denied' }).body.circuit.episodeId;

      const { panel, asked } = controller(wires);
      await panel.load();
      assert.match(panel.html(), new RegExp(`<strong>OPEN</strong>, episode ${episode} since .* \\(chat-permission-denied\\)`));
      assert.equal(await panel.act('circuit-reset', { episodeId: episode }), 'blocked', 'no decision, no reset');
      assert.equal(await panel.act('circuit-reset', { episodeId: episode, decision: 'ignore' }), 'blocked');
      assert.deepEqual(asked, []);
      assert.ok(bridgeStore.circuit.open());

      assert.equal(await panel.act('circuit-reset', { episodeId: episode, decision: 'requeue' }), 'done');
      assert.equal(bridgeStore.circuit.open(), null);
      assert.equal(bridgeStore.outbound.get(id).state, 'ready');
      assert.match(panel.html(), /Configuration circuit[\s\S]*closed/);
      const body = wires.calls.find((c) => /circuit\/reset$/.test(c.url)).body;
      assert.deepEqual([body.decision, /^op-/.test(body.requestId)], ['requeue', true]);
      assert.equal(await panel.act('circuit-reset', { episodeId: episode, decision: 'requeue' }), 'failed', 'there is no open episode to reset twice');
    });
  });

  describe('rolling back', () => {
    it('is disable first: the token cannot be revoked from the panel while the bridge is enabled', async () => {
      const wires = real(SIGNED_IN);
      const { panel, asked } = controller(wires);
      await panel.load();
      await panel.act('allowlist', IDS);
      await panel.act('mint-token');
      const token = panel.state.token;
      await panel.act('dismiss-token');
      await panel.act('enable');
      await panel.act('primer-on');
      assert.equal(bridgeApi.candidatesPrimed(), true);
      asked.length = 0;

      assert.match(panel.html(), /data-bridge-action="revoke-token" disabled/);
      assert.match(panel.html(), /To revoke the token, disable the bridge first\./);
      const before = wires.calls.length;
      assert.equal(await panel.act('revoke-token'), 'blocked');
      assert.deepEqual([asked.length, wires.calls.length], [0, before], 'nothing was asked or sent');
      assert.match(panel.state.notice.text, /Disable the bridge first, then revoke the token\./);
      assert.ok(gateway.verifyHelperToken(token));

      // The rollback, in the runbook's order: disable, primer off, revoke.
      assert.equal(await panel.act('disable'), 'done');
      assert.equal(bridgeStore.settings.isEnabled(), false);
      assert.match(panel.html(), /set on, and <strong>not in effect while the bridge is disabled<\/strong>/);
      assert.match(panel.html(), /data-bridge-action="primer-off"/, 'the primer can still be switched off with the bridge disabled');
      assert.equal(await panel.act('primer-off'), 'done');
      assert.equal(bridgeStore.settings.get('candidates.primed'), 'false');
      assert.match(panel.html(), /data-bridge-action="primer-on" disabled/);
      assert.ok(!/data-bridge-action="revoke-token" disabled/.test(panel.html()));
      assert.equal(await panel.act('revoke-token'), 'done');
      assert.equal(gateway.verifyHelperToken(token), null);
      assert.equal(bridgeStore.helperTokens.active(), null);
      // Enabled again later, nothing is primed until the operator says so again.
      await panel.act('mint-token');
      await panel.act('enable');
      assert.equal(bridgeApi.candidatesPrimed(), false);

      const audited = store.getDb().prepare("SELECT op, proof, detail_json FROM bridge_audit WHERE actor = 'operator' ORDER BY audit_seq DESC LIMIT 5").all();
      assert.ok(audited.every((r) => r.proof === 'verified-session' && JSON.parse(r.detail_json).user === 'rosie'), 'each on the record with who did it');
      assert.ok(!JSON.stringify(audited).includes(token), 'and the record holds no token');
    });
  });

  describe('on the page', () => {
    it('mounts into settings, reads the allowlist from its inputs, and acts on the control that was pressed', async () => {
      const { doc, ids } = makeDocument(['gsOperatorBridgeSection']);
      const container = withIdParsingInnerHTML(ids.gsOperatorBridgeSection, doc);
      container.ownerDocument = doc;
      let onClick = null;
      container.addEventListener = (type, fn) => { if (type === 'click') onClick = fn; };
      const asked = [];
      const sandbox = lift({
        document: doc, confirm: (t) => { asked.push(t); return true; },
        crypto: { getRandomValues: (bytes) => bytes.fill(171) }
      });
      const wires = real(SIGNED_IN);
      const panel = await sandbox.tcMountOperatorBridge(container, wires);
      assert.match(container.innerHTML, /<strong>disabled<\/strong>/);
      assert.equal(container.dataset.bridgeBound, '1');

      /**
       * Press a control.
       * @param {object} dataset - The pressed element's data.
       * @param {boolean} [disabled] - Whether it is off.
       * @returns {Promise<void>}
       */
      const press = (dataset, disabled = false) => onClick({ target: { dataset, disabled } });
      doc.getElementById('obAuthorId').value = ` ${IDS.authorId} `;
      doc.getElementById('obSpaceId').value = IDS.spaceId;
      doc.getElementById('obChannelId').value = IDS.channelId;
      await press({ bridgeAction: 'allowlist' });
      assert.deepEqual(gateway.allowlist(), IDS, 'the three inputs, trimmed');
      assert.match(container.innerHTML, new RegExp(`author ${IDS.authorId}`));

      await press({ bridgeAction: 'mint-token' });
      assert.ok(container.innerHTML.includes(panel.state.token));
      assert.ok(doc.getElementById('obTokenValue'), 'the token has its own element to select from');
      await press({ bridgeAction: 'enable' });
      assert.equal(bridgeStore.settings.isEnabled(), true);

      // A control that is switched off does nothing when pressed, and a press on anything else is ignored.
      const before = wires.calls.length;
      await press({ bridgeAction: 'revoke-token' }, true);
      await press({});
      await onClick({ target: null });
      assert.equal(wires.calls.length, before);

      // A held item's own button carries its id; the request id comes from the browser's random source.
      const id = bridgeStore.outbound.enqueue({ idemKey: `notify:operator-needed:m-${Date.now()}`, kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw', text: 'm', digest: bridgeStore.digest('m') }).outboundId;
      const tokenId = bridgeStore.helperTokens.active().tokenId;
      const claimed = gateway.claimOutbound({ tokenId }, `m${String(id).padStart(20, '0')}`, { limit: 10 }).body.items.find((i) => i.outboundId === id);
      gateway.reportFailure(id, { leaseId: claimed.leaseId, tokenId, reason: 'rejected-by-chat' });
      await press({ bridgeAction: 'refresh' });
      assert.match(container.innerHTML, new RegExp(`data-bridge-action="withdraw" data-bridge-item="${id}"`));
      await press({ bridgeAction: 'withdraw', bridgeItem: String(id) });
      assert.equal(bridgeStore.outbound.get(id).state, 'dropped');
      assert.equal(wires.calls.find((c) => /withdraw$/.test(c.url)).body.requestId, `op-${'ab'.repeat(12)}`);

      // Closing settings hides the dialog and does not remove it: a token on screen goes with it.
      await press({ bridgeAction: 'mint-token' });
      const shown = panel.state.token;
      assert.ok(shown && container.innerHTML.includes(shown));
      sandbox.tcForgetOperatorBridge(container);
      assert.deepEqual([container.innerHTML, panel.state.token, panel.state.notice], ['', null, null]);
      sandbox.tcForgetOperatorBridge(null);

      // Mounting again binds nothing twice; no container, no panel.
      let bound = 0;
      container.addEventListener = () => { bound += 1; };
      await sandbox.tcMountOperatorBridge(container, wires);
      assert.equal(bound, 0);
      assert.equal(await sandbox.tcMountOperatorBridge(null, wires), null);
    });

    it('is loaded by the dashboard, mounted by settings, and kept fresh by the service worker', () => {
      const index = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
      const ui = fs.readFileSync(path.join(PUBLIC, 'ui.js'), 'utf8');
      const sw = fs.readFileSync(path.join(PUBLIC, 'sw.js'), 'utf8');
      assert.ok(index.indexOf('<script src="/operator-bridge-panel.js"></script>') > -1);
      assert.ok(index.indexOf('/operator-bridge-panel.js') < index.indexOf('<script src="/ui.js'), 'before the script that mounts it');
      assert.match(ui, /id="gsOperatorBridgeSection"/);
      assert.match(ui, /window\.tcMountOperatorBridge\(document\.getElementById\('gsOperatorBridgeSection'\), \{ api, apiMutate \}\)/);
      assert.equal(sw.split("'/operator-bridge-panel.js'").length - 1, 2, 'precached, and fetched network-first');
      // Closing settings clears the panel: run the real close against a page that has one.
      const start = ui.indexOf('function closeGlobalSettings() {');
      const close = ui.slice(start, ui.indexOf('\n}\n', start) + 3);
      const cleared = [];
      const page = {
        document: { getElementById: (id) => (id === 'globalSettingsModal' ? { classList: { remove() {} } } : { id }) },
        tcForgetOperatorBridge: (el) => cleared.push(el.id)
      };
      page.window = page;
      vm.createContext(page);
      vm.runInContext(`${close}\ncloseGlobalSettings();`, page);
      assert.deepEqual(cleared, ['gsOperatorBridgeSection']);
      // The script itself reaches for no storage and builds no URL from a token.
      assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|location\.|history\.|console\./.test(SRC));
    });
  });
});
