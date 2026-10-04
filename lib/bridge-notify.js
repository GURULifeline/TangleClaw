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
 * found again on the next pass under the same key, for as long as its record
 * is inside the lookback, and one that was enqueued is never made twice. Only
 * records written since the bridge was last enabled are considered, so
 * enabling it delivers no backlog.
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

/** What this process has seen of the fleet, for telling one idle episode from the next. */
const _state = { episode: null, beginning: null, primedFor: null, resumed: false, warnedNoEnableTime: false };

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
 * Read every live lane through the fleet's own composition, so this module
 * and the fleet roster can never disagree about whether a lane is clear.
 * @param {(session: object, projectName: (string|null)) => {workload: object, composed: object}} composeLane - The roster's lane composition.
 * @returns {{sessionId: number, launchId: (string|null), receiptSeq: (number|null), availability: string}[]}
 */
function readLanes(composeLane) {
  return store.sessions.listLiveAll().map((session) => {
    const project = store.projects.get(session.projectId);
    const lane = composeLane(session, project ? project.name : null);
    const sequence = store.launchSequences.getBySession(session.id);
    const receipt = lane && lane.workload ? lane.workload.receipt : null;
    return {
      sessionId: session.id,
      launchId: sequence ? sequence.launchId : null,
      receiptSeq: receipt && Number.isInteger(receipt.seq) ? receipt.seq : null,
      availability: lane && lane.composed ? lane.composed.availability : 'UNKNOWN'
    };
  });
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

/** Lane readings that are evidence a lane is not finished and clear. */
const BUSY = Object.freeze(new Set(['WORKING', 'WAITING', 'BLOCKED', 'HELD', 'STOPPED']));

/**
 * What the fleet's lanes say right now.
 *
 * - `idle`: a non-empty fleet in which every lane is at a known launch with a
 *   current receipt and reads `AVAILABLE`, which the lane composition gives
 *   only to a fresh `complete`, `safe-to-clear` receipt of the live launch
 *   with the engine at rest.
 * - `busy`: there is evidence it is not idle. A lane is working, waiting,
 *   blocked, held or stopped, or there are no lanes at all.
 * - `unknown`: neither. A lane's engine has not been observed at rest yet (as
 *   after a server start), an observation lapsed, or a receipt went stale.
 *
 * The three are kept apart because they mean different things for an
 * episode. Only `idle` can begin one: not knowing is not idle. Only `busy`,
 * or a change of members, can end one: not knowing is not evidence that
 * anything changed.
 * @returns {{reading: ('idle'|'busy'|'unknown'), members: string}} `members`
 *   is the fleet's lanes as sorted `session:launch`, whatever they read.
 */
function _fleetReading() {
  const lanes = _deps.lanes();
  if (!Array.isArray(lanes)) return { reading: 'unknown', members: '' };
  if (lanes.length === 0) return { reading: 'busy', members: '' };
  const members = lanes.map((l) => `${l && l.sessionId}:${l && l.launchId}`).sort().join('\n');
  if (lanes.some((l) => l && BUSY.has(l.availability))) return { reading: 'busy', members };
  const idle = lanes.every((l) => l && l.availability === 'AVAILABLE' && l.launchId && Number.isInteger(l.receiptSeq));
  return { reading: idle ? 'idle' : 'unknown', members };
}

/**
 * The members of the last idle episode that was announced, as the digest its
 * notice was keyed by. The notice is the durable record of an episode: it
 * outlives the process, so an episode's identity survives a restart.
 * @returns {string|null}
 */
function _lastAnnouncedMembers() {
  const row = store.getDb().prepare(
    "SELECT idem_key FROM bridge_outbound WHERE kind = 'notification' AND notify_type = 'fleet-idle' ORDER BY outbound_id DESC LIMIT 1"
  ).get();
  return row ? row.idem_key.slice(row.idem_key.lastIndexOf(':') + 1) : null;
}

/**
 * `fleet-idle`: every live lane has finished and is clear.
 *
 * An episode is one spell of an idle fleet with the same members. It is
 * notified once, when it is seen to begin: the fleet read `idle` after there
 * was evidence it was not, or with different members. A lane that stays
 * finished and reports again is the same episode, and so is a spell in which
 * a reading lapsed and came back.
 *
 * The first reading that says anything, after this process starts or the
 * bridge is enabled, is taken as it is and not announced: an idle fleet found
 * then began its spell before anything here could see it. That is the
 * no-backlog rule for a condition, and while the server was down no lane
 * could have finished.
 * @param {string} enabledAt - When the bridge was last enabled.
 * @returns {number} 1 when a notification was enqueued, else 0.
 */
function _fleetIdle(enabledAt) {
  const now = _fleetReading();
  if (_state.primedFor !== enabledAt) {
    // Until a reading says something, there is nothing to take as the start.
    if (now.reading === 'unknown') return 0;
    _state.primedFor = enabledAt;
    _state.episode = now.reading === 'idle' ? now.members : null;
    _state.beginning = null;
    // The last episode announced is on record in its notice's key. Finding
    // the same members idle again after a start is that episode resumed.
    _state.resumed = now.reading === 'idle' && _lastAnnouncedMembers() === bridgeStore.digest(now.members).slice(0, 16);
    return 0;
  }
  if (_state.episode !== null) {
    // An open episode ends on evidence: a busy lane, or different members.
    const ended = now.reading === 'busy' || (now.members !== '' && now.members !== _state.episode);
    if (!ended) return 0;
    _state.episode = null;
    _state.resumed = false;
  }
  if (now.reading !== 'idle') {
    _state.beginning = null;
    return 0;
  }
  // One key for the episode, kept until its notice exists: a notice that
  // could not be enqueued is tried again under the same key, never a second one.
  if (!_state.beginning || _state.beginning.members !== now.members) {
    _state.beginning = { members: now.members, at: _deps.now() };
  }
  const lanes = now.members.split('\n').length;
  _emit('fleet-idle', `episode:${_state.beginning.at}:${bridgeStore.digest(now.members).slice(0, 16)}`, { lanes });
  _state.episode = now.members;
  _state.beginning = null;
  return 1;
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
  if (!since) {
    if (!_state.warnedNoEnableTime) {
      _state.warnedNoEnableTime = true;
      log.warn('Bridge is enabled with no recorded enable time — no notification will be raised until it is enabled again');
    }
    return out;
  }
  const attempt = (name, work) => {
    try {
      out[name] = work();
    } catch (err) {
      log.warn('Bridge notification pass failed for one kind', { kind: name, error: err.message });
    }
  };
  attempt('workBlocked', () => _workBlocked(since));
  attempt('operatorNeeded', () => _operatorNeeded(since));
  attempt('fleetIdle', () => _fleetIdle(bridgeStore.settings.get(ENABLED_AT)));
  return out;
}

/**
 * Forget what this process has seen of the fleet. For tests.
 * @returns {void}
 */
function _reset() {
  _state.episode = null;
  _state.beginning = null;
  _state.resumed = false;
  _state.primedFor = null;
  _state.warnedNoEnableTime = false;
}

module.exports = {
  ENABLED_AT, LOOKBACK_MS, TEMPLATES, setLaneReader, readLanes, reconcile, _deps, _reset,
  /** @returns {{open: boolean, resumed: boolean}} Whether an episode is open, and whether it was resumed from its notice after a start. */
  episode: () => ({ open: _state.episode !== null, resumed: _state.resumed })
};
