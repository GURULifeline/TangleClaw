'use strict';

/*
 * One server lifetime, for the #2086 proofs (`test/medusa-wake-exchange-proof.test.js`).
 *
 * Run as its own process: `node medusa-proof-phase.js '<json>'`. It opens the
 * scratch store at `basePath`, runs the real wake monitor, the real exchange
 * record and the real delivery watchdog through a list of steps, prints what
 * it saw as one JSON line, and exits. A restart in the proofs is the next
 * process on the same `basePath`, so nothing this process held in memory can
 * carry a result into it: what the next lifetime knows, it read from disk.
 *
 * Only what lies outside the server is a stand-in here, and the caller owns
 * all of it, because it outlives a restart:
 *   - the tmux pane (what a read returns, what typing into it does, what a
 *     later read says became of the nudge) and which sessions tmux holds;
 *   - the Medusa listener and Hub (the recipient's inbox, the workspace a
 *     project is registered as, a notice the Hub accepts);
 *   - time.
 * The monitor's exchange seams, its ledger, its gates, the project config it
 * reads and the watchdog's store are the real ones.
 */

const fs = require('node:fs');
const path = require('node:path');

const input = JSON.parse(process.argv[2]);
const { setLevel } = require('../../lib/logger');

setLevel('error');

const store = require('../../lib/store');
const mx = require('../../lib/medusa-exchanges');
const wake = require('../../lib/medusa-wake');
const watchdog = require('../../lib/medusa-watchdog');
const { IDLE_PANE, BUSY_PANE, TYPING_PANE } = require('../_wake-fixtures');

const PANES = { idle: IDLE_PANE, busy: BUSY_PANE, typing: TYPING_PANE };
const TICK_MS = 5000;
const RECIPIENT_WS = 'proof-builder-ws';
const SENDER_WS = 'proof-pm-ws';
const TMUX = 'tc-proof-builder';

// The outside world, as the caller left it.
const world = {
  now: input.now,
  pane: input.pane || 'idle',
  receipt: input.receipt || 'unknown',
  inbox: (input.inbox || []).slice(),
  live: input.live !== false,
  injected: [],
  notices: [],
  // Receipts the pane has not answered yet, oldest first (`receipt: 'deferred'`).
  awaited: []
};

/** Let promise callbacks and deferred monitor work run. @returns {Promise<void>} */
async function settle() {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve));
}

store._setBasePath(input.basePath);
store.init();

const byName = (name) => store.projects.list().find((p) => p.name === name) || null;

/**
 * Install the stand-ins for tmux, the listener, the Hub and time.
 * @returns {void}
 */
function installWorld() {
  const s = wake._internal;
  const builder = () => byName('proof-builder');
  s.now = () => world.now;
  s.clock = () => world.now;
  mx._internal.now = () => new Date(world.now);
  watchdog._internal.now = () => world.now;
  // tmux: which sessions exist, what a pane read returns, what typing does.
  s.listLiveAll = () => (world.live && builder()
    ? [{ id: 2, projectId: builder().id, sessionMode: 'tmux', tmuxSession: TMUX, engineId: 'claude', startedAt: '2026-10-04T00:00:00.000Z' }]
    : []);
  s.masterWakeRecord = () => null;
  s.capturePane = () => ({ lines: PANES[world.pane] });
  s.cursorInfo = () => null;
  s.readPaneAsync = () => Promise.resolve({ cap: { lines: PANES[world.pane], alternateScreen: false }, cursor: null });
  s.injectCommand = (projectName, command) => {
    world.injected.push({ at: world.now, projectName, command });
    return { ok: true, error: null };
  };
  s.verifySubmission = () => (world.receipt === 'deferred'
    ? new Promise((resolve) => { world.awaited.push(resolve); })
    : Promise.resolve({ outcome: world.receipt, reason: 'proof' }));
  // The listener and the Hub.
  s.getStatus = () => ({ state: 'listening', workspaceId: RECIPIENT_WS, unread: world.inbox.length, lastError: null });
  s.getMessages = () => world.inbox.map((id) => ({ id, from: SENDER_WS, message: 'proof' }));
  watchdog._internal.sendSystemMessage = async (m) => {
    world.notices.push({ at: world.now, to: m.to, body: JSON.parse(m.message) });
    return { status: 'received' };
  };
  watchdog._internal.workspaceForProject = (id) => {
    const pm = byName('proof-pm');
    return pm && id === pm.id ? SENDER_WS : null;
  };
  watchdog._internal.isLocalWorkspace = () => false;
}

const STEPS = {
  /** Create the two projects, the recipient opted in to wake-on-mail. */
  setup() {
    for (const name of ['proof-pm', 'proof-builder']) {
      const dir = path.join(input.basePath, name);
      fs.mkdirSync(dir, { recursive: true });
      store.projects.create({ name, path: dir, engine: 'claude' });
    }
    const dir = byName('proof-builder').path;
    store.projectConfig.save(dir, { ...store.projectConfig.load(dir), medusaWake: true });
  },
  /** A message from the PM to the Builder, stored by the Hub and delivered. */
  send(step) {
    const pm = byName('proof-pm');
    const builder = byName('proof-builder');
    const caller = { kind: 'project', projectId: pm.id };
    const x = mx.createSendIntent({
      meta: mx.validateSendMeta(step.body || {}, caller, pm.id),
      sender: { projectId: pm.id, workspaceId: SENDER_WS },
      recipient: { workspaceId: RECIPIENT_WS, projectId: builder.id, sessionId: 2 }
    });
    mx.bindHubId(x.exchange_id, step.hubId);
    mx.recordArrival({ hubId: step.hubId, recipientWorkspaceId: RECIPIENT_WS });
    world.inbox.push(step.hubId);
  },
  /** Mail the Hub delivers that this host keeps no tracked exchange for. */
  sendUntracked(step) {
    const pm = byName('proof-pm');
    const x = mx.createSendIntent({
      meta: mx.validateSendMeta({}, { kind: 'project', projectId: pm.id }, pm.id),
      sender: { projectId: pm.id, workspaceId: SENDER_WS },
      recipient: { workspaceId: RECIPIENT_WS },
      tracking: 'untracked'
    });
    mx.bindHubId(x.exchange_id, step.hubId);
    world.inbox.push(step.hubId);
  },
  /** The Hub hands over again what was never marked handled, as it does after a restart. */
  redeliver(step) {
    for (const hubId of step.hubIds) mx.recordArrival({ hubId, recipientWorkspaceId: RECIPIENT_WS });
  },
  /** Mail in the inbox that has no exchange record at all (a system broadcast). */
  deliverUnrecorded(step) { world.inbox.push(step.hubId); },
  /** Fire the monitor's tick `n` times, five seconds apart, letting each pane read answer. */
  async ticks(step) {
    for (let i = 0; i < step.n; i++) {
      world.now += TICK_MS;
      wake._internal.tick({ async: true });
      await settle();
    }
  },
  /** One watchdog pass, waiting for its notices. */
  async watchdog() {
    const out = watchdog.tick(world.now);
    await out.notices;
  },
  /** Move time forward. */
  advance(step) { world.now += step.ms; },
  /** The outside world changes. */
  pane(step) { world.pane = step.name; },
  receipt(step) { world.receipt = step.outcome; },
  /** The oldest receipt still out is answered, late. */
  async answerReceipt(step) {
    world.awaited.shift()({ outcome: step.outcome, reason: 'proof' });
    await settle();
  },
  /** The recipient fetches, then marks handled. */
  read(step) {
    mx.recordRead(step.hubIds, RECIPIENT_WS, { kind: 'project', projectId: byName('proof-builder').id });
  },
  ack(step) {
    mx.recordAcknowledged(step.hubIds, RECIPIENT_WS, { kind: 'project', projectId: byName('proof-builder').id });
    world.inbox = world.inbox.filter((id) => !step.hubIds.includes(id));
  }
};

/**
 * Everything durable, read back from the store.
 * @returns {object}
 */
function snapshot() {
  const db = store.getDb();
  const rows = db.prepare('SELECT * FROM medusa_exchanges ORDER BY created_at, exchange_id').all();
  const exchanges = rows.map((x) => ({
    exchangeId: x.exchange_id,
    hubId: x.hub_id,
    state: x.state,
    wakeCode: x.wake_code,
    escLevel: x.esc_level,
    rearmCount: x.rearm_count,
    nextEligibleAt: x.next_eligible_at,
    facts: store.medusaExchanges.facts(x.exchange_id).map((f) => {
      const detail = f.detail_json ? JSON.parse(f.detail_json) : {};
      return { seq: f.fact_seq, fact: f.fact, code: f.code, at: f.at, nonce: detail.nonce || null };
    })
  }));
  const ledger = db.prepare('SELECT * FROM medusa_deliveries ORDER BY id').all();
  const activity = store.activity.query({ eventType: 'medusa-escalation', limit: 500 });
  return { exchanges, ledger, activity };
}

(async () => {
  installWorld();
  // Running, so the watchdog reads a monitor that retries; the interval never fires.
  wake.start({ intervalMs: 2 ** 30 });
  for (const step of input.steps) await STEPS[step.op](step);
  await settle();
  wake.stop();
  const out = {
    world: { now: world.now, pane: world.pane, receipt: world.receipt, inbox: world.inbox },
    injected: world.injected,
    notices: world.notices,
    durable: snapshot()
  };
  store.close();
  process.stdout.write(`${JSON.stringify(out)}\n`);
})().catch((err) => {
  process.stderr.write(`${err.stack}\n`);
  process.exit(1);
});
