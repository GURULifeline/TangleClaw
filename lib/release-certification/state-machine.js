'use strict';

/**
 * Release-candidate certification: the pure state machine.
 *
 * A release candidate is certified by watching the exact commit run for 72
 * hours of healthy time. This module decides what each observation means and
 * does no I/O: the runner gathers structured observations, the store persists
 * what this module returns, and every rule about what counts lives here, so the
 * rules can be tested without a clock, a server or a disk.
 *
 * The model:
 * - A run is keyed to one 40-character candidate SHA, recorded in a manifest
 *   at admission. Nothing reads main, so later commits are never certified.
 * - Time is earned per interval between consecutive samples. An interval earns
 *   its monotonic duration only when both of its samples are healthy, the same
 *   runner process took them, it is no longer than the manifest's maximum
 *   interval, the server did not restart between them, and wall and
 *   monotonic time agree. A sleeping machine, a stopped runner, a server that
 *   restarted between samples or an unreachable probe therefore extends the
 *   run and never earns time.
 * - Unknown never counts as healthy. A probe that cannot say is an extension,
 *   not a pass.
 * - A hard-fail condition in any sample ends the run in `failed`.
 * - `extended` is not terminal: the next qualifying interval returns the run
 *   to `running`, and earned time is kept. The exception is a run that has
 *   earned its target without meeting the PTY-use target: it stays extended
 *   until that target is met, because more healthy time cannot fix it.
 * - Reaching the target leads to `awaiting-review`, never to `passed`. Only an
 *   operator's acceptance passes a run, because the PTY pool trend is judged by
 *   a person.
 *
 * @module lib/release-certification/state-machine
 */

const {
  SCHEMA, STATES, EXTEND, HARD_FAIL, TRANSITION, REFUSAL,
  CHECK_STATES, CertificationError, isTerminal, priority
} = require('./codes');

/**
 * The thresholds a certification is judged by. A manifest may carry different
 * values so a smoke test can compress 72 hours into minutes; `summarize`
 * reports whether a run used these, and only such a run certifies a release.
 * @type {Readonly<Record<string, number>>}
 */
const DEFAULT_THRESHOLDS = Object.freeze({
  targetQualifiedMs: 72 * 60 * 60 * 1000,
  maxIntervalMs: 150 * 1000,
  clockToleranceMs: 5 * 1000,
  ptyMinAttaches: 25,
  ptyMinDetaches: 25,
  ptyMinSpanMs: 6 * 60 * 60 * 1000,
  trendBucketMs: 60 * 60 * 1000
});

/** Pool-use trend points kept in state; an hourly trend fills this in about 83 days. */
const MAX_TREND_POINTS = 2000;

const SHA_RE = /^[0-9a-f]{40}$/;
const ACTOR_RE = /^[A-Za-z0-9._:@-]{1,128}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;
const TEXT_RE = /^[^\u0000-\u001f]{1,256}$/;
const MAX_REQUIRED_CHECKS = 64;

/**
 * Throw a refusal.
 * @param {string} code - A REFUSAL code
 * @param {string} message - Why
 * @param {object} [details] - Bounded facts
 * @returns {never}
 */
function _refuse(code, message, details) {
  throw new CertificationError(code, message, details);
}

/**
 * Whether a value is a non-negative safe integer.
 * @param {*} n - Value to test
 * @returns {boolean} True for 0, 1, 2, ...
 */
function _isCount(n) {
  return Number.isSafeInteger(n) && n >= 0;
}

/**
 * Merge and validate manifest thresholds over the defaults.
 * @param {object} [overrides] - Threshold overrides
 * @returns {Record<string, number>} Complete thresholds
 */
function _thresholds(overrides = {}) {
  const out = { ...DEFAULT_THRESHOLDS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!(key in DEFAULT_THRESHOLDS)) _refuse(REFUSAL.INVALID_MANIFEST, `unknown threshold ${key}`, { field: key });
    if (!Number.isSafeInteger(value) || value <= 0) _refuse(REFUSAL.INVALID_MANIFEST, `threshold ${key} must be a positive integer`, { field: key });
    out[key] = value;
  }
  return out;
}

/**
 * Validate the required-check names a manifest pins.
 * @param {*} checks - Candidate list
 * @returns {string[]} A copy of the list
 */
function _requiredChecks(checks) {
  if (!Array.isArray(checks) || checks.length > MAX_REQUIRED_CHECKS) {
    _refuse(REFUSAL.INVALID_MANIFEST, 'requiredChecks must be an array of at most 64 names', { field: 'requiredChecks' });
  }
  if (!checks.every((c) => typeof c === 'string' && TEXT_RE.test(c)) || new Set(checks).size !== checks.length) {
    _refuse(REFUSAL.INVALID_MANIFEST, 'requiredChecks must be unique non-empty names', { field: 'requiredChecks' });
  }
  return [...checks];
}

/**
 * Build a manifest: the immutable record of what is being certified and how.
 *
 * Fields a public reader must never see (paths, host, the ttyd pid inside its
 * generation) sit under `private`, so publishing a sanitized copy is a matter
 * of dropping one key rather than remembering which fields are sensitive.
 *
 * @param {object} input
 * @param {string} input.candidateSha - Exact 40-character lowercase SHA
 * @param {string} input.version - The version.json version the candidate carries
 * @param {string} input.repository - `owner/name` whose checks are judged
 * @param {string[]} input.requiredChecks - Required check names on the candidate
 * @param {number} input.createdAt - Epoch ms
 * @param {string} input.worktreePath - Absolute path of the detached worktree
 * @param {string} input.ttydGeneration - Owned ttyd generation at admission
 * @param {string} [input.host] - Host name the run is on
 * @param {object} [input.thresholds] - Threshold overrides (smoke tests only)
 * @returns {object} The manifest
 */
function buildManifest(input) {
  const { candidateSha, version, repository, requiredChecks, createdAt, worktreePath, ttydGeneration, host = null, thresholds } = input || {};
  if (typeof candidateSha !== 'string' || !SHA_RE.test(candidateSha)) _refuse(REFUSAL.INVALID_MANIFEST, 'candidateSha must be 40 lowercase hex characters', { field: 'candidateSha' });
  if (typeof version !== 'string' || !TEXT_RE.test(version)) _refuse(REFUSAL.INVALID_MANIFEST, 'version is required', { field: 'version' });
  if (typeof repository !== 'string' || !REPO_RE.test(repository)) _refuse(REFUSAL.INVALID_MANIFEST, 'repository must be owner/name', { field: 'repository' });
  if (!_isCount(createdAt)) _refuse(REFUSAL.INVALID_MANIFEST, 'createdAt must be epoch ms', { field: 'createdAt' });
  if (typeof worktreePath !== 'string' || !worktreePath.startsWith('/')) _refuse(REFUSAL.INVALID_MANIFEST, 'worktreePath must be absolute', { field: 'worktreePath' });
  if (typeof ttydGeneration !== 'string' || !TEXT_RE.test(ttydGeneration)) _refuse(REFUSAL.INVALID_MANIFEST, 'ttydGeneration is required', { field: 'ttydGeneration' });
  if (host !== null && (typeof host !== 'string' || !TEXT_RE.test(host))) _refuse(REFUSAL.INVALID_MANIFEST, 'host must be a name', { field: 'host' });
  return {
    schema: SCHEMA,
    candidateSha,
    version,
    repository,
    requiredChecks: _requiredChecks(requiredChecks),
    thresholds: _thresholds(thresholds),
    createdAt,
    private: { worktreePath, host, baseline: { ttydGeneration } }
  };
}

/**
 * Whether a manifest judges by the default thresholds, and so can certify a release.
 * @param {object} manifest - A manifest
 * @returns {boolean} True when every threshold equals its default
 */
function isCanonical(manifest) {
  return Object.entries(DEFAULT_THRESHOLDS).every(([k, v]) => manifest.thresholds[k] === v);
}

/**
 * Validate a sample's envelope. Observation contents are judged by `classify`,
 * where a malformed field is an unknown, not an error: probes fail in the field.
 * @param {*} sample - Candidate sample
 * @returns {void}
 */
function _validateSample(sample) {
  if (!sample || typeof sample !== 'object') _refuse(REFUSAL.INVALID_SAMPLE, 'sample must be an object');
  if (!_isCount(sample.wallAt)) _refuse(REFUSAL.INVALID_SAMPLE, 'wallAt must be epoch ms', { field: 'wallAt' });
  if (typeof sample.monoAt !== 'number' || !Number.isFinite(sample.monoAt) || sample.monoAt < 0) _refuse(REFUSAL.INVALID_SAMPLE, 'monoAt must be a monotonic ms reading', { field: 'monoAt' });
  if (typeof sample.runnerInstance !== 'string' || !TEXT_RE.test(sample.runnerInstance)) _refuse(REFUSAL.INVALID_SAMPLE, 'runnerInstance is required', { field: 'runnerInstance' });
  if (!sample.observations || typeof sample.observations !== 'object') _refuse(REFUSAL.INVALID_SAMPLE, 'observations must be an object', { field: 'observations' });
}

/**
 * A reason record.
 * @param {string} code - An EXTEND or HARD_FAIL code
 * @param {string} probe - The probe it came from
 * @param {object} [extra] - Bounded detail (`field` or `check`)
 * @returns {{code: string, probe: string}} The reason
 */
function _reason(code, probe, extra = {}) {
  return { code, probe, ...extra };
}

/**
 * Judge the worktree observation: the candidate itself.
 * @param {object|null} o - `{headSha, detached, dirty}`
 * @param {object} manifest - The manifest
 * @param {object} out - `{hardFails, extends}` accumulator
 * @returns {void}
 */
function _judgeWorktree(o, manifest, out) {
  const unknown = (field) => out.extends.push(_reason(EXTEND.PROBE_UNKNOWN, 'worktree', { field }));
  if (!o) return unknown('*');
  if (typeof o.headSha !== 'string') unknown('headSha');
  else if (o.headSha !== manifest.candidateSha) out.hardFails.push(_reason(HARD_FAIL.HEAD_DRIFT, 'worktree'));
  if (o.detached === false) out.hardFails.push(_reason(HARD_FAIL.WORKTREE_NOT_DETACHED, 'worktree'));
  else if (o.detached !== true) unknown('detached');
  if (o.dirty === true) out.hardFails.push(_reason(HARD_FAIL.WORKTREE_DIRTY, 'worktree'));
  else if (o.dirty !== false) unknown('dirty');
}

/**
 * Judge the server observation: the runtime claiming to be the candidate.
 * Only a SHA the server captured at boot proves what it runs; one it adopted
 * later is unproven, whatever its value.
 * @param {object|null} o - `{startupSha, shaBaselineSource, runningVersion, startedAt}`
 * @param {object} manifest - The manifest
 * @param {object} out - Accumulator
 * @returns {void}
 */
function _judgeServer(o, manifest, out) {
  const unknown = (field) => out.extends.push(_reason(EXTEND.PROBE_UNKNOWN, 'server', { field }));
  if (!o) return unknown('*');
  if (o.shaBaselineSource !== 'startup') out.extends.push(_reason(EXTEND.RUNTIME_UNPROVEN, 'server'));
  else if (typeof o.startupSha !== 'string') unknown('startupSha');
  else if (o.startupSha !== manifest.candidateSha) out.hardFails.push(_reason(HARD_FAIL.RUNTIME_SHA_MISMATCH, 'server'));
  if (typeof o.runningVersion !== 'string') unknown('runningVersion');
  else if (o.runningVersion !== manifest.version) out.hardFails.push(_reason(HARD_FAIL.VERSION_MISMATCH, 'server'));
  if (!_isCount(o.startedAt)) unknown('startedAt');
}

/**
 * The server process a sample observed, identified by its start time.
 * @param {object} sample - A sample
 * @returns {number|null} Server start epoch ms, or null when not observed
 */
function _serverInstance(sample) {
  const server = sample.observations.server;
  return server && _isCount(server.startedAt) ? server.startedAt : null;
}

/**
 * Judge the owned-ttyd observation.
 * @param {object|null} o - `{managed, generation, leakState, wedgedCount, orphanGate}`
 * @param {object} manifest - The manifest
 * @param {object} out - Accumulator
 * @returns {void}
 */
function _judgeTtyd(o, manifest, out) {
  const unknown = (field) => out.extends.push(_reason(EXTEND.PROBE_UNKNOWN, 'ttyd', { field }));
  const fail = (code) => out.hardFails.push(_reason(code, 'ttyd'));
  if (!o) return unknown('*');
  if (o.managed === false) fail(HARD_FAIL.TTYD_NOT_OWNED);
  else if (o.managed !== true) unknown('managed');
  if (typeof o.generation !== 'string') unknown('generation');
  else if (o.generation !== manifest.private.baseline.ttydGeneration) fail(HARD_FAIL.TTYD_GENERATION_CHANGED);
  if (o.leakState === 'fired') fail(HARD_FAIL.LEAK_FIRED);
  else if (o.leakState !== 'clear') unknown('leakState');
  if (!_isCount(o.wedgedCount)) unknown('wedgedCount');
  else if (o.wedgedCount > 0) fail(HARD_FAIL.WEDGED_CHILD);
  if (o.orphanGate === true) fail(HARD_FAIL.ORPHAN_GATE);
  else if (o.orphanGate !== false) unknown('orphanGate');
}

/**
 * Judge the GitHub observation. Only the checks the manifest pinned as
 * required matter, and only on the candidate SHA the probe was asked about.
 * @param {object|null} o - `{state: 'ok'|'unavailable', checks: {[name]: CHECK_STATES}}`
 * @param {object} manifest - The manifest
 * @param {object} out - Accumulator
 * @returns {void}
 */
function _judgeGithub(o, manifest, out) {
  if (!o || o.state !== 'ok' || !o.checks || typeof o.checks !== 'object') {
    out.extends.push(_reason(EXTEND.GITHUB_UNAVAILABLE, 'github'));
    return;
  }
  for (const check of manifest.requiredChecks) {
    const state = CHECK_STATES.includes(o.checks[check]) ? o.checks[check] : 'missing';
    if (state === 'failure') out.hardFails.push(_reason(HARD_FAIL.REQUIRED_CHECK_FAILED, 'github', { check }));
    else if (state !== 'success') out.extends.push(_reason(EXTEND.CHECKS_PENDING, 'github', { check }));
  }
}

/**
 * Whether a PTY-activity observation is well formed.
 * @param {*} o - `{instance, attaches, detaches, lastAt}`
 * @returns {boolean} True when usable
 */
function _ptyObservationValid(o) {
  return Boolean(o) && typeof o.instance === 'string' && TEXT_RE.test(o.instance)
    && _isCount(o.attaches) && _isCount(o.detaches)
    && (o.lastAt === null || _isCount(o.lastAt));
}

/**
 * Judge every observation in a sample against the manifest.
 * @param {object} manifest - The manifest
 * @param {object} observations - `{worktree, server, ttyd, github, pty}`
 * @returns {{hardFails: object[], extends: object[]}} Reasons, each list in priority order
 */
function classify(manifest, observations) {
  const out = { hardFails: [], extends: [] };
  _judgeWorktree(observations.worktree, manifest, out);
  _judgeServer(observations.server, manifest, out);
  _judgeTtyd(observations.ttyd, manifest, out);
  _judgeGithub(observations.github, manifest, out);
  if (!_ptyObservationValid(observations.pty)) out.extends.push(_reason(EXTEND.PROBE_UNKNOWN, 'pty', { field: '*' }));
  out.hardFails.sort((a, b) => priority(HARD_FAIL, a.code) - priority(HARD_FAIL, b.code));
  out.extends.sort((a, b) => priority(EXTEND, a.code) - priority(EXTEND, b.code));
  return out;
}

/**
 * Start PTY accounting at admission. Events the server counted before the
 * run began are the baseline, not evidence.
 * @param {object} o - A valid PTY observation
 * @returns {object} PTY state
 */
function _initPty(o) {
  return {
    instance: o.instance,
    baseAttaches: o.attaches,
    baseDetaches: o.detaches,
    rawAttaches: o.attaches,
    rawDetaches: o.detaches,
    carriedAttaches: 0,
    carriedDetaches: 0,
    attaches: 0,
    detaches: 0,
    firstEventAt: null,
    lastEventAt: null
  };
}

/**
 * Fold a PTY observation into PTY state.
 *
 * The server's counters live in memory and restart from zero with it, so a new
 * server instance carries the totals already seen and counts from zero. A
 * counter that goes backwards within one instance is not believed.
 *
 * Event times are conservative: the first event is dated by the server's
 * latest event when an increase is first seen, which is no earlier than the
 * real first event, so the measured span never exceeds the true one.
 *
 * @param {object} p - PTY state (mutated)
 * @param {object} o - A PTY observation
 * @param {number} wallAt - The sample's wall time
 * @returns {void}
 */
function _foldPty(p, o, wallAt) {
  if (!_ptyObservationValid(o)) return;
  if (o.instance !== p.instance) {
    p.instance = o.instance;
    p.carriedAttaches = p.attaches;
    p.carriedDetaches = p.detaches;
    p.baseAttaches = 0;
    p.baseDetaches = 0;
  } else if (o.attaches < p.rawAttaches || o.detaches < p.rawDetaches) {
    return;
  }
  p.rawAttaches = o.attaches;
  p.rawDetaches = o.detaches;
  const attaches = p.carriedAttaches + o.attaches - p.baseAttaches;
  const detaches = p.carriedDetaches + o.detaches - p.baseDetaches;
  if (attaches + detaches > p.attaches + p.detaches) {
    const eventAt = o.lastAt === null ? wallAt : Math.min(o.lastAt, wallAt);
    if (p.firstEventAt === null) p.firstEventAt = eventAt;
    p.lastEventAt = Math.max(p.lastEventAt ?? eventAt, eventAt);
  }
  p.attaches = attaches;
  p.detaches = detaches;
}

/**
 * Whether the PTY-use target is met.
 * @param {object} p - PTY state
 * @param {object} t - Thresholds
 * @returns {boolean} True when attaches, detaches and span all reach their minimums
 */
function ptyTargetMet(p, t) {
  return p.attaches >= t.ptyMinAttaches && p.detaches >= t.ptyMinDetaches
    && p.firstEventAt !== null && p.lastEventAt - p.firstEventAt >= t.ptyMinSpanMs;
}

/**
 * Add a pool-use trend point when a bucket has passed since the last one.
 * @param {object[]} trend - Trend points (mutated)
 * @param {object|null} ttyd - The ttyd observation
 * @param {number} wallAt - Sample wall time
 * @param {object} t - Thresholds
 * @returns {void}
 */
function _foldTrend(trend, ttyd, wallAt, t) {
  if (!ttyd || !_isCount(ttyd.poolUsed)) return;
  const last = trend[trend.length - 1];
  if (last && wallAt - last.at < t.trendBucketMs) return;
  trend.push({ at: wallAt, used: ttyd.poolUsed });
  if (trend.length > MAX_TREND_POINTS) trend.shift();
}

/**
 * Judge the interval between the previous sample and this one.
 *
 * Monotonic time is only comparable within one runner process, so a new
 * runner is a gap whatever the clocks say. Within one runner, wall time
 * running ahead of monotonic time means the machine slept; behind it means the
 * wall clock was stepped. A server whose start time changed restarted inside
 * the interval, however quickly it came back, so the interval earns nothing.
 *
 * @param {object} prev - `state.lastSample`
 * @param {object} sample - The new sample
 * @param {object[]} sampleExtends - The new sample's own extend reasons
 * @param {object} t - Thresholds
 * @returns {{qualifies: boolean, reasons: object[], wallDelta: number, monoDelta: number|null}} Verdict
 */
function assessInterval(prev, sample, sampleExtends, t) {
  const reasons = [];
  const wallDelta = sample.wallAt - prev.wallAt;
  let monoDelta = null;
  if (prev.runnerInstance !== sample.runnerInstance) {
    reasons.push(_reason(EXTEND.MONITOR_GAP, 'runner'));
  } else {
    monoDelta = sample.monoAt - prev.monoAt;
    if (monoDelta <= 0) _refuse(REFUSAL.INVALID_SAMPLE, 'monotonic time did not advance', { field: 'monoAt' });
    const skew = wallDelta - monoDelta;
    if (skew > t.clockToleranceMs) reasons.push(_reason(EXTEND.SLEEP_DETECTED, 'clock'));
    else if (skew < -t.clockToleranceMs) reasons.push(_reason(EXTEND.CLOCK_SKEW, 'clock'));
    if (monoDelta > t.maxIntervalMs) reasons.push(_reason(EXTEND.INTERVAL_TOO_LONG, 'clock'));
  }
  const serverNow = _serverInstance(sample);
  if (prev.serverInstance !== null && serverNow !== null && serverNow !== prev.serverInstance) {
    reasons.push(_reason(EXTEND.SERVER_RESTARTED, 'server'));
  }
  reasons.push(...sampleExtends);
  if (reasons.length === 0 && prev.extendCodes.length > 0) reasons.push(_reason(prev.extendCodes[0], 'prior-sample'));
  reasons.sort((a, b) => priority(EXTEND, a.code) - priority(EXTEND, b.code));
  return { qualifies: reasons.length === 0, reasons, wallDelta, monoDelta };
}

/**
 * The last-sample record kept in state.
 * @param {number} seq - Sample sequence number
 * @param {object} sample - The sample
 * @param {object[]} sampleExtends - Its extend reasons
 * @returns {object} Record
 */
function _lastSample(seq, sample, sampleExtends) {
  return {
    seq,
    wallAt: sample.wallAt,
    monoAt: sample.monoAt,
    runnerInstance: sample.runnerInstance,
    serverInstance: _serverInstance(sample),
    extendCodes: sampleExtends.map((r) => r.code)
  };
}

/**
 * A transition event.
 * @param {string} from - Previous state
 * @param {string} to - New state
 * @param {string} code - Why
 * @param {number} at - Epoch ms
 * @param {number|null} sampleSeq - The sample that caused it, if any
 * @returns {object} Event
 */
function _transition(from, to, code, at, sampleSeq) {
  return { type: 'transition', from, to, code, at, sampleSeq };
}

/**
 * Admit a candidate: the first sample must be fully healthy. A hard-fail
 * condition, an unproven runtime, a required check not yet green, or any
 * unknown refuses admission, and nothing about the run exists yet.
 * @param {object} manifest - The manifest
 * @param {object} sample - The admission sample
 * @returns {{state: object, events: object[]}} Initial running state and its event
 */
function admit(manifest, sample) {
  _validateSample(sample);
  const verdict = classify(manifest, sample.observations);
  const codes = [...verdict.hardFails, ...verdict.extends];
  if (codes.length > 0) {
    _refuse(REFUSAL.ADMISSION_REFUSED, `admission refused: ${codes[0].code}`, { reasons: codes });
  }
  const state = {
    schema: SCHEMA,
    candidateSha: manifest.candidateSha,
    state: STATES.RUNNING,
    startedAt: sample.wallAt,
    updatedAt: sample.wallAt,
    sampleCount: 1,
    lastSample: _lastSample(1, sample, []),
    qualifiedMs: 0,
    extensions: {},
    failure: null,
    pty: _initPty(sample.observations.pty),
    poolUsedTrend: [],
    acceptance: null,
    cancellation: null
  };
  _foldTrend(state.poolUsedTrend, sample.observations.ttyd, sample.wallAt, manifest.thresholds);
  return { state, events: [_transition(STATES.NOT_STARTED, STATES.RUNNING, TRANSITION.ADMITTED, sample.wallAt, 1)] };
}

/**
 * Record wall time an interval did not earn.
 * @param {object} extensions - `state.extensions` (mutated)
 * @param {string} code - The interval's primary reason
 * @param {number} lostMs - Wall time the interval spent without earning it
 * @returns {void}
 */
function _recordExtension(extensions, code, lostMs) {
  const entry = extensions[code] || (extensions[code] = { intervals: 0, lostMs: 0 });
  entry.intervals += 1;
  entry.lostMs += Math.max(0, lostMs);
}

/**
 * Decide the live state after an interval, and account its time.
 *
 * Earned time stops at the target. Past it, a healthy interval spent waiting
 * for the PTY-use target is recorded as extension time instead, so qualified
 * and extension time together never exceed the time that passed. Review
 * begins only on a qualifying interval: a sample that cannot vouch for the
 * candidate never hands it to a person.
 *
 * @param {object} next - State being built (mutated)
 * @param {object} interval - `assessInterval` verdict
 * @param {object} t - Thresholds
 * @returns {{to: string, code: string}} Target state and why
 */
function _advanceLive(next, interval, t) {
  if (!interval.qualifies) {
    _recordExtension(next.extensions, interval.reasons[0].code, interval.wallDelta);
    return { to: STATES.EXTENDED, code: interval.reasons[0].code };
  }
  const earned = Math.min(interval.monoDelta, t.targetQualifiedMs - next.qualifiedMs);
  next.qualifiedMs += earned;
  if (next.qualifiedMs < t.targetQualifiedMs) return { to: STATES.RUNNING, code: TRANSITION.RECOVERED };
  if (ptyTargetMet(next.pty, t)) return { to: STATES.AWAITING_REVIEW, code: TRANSITION.TARGET_REACHED };
  _recordExtension(next.extensions, EXTEND.PTY_TARGET_UNMET, interval.wallDelta - earned);
  return { to: STATES.EXTENDED, code: EXTEND.PTY_TARGET_UNMET };
}

/**
 * Fold one sample into a certification.
 * @param {object} state - Current state (not mutated)
 * @param {object} manifest - The manifest
 * @param {object} sample - The new sample
 * @returns {{state: object, events: object[], verdict: object, interval: object}} Next state, transition events, and what was judged
 */
function reduce(state, manifest, sample) {
  _validateSample(sample);
  if (isTerminal(state.state)) _refuse(REFUSAL.ALREADY_TERMINAL, `run is ${state.state}`, { state: state.state });
  if (state.state === STATES.NOT_STARTED) _refuse(REFUSAL.INVALID_SAMPLE, 'admit the candidate first', { state: state.state });
  const t = manifest.thresholds;
  const seq = state.sampleCount + 1;
  const verdict = classify(manifest, sample.observations);
  const interval = assessInterval(state.lastSample, sample, verdict.extends, t);
  const next = structuredClone(state);
  next.sampleCount = seq;
  next.updatedAt = sample.wallAt;
  next.lastSample = _lastSample(seq, sample, verdict.extends);
  _foldPty(next.pty, sample.observations.pty, sample.wallAt);
  _foldTrend(next.poolUsedTrend, sample.observations.ttyd, sample.wallAt, t);

  let move = null;
  if (verdict.hardFails.length > 0) {
    next.failure = { code: verdict.hardFails[0].code, reasons: verdict.hardFails, at: sample.wallAt, sampleSeq: seq };
    move = { to: STATES.FAILED, code: verdict.hardFails[0].code };
  } else if (state.state !== STATES.AWAITING_REVIEW) {
    move = _advanceLive(next, interval, t);
  }
  const events = [];
  if (move && move.to !== state.state) {
    next.state = move.to;
    events.push(_transition(state.state, move.to, move.code, sample.wallAt, seq));
  }
  return { state: next, events, verdict, interval };
}

/**
 * Validate an operator identity.
 * @param {*} actor - Candidate actor
 * @returns {void}
 */
function _validateActor(actor) {
  if (typeof actor !== 'string' || !ACTOR_RE.test(actor)) _refuse(REFUSAL.INVALID_ACTOR, 'actor must be an identifier');
}

/**
 * Accept a run that reached its target: the only way to `passed`.
 * @param {object} state - Current state (not mutated)
 * @param {string} actor - Who accepted it
 * @param {number} at - Epoch ms
 * @returns {{state: object, events: object[]}} Passed state and its event
 */
function accept(state, actor, at) {
  _validateActor(actor);
  if (isTerminal(state.state)) _refuse(REFUSAL.ALREADY_TERMINAL, `run is ${state.state}`, { state: state.state });
  if (state.state !== STATES.AWAITING_REVIEW) _refuse(REFUSAL.NOT_AWAITING_REVIEW, `run is ${state.state}`, { state: state.state });
  const next = structuredClone(state);
  next.state = STATES.PASSED;
  next.updatedAt = at;
  next.acceptance = { actor, at };
  return { state: next, events: [_transition(state.state, STATES.PASSED, TRANSITION.OPERATOR_ACCEPTED, at, null)] };
}

/**
 * Cancel a live run.
 * @param {object} state - Current state (not mutated)
 * @param {string} actor - Who cancelled it
 * @param {number} at - Epoch ms
 * @returns {{state: object, events: object[]}} Cancelled state and its event
 */
function cancel(state, actor, at) {
  _validateActor(actor);
  if (isTerminal(state.state)) _refuse(REFUSAL.ALREADY_TERMINAL, `run is ${state.state}`, { state: state.state });
  const next = structuredClone(state);
  next.state = STATES.CANCELLED;
  next.updatedAt = at;
  next.cancellation = { actor, at };
  return { state: next, events: [_transition(state.state, STATES.CANCELLED, TRANSITION.OPERATOR_CANCELLED, at, null)] };
}

/**
 * The structured health of a run: what the CLI prints and the scorecard and
 * registry cards read. Times are epoch ms in UTC; rendering them in a time
 * zone is the reader's job.
 * @param {object} state - Current state
 * @param {object} manifest - The manifest
 * @param {number} now - Epoch ms
 * @returns {object} Summary
 */
function summarize(state, manifest, now) {
  const t = manifest.thresholds;
  const live = !isTerminal(state.state);
  return {
    schema: SCHEMA,
    candidateSha: manifest.candidateSha,
    version: manifest.version,
    state: state.state,
    canonicalThresholds: isCanonical(manifest),
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    lastSampleAt: state.lastSample.wallAt,
    monitorStale: live && now - state.lastSample.wallAt > t.maxIntervalMs,
    elapsedMs: (live ? now : state.updatedAt) - state.startedAt,
    qualifiedMs: state.qualifiedMs,
    targetMs: t.targetQualifiedMs,
    remainingMs: Math.max(0, t.targetQualifiedMs - state.qualifiedMs),
    extensions: structuredClone(state.extensions),
    pty: {
      attaches: state.pty.attaches,
      detaches: state.pty.detaches,
      firstEventAt: state.pty.firstEventAt,
      lastEventAt: state.pty.lastEventAt,
      spanMs: state.pty.firstEventAt === null ? 0 : state.pty.lastEventAt - state.pty.firstEventAt,
      met: ptyTargetMet(state.pty, t),
      target: { attaches: t.ptyMinAttaches, detaches: t.ptyMinDetaches, spanMs: t.ptyMinSpanMs }
    },
    poolUsedTrend: structuredClone(state.poolUsedTrend),
    failure: structuredClone(state.failure),
    acceptance: structuredClone(state.acceptance),
    cancellation: structuredClone(state.cancellation)
  };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  buildManifest,
  isCanonical,
  classify,
  assessInterval,
  ptyTargetMet,
  admit,
  reduce,
  accept,
  cancel,
  summarize
};
