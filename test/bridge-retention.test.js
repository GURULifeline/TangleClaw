'use strict';

// #2031 (ADR 0023 Decision 20, Architect ruling 2026-10-04): how long each
// kind of thing may wait before the bridge lets it go. A milestone candidate
// 7 days; an operator-action candidate 30; work-blocked and operator-needed 7
// days; fleet-idle and a route's status notice 24 hours; a reply never. Each
// limit is tested at its exact boundary, each thing let go is audited by its
// own id, and nothing let go is raised again.

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
const { bindProject } = require('./_shared-docs-callers');

const DAY = 24 * 60 * 60 * 1000;
const T0 = '2026-10-04T00:00:00.000Z';
const digest = 'a'.repeat(64);

let tmpDir;
let project;
let bound;

/**
 * The instant a given number of milliseconds after T0.
 * @param {number} ms - Offset.
 * @returns {string}
 */
function at(ms) {
  return new Date(Date.parse(T0) + ms).toISOString();
}

/**
 * Queue a typed notification at T0.
 * @param {string} type - Notification type.
 * @returns {number} Its id.
 */
function notification(type) {
  return bridgeStore.outbound.enqueue({
    idemKey: `notify:${type}:x`, kind: 'notification', notifyType: type, sourceLabel: 'TangleClaw', text: 'x', digest, at: T0
  }).outboundId;
}

/**
 * Submit a candidate at T0.
 * @param {string} kind - Candidate kind.
 * @param {string} id - Candidate id.
 * @returns {string} Its id.
 */
function candidate(kind, id) {
  bridgeStore.candidates.submit({
    candidateId: id, idemKey: `cand:${id}`, kind, sourceProjectId: project.id, sourceLaunchId: bound.launchId, text: 'x',
    receipts: [{ kind: 'workload', id: '1', digest }], at: T0
  });
  return id;
}

/**
 * Approve a candidate at T0, so its item waits for the helper.
 * @param {string} id - Candidate id.
 * @returns {number} The outbound item's id.
 */
function approved(id) {
  const result = bridgeStore.applyCandidateWrite({
    op: 'candidate-approve', requestId: `req-approve-${id}`, candidateId: id, expectedVersion: 1, masterGeneration: 1, at: T0,
    change: () => ({ state: 'approved', outbound: { idemKey: `candidate:${id}`, kind: 'candidate', sourceLabel: 'Project Master', text: 'x', digest, releasedGeneration: 1 } })
  });
  assert.equal(result.outcome, 'applied');
  return store.getDb().prepare('SELECT outbound_id FROM bridge_outbound WHERE candidate_id = ?').get(id).outbound_id;
}

/**
 * A route at T0.
 * @param {string} id - Route id.
 * @returns {string}
 */
function route(id) {
  bridgeStore.routes.accept({ routeId: id, externalId: `ext-${id}`, authorId: 'a', spaceId: 's', channelId: 'c', text: 'hello', digest, at: T0 });
  return id;
}

/**
 * The state of an outbound item.
 * @param {number} id - Item id.
 * @returns {string}
 */
function itemState(id) {
  return bridgeStore.outbound.get(id).state;
}

describe('bridge retention: what is let go, and exactly when (#2031)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bridge-retention-'));
    store._setBasePath(tmpDir);
    store.init();
    project = store.projects.create({ name: 'Alpha', path: path.join(tmpDir, 'alpha') });
    bound = bindProject(project);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('states the limits the Architect ruled', () => {
    assert.deepEqual(bridgeStore.EXPIRY_MS, {
      candidate: { milestone: 7 * DAY, 'operator-action-required': 30 * DAY },
      notification: { 'work-blocked': 7 * DAY, 'operator-needed': 7 * DAY, 'fleet-idle': DAY },
      status: DAY
    });
  });

  for (const [type, limit] of [['work-blocked', 7 * DAY], ['operator-needed', 7 * DAY], ['fleet-idle', DAY]]) {
    it(`keeps a ${type} notification at exactly its limit and lets it go one millisecond later`, () => {
      const id = notification(type);
      assert.deepEqual(bridgeStore.expire({ now: at(limit) }), { outbound: 0, candidates: 0 });
      assert.equal(itemState(id), 'ready');
      assert.deepEqual(bridgeStore.expire({ now: at(limit + 1) }), { outbound: 1, candidates: 0 });
      const item = bridgeStore.outbound.get(id);
      assert.deepEqual([item.state, item.dropCode, item.text], ['dropped', 'expired', null]);
    });
  }

  it('keeps a route\'s status notice for 24 hours, to the millisecond', () => {
    route('rt_1');
    const id = bridgeStore.outbound.enqueueStatus('rt_1', 'pending', { at: T0 }).item.outboundId;
    bridgeStore.expire({ now: at(DAY) });
    assert.equal(itemState(id), 'ready');
    bridgeStore.expire({ now: at(DAY + 1) });
    assert.equal(itemState(id), 'dropped');
    assert.equal(bridgeStore.outbound.enqueueStatus('rt_1', 'pending', { at: at(2 * DAY) }).created, false, 'a route still has had its one notice');
  });

  for (const [kind, limit] of [['milestone', 7 * DAY], ['operator-action-required', 30 * DAY]]) {
    it(`rejects an undecided ${kind} candidate one millisecond past its limit, and not before`, () => {
      const id = candidate(kind, 'cd_1');
      assert.equal(bridgeStore.expire({ now: at(limit) }).candidates, 0);
      assert.equal(bridgeStore.candidates.get(id).state, 'submitted');
      assert.equal(bridgeStore.expire({ now: at(limit + 1) }).candidates, 1);
      const after = bridgeStore.candidates.get(id);
      assert.deepEqual([after.state, after.version, after.decidedGeneration], ['rejected', 2, null], 'let go by nobody\'s decision');
    });

    it(`drops an approved ${kind} candidate nobody collected one millisecond past its limit, and not before`, () => {
      const id = approved(candidate(kind, 'cd_1'));
      bridgeStore.expire({ now: at(limit) });
      assert.equal(itemState(id), 'ready');
      assert.equal(bridgeStore.expire({ now: at(limit + 1) }).outbound, 1);
      assert.equal(itemState(id), 'dropped');
    });
  }

  it('a milestone and an operator action submitted together part ways at seven days', () => {
    const news = candidate('milestone', 'cd_news');
    const action = candidate('operator-action-required', 'cd_action');
    bridgeStore.expire({ now: at(7 * DAY + 1) });
    assert.deepEqual([bridgeStore.candidates.get(news).state, bridgeStore.candidates.get(action).state], ['rejected', 'submitted']);
  });

  it('never lets go of a reply or a failure notice, whatever its age', () => {
    route('rt_1');
    bridgeStore.applyRouteWrite({
      op: 'answer', requestId: 'req-answer-0001', routeId: 'rt_1', expectedVersion: 1, actor: 'master', proof: 'master-launch', masterGeneration: 1, at: T0,
      change: () => ({ set: { state: 'released' }, outbound: { idemKey: 'route:rt_1:answer', kind: 'reply', sourceLabel: 'Project Master', text: 'the answer', digest, releasedGeneration: 1 } })
    });
    const failure = bridgeStore.outbound.enqueue({ idemKey: 'route:rt_1:failure', kind: 'failure', routeId: 'rt_1', sourceLabel: 'TangleClaw', text: 'x', digest, at: T0 }).outboundId;
    assert.deepEqual(bridgeStore.expire({ now: at(3650 * DAY) }), { outbound: 0, candidates: 0 });
    const reply = store.getDb().prepare("SELECT * FROM bridge_outbound WHERE kind = 'reply'").get();
    assert.deepEqual([reply.state, reply.text], ['ready', 'the answer']);
    assert.equal(itemState(failure), 'ready');
  });

  it('audits each thing it lets go by its own id, with one fixed reason', () => {
    const blocked = notification('work-blocked');
    const idle = notification('fleet-idle');
    const waiting = candidate('milestone', 'cd_wait');
    const item = approved(candidate('milestone', 'cd_done'));
    bridgeStore.expire({ now: at(30 * DAY) });
    const rows = store.getDb().prepare("SELECT * FROM bridge_audit WHERE op = 'expire' ORDER BY audit_seq").all();
    assert.ok(rows.every((r) => r.actor === 'gateway' && r.outcome === 'expired'));
    assert.deepEqual(rows.map((r) => JSON.parse(r.detail_json)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), [
      { what: 'candidate', candidateId: waiting, kind: 'milestone' },
      { what: 'outbound', outboundId: blocked, kind: 'notification', type: 'work-blocked' },
      { what: 'outbound', outboundId: idle, kind: 'notification', type: 'fleet-idle' },
      { what: 'outbound', outboundId: item, kind: 'candidate', type: 'milestone' }
    ].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
    assert.deepEqual(bridgeStore.expire({ now: at(31 * DAY) }), { outbound: 0, candidates: 0 }, 'nothing is let go twice');
    assert.equal(store.getDb().prepare("SELECT COUNT(*) AS n FROM bridge_audit WHERE op = 'expire'").get().n, 4);
  });

  it('a notification that expired is not raised again from the record that caused it', () => {
    const realDeps = { ...bridgeNotify._deps };
    let clock = at(1000);
    Object.assign(bridgeNotify._deps, { now: () => clock, lanes: () => [] });
    bridgeNotify._reset();
    try {
      bridgeStore.settings.set('enabled', 'true');
      bridgeStore.settings.set(bridgeNotify.ENABLED_AT, T0);
      store.workloadReceipts.append({
        project_id: project.id, session_id: bound.sessionId, launch_id: bound.launchId, assignment_id: null,
        state: 'blocked', clearance: 'do-not-clear', summary: 'stuck', wait_kind: null, wait_detail: null,
        refs_json: '{}', branch: null, head_sha: null, source: 'tc-cli', received_at: clock
      }, { minIntervalMs: 0, nowMs: Date.parse(clock) });
      assert.equal(bridgeNotify.reconcile().workBlocked, 1);

      // Its receipt is still inside the notifier's lookback when it expires
      // only if the lookback were longer than the limit; either way, the key stays.
      clock = at(7 * DAY + 5000);
      assert.equal(bridgeStore.expire({ now: clock }).outbound, 1);
      assert.equal(bridgeNotify.reconcile().workBlocked, 0);
      clock = at(1000 + 60 * 1000);
      assert.equal(bridgeNotify.reconcile().workBlocked, 0, 'even with the clock back inside the lookback, the dropped item\'s key stands');
      assert.equal(store.getDb().prepare("SELECT COUNT(*) AS n FROM bridge_outbound WHERE kind = 'notification'").get().n, 1);
    } finally {
      Object.assign(bridgeNotify._deps, realDeps);
    }
  });
});
