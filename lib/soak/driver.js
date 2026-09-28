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
const os = require('node:os');

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
 * The names this machine answers to: loopback in all its spellings, the
 * wildcard addresses, its hostname with and without a domain (a MagicDNS or LAN
 * name starts with it), and every local interface address.
 * @returns {{exact: Set<string>, hostnamePrefix: string}} Lower-cased names
 */
function localNames() {
  const exact = new Set(['localhost', '::1', '[::1]', '0.0.0.0', '::', '[::]']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      exact.add(a.address.toLowerCase());
      if (a.family === 'IPv6' || a.family === 6) exact.add(`[${a.address.toLowerCase()}]`);
    }
  }
  const hostname = os.hostname().toLowerCase();
  const short = hostname.split('.')[0];
  exact.add(hostname);
  exact.add(short);
  return { exact, hostnamePrefix: `${short}.` };
}

/**
 * Whether a URL host names this machine.
 * @param {string} host - `URL.hostname`
 * @param {{exact: Set<string>, hostnamePrefix: string}} names - From `localNames`
 * @returns {boolean} True for a local alias
 */
function _isLocal(host, names) {
  const h = host.toLowerCase();
  return names.exact.has(h) || /^127\./.test(h) || h.startsWith(names.hostnamePrefix);
}

/**
 * The port a URL connects to, filling in the scheme's default.
 * @param {URL} u - URL
 * @returns {string} Port
 */
function _port(u) {
  return u.port || (u.protocol === 'https:' ? '443' : '80');
}

/**
 * Refuse a target that is, by its address, the live install this process was
 * launched from. A soak's load includes writes (port leases, sessions), and
 * pointing one at the operator's real TangleClaw is the mistake this guard
 * exists for.
 *
 * The same origin is refused, and so is any spelling that reaches the same
 * port on this machine: `127.0.0.1` for `localhost`, `[::1]`, the hostname or
 * its MagicDNS name, a local interface address, or the other scheme. A route
 * to the live install that this cannot see (a reverse proxy on another port)
 * is `refuseSameInstall`'s job.
 * @param {string} apiBase - The target the operator named
 * @param {string|undefined} liveApi - `TANGLECLAW_API` of the launching pane, if any
 * @param {{exact: Set<string>, hostnamePrefix: string}} [names] - Local names, injectable for tests
 * @throws {DriverRefusal} `LIVE_INSTALL_TARGET`
 */
function refuseLiveTarget(apiBase, liveApi, names) {
  if (!liveApi) return;
  let target;
  let live;
  try {
    target = new URL(apiBase);
    live = new URL(liveApi);
  } catch (err) {
    // An unparseable TANGLECLAW_API cannot name the target; an unparseable
    // target is refused later, by the first request.
    if (err instanceof TypeError) return;
    throw err;
  }
  const local = names || localNames();
  const sameOrigin = target.origin === live.origin;
  const sameMachinePort = _port(target) === _port(live) && _isLocal(target.hostname, local) && _isLocal(live.hostname, local);
  if (sameOrigin || sameMachinePort) {
    throw new DriverRefusal(REFUSAL.LIVE_INSTALL_TARGET, `refusing to run a soak against ${target.origin}: it reaches this pane's own TangleClaw (TANGLECLAW_API ${live.origin})`, { target: target.origin });
  }
}

/**
 * Refuse a target that identifies itself as the same running server as the
 * live install. Both are asked for `/api/server-info`; the same `startedAt`
 * and `startupSha` means one process, whatever address reached it. This is
 * what catches a route `refuseLiveTarget` cannot see, such as a reverse proxy
 * in front of the live install on another port.
 *
 * It can only compare what it can read. When either side does not answer, it
 * returns `checked: false` with the reason, for the caller to report: a
 * target that cannot be reached cannot be written to either, and a pane with
 * no reachable live install has nothing to protect.
 * @param {object} opts - Options
 * @param {string} opts.apiBase - Target
 * @param {string|undefined} opts.liveApi - `TANGLECLAW_API`, if any
 * @param {Function} opts.fetch - Fetch implementation
 * @param {string|null} [opts.token] - Service token for the target
 * @returns {Promise<{checked: boolean, reason: string|null}>} Whether the comparison ran
 * @throws {DriverRefusal} `LIVE_INSTALL_TARGET` when both report the same process
 */
async function refuseSameInstall(opts) {
  if (!opts.liveApi) return { checked: false, reason: 'no TANGLECLAW_API in this pane' };
  const info = async (base, token) => {
    const res = await opts.fetch(new URL('/api/server-info', base), {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(10 * 1000)
    });
    if (res.status !== 200) return { error: `HTTP ${res.status}` };
    return { body: JSON.parse(await res.text()) };
  };
  let live;
  let target;
  try {
    [live, target] = await Promise.all([info(opts.liveApi, null), info(opts.apiBase, opts.token || null)]);
  } catch (err) { // prawduct:allow prawduct/broad-except -- network boundary: an unreadable side is reported as unchecked, never crashes the guard
    return { checked: false, reason: `server-info unreadable: ${err && err.message}` };
  }
  if (live.error) return { checked: false, reason: `live install server-info: ${live.error}` };
  if (target.error) return { checked: false, reason: `target server-info: ${target.error}` };
  const a = live.body || {};
  const b = target.body || {};
  if (!a.startedAt || !a.startupSha) return { checked: false, reason: 'live install server-info has no startedAt/startupSha' };
  if (a.startedAt === b.startedAt && a.startupSha === b.startupSha) {
    throw new DriverRefusal(REFUSAL.LIVE_INSTALL_TARGET, `refusing to run a soak against ${new URL(opts.apiBase).origin}: it reports the same running server as this pane's TangleClaw (started ${a.startedAt})`, { target: new URL(opts.apiBase).origin });
  }
  return { checked: true, reason: null };
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

module.exports = { LOG_SCHEMA, REFUSAL, DriverRefusal, localNames, refuseLiveTarget, refuseSameInstall, readLog, appendRecord, runSchedule };
