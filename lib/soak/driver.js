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
const dns = require('node:dns').promises;

const scheduleLib = require('./schedule');

const LOG_SCHEMA = 'tc.soak-log/v1';

/** Closed set of reasons the driver refuses to run. */
const REFUSAL = Object.freeze({
  INVALID_SCHEDULE: 'INVALID_SCHEDULE',
  NO_EXECUTOR: 'NO_EXECUTOR',
  LIVE_INSTALL_TARGET: 'LIVE_INSTALL_TARGET',
  LIVE_IDENTITY_UNREADABLE: 'LIVE_IDENTITY_UNREADABLE',
  TARGET_UNRESOLVED: 'TARGET_UNRESOLVED',
  GUARD_CONTEXT_ABSENT: 'GUARD_CONTEXT_ABSENT',
  LOG_LOCKED: 'LOG_LOCKED',
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
 * A host in one canonical spelling, so that aliases compare equal: lower
 * case, IPv6 brackets removed, trailing dots removed (`localhost.` is
 * `localhost`), and an IPv4-mapped IPv6 address (`::ffff:127.0.0.1`, which
 * WHATWG URL reports as `[::ffff:7f00:1]`) reduced to its IPv4 form. Numeric
 * IPv4 spellings such as `2130706433` or `0x7f.1` need nothing here, because
 * URL parsing already normalizes them to dotted form.
 * @param {string} host - `URL.hostname` or a resolved address
 * @returns {string} Canonical host
 */
function canonicalHost(host) {
  let h = host.toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  h = h.replace(/\.+$/, '');
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hex) {
    const a = parseInt(hex[1], 16);
    const b = parseInt(hex[2], 16);
    return `${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`;
  }
  return h;
}

/**
 * Whether a host names this machine: loopback in any spelling (all of
 * 127.0.0.0/8, `::1`, `localhost` and every `*.localhost` name, which
 * resolvers must send to loopback), the wildcard addresses, the hostname and
 * names under it, and every local interface address.
 * @param {string} host - A host or address, in any spelling
 * @param {{exact: Set<string>, hostnamePrefix: string}} names - From `localNames`
 * @returns {boolean} True for this machine
 */
function _isLocal(host, names) {
  const h = canonicalHost(host);
  return h === 'localhost' || h.endsWith('.localhost') || /^127\./.test(h) || h === '::1' || h === '0.0.0.0' || h === '::'
    || names.exact.has(h) || h.startsWith(names.hostnamePrefix);
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
 * port on this machine, in either scheme (see `_isLocal`). This check reads
 * only the spelling. `refuseLiveResolved` adds what DNS says the name means,
 * and `refuseSameInstall` covers a route on another port, such as a reverse
 * proxy.
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
 * Refuse a target whose name RESOLVES to this machine on the live port. This
 * catches any name that no spelling rule anticipates, such as an /etc/hosts
 * entry or a DNS record pointing at a local address.
 *
 * It fails closed. A name that does not resolve now, or resolves to nothing,
 * is refused (`TARGET_UNRESOLVED`), because it could resolve to this machine
 * later in the run, and an answer that cannot be checked is not a safe one.
 * @param {object} opts - Options
 * @param {string} opts.apiBase - Target
 * @param {string|undefined} opts.liveApi - `TANGLECLAW_API`, if any
 * @param {{exact: Set<string>, hostnamePrefix: string}} [opts.names] - Local names
 * @param {(host: string) => Promise<string[]>} [opts.lookup] - Resolver returning every address, injectable for tests
 * @returns {Promise<void>} Resolves when the target is not the live install
 * @throws {DriverRefusal} `LIVE_INSTALL_TARGET` or `TARGET_UNRESOLVED`
 */
async function refuseLiveResolved(opts) {
  if (!opts.liveApi) return;
  const target = new URL(opts.apiBase);
  const live = new URL(opts.liveApi);
  const local = opts.names || localNames();
  if (_port(target) !== _port(live)) return;
  const lookup = opts.lookup || (async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((a) => a.address));
  // Whether the live install is on this machine is decided the same way as
  // for the target, by spelling OR by resolution. TANGLECLAW_API may name
  // this machine by a Tailscale or LAN name that is not its hostname, and
  // then only resolution shows that 127.0.0.1 on the same port reaches it.
  // A live name that does not resolve counts as local: when in doubt, protect.
  let liveLocal = _isLocal(live.hostname, local);
  if (!liveLocal) {
    try {
      const liveAddrs = await lookup(canonicalHost(live.hostname));
      liveLocal = !Array.isArray(liveAddrs) || liveAddrs.length === 0 || liveAddrs.some((a) => _isLocal(a, local));
    } catch (err) { // prawduct:allow prawduct/broad-except -- resolver boundary: an unresolvable live name is treated as local, the protective answer
      liveLocal = true;
    }
  }
  if (!liveLocal) return;
  if (_isLocal(target.hostname, local)) {
    throw new DriverRefusal(REFUSAL.LIVE_INSTALL_TARGET, `refusing to run a soak against ${target.origin}: it is this machine on the live port, and ${live.hostname} resolves to this machine too`, { target: target.origin });
  }
  let addresses;
  try {
    addresses = await lookup(canonicalHost(target.hostname));
  } catch (err) { // prawduct:allow prawduct/broad-except -- resolver boundary: every lookup failure is the same refusal, with the resolver's code
    throw new DriverRefusal(REFUSAL.TARGET_UNRESOLVED, `refusing to run: ${target.hostname} did not resolve (${(err && err.code) || err}), so it cannot be shown not to be this machine`, { target: target.origin, code: err && err.code });
  }
  if (!Array.isArray(addresses) || addresses.length === 0) {
    throw new DriverRefusal(REFUSAL.TARGET_UNRESOLVED, `refusing to run: ${target.hostname} resolved to no address`, { target: target.origin });
  }
  const hit = addresses.find((a) => _isLocal(a, local));
  if (hit) {
    throw new DriverRefusal(REFUSAL.LIVE_INSTALL_TARGET, `refusing to run a soak against ${target.origin}: ${target.hostname} resolves to ${hit}, this machine, on the live port`, { target: target.origin, address: hit });
  }
}

/**
 * Refuse to run with no live-install guard context, unless the operator says
 * so explicitly. Every guard compares the target with `TANGLECLAW_API`, so a
 * run started where that is unset (a plain shell, cron, launchd) is not
 * guarded at all. That is correct inside the soak guest, where the driver
 * targets the guest's own TangleClaw, but it has to be stated, not assumed.
 * The override is recorded in the log header by the caller.
 * @param {string|undefined} liveApi - `TANGLECLAW_API`, if any
 * @param {boolean} override - The operator's explicit `--no-live-install`
 * @returns {boolean} True when the run proceeds on the override
 * @throws {DriverRefusal} `GUARD_CONTEXT_ABSENT`
 */
function requireGuardContext(liveApi, override) {
  if (liveApi) return false;
  if (override) return true;
  throw new DriverRefusal(REFUSAL.GUARD_CONTEXT_ABSENT, 'refusing to run: TANGLECLAW_API is not set, so nothing can check that the target is not a live install. Inside the soak guest, pass --no-live-install to say so');
}

/**
 * Refuse a target that identifies itself as the same running server as the
 * live install. Both are asked for `/api/server-info`; the same `startedAt`
 * and `startupSha` means one process, whatever address reached it. This is
 * what catches a route the address checks cannot see, such as a reverse proxy
 * in front of the live install on another port.
 *
 * The two sides fail differently, on purpose:
 * - **The live side** is the thing being protected. When `TANGLECLAW_API` is
 *   set but its identity cannot be read (an error, a timeout, a non-200, or no
 *   `startedAt`/`startupSha`), the check refuses (`LIVE_IDENTITY_UNREADABLE`)
 *   unless `allowUnverifiedLive` is given. The caller records that override.
 * - **The target side** failing only means the comparison cannot be made. A
 *   target that answers nothing, or answers `401`, answers the load the same
 *   way, so nothing can be written through it. That is reported as unchecked.
 *
 * With no `TANGLECLAW_API` there is no live install to protect from this
 * process. That is the soak guest's normal case: the driver runs there
 * against the guest's own TangleClaw.
 * @param {object} opts - Options
 * @param {string} opts.apiBase - Target
 * @param {string|undefined} opts.liveApi - `TANGLECLAW_API`, if any
 * @param {Function} opts.fetch - Fetch implementation
 * @param {string|null} [opts.token] - Service token for the target
 * @param {boolean} [opts.allowUnverifiedLive] - Proceed when the live identity is unreadable
 * @returns {Promise<{checked: boolean, reason: string|null, liveUnverified: boolean}>} What the comparison established
 * @throws {DriverRefusal} `LIVE_INSTALL_TARGET` or `LIVE_IDENTITY_UNREADABLE`
 */
async function refuseSameInstall(opts) {
  if (!opts.liveApi) return { checked: false, reason: 'no TANGLECLAW_API in this pane', liveUnverified: false };
  const read = async (base, token) => {
    try {
      const res = await opts.fetch(new URL('/api/server-info', base), {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(10 * 1000)
      });
      if (res.status !== 200) return { error: `HTTP ${res.status}` };
      const body = JSON.parse(await res.text());
      if (!body || !body.startedAt || !body.startupSha) return { error: 'no startedAt/startupSha' };
      return { body };
    } catch (err) { // prawduct:allow prawduct/broad-except -- network boundary: an unreadable side becomes a reason, and each side's caller decides what that means
      return { error: String((err && (err.name === 'TimeoutError' ? 'timeout' : err.message)) || err) };
    }
  };
  const [live, target] = await Promise.all([read(opts.liveApi, null), read(opts.apiBase, opts.token || null)]);
  if (live.error) {
    const reason = `live install server-info: ${live.error}`;
    if (!opts.allowUnverifiedLive) {
      throw new DriverRefusal(REFUSAL.LIVE_IDENTITY_UNREADABLE, `refusing to run: cannot read the live install's identity (${reason}), so the target cannot be shown to be a different server. Pass --allow-unverified-live to proceed anyway`, { reason });
    }
    return { checked: false, reason, liveUnverified: true };
  }
  if (target.error) return { checked: false, reason: `target server-info: ${target.error}`, liveUnverified: false };
  if (live.body.startedAt === target.body.startedAt && live.body.startupSha === target.body.startupSha) {
    throw new DriverRefusal(REFUSAL.LIVE_INSTALL_TARGET, `refusing to run a soak against ${new URL(opts.apiBase).origin}: it reports the same running server as this pane's TangleClaw (started ${live.body.startedAt})`, { target: new URL(opts.apiBase).origin });
  }
  return { checked: true, reason: null, liveUnverified: false };
}

/**
 * Read an existing log without changing it.
 *
 * A crash mid-write can leave a final line without its newline. That torn
 * tail is reported (`tornTail`) and its event counts as not run, so it runs
 * again. The file itself is left as it is: `sealTornTail` closes the fragment
 * by appending after it, under the lock, so no byte of evidence is ever
 * rewritten or removed. A malformed line is accepted only where a seal
 * record directly follows it. Anywhere else it is refused, because the log
 * can no longer be trusted as evidence.
 * @param {string} logPath - Log file
 * @returns {{header: object|null, lastIndex: number, ended: boolean, tornTail: boolean, tornBytes: number, lastStartedAt: number|null, lastFaultStartedAt: number|null}} What the log records
 * @throws {DriverRefusal} `LOG_UNREADABLE`
 */
function readLog(logPath) {
  let text;
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { header: null, lastIndex: -1, ended: false, tornTail: false, tornBytes: 0, lastStartedAt: null, lastFaultStartedAt: null };
    throw new DriverRefusal(REFUSAL.LOG_UNREADABLE, `cannot read ${logPath}: ${err.code || err.message}`);
  }
  let tornTail = false;
  let tornBytes = 0;
  if (text.length > 0 && !text.endsWith('\n')) {
    const keep = text.lastIndexOf('\n') + 1;
    tornTail = true;
    tornBytes = Buffer.byteLength(text.slice(keep));
    text = text.slice(0, keep);
  }
  const lines = text.split('\n').filter((l) => l.length > 0);
  const parsed = lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      return undefined;
    }
  });
  const records = [];
  parsed.forEach((r, i) => {
    if (r !== undefined) {
      records.push(r);
      return;
    }
    const next = parsed[i + 1];
    if (!(next && next.type === 'torn-tail-sealed')) {
      throw new DriverRefusal(REFUSAL.LOG_UNREADABLE, `line ${i + 1} of ${logPath} is not JSON and was never sealed as a torn write`);
    }
  });
  const header = records.length > 0 ? records[0] : null;
  if (!header && (tornTail || lines.length > 0)) {
    throw new DriverRefusal(REFUSAL.LOG_UNREADABLE, `${logPath} has no complete header; it cannot be resumed`);
  }
  if (header && (header.type !== 'header' || header.schema !== LOG_SCHEMA)) {
    throw new DriverRefusal(REFUSAL.LOG_UNREADABLE, `${logPath} does not start with a ${LOG_SCHEMA} header`);
  }
  // Every slot is computed from startEpochMs. A missing or non-numeric value
  // would make every slot NaN, and every event would fire at once.
  if (header && (!Number.isSafeInteger(header.startEpochMs) || header.startEpochMs <= 0 || typeof header.scheduleDigest !== 'string')) {
    throw new DriverRefusal(REFUSAL.LOG_UNREADABLE, `${logPath} has a header without a valid startEpochMs and scheduleDigest`);
  }
  let lastIndex = -1;
  let ended = false;
  let lastStartedAt = null;
  let lastFaultStartedAt = null;
  for (const r of records.slice(1)) {
    if (r.type === 'event' && Number.isInteger(r.index)) {
      lastIndex = Math.max(lastIndex, r.index);
      if (Number.isFinite(r.startedAt)) {
        lastStartedAt = r.startedAt;
        if (typeof r.kind === 'string' && r.kind.startsWith('fault.') && !r.skipped) lastFaultStartedAt = r.startedAt;
      }
    }
    if (r.type === 'end') ended = true;
  }
  return { header, lastIndex, ended, tornTail, tornBytes, lastStartedAt, lastFaultStartedAt };
}

/**
 * Close a torn final line by appending after it: a newline that ends the
 * fragment as a line of its own, then a seal record naming its size. Nothing
 * already in the file changes, and the next `readLog` accepts the fragment
 * because the seal follows it.
 * @param {string} logPath - Log file
 * @param {number} tornBytes - Size of the fragment
 * @param {number} at - Clock time
 */
function sealTornTail(logPath, tornBytes, at) {
  const fd = fs.openSync(logPath, 'a', 0o600);
  try {
    fs.writeSync(fd, `\n${JSON.stringify({ type: 'torn-tail-sealed', at, bytes: tornBytes })}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Take the log's lock, so two drivers can never append to the same log, or
 * seal the same torn tail twice. The lock file records the holder's pid and host. A lock left by a
 * process on this host that no longer exists is reclaimed, and the reclaim is
 * reported. Any other lock refuses the run: a live holder, or a holder on
 * another host whose liveness cannot be checked from here.
 * @param {string} logPath - Log file
 * @param {object} [deps] - `{pid, host, isAlive}`, injectable for tests
 * @returns {{release: () => void, reclaimed: object|null}} The lock
 * @throws {DriverRefusal} `LOG_LOCKED`
 */
function acquireLogLock(logPath, deps = {}) {
  const lockPath = `${logPath}.lock`;
  const pid = deps.pid || process.pid;
  const host = deps.host || os.hostname();
  const isAlive = deps.isAlive || ((p) => {
    try {
      process.kill(p, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  });
  let reclaimed = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, JSON.stringify({ pid, host }), { flag: 'wx', mode: 0o600 });
      return { release: () => fs.rmSync(lockPath, { force: true }), reclaimed };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    let holder = null;
    try {
      holder = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    } catch (err) {
      if (!(err instanceof SyntaxError) && err.code !== 'ENOENT') throw err;
    }
    const stale = holder && holder.host === host && Number.isInteger(holder.pid) && !isAlive(holder.pid);
    if (attempt === 0 && stale) {
      fs.rmSync(lockPath, { force: true });
      reclaimed = holder;
      continue;
    }
    throw new DriverRefusal(REFUSAL.LOG_LOCKED, `${logPath} is locked by ${holder ? `pid ${holder.pid} on ${holder.host}` : 'an unreadable lock file'}; remove ${lockPath} only if no driver is running`, { holder });
  }
  throw new DriverRefusal(REFUSAL.LOG_LOCKED, `${logPath} lock could not be taken`);
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

/** The minimum gap between two events while the run is behind schedule. */
const CATCH_UP_GAP_MS = 1000;

/** A load event this far past its slot is skipped and recorded, not run. */
const STALE_LOAD_MS = 60 * 1000;

/** The longest a stop request waits while the driver is waiting for a slot. */
const STOP_POLL_MS = 1000;

/**
 * Run a schedule to its end, or until `shouldStop` says to stop.
 *
 * On time, every event runs at its slot. Behind schedule, for example after
 * the driver was down, three rules apply, and each record says which:
 * - A load event more than `staleLoadMs` past its slot is skipped and logged
 *   (`skipped: true`, `SKIPPED_STALE`), never run late in a burst.
 * The two pacing rules (`paced`):
 * - A fault never starts within `faultQuietMs` of the previous fault's start,
 *   counting faults the log shows ran before an interruption. The schedule's
 *   quiet-window invariant therefore holds at run time, not only on paper.
 * - Overdue events run at least `catchUpGapMs` apart, never as one burst
 *   straight after whatever caused the delay.
 * `lateMs` records how far each event started after its slot.
 * @param {object} opts - Options
 * @param {object} opts.schedule - A schedule (see `lib/soak/schedule`)
 * @param {Object<string, Function>} opts.executors - Executors by kind
 * @param {object} opts.ctx - Passed to every executor (`{apiBase, token, fetch, timeoutMs}`)
 * @param {string} opts.logPath - The ndjson log to create or resume
 * @param {{now: () => number, sleep: (ms: number) => Promise<void>}} opts.clock - Wall clock, injectable for tests
 * @param {() => boolean} [opts.shouldStop] - Checked before each event
 * @param {number} [opts.catchUpGapMs] - Minimum gap between overdue events (default `CATCH_UP_GAP_MS`)
 * @param {number} [opts.staleLoadMs] - Lateness past which load is skipped (default `STALE_LOAD_MS`)
 * @param {number} [opts.stopPollMs] - Longest wait between stop checks (default `STOP_POLL_MS`)
 * @param {object} [opts.headerExtra] - Extra header fields for a new log, e.g. an identity override
 * @param {object} [opts.lockDeps] - Lock dependencies, injectable for tests (see `acquireLogLock`)
 * @returns {Promise<{status: 'completed'|'stopped'|'already-complete', ran: number, resumedFrom: number, tornTail: boolean, skipped: number}>} Result
 * @throws {DriverRefusal} When the run cannot start
 */
async function runSchedule(opts) {
  const { schedule, executors } = opts;
  const shouldStop = opts.shouldStop || (() => false);

  const violations = scheduleLib.validateSchedule(schedule);
  if (violations.length > 0) {
    throw new DriverRefusal(REFUSAL.INVALID_SCHEDULE, `schedule is invalid: ${violations.slice(0, 5).map((v) => v.code).join(', ')}`, { violations });
  }
  const missing = [...new Set(schedule.events.map((e) => e.kind))].filter((k) => typeof executors[k] !== 'function');
  if (missing.length > 0) {
    throw new DriverRefusal(REFUSAL.NO_EXECUTOR, `no executor for: ${missing.join(', ')}`, { kinds: missing });
  }

  const lock = acquireLogLock(opts.logPath, opts.lockDeps);
  try {
    return await _runLocked(opts, shouldStop, lock.reclaimed);
  } finally {
    lock.release();
  }
}

/**
 * The body of `runSchedule`, run while holding the log lock.
 * @param {object} opts - As for `runSchedule`
 * @param {() => boolean} shouldStop - Stop check
 * @param {object|null} reclaimed - A stale lock holder that was reclaimed, if any
 * @returns {Promise<object>} As for `runSchedule`
 */
async function _runLocked(opts, shouldStop, reclaimed) {
  const { schedule, executors, ctx, logPath, clock } = opts;
  const catchUpGapMs = opts.catchUpGapMs === undefined ? CATCH_UP_GAP_MS : opts.catchUpGapMs;
  const staleLoadMs = opts.staleLoadMs === undefined ? STALE_LOAD_MS : opts.staleLoadMs;
  const stopPollMs = opts.stopPollMs === undefined ? STOP_POLL_MS : opts.stopPollMs;
  // Read through the normalizer, never straight from the file, so the value
  // used at run time is the value validation checked.
  const faultQuietMs = scheduleLib.normalizeParams(schedule.params).faultQuietMs;
  const log = readLog(logPath);
  if (log.header && log.header.scheduleDigest !== schedule.digest) {
    throw new DriverRefusal(REFUSAL.LOG_MISMATCH, `${logPath} belongs to schedule ${log.header.scheduleDigest}, not ${schedule.digest}`);
  }
  if (log.ended) return { status: 'already-complete', ran: 0, resumedFrom: log.lastIndex + 1, tornTail: log.tornTail, skipped: 0 };
  if (log.tornTail) sealTornTail(logPath, log.tornBytes, clock.now());

  let startEpochMs;
  if (log.header) {
    startEpochMs = log.header.startEpochMs;
  } else {
    startEpochMs = clock.now();
    appendRecord(logPath, { type: 'header', schema: LOG_SCHEMA, scheduleDigest: schedule.digest, phase: schedule.params.phase, seed: schedule.params.seed, startEpochMs, ...(opts.headerExtra || {}) });
  }
  if (reclaimed) appendRecord(logPath, { type: 'lock-reclaimed', at: clock.now(), holder: reclaimed });

  const resumedFrom = log.lastIndex + 1;
  let lastStartedAt = log.lastStartedAt;
  let lastFaultStartedAt = log.lastFaultStartedAt;
  let ran = 0;
  let skipped = 0;
  for (const event of schedule.events.slice(resumedFrom)) {
    if (shouldStop()) return { status: 'stopped', ran, resumedFrom, tornTail: log.tornTail, skipped };
    const due = startEpochMs + event.atMs;
    // Load that is already stale is recorded as skipped, not run: a backlog
    // replayed after an outage is not the load the schedule described, and
    // running it would only hammer a server that has just recovered. Faults
    // are never skipped. They are deferred, below.
    if (event.class !== 'fault' && clock.now() - due > staleLoadMs) {
      appendRecord(logPath, { type: 'event', index: event.index, kind: event.kind, scheduledAt: due, startedAt: null, lateMs: clock.now() - due, paced: null, skipped: true, ok: null, code: 'SKIPPED_STALE' });
      skipped++;
      continue;
    }
    let startAt = due;
    let paced = null;
    if (event.class === 'fault' && lastFaultStartedAt !== null && lastFaultStartedAt + faultQuietMs > startAt) {
      startAt = lastFaultStartedAt + faultQuietMs;
      paced = 'quiet-window';
    }
    if (clock.now() > due && lastStartedAt !== null && lastStartedAt + catchUpGapMs > startAt) {
      startAt = lastStartedAt + catchUpGapMs;
      paced = paced || 'catch-up';
    }
    // Wait in short slices, so a stop is honoured within a slice, not after
    // a deferred fault's whole quiet window.
    while (clock.now() < startAt) {
      if (shouldStop()) return { status: 'stopped', ran, resumedFrom, tornTail: log.tornTail, skipped };
      await clock.sleep(Math.min(stopPollMs, startAt - clock.now()));
    }
    if (shouldStop()) return { status: 'stopped', ran, resumedFrom, tornTail: log.tornTail, skipped };
    const startedAt = clock.now();
    let outcome;
    try {
      outcome = await executors[event.kind](ctx, event.params);
    } catch (err) { // prawduct:allow prawduct/broad-except -- a supervisor loop: one faulty executor must not end a 72-hour run
      // Executors resolve to outcomes by contract; one that throws is a bug in
      // the executor, recorded as such so the soak keeps its remaining load.
      outcome = { ok: false, code: 'EXECUTOR_THREW', status: null, error: String(err && err.message) };
    }
    // The outcome goes first, so no key an executor returns can overwrite the
    // fields resume depends on (type, index, kind, startedAt).
    appendRecord(logPath, {
      ...outcome,
      type: 'event',
      index: event.index,
      kind: event.kind,
      scheduledAt: due,
      startedAt,
      lateMs: Math.max(0, startedAt - due),
      paced,
      durationMs: clock.now() - startedAt
    });
    lastStartedAt = startedAt;
    if (event.class === 'fault') lastFaultStartedAt = startedAt;
    ran++;
  }
  appendRecord(logPath, { type: 'end', completedAt: clock.now(), events: schedule.events.length });
  return { status: 'completed', ran, resumedFrom, tornTail: log.tornTail, skipped };
}

module.exports = { LOG_SCHEMA, REFUSAL, CATCH_UP_GAP_MS, STALE_LOAD_MS, STOP_POLL_MS, DriverRefusal, acquireLogLock, requireGuardContext, sealTornTail, localNames, canonicalHost, refuseLiveTarget, refuseLiveResolved, refuseSameInstall, readLog, appendRecord, runSchedule };
