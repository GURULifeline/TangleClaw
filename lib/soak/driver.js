'use strict';

/**
 * Execute a soak schedule (#2020) against the server under test, and keep an
 * append-only ndjson log of every outcome.
 *
 * The log is the run's evidence and its resume point:
 * - Its header binds it to one schedule digest and one start time.
 * - Resuming after an interruption continues from the first event with no
 *   logged outcome, so no event runs twice.
 * - Every event keeps its original wall-clock slot. An event whose slot passed
 *   while the driver was down runs at once, and its lateness is recorded
 *   rather than hidden.
 *
 * The driver judges nothing. Whether the soak passed is decided elsewhere,
 * from this log together with the release-certification evidence.
 *
 * @module lib/soak/driver
 */

const fs = require('node:fs');

const scheduleLib = require('./schedule');

const LOG_SCHEMA = 'tc.soak-log/v1';

/** Closed set of reasons the driver refuses to run. */
const REFUSAL = Object.freeze({
  INVALID_SCHEDULE: 'INVALID_SCHEDULE',
  NO_EXECUTOR: 'NO_EXECUTOR',
  LIVE_INSTALL_TARGET: 'LIVE_INSTALL_TARGET',
  LOG_MISMATCH: 'LOG_MISMATCH',
  LOG_UNREADABLE: 'LOG_UNREADABLE'
});

/** A refusal: the run did not start, and the reason is one of `REFUSAL`. */
class DriverRefusal extends Error {
  /**
   * @param {string} code - One of `REFUSAL`
   * @param {string} message - Human explanation
   * @param {object} [details] - Structured details
   */
  constructor(code, message, details) {
    super(message);
    this.name = 'DriverRefusal';
    this.code = code;
    this.details = details || {};
  }
}

/**
 * Refuse a target that is the live install this process was launched from.
 * A soak's load includes writes (port leases, sessions), and pointing one at
 * the operator's real TangleClaw is the mistake this guard exists for. The
 * comparison is by origin, so a trailing slash or a path does not slip past.
 * @param {string} apiBase - The target the operator named
 * @param {string|undefined} liveApi - `TANGLECLAW_API` of the launching pane, if any
 * @throws {DriverRefusal} `LIVE_INSTALL_TARGET` when they are the same origin
 */
function refuseLiveTarget(apiBase, liveApi) {
  if (!liveApi) return;
  let target;
  let live;
  try {
    target = new URL(apiBase).origin;
    live = new URL(liveApi).origin;
  } catch (err) {
    // An unparseable TANGLECLAW_API cannot name the target; an unparseable
    // target is refused later, by the first request.
    if (err instanceof TypeError) return;
    throw err;
  }
  if (target === live) {
    throw new DriverRefusal(REFUSAL.LIVE_INSTALL_TARGET, `refusing to run a soak against ${target}: it is this pane's own TangleClaw (TANGLECLAW_API)`, { target });
  }
}

/**
 * Read an existing log. A final line cut short by a crash mid-write is
 * truncated away, since its event never has a complete record and must run
 * again. A malformed line anywhere else is refused, because the log can no
 * longer be trusted as evidence.
 * @param {string} logPath - Log file
 * @returns {{header: object|null, lastIndex: number, ended: boolean, truncated: boolean}} What the log records
 * @throws {DriverRefusal} `LOG_UNREADABLE`
 */
function readLog(logPath) {
  let text;
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { header: null, lastIndex: -1, ended: false, truncated: false };
    throw new DriverRefusal(REFUSAL.LOG_UNREADABLE, `cannot read ${logPath}: ${err.code || err.message}`);
  }
  let truncated = false;
  if (text.length > 0 && !text.endsWith('\n')) {
    const keep = text.lastIndexOf('\n') + 1;
    fs.truncateSync(logPath, Buffer.byteLength(text.slice(0, keep)));
    text = text.slice(0, keep);
    truncated = true;
  }
  const lines = text.split('\n').filter((l) => l.length > 0);
  const records = lines.map((line, i) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      throw new DriverRefusal(REFUSAL.LOG_UNREADABLE, `line ${i + 1} of ${logPath} is not JSON`);
    }
  });
  const header = records.length > 0 ? records[0] : null;
  if (header && (header.type !== 'header' || header.schema !== LOG_SCHEMA)) {
    throw new DriverRefusal(REFUSAL.LOG_UNREADABLE, `${logPath} does not start with a ${LOG_SCHEMA} header`);
  }
  let lastIndex = -1;
  let ended = false;
  for (const r of records.slice(1)) {
    if (r.type === 'event' && Number.isInteger(r.index)) lastIndex = Math.max(lastIndex, r.index);
    if (r.type === 'end') ended = true;
  }
  return { header, lastIndex, ended, truncated };
}

/**
 * Append one record and flush it to disk before returning, so a crash can
 * lose at most the event in flight.
 * @param {string} logPath - Log file
 * @param {object} record - Record
 */
function appendRecord(logPath, record) {
  const fd = fs.openSync(logPath, 'a', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(record)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Run a schedule to its end, or until `shouldStop` says to stop.
 * @param {object} opts - Options
 * @param {object} opts.schedule - A schedule (see `lib/soak/schedule`)
 * @param {Object<string, Function>} opts.executors - Executors by kind
 * @param {object} opts.ctx - Passed to every executor (`{apiBase, token, fetch, timeoutMs}`)
 * @param {string} opts.logPath - The ndjson log to create or resume
 * @param {{now: () => number, sleep: (ms: number) => Promise<void>}} opts.clock - Wall clock, injectable for tests
 * @param {() => boolean} [opts.shouldStop] - Checked before each event
 * @returns {Promise<{status: 'completed'|'stopped'|'already-complete', ran: number, resumedFrom: number, truncated: boolean}>} Result
 * @throws {DriverRefusal} When the run cannot start
 */
async function runSchedule(opts) {
  const { schedule, executors, ctx, logPath, clock } = opts;
  const shouldStop = opts.shouldStop || (() => false);

  const violations = scheduleLib.validateSchedule(schedule);
  if (violations.length > 0) {
    throw new DriverRefusal(REFUSAL.INVALID_SCHEDULE, `schedule is invalid: ${violations.slice(0, 5).map((v) => v.code).join(', ')}`, { violations });
  }
  const missing = [...new Set(schedule.events.map((e) => e.kind))].filter((k) => typeof executors[k] !== 'function');
  if (missing.length > 0) {
    throw new DriverRefusal(REFUSAL.NO_EXECUTOR, `no executor for: ${missing.join(', ')}`, { kinds: missing });
  }

  const log = readLog(logPath);
  if (log.header && log.header.scheduleDigest !== schedule.digest) {
    throw new DriverRefusal(REFUSAL.LOG_MISMATCH, `${logPath} belongs to schedule ${log.header.scheduleDigest}, not ${schedule.digest}`);
  }
  if (log.ended) return { status: 'already-complete', ran: 0, resumedFrom: log.lastIndex + 1, truncated: log.truncated };

  let startEpochMs;
  if (log.header) {
    startEpochMs = log.header.startEpochMs;
  } else {
    startEpochMs = clock.now();
    appendRecord(logPath, { type: 'header', schema: LOG_SCHEMA, scheduleDigest: schedule.digest, phase: schedule.params.phase, seed: schedule.params.seed, startEpochMs });
  }

  const resumedFrom = log.lastIndex + 1;
  let ran = 0;
  for (const event of schedule.events.slice(resumedFrom)) {
    if (shouldStop()) return { status: 'stopped', ran, resumedFrom, truncated: log.truncated };
    const due = startEpochMs + event.atMs;
    const wait = due - clock.now();
    if (wait > 0) await clock.sleep(wait);
    if (shouldStop()) return { status: 'stopped', ran, resumedFrom, truncated: log.truncated };
    const startedAt = clock.now();
    let outcome;
    try {
      outcome = await executors[event.kind](ctx, event.params);
    } catch (err) { // prawduct:allow prawduct/broad-except -- a supervisor loop: one faulty executor must not end a 72-hour run
      // Executors resolve to outcomes by contract; one that throws is a bug in
      // the executor, recorded as such so the soak keeps its remaining load.
      outcome = { ok: false, code: 'EXECUTOR_THREW', status: null, error: String(err && err.message) };
    }
    appendRecord(logPath, {
      type: 'event',
      index: event.index,
      kind: event.kind,
      scheduledAt: due,
      startedAt,
      lateMs: Math.max(0, startedAt - due),
      durationMs: clock.now() - startedAt,
      ...outcome
    });
    ran++;
  }
  appendRecord(logPath, { type: 'end', completedAt: clock.now(), events: schedule.events.length });
  return { status: 'completed', ran, resumedFrom, truncated: log.truncated };
}

module.exports = { LOG_SCHEMA, REFUSAL, DriverRefusal, refuseLiveTarget, readLog, appendRecord, runSchedule };
