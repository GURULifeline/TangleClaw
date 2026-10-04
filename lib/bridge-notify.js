'use strict';

/*
 * The operator bridge's three typed server notifications (ADR 0023 Decisions
 * 8 and 9): `work-blocked`, `operator-needed` and `fleet-idle`.
 *
 * They are transport control the server writes, never anybody's prose. Each
 * is rendered from a fixed template that takes only values this module
 * resolved itself, and goes straight to the helper's mailbox.
 *
 * Nothing calls this when an event happens. A pass reads the records that
 * are the events (a workload receipt, an exchange fact, the lanes' current
 * receipts) and enqueues a notification for each one that has none, keyed by
 * the record that caused it. So a notification that could not be enqueued is
 * simply found again on the next pass under the same key, and one that was
 * enqueued is never made twice. Only records written while the bridge is
 * enabled are considered, so enabling it delivers no backlog.
 */

const store = require('./store');
const bridgeStore = require('./bridge-store');
const { createLogger } = require('./logger');

const log = createLogger('bridge-notify');

/** Setting holding when the bridge was last enabled: nothing older is notified. */
const ENABLED_AT = 'enabled.at';

/**
 * How far back a pass looks for events. A notification is enqueued within one
 * pass of its event, so anything older than this was either notified already
 * or happened while the bridge was off; the bound keeps the scan small.
 */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

/** Longest project name a template will show. */
const MAX_NAME = 60;

/** Seams, so tests supply the lanes and the clock. */
const _deps = {
  now: () => new Date().toISOString(),
  /** @returns {{sessionId: number, launchId: (string|null), receiptSeq: (number|null), availability: string}[]} */
  lanes: () => []
};

/**
 * Tell this module how to read the fleet's lanes. The server owns the
 * activity observer the composition needs, so it supplies the reader.
 * @param {() => object[]} reader - Returns one entry per live lane.
 * @returns {void}
 */
function setLaneReader(reader) {
  _deps.lanes = reader;
}

/**
 * A project's name as a template may show it: printable, single-line, bounded.
 * @param {number|null} projectId - Project id.
 * @returns {string}
 */
function _projectName(projectId) {
  const project = Number.isInteger(projectId) ? store.projects.get(projectId) : null;
  if (!project || typeof project.name !== 'string') return 'a project';
  // eslint-disable-next-line no-control-regex
  const clean = project.name.replace(/[\u0000-\u001F\u007F\u202A-\u202E\u2066-\u2069]/g, '').trim().slice(0, MAX_NAME);
  return clean || 'a project';
}

/**
 * The fixed templates. Each takes only values resolved here.
 * @type {Readonly<Record<string, function(object): string>>}
 */
const TEMPLATES = Object.freeze({
  'work-blocked': ({ project }) => `${project} reports its work is blocked.`,
  'operator-needed': ({ project }) => `A message to ${project} has gone unanswered long enough to need you.`,
  'fleet-idle': ({ lanes }) => `Every live session has finished its work and is clear (${lanes} ${lanes === 1 ? 'lane' : 'lanes'}). The fleet is waiting for work.`
});

/**
 * Enqueue one notification under its key. Idempotent: a key that already has
 * an item is left alone.
 * @param {string} type - Notification type.
 * @param {string} bound - What it is bound to: part of the key.
 * @param {object} values - Values for the template.
 * @returns {boolean} Whether this call created it.
 */
function _emit(type, bound, values) {
  const idemKey = `notify:${type}:${bound}`;
  const before = store.getDb().prepare('SELECT 1 FROM bridge_outbound WHERE idem_key = ?').get(idemKey);
  if (before) return false;
  const text = TEMPLATES[type](values);
  bridgeStore.outbound.enqueue({
    idemKey, kind: 'notification', notifyType: type, sourceLabel: 'TangleClaw', text, digest: bridgeStore.digest(text), at: _deps.now()
  });
  return true;
}

/**
 * The instant before which nothing is notified: when the bridge was enabled,
 * or the lookback bound, whichever is later.
 * @returns {string|null} Null when the bridge has no recorded enable time.
 */
function _since() {
  const enabledAt = bridgeStore.settings.get(ENABLED_AT);
  if (!enabledAt) return null;
  const floor = new Date(Date.parse(_deps.now()) - LOOKBACK_MS).toISOString();
  return enabledAt > floor ? enabledAt : floor;
}

/**
 * `work-blocked`: a lane's workload receipt entered `blocked`. Bound to that
 * receipt. A lane that stays blocked and reports again is not a new event.
 * @param {string} since - Earliest receipt time considered.
 * @returns {number} How many were enqueued.
 */
function _workBlocked(since) {
  const rows = store.getDb().prepare(
    "SELECT w.receipt_id, w.project_id FROM workload_receipts w WHERE w.state = 'blocked' AND w.received_at >= ? "
    + "AND NOT EXISTS (SELECT 1 FROM workload_receipts p WHERE p.launch_id = w.launch_id AND p.seq = w.seq - 1 AND p.state = 'blocked') "
    + 'ORDER BY w.receipt_id'
  ).all(since);
  let made = 0;
  for (const row of rows) {
    if (_emit('work-blocked', `receipt:${row.receipt_id}`, { project: _projectName(row.project_id) })) made += 1;
  }
  return made;
}

/**
 * `operator-needed`: the Medusa watchdog raised an exchange to its operator
 * rung. Bound to that exchange.
 * @param {string} since - Earliest fact time considered.
 * @returns {number} How many were enqueued.
 */
function _operatorNeeded(since) {
  const rows = store.getDb().prepare(
    "SELECT f.exchange_id, x.recipient_project_id FROM medusa_exchange_facts f JOIN medusa_exchanges x ON x.exchange_id = f.exchange_id "
    + "WHERE f.fact = 'operator_alerted' AND f.at >= ? ORDER BY f.fact_seq"
  ).all(since);
  let made = 0;
  for (const row of rows) {
    if (_emit('operator-needed', `exchange:${row.exchange_id}`, { project: _projectName(row.recipient_project_id) })) made += 1;
  }
  return made;
}

/**
 * `fleet-idle`: every live lane has finished and is clear. Fails closed: the
 * fleet must be non-empty, and every lane must be at a known launch with a
 * current receipt and read `AVAILABLE`, which the lane composition gives only
 * to a fresh `complete`, `safe-to-clear` receipt of the live launch with the
 * engine at rest. A lane that is working, waiting, blocked, stale or unknown
 * means the fleet is not idle.
 *
 * Bound to the episode: the exact set of lanes, launches and receipts that
 * made the fleet idle. Any change of membership or of any lane's receipt is a
 * different set, so the episode ends and a later idle spell is a new one.
 * @returns {number} 1 when a notification was enqueued, else 0.
 */
function _fleetIdle() {
  const lanes = _deps.lanes();
  if (!Array.isArray(lanes) || lanes.length === 0) return 0;
  for (const lane of lanes) {
    if (!lane || lane.availability !== 'AVAILABLE' || !lane.launchId || !Number.isInteger(lane.receiptSeq)) return 0;
  }
  const members = lanes.map((l) => `${l.sessionId}:${l.launchId}:${l.receiptSeq}`).sort();
  const episode = bridgeStore.digest(members.join('\n')).slice(0, 32);
  return _emit('fleet-idle', `episode:${episode}`, { lanes: lanes.length }) ? 1 : 0;
}

/**
 * One pass: enqueue a notification for every event that has none. Does
 * nothing while the bridge is disabled. Each kind is tried apart from the
 * others, and a failure is logged and left for the next pass.
 * @returns {{workBlocked: number, operatorNeeded: number, fleetIdle: number}}
 */
function reconcile() {
  const out = { workBlocked: 0, operatorNeeded: 0, fleetIdle: 0 };
  if (!bridgeStore.settings.isEnabled()) return out;
  const since = _since();
  if (!since) return out;
  const attempt = (name, work) => {
    try {
      out[name] = work();
    } catch (err) {
      log.warn('Bridge notification pass failed for one kind', { kind: name, error: err.message });
    }
  };
  attempt('workBlocked', () => _workBlocked(since));
  attempt('operatorNeeded', () => _operatorNeeded(since));
  attempt('fleetIdle', () => _fleetIdle());
  return out;
}

module.exports = { ENABLED_AT, TEMPLATES, setLaneReader, reconcile, _deps };
