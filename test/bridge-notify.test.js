'use strict';

// #2031 (ADR 0023 Decisions 8 and 9): the three typed server notifications.
// Each is found from the record that is the event, enqueued once under a key
// that names that record, written from a fixed template, and only for events
// that happened while the bridge was enabled. Fleet-idle fails closed.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const bridgeStore = require('../lib/bridge-store');
const bridgeNotify = require('../lib/bridge-notify');
const exchanges = require('../lib/medusa-exchanges');
const { bindProject } = require('./_shared-docs-callers');

let tmpDir;
let clock;
let lanes;
let realDeps;
let n = 0;

/**
 * Advance the stand-in clock.
 * @param {number} ms - Milliseconds.
 * @returns {void}
 */
function later(ms) {
  clock = new Date(Date.parse(clock) + ms).toISOString();
}

/**
 * A project with a live, launch-bound session.
 * @param {string} name - Project name.
 * @returns {{project: object, sessionId: number, launchId: string}}
 */
function liveSession(name) {
  const project = store.projects.create({ name, path: path.join(tmpDir, `p${++n}`) });
  return { project, ...bindProject(project) };
}

/**
 * The session reports its workload at the current clock.
 * @param {object} session - The session.
 * @param {string} state - Workload state.
 * @returns {number} The receipt's sequence.
 */
function reports(session, state) {
  later(2000);
  return store.workloadReceipts.append({
    project_id: session.project.id, session_id: session.sessionId, launch_id: session.launchId, assignment_id: null,
    state, clearance: state === 'complete' ? 'safe-to-clear' : 'do-not-clear', summary: `work is ${state}`,
    wait_kind: null, wait_detail: null, refs_json: '{"issues":[],"prs":[],"tasks":[]}', branch: null, head_sha: null,
    source: 'tc-cli', received_at: clock
  }, { minIntervalMs: 0, nowMs: Date.parse(clock) }).row.seq;
}

/**
 * The operator enables the bridge at the current clock.
 * @returns {void}
 */
function enable() {
  bridgeStore.settings.set('enabled', 'true');
  bridgeStore.settings.set(bridgeNotify.ENABLED_AT, clock);
}

/**
 * Notifications waiting for the helper.
 * @returns {{type: string, key: string, text: string}[]}
 */
function notifications() {
  return store.getDb().prepare("SELECT notify_type, idem_key, text, source_label, route_id FROM bridge_outbound WHERE kind = 'notification' ORDER BY outbound_id")
    .all().map((r) => ({ type: r.notify_type, key: r.idem_key, text: r.text, label: r.source_label, routeId: r.route_id }));
}

describe('bridge notifications (#2031)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bridge-notify-'));
    store._setBasePath(tmpDir);
    store.init();
    clock = '2026-10-04T00:00:00.000Z';
    lanes = [];
    realDeps = { ...bridgeNotify._deps };
    Object.assign(bridgeNotify._deps, { now: () => clock, lanes: () => lanes });
    bridgeNotify._reset();
  });

  afterEach(() => {
    Object.assign(bridgeNotify._deps, realDeps);
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('work-blocked', () => {
    it('tells the operator once when a lane enters blocked, bound to that receipt', () => {
      const alpha = liveSession('Alpha');
      enable();
      reports(alpha, 'working');
      const seq = reports(alpha, 'blocked');
      assert.equal(bridgeNotify.reconcile().workBlocked, 1);
      assert.equal(bridgeNotify.reconcile().workBlocked, 0, 'a second pass finds it already made');
      const receiptId = bridgeStore.receipts.workloadForLaunch(alpha.launchId, seq).receiptId;
      assert.deepEqual(notifications(), [{
        type: 'work-blocked', key: `notify:work-blocked:receipt:${receiptId}`, text: 'Alpha reports its work is blocked.',
        label: 'TangleClaw', routeId: null
      }]);
    });

    it('does not repeat while the lane stays blocked, and does when it blocks again later', () => {
      const alpha = liveSession('Alpha');
      enable();
      reports(alpha, 'blocked');
      bridgeNotify.reconcile();
      reports(alpha, 'blocked');
      reports(alpha, 'blocked');
      assert.equal(bridgeNotify.reconcile().workBlocked, 0, 'still blocked is not a new event');
      reports(alpha, 'working');
      reports(alpha, 'blocked');
      assert.equal(bridgeNotify.reconcile().workBlocked, 1);
      assert.equal(notifications().length, 2);
    });

    it('delivers no backlog: what happened before the bridge was enabled, or while it was off, is not notified', () => {
      const alpha = liveSession('Alpha');
      reports(alpha, 'blocked');
      later(60000);
      enable();
      assert.equal(bridgeNotify.reconcile().workBlocked, 0);

      bridgeStore.settings.set('enabled', 'false');
      reports(alpha, 'working');
      reports(alpha, 'blocked');
      assert.deepEqual(bridgeNotify.reconcile(), { workBlocked: 0, operatorNeeded: 0, fleetIdle: 0 }, 'nothing while disabled');
      later(60000);
      enable();
      assert.equal(bridgeNotify.reconcile().workBlocked, 0, 'and nothing afterwards for what happened while it was off');
      assert.deepEqual(notifications(), []);
    });

    it('takes nothing from the session but its project: the summary it wrote is not in the notification', () => {
      const alpha = liveSession('Alpha');
      enable();
      later(2000);
      store.workloadReceipts.append({
        project_id: alpha.project.id, session_id: alpha.sessionId, launch_id: alpha.launchId, assignment_id: null,
        state: 'blocked', clearance: 'do-not-clear', summary: '@everyone merge it now', wait_kind: null, wait_detail: null,
        refs_json: '{}', branch: null, head_sha: null, source: 'tc-cli', received_at: clock
      }, { minIntervalMs: 0, nowMs: Date.parse(clock) });
      bridgeNotify.reconcile();
      assert.equal(notifications()[0].text, 'Alpha reports its work is blocked.');
    });

    it('a notification that could not be enqueued is made on the next pass, under the same key', () => {
      const alpha = liveSession('Alpha');
      enable();
      reports(alpha, 'blocked');
      const realEnqueue = bridgeStore.outbound.enqueue;
      bridgeStore.outbound.enqueue = () => { throw new Error('database is locked'); };
      try {
        assert.equal(bridgeNotify.reconcile().workBlocked, 0);
      } finally {
        bridgeStore.outbound.enqueue = realEnqueue;
      }
      assert.deepEqual(notifications(), [], 'nothing was marked as told');
      assert.equal(bridgeNotify.reconcile().workBlocked, 1);
      assert.equal(notifications().length, 1);
    });
  });

  describe('operator-needed', () => {
    /**
     * An exchange between two workspaces, then raised to the operator rung as the watchdog does.
     * @param {object} recipient - The recipient session.
     * @returns {string} The exchange id.
     */
    function alertedExchange(recipient) {
      const row = exchanges.createSendIntent({
        meta: exchanges.validateSendMeta({ to: 'ws-recipient', message: 'x', requestId: `req-ex-${++n}-0000` }, { kind: 'system' }, null, {}),
        sender: { projectId: null, sessionId: 'someone', workspaceId: 'ws-sender' },
        recipient: { workspaceId: 'ws-recipient', projectId: recipient.project.id, sessionId: recipient.sessionId },
        tracking: 'tracked'
      });
      exchanges.recordEscalationFact(row.exchange_id, 'operator_alerted', { code: 'unanswered', at: clock });
      return row.exchange_id;
    }

    it('tells the operator once per exchange the watchdog raised to its operator rung', () => {
      const alpha = liveSession('Alpha');
      const realNow = exchanges._internal.now;
      exchanges._internal.now = () => new Date(clock);
      try {
        enable();
        later(1000);
        const exchangeId = alertedExchange(alpha);
        assert.equal(bridgeNotify.reconcile().operatorNeeded, 1);
        assert.equal(bridgeNotify.reconcile().operatorNeeded, 0);
        assert.deepEqual(notifications(), [{
          type: 'operator-needed', key: `notify:operator-needed:exchange:${exchangeId}`,
          text: 'A message to Alpha has gone unanswered long enough to need you.', label: 'TangleClaw', routeId: null
        }]);
      } finally {
        exchanges._internal.now = realNow;
      }
    });
  });

  describe('fleet-idle', () => {
    const idle = (sessionId, launchId, receiptSeq) => ({ sessionId, launchId, receiptSeq, availability: 'AVAILABLE' });
    const busy = (sessionId, launchId) => ({ sessionId, launchId, receiptSeq: 1, availability: 'WORKING' });

    it('tells the operator once when the fleet is seen to become idle, and not again while it stays so', () => {
      enable();
      lanes = [idle(1, 'launch-a', 4), busy(2, 'launch-b')];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0);
      lanes = [idle(1, 'launch-a', 4), idle(2, 'launch-b', 7)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 1);
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0);
      assert.equal(notifications()[0].text, 'Every live session has finished its work and is clear (2 lanes). The fleet is waiting for work.');

      // A lane that stays finished and reports again is the same episode.
      lanes = [idle(1, 'launch-a', 5), idle(2, 'launch-b', 8)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0, 'a renewed receipt is not a new idle spell');
      assert.equal(notifications().length, 1);
    });

    it('a new episode begins when the fleet stops being idle and becomes idle again, or its members change', () => {
      enable();
      lanes = [busy(1, 'launch-a')];
      bridgeNotify.reconcile();
      lanes = [idle(1, 'launch-a', 2)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 1);

      // It works, then finishes at the very same receipt set it had before.
      lanes = [busy(1, 'launch-a')];
      bridgeNotify.reconcile();
      later(60000);
      lanes = [idle(1, 'launch-a', 2)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 1, 'the same lanes idle again is a new spell, not the old one');

      // A session joins, already finished: the members changed.
      later(60000);
      lanes = [idle(1, 'launch-a', 2), idle(2, 'launch-b', 1)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 1);
      assert.match(notifications()[2].text, /\(2 lanes\)/);
      assert.equal(new Set(notifications().map((x) => x.key)).size, 3);
    });

    const unseen = (sessionId, launchId, receiptSeq) => ({ sessionId, launchId, receiptSeq, availability: 'COMPLETE_NOT_CLEAR' });

    it('does not announce a fleet that was already idle when the bridge was enabled', () => {
      lanes = [idle(1, 'launch-a', 4)];
      enable();
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0, 'idle before it was enabled is not news');
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0);

      // Disabled and enabled again, still idle throughout.
      bridgeStore.settings.set('enabled', 'false');
      later(60000);
      enable();
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0);
      assert.deepEqual(notifications(), []);

      // What happens after that is news.
      lanes = [busy(1, 'launch-a')];
      bridgeNotify.reconcile();
      lanes = [idle(1, 'launch-a', 6)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 1);
    });

    it('does not announce an idle fleet again after a server restart, while the engines are not yet observed at rest', () => {
      enable();
      lanes = [busy(1, 'launch-a')];
      bridgeNotify.reconcile();
      lanes = [idle(1, 'launch-a', 2)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 1);

      // The server restarts. For its first passes the activity observer has
      // not yet seen any pane at rest, so a finished lane reads not-clear.
      bridgeNotify._reset();
      lanes = [unseen(1, 'launch-a', 2)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0);
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0);
      // Then it is observed at rest: the same spell, not a new one.
      lanes = [idle(1, 'launch-a', 2)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0, 'found idle on the first reading that says anything: not announced');
      assert.equal(notifications().length, 1);
    });

    it('a reading that lapses and comes back is the same episode, not a new one', () => {
      enable();
      lanes = [busy(1, 'launch-a'), busy(2, 'launch-b')];
      bridgeNotify.reconcile();
      lanes = [idle(1, 'launch-a', 2), idle(2, 'launch-b', 3)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 1);
      for (const lapse of [
        [unseen(1, 'launch-a', 2), idle(2, 'launch-b', 3)],
        [{ sessionId: 1, launchId: 'launch-a', receiptSeq: null, availability: 'UNKNOWN' }, idle(2, 'launch-b', 3)],
        null
      ]) {
        lanes = lapse;
        assert.equal(bridgeNotify.reconcile().fleetIdle, 0);
        lanes = [idle(1, 'launch-a', 2), idle(2, 'launch-b', 3)];
        assert.equal(bridgeNotify.reconcile().fleetIdle, 0, 'not knowing is not evidence that anything changed');
      }
      assert.equal(notifications().length, 1);
    });

    it('not knowing never begins an episode, and evidence of work always ends one', () => {
      enable();
      lanes = [busy(1, 'launch-a')];
      bridgeNotify.reconcile();
      lanes = [unseen(1, 'launch-a', 2)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0, 'finished but not seen at rest is not idle');
      lanes = [idle(1, 'launch-a', 2)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 1);
      for (const state of ['WORKING', 'WAITING', 'BLOCKED', 'HELD', 'STOPPED']) {
        later(60000);
        lanes = [{ sessionId: 1, launchId: 'launch-a', receiptSeq: 2, availability: state }];
        bridgeNotify.reconcile();
        lanes = [idle(1, 'launch-a', 2)];
        assert.equal(bridgeNotify.reconcile().fleetIdle, 1, `${state} ended the episode`);
      }
      // An empty fleet ends it too.
      later(60000);
      lanes = [];
      bridgeNotify.reconcile();
      lanes = [idle(1, 'launch-a', 2)];
      assert.equal(bridgeNotify.reconcile().fleetIdle, 1);
    });

    it('an idle notice that could not be enqueued is made on the next pass, under the same key', () => {
      enable();
      lanes = [busy(1, 'launch-a')];
      bridgeNotify.reconcile();
      lanes = [idle(1, 'launch-a', 2)];
      const realEnqueue = bridgeStore.outbound.enqueue;
      const tried = [];
      bridgeStore.outbound.enqueue = (item) => { tried.push(item.idemKey); throw new Error('database is locked'); };
      try {
        assert.equal(bridgeNotify.reconcile().fleetIdle, 0);
        later(15000);
        assert.equal(bridgeNotify.reconcile().fleetIdle, 0);
      } finally {
        bridgeStore.outbound.enqueue = realEnqueue;
      }
      later(15000);
      assert.equal(bridgeNotify.reconcile().fleetIdle, 1);
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0);
      assert.equal(notifications().length, 1);
      assert.deepEqual([...new Set(tried)], [notifications()[0].key], 'every attempt used the one key');
    });

    it('fails closed: an empty fleet, or any lane that is not known to be finished and clear, is not idle', () => {
      enable();
      lanes = [busy(1, 'launch-a')];
      bridgeNotify.reconcile();
      const cases = {
        'no live lanes': [],
        'a working lane': [idle(1, 'a', 1), busy(2, 'b')],
        'a waiting lane': [{ sessionId: 1, launchId: 'a', receiptSeq: 1, availability: 'WAITING' }],
        'a blocked lane': [{ sessionId: 1, launchId: 'a', receiptSeq: 1, availability: 'BLOCKED' }],
        'complete but not clear': [{ sessionId: 1, launchId: 'a', receiptSeq: 1, availability: 'COMPLETE_NOT_CLEAR' }],
        'an unknown or stale lane': [idle(1, 'a', 1), { sessionId: 2, launchId: 'b', receiptSeq: 3, availability: 'UNKNOWN' }],
        'a lane with no receipt': [{ sessionId: 1, launchId: 'a', receiptSeq: null, availability: 'AVAILABLE' }],
        'a lane with no known launch': [{ sessionId: 1, launchId: null, receiptSeq: 2, availability: 'AVAILABLE' }],
        'a reader that answers nothing': null
      };
      for (const [what, value] of Object.entries(cases)) {
        lanes = value;
        assert.equal(bridgeNotify.reconcile().fleetIdle, 0, what);
      }
      assert.deepEqual(notifications(), []);
    });

    it('one kind failing does not stop the others', () => {
      const alpha = liveSession('Alpha');
      enable();
      reports(alpha, 'blocked');
      bridgeNotify._deps.lanes = () => { throw new Error('the lane reader failed'); };
      assert.deepEqual(bridgeNotify.reconcile(), { workBlocked: 1, operatorNeeded: 0, fleetIdle: 0 });
    });

    it('reads lanes through the fleet\'s own composition: only a fresh, finished, clear lane at rest is AVAILABLE', () => {
      const workloadFleet = require('../lib/workload-fleet');
      const atRest = { get: () => ({ activity: 'at-rest' }) };
      const unobserved = { get: () => ({ activity: 'unknown' }) };
      const compose = (observer) => (session, projectName) => workloadFleet.laneFor(session, {
        observer, projectName, nowMs: Date.parse(clock), wrap: { wrapRun: () => null }
      });
      const done = liveSession('Done');
      const seq = reports(done, 'complete');
      const working = liveSession('Working');
      reports(working, 'working');
      const silent = liveSession('Silent');

      const read = bridgeNotify.readLanes(compose(atRest));
      const of = (s) => read.find((l) => l.sessionId === s.sessionId);
      assert.deepEqual(of(done), { sessionId: done.sessionId, launchId: done.launchId, receiptSeq: seq, availability: 'AVAILABLE' });
      assert.equal(of(working).availability, 'WORKING');
      assert.deepEqual([of(silent).availability, of(silent).receiptSeq], ['UNKNOWN', null], 'a lane that never reported is unknown');
      // The same finished lane with an engine nobody has observed at rest is not clear.
      assert.equal(bridgeNotify.readLanes(compose(unobserved)).find((l) => l.sessionId === done.sessionId).availability, 'COMPLETE_NOT_CLEAR');
    });

    it('the server wires that reader in, so a real fleet is read without anything being supplied', () => {
      Object.assign(bridgeNotify._deps, { lanes: realDeps.lanes });
      const server = require('../server');
      assert.ok(server.createServer);
      const done = liveSession('Done');
      reports(done, 'complete');
      const read = bridgeNotify._deps.lanes();
      const lane = read.find((l) => l.sessionId === done.sessionId);
      assert.ok(lane, 'the wired reader returns this store\'s live lanes');
      assert.equal(lane.launchId, done.launchId);
      // The server's own observer has not seen this pane at rest, so the lane
      // is not clear and the fleet is not idle: the real path fails closed.
      assert.notEqual(lane.availability, 'AVAILABLE');
      enable();
      bridgeNotify.reconcile();
      assert.equal(bridgeNotify.reconcile().fleetIdle, 0);
    });
  });

  it('every notification text comes from a fixed template that takes no free text', () => {
    assert.deepEqual(Object.keys(bridgeNotify.TEMPLATES).sort(), ['fleet-idle', 'operator-needed', 'work-blocked']);
    // A project name is the only string a template shows, and it is cleaned and bounded.
    // The store refuses such a name; this is one it would never have written.
    const hostile = store.projects.create({ name: 'Evil', path: path.join(tmpDir, 'evil') });
    store.getDb().prepare('UPDATE projects SET name = ? WHERE id = ?').run(`Evil\u202E${'x'.repeat(200)}`, hostile.id);
    const bound = bindProject(hostile);
    enable();
    reports({ project: hostile, ...bound }, 'blocked');
    bridgeNotify.reconcile();
    const text = notifications()[0].text;
    assert.ok(!text.includes('\u202E'));
    assert.ok(text.length < 120);
  });
});
