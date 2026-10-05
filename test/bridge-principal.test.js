'use strict';

// #2031 (ADR 0023 Decisions 5 and 14): the Master's bridge principal. A
// credential is good only once the pane has taken it, only while its
// generation is the live one, and never after the Master is killed. Launching
// the Master puts the credential in no tmux argument and no tmux environment.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');
delete process.env.TANGLECLAW_PORT;

const store = require('../lib/store');
const handoff = require('../lib/bridge-handoff');
const principal = require('../lib/bridge-principal');
const bridgeStore = require('../lib/bridge-store');
const master = require('../lib/master');

const NO_FLEET = async () => ({ refreshed: false, count: 0 });
const availableEngines = {
  detectEngine: () => ({ available: true, path: '/usr/bin/true' }),
  resolveDefaultEngine: () => 'claude',
  reconcileLaunchMode: (_engine, mode) => mode
};

let tmpDir;

/**
 * Fake tmux: programmable liveness, records what a session was created with.
 * @param {object} [opts]
 * @param {boolean} [opts.alive] - Whether the Master session reads as live.
 * @param {Function} [opts.createSession] - Creation behaviour override.
 * @returns {object}
 */
function fakeTmux({ alive = false, createSession } = {}) {
  const calls = [];
  return {
    calls,
    probeSession: () => ({ live: alive, answered: true, cause: null }),
    hasSession: () => alive,
    createSession: (name, opts) => { calls.push({ name, opts }); return createSession ? createSession(name, opts) : true; },
    killSession: () => true,
    readSessionEnv: () => ({ value: null, answered: true, cause: null })
  };
}

/**
 * Take the credential the way a pane would: run the reader the launch command names.
 * @param {string} fifoPath - FIFO path.
 * @returns {Promise<string>} What the reader printed.
 */
function paneReads(fifoPath) {
  const reader = path.join(__dirname, '..', 'bin', 'tc-bridge-receive');
  const child = spawn(process.execPath, [reader, fifoPath], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  return new Promise((resolve) => child.on('close', () => resolve(out)));
}

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bridge-principal-'));
  store._setBasePath(tmpDir);
  store.init();
});

after(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('bridge principal (#2031)', () => {
  beforeEach(() => {
    principal.revokeAll('test-reset');
  });

  it('keeps its FIFOs in TangleClaw\'s state directory, outside the Master home', () => {
    assert.equal(principal.handoffDir(), path.join(tmpDir, 'bridge-handoff'));
    assert.ok(!principal.handoffDir().startsWith(path.join(tmpDir, 'master') + path.sep));
  });

  it('verifies a credential only once the pane has taken it', async () => {
    const issued = principal.begin();
    assert.equal(principal.verify(issued.credential), null, 'pending is not yet good');

    const [taken, settled] = await Promise.all([paneReads(issued.fifoPath), principal.settle(issued)]);
    assert.equal(taken, issued.credential);
    assert.deepEqual(settled, { generation: issued.generation, delivered: true, code: 'delivered' });
    assert.deepEqual(principal.verify(issued.credential), { generation: issued.generation, proof: 'master-launch' });
    assert.ok(!fs.existsSync(issued.fifoPath));
  });

  it('stores the hash and never the credential', async () => {
    const issued = principal.begin();
    await Promise.all([paneReads(issued.fifoPath), principal.settle(issued)]);
    store.close();
    const raw = fs.readFileSync(path.join(tmpDir, 'tangleclaw.db'));
    store._setBasePath(tmpDir);
    store.init();
    assert.ok(!raw.includes(issued.credential), 'the database file does not contain the credential');
    assert.ok(raw.includes(issued.hash));
  });

  it('revokes the generation when the pane never takes the credential', async () => {
    const issued = principal.begin();
    const settled = await principal.settle(issued, { timeoutMs: 150 });
    assert.deepEqual(settled, { generation: issued.generation, delivered: false, code: 'no-reader' });
    assert.equal(principal.verify(issued.credential), null);
    assert.equal(bridgeStore.masterCredentials.live(), null);
    assert.ok(!fs.existsSync(issued.fifoPath));
  });

  it('a new launch revokes the generation before it', async () => {
    const first = principal.begin();
    await Promise.all([paneReads(first.fifoPath), principal.settle(first)]);
    const second = principal.begin();
    assert.equal(principal.verify(first.credential), null, 'superseded at mint, before the new one is delivered');
    await Promise.all([paneReads(second.fifoPath), principal.settle(second)]);
    assert.equal(principal.verify(second.credential).generation, first.generation + 1);
  });

  it('a handoff that settles after it was superseded leaves the newer generation alone', async () => {
    const first = principal.begin();
    const second = principal.begin();
    // The first launch's pane takes its credential late, after the second mint.
    fs.rmSync(second.fifoPath);
    const lateFifo = handoff.prepareFifo(path.join(tmpDir, 'late'));
    const late = { ...first, fifoPath: lateFifo };
    const [, settled] = await Promise.all([paneReads(lateFifo), principal.settle(late)]);
    assert.equal(settled.code, 'superseded');
    assert.equal(principal.verify(first.credential), null);
    assert.deepEqual(bridgeStore.masterCredentials.live().generation, second.generation);
  });

  it('abandoning a launch revokes its generation, and doing it twice is harmless', () => {
    const issued = principal.begin();
    principal.abandon(issued);
    principal.abandon(issued);
    assert.equal(bridgeStore.masterCredentials.live(), null);
    assert.ok(!fs.existsSync(issued.fifoPath));
  });

  it('refuses anything that is not the live credential', async () => {
    const issued = principal.begin();
    await Promise.all([paneReads(issued.fifoPath), principal.settle(issued)]);
    for (const wrong of [undefined, null, '', 'mbk_short', handoff.mintCredential().credential, issued.hash, ['x']]) {
      assert.equal(principal.verify(wrong), null);
    }
  });
});

describe('Master launch and the bridge credential (#2031)', () => {
  let home;

  beforeEach(() => {
    principal.revokeAll('test-reset');
    home = path.join(tmpDir, `master-home-${Math.random().toString(36).slice(2)}`);
  });

  it('launches with the FIFO path in the command and the credential nowhere tmux can see', async () => {
    let seen = null;
    const t = fakeTmux({
      createSession: (_name, opts) => {
        const fifo = fs.readdirSync(principal.handoffDir()).map((n) => path.join(principal.handoffDir(), n))[0];
        seen = { fifo, taken: paneReads(fifo) };
        return true;
      }
    });
    const r = master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: t, enginesLib: availableEngines });
    assert.equal(r.created, true);
    const credential = await seen.taken;
    const settled = await principal.settled();
    assert.equal(settled.delivered, true);
    assert.ok(handoff.looksLikeCredential(credential));
    assert.ok(principal.verify(credential), 'what the pane took is the live credential');

    const opts = t.calls[0].opts;
    assert.ok(opts.command.includes(seen.fifo), 'the command names the FIFO');
    assert.ok(!opts.command.includes(credential), 'the command does not contain the credential');
    assert.ok(!(handoff.CREDENTIAL_ENV in opts.env), 'the credential is not a tmux -e variable');
    assert.ok(!JSON.stringify(opts).includes(credential), 'nothing handed to tmux contains the credential');
    assert.ok(!JSON.stringify(r).includes(credential), 'nor does what ensure returns');
  });

  it('revokes the credential when tmux refuses to create the session', () => {
    const t = fakeTmux({ createSession: () => false });
    const r = master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: t, enginesLib: availableEngines });
    assert.equal(r.created, false);
    assert.equal(bridgeStore.masterCredentials.live(), null);
    assert.deepEqual(fs.readdirSync(principal.handoffDir()), []);
  });

  it('revokes the credential when tmux throws', () => {
    const t = fakeTmux({ createSession: () => { throw new Error('boom'); } });
    const r = master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: t, enginesLib: availableEngines });
    assert.match(r.error, /boom/);
    assert.equal(bridgeStore.masterCredentials.live(), null);
  });

  it('mints nothing for a Master that is already running', () => {
    const t = fakeTmux({ alive: true });
    master.ensureMasterSession({ refreshFleet: NO_FLEET, home, tmuxLib: t, enginesLib: availableEngines });
    assert.equal(bridgeStore.masterCredentials.live(), null);
  });

  it('killing the Master revokes its credential', async () => {
    const issued = principal.begin();
    await Promise.all([paneReads(issued.fifoPath), principal.settle(issued)]);
    assert.ok(principal.verify(issued.credential));
    const r = master.killMasterSession({ tmuxLib: fakeTmux({ alive: true }) });
    assert.equal(r.killed, true);
    assert.equal(principal.verify(issued.credential), null);
  });

  it('at startup, revokes an interrupted handoff and a credential whose Master is gone', async () => {
    const interrupted = principal.begin();
    assert.deepEqual(master.reconcileBridgeCredential({ tmuxLib: fakeTmux({ alive: true }) }),
      { pendingRevoked: 1, activeRevoked: 0, live: true });
    fs.rmSync(interrupted.fifoPath);

    const issued = principal.begin();
    await Promise.all([paneReads(issued.fifoPath), principal.settle(issued)]);
    master.reconcileBridgeCredential({ tmuxLib: fakeTmux({ alive: true }) });
    assert.ok(principal.verify(issued.credential), 'a live Master keeps its credential across a server restart');

    const silent = { ...fakeTmux(), probeSession: () => ({ live: false, answered: false, cause: 'timeout' }) };
    master.reconcileBridgeCredential({ tmuxLib: silent });
    assert.ok(principal.verify(issued.credential), 'tmux not answering is not proof the Master is gone');

    assert.equal(master.reconcileBridgeCredential({ tmuxLib: fakeTmux({ alive: false }) }).activeRevoked, 1);
    assert.equal(principal.verify(issued.credential), null);
  });

  it('a kill that finds no Master still revokes a credential left behind', async () => {
    const issued = principal.begin();
    await Promise.all([paneReads(issued.fifoPath), principal.settle(issued)]);
    master.killMasterSession({ tmuxLib: fakeTmux({ alive: false }) });
    assert.equal(principal.verify(issued.credential), null);
  });
});

describe('the Master\'s standing instructions for the bridge (#2031)', () => {
  it('keeps the Master read-only with one narrow, conditioned exception', () => {
    const rule = master.MASTER_BASELINE_RULES[0];
    assert.match(rule, /Read-only\./);
    assert.match(rule, /Use only GET endpoints/);
    assert.match(rule, /one exception is the operator bridge/);
    // The exception, word for word (Architect ruling, 2026-10-04). It names no
    // verb's fields: every write uses what its own verb requires, from state
    // just read. Enabled, it lists what the Master may do. Disabled, nothing is
    // sent, and what is left is only what winds the bridge down.
    const EXCEPTION = 'The one exception is the operator bridge: you may record decisions with tc bridge, and with nothing else,'
      + ' when you hold the live bridge credential. Every write uses exactly the identifiers, version and proof required by that tc bridge verb,'
      + ' taken from the state you just read. While the operator has the bridge enabled, that is routing, answering, releasing, pinning and'
      + ' closing routes, deciding candidates, and requeueing or withdrawing items. While it is disabled nothing is sent: you may only close'
      + ' routes, withdraw queued items, and acknowledge or reset the circuit. That is routing, not authority: it permits no other mutating'
      + ' call and gives you none of the operator powers.';
    assert.equal(master.MASTER_BRIDGE_EXCEPTION, EXCEPTION);
    assert.ok(rule.endsWith(` ${EXCEPTION}`), rule);
    assert.equal(rule.split(EXCEPTION).length - 1, 1, 'said once');
    // The same sentence, verbatim, wherever an operator is told to put it in place or check it.
    const fs = require('node:fs');
    const path = require('node:path');
    for (const file of ['docs/operator-bridge.md', 'docs/runbooks/activate-the-operator-bridge.md']) {
      const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8').replace(/\n> ?/g, ' ').replace(/\s+/g, ' ');
      assert.ok(text.includes(EXCEPTION), `${file} prints the sentence word for word`);
    }
    assert.match(rule, /routing, not authority/);
    assert.match(rule, /permits no other mutating call/);
  });

  it('an id typed at tc bridge becomes a path segment only when it has an id\'s exact shape, and nothing is sent otherwise', async () => {
    const { bridgePathSegment, bridgeCredentialHeader, VERB_ROSTER } = require('../lib/tc-verbs');
    const bridge = VERB_ROSTER.find((v) => v.id === 'bridge');
    const calls = [];
    const ctx = (argv) => ({
      argv,
      getJson: async (p) => { calls.push(`GET ${p}`); return {}; },
      postJson: async (p, body) => { calls.push(`POST ${p}`); return { replayed: false, ...body }; }
    });
    // Everything that is not exactly an id: traversal, a slash, their encoded forms, a query, a fragment, whitespace, signs, too long.
    const NOT_IDS = ['..', '../1', '1/..', '1/2', '..%2F1', '%2e%2e', '%2E%2E%2F7', '1%2F2', '7?x=1', '7#frag', ' 7', '7 ', '7\n', '7\t', '', '-7', '+7', '7.0', '0x7', '7e2', 'seven', '٧', '1'.repeat(13)];
    for (const typed of NOT_IDS) {
      for (const argv of [['requeue', typed], ['withdraw', typed], ['requeue', typed, '--request-id', 'req-12345678'], ['circuit', 'ack', typed]]) {
        if (argv[0] === 'circuit' && typed === '1'.repeat(13)) continue;
        const out = await bridge.run(ctx(argv));
        assert.equal(out.code, 1, JSON.stringify(argv));
        assert.match(out.stderr, /Nothing was sent\.\n$/, JSON.stringify(argv));
      }
    }
    assert.equal((await bridge.run(ctx(['circuit', 'ack', '1'.repeat(10)]))).code, 1, 'an episode number is at most nine digits');
    assert.deepEqual(calls, [], 'no request was made for any of them, so no header went anywhere');

    // A real id goes out as itself, in exactly one place.
    await bridge.run(ctx(['requeue', '7']));
    await bridge.run(ctx(['withdraw', '123456789012']));
    await bridge.run(ctx(['circuit', 'ack', '3']));
    assert.deepEqual(calls, ['POST /api/bridge/master/outbound/7/requeue', 'POST /api/bridge/master/outbound/123456789012/withdraw', 'POST /api/bridge/master/circuit/3/ack']);

    // The segment is encoded whatever shape it was allowed under: the shape and the encoding are two guards, not one.
    assert.equal(bridgePathSegment('7', /^\d{1,12}$/), '7');
    assert.equal(bridgePathSegment('a/b?c#d e', /^.*$/), 'a%2Fb%3Fc%23d%20e');
    assert.equal(bridgePathSegment('..%2F', /^.*$/), '..%252F');
    assert.equal(bridgePathSegment('7/', /^\d{1,12}$/), null);
    for (const notAString of [7, null, undefined, ['7'], { toString: () => '7' }]) assert.equal(bridgePathSegment(notAString, /^\d{1,12}$/), null);

    // The credential is attached only to a bridge path that will be sent exactly as written.
    const header = { 'x-tangleclaw-bridge-credential': 'the-credential' };
    for (const plain of ['/api/bridge/master/status', '/api/bridge/master/outbound/7/requeue', '/api/bridge/master/routes?states=accepted%2Crouted', '/api/bridge/master/routes/rt_1']) {
      assert.deepEqual(bridgeCredentialHeader(plain, 'the-credential'), header, plain);
    }
    for (const notPlain of [
      '/api/bridge/master/routes/..', '/api/bridge/master/routes/../../control/assignments', '/api/bridge/master/routes/.', '/api/bridge/../auth/login',
      '/api/bridge/master/routes/%2e%2e', '/api/bridge/master/routes/%2E%2e/x', '/api/bridge//master/status', '/api/bridge/master/status#x',
      '/api/bridge/master/routes/a b', '/api/bridge/master\\status', '/api/bridge/master/routes/a\tb'
    ]) {
      assert.throws(() => bridgeCredentialHeader(notPlain, 'the-credential'), (err) => err.code === 'BRIDGE_PATH_NOT_PLAIN' && !err.message.includes('the-credential'), notPlain);
    }
    // Not a bridge path, or no credential: no header, and no objection, because nothing secret is at stake.
    assert.deepEqual(bridgeCredentialHeader('/api/control/assignments/mine', 'the-credential'), {});
    assert.deepEqual(bridgeCredentialHeader('/api/bridgeish/x', 'the-credential'), {});
    assert.deepEqual(bridgeCredentialHeader('/api/bridge/master/status', null), {});
    assert.deepEqual(bridgeCredentialHeader('/api/bridge/master/routes/..', ''), {});
    // And the real tc asks this function for the header: it does not attach one by itself.
    const tcSource = fs.readFileSync(path.join(__dirname, '..', 'bin', 'tc'), 'utf8');
    assert.ok(tcSource.includes('...bridgeCredentialHeader(apiPath, bridgeCredential)'));
    assert.equal(tcSource.split("'x-tangleclaw-bridge-credential'").length - 1, 0, 'the header name appears nowhere else in the executable');
  });

  it('the Master is told the whole of `tc bridge`: every subverb it implements, and none it does not', async () => {
    const { BRIDGE_SUBVERBS, BRIDGE_USAGE, VERB_ROSTER } = require('../lib/tc-verbs');
    const bridge = VERB_ROSTER.find((v) => v.id === 'bridge');
    const identity = master.buildMasterClaudeMd(store.config.load());
    assert.deepEqual([...BRIDGE_SUBVERBS], ['status', 'routes', 'read', 'route', 'answer', 'release', 'pin', 'close',
      'candidates', 'candidate', 'approve', 'reject', 'merge', 'blocked', 'requeue', 'withdraw', 'circuit ack', 'reset']);
    /**
     * Whether a usage text names a subverb as a word of its own.
     * @param {string} text - Usage text.
     * @param {string} verb - Subverb.
     * @returns {boolean}
     */
    const names = (text, verb) => new RegExp(`(^|[ |(])${verb.replace(' ', ' +')}( |$|\\n)`).test(text.replace(/tc bridge /g, ''));
    for (const verb of BRIDGE_SUBVERBS) {
      assert.ok(names(bridge.usage, verb), `the roster line names ${verb}`);
      assert.ok(names(BRIDGE_USAGE, verb), `tc bridge's own usage names ${verb}`);
      assert.ok(identity.includes(bridge.usage), 'and the Master\'s identity carries the roster line whole');
    }
    assert.ok(!/circuit ack <episode> \| reset/.test(BRIDGE_USAGE), 'reset is tc bridge reset, not a circuit subverb');
    assert.match(BRIDGE_USAGE, /every write but `circuit ack` also takes \[--request-id <id>\]/);

    // Each one is implemented: asked for with no server behind it, none is answered as unknown.
    const asked = [];
    const ctx = (argv) => ({
      argv,
      getJson: async (p) => { asked.push(`GET ${p}`); throw Object.assign(new Error('no server'), { body: { code: 'STUB', error: 'stub' } }); },
      postJson: async (p) => { asked.push(`POST ${p}`); throw Object.assign(new Error('no server'), { body: { code: 'STUB', error: 'stub' } }); }
    });
    const args = {
      status: [], routes: [], read: ['rt_1'], route: ['rt_1', '--version', '1', '--to', 'master'], answer: ['rt_1', '--version', '1', '--text', 'x'],
      release: ['rt_1', '--version', '1'], pin: ['rt_1', '--version', '1', '--to', 'master'], close: ['rt_1', '--version', '1'],
      candidates: [], candidate: ['cand_1'], approve: ['cand_1', '--version', '1'], reject: ['cand_1', '--version', '1'],
      merge: ['cand_1', '--version', '1', '--into', 'cand_2'], blocked: [], requeue: ['7'], withdraw: ['7'], 'circuit ack': ['3'], reset: ['--requeue']
    };
    for (const verb of BRIDGE_SUBVERBS) {
      const before = asked.length;
      const out = await bridge.run(ctx([...verb.split(' '), ...args[verb]]));
      assert.equal(asked.length, before + 1, `${verb} reaches the bridge`);
      assert.deepEqual([out.code, /refused \[STUB\]/.test(out.stderr)], [2, true], `${verb}: ${out.stderr}`);
    }
    // And what is not a subverb is said to be that, by name.
    const none = await bridge.run(ctx([]));
    assert.match(none.stderr, /^tc: bridge needs a subverb\./);
    const invented = await bridge.run(ctx(['teleport', 'rt_1']));
    assert.match(invented.stderr, /^tc: bridge has no subverb `teleport`\./);
    const circuitReset = await bridge.run(ctx(['circuit', 'reset']));
    assert.match(circuitReset.stderr, /^tc: bridge has no subverb `circuit`\./);
    const wrong = await bridge.run(ctx(['read']));
    assert.match(wrong.stderr, /^tc: bridge read: wrong arguments\./);
  });

  it('names every Master-only verb to the Master, and tc --help names every verb', () => {
    const { VERB_ROSTER, verbsFor, renderUsage } = require('../lib/tc-verbs');
    const masterVerbs = verbsFor('master');
    assert.ok(masterVerbs.some((v) => v.id === 'bridge'));
    const md = master.buildMasterClaudeMd(store.config.load());
    for (const v of masterVerbs) assert.ok(md.includes(v.usage), `the Master identity names ${v.id}`);
    const usage = renderUsage();
    for (const v of VERB_ROSTER) assert.ok(usage.includes(v.usage), `tc --help names ${v.id}`);
    assert.throws(() => verbsFor('everyone'), /unknown audience/);
  });

  it('tells every Master how to treat the bridge, whatever its rules say', () => {
    const custom = master.buildMasterClaudeMd(store.config.load(), { rules: [{ id: 7, content: 'An operator-written rule.' }] });
    const md = master.buildMasterClaudeMd(store.config.load());
    for (const text of [md, custom]) {
      assert.match(text, /## Operator bridge/);
      // Disabled is not "nothing to do": a rollback has the Master close what is still open.
      assert.ok(text.includes('`tc bridge status` says whether it is enabled. While it is not, nothing is sent or routed;\n'
        + 'what is left is to wind it down: close routes still open (`tc bridge routes`, then\n'
        + '`tc bridge close`), withdraw what is queued, and acknowledge or reset the circuit.'), 'the line about a disabled bridge');
      // The same three things the rule allows while disabled, and no fourth.
      assert.match(master.MASTER_BRIDGE_EXCEPTION, /While it is disabled nothing is sent: you may only close routes, withdraw queued items, and acknowledge or reset the circuit\./);
      assert.ok(!/there is nothing to do here/.test(text));
      assert.match(text, /Use only `tc bridge`/);
      assert.match(text, /conversation, not authority/);
      assert.match(text, new RegExp(`Never print, store or send \`${handoff.CREDENTIAL_ENV}\``));
      assert.ok(!/mbk_/.test(text), 'the identity never contains a credential');
    }
  });
});
