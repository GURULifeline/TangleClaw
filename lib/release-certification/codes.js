'use strict';

/**
 * The closed vocabulary of release-candidate certification.
 *
 * A certification's evidence is read by the public scorecard, the registry
 * cards and the release promotion step. None of them may parse prose, so every
 * state, every reason an interval did not count and every reason a run failed
 * is one of the codes below. A code nothing here declares is a programming
 * error, not a new kind of evidence.
 *
 * The categories are disjoint, and the category decides the effect:
 * - an EXTEND code makes the interval it names earn no qualified time;
 * - a HARD_FAIL code ends the run in `failed`, and nothing reopens it;
 * - a TRANSITION code names why the state moved when no failure or extension did;
 * - a REFUSAL code is thrown by an operation the current state does not allow.
 *
 * @module lib/release-certification/codes
 */

/** Schema tag carried by every persisted certification document. */
const SCHEMA = 'tc.release-certification/v1';

/**
 * Certification states. `failed`, `passed` and `cancelled` are terminal.
 * @type {Readonly<Record<string, string>>}
 */
const STATES = Object.freeze({
  NOT_STARTED: 'not-started',
  RUNNING: 'running',
  EXTENDED: 'extended',
  FAILED: 'failed',
  AWAITING_REVIEW: 'awaiting-review',
  PASSED: 'passed',
  CANCELLED: 'cancelled'
});

/** @type {readonly string[]} */
const TERMINAL_STATES = Object.freeze([STATES.FAILED, STATES.PASSED, STATES.CANCELLED]);

/**
 * Reasons an interval earns no qualified time. Listed in the order they are
 * reported when several apply, so the first one is the interval's primary
 * reason: what stopped the clock before anything about the samples themselves.
 * @type {Readonly<Record<string, string>>}
 */
const EXTEND = Object.freeze({
  MONITOR_GAP: 'MONITOR_GAP',
  SLEEP_DETECTED: 'SLEEP_DETECTED',
  CLOCK_SKEW: 'CLOCK_SKEW',
  INTERVAL_TOO_LONG: 'INTERVAL_TOO_LONG',
  PROBE_UNKNOWN: 'PROBE_UNKNOWN',
  RUNTIME_UNPROVEN: 'RUNTIME_UNPROVEN',
  GITHUB_UNAVAILABLE: 'GITHUB_UNAVAILABLE',
  CHECKS_PENDING: 'CHECKS_PENDING',
  PTY_TARGET_UNMET: 'PTY_TARGET_UNMET'
});

/**
 * Conditions that end a run. Listed in reporting priority: the candidate
 * itself first, then the runtime claiming to be it, then the ttyd it owns,
 * then the required checks.
 * @type {Readonly<Record<string, string>>}
 */
const HARD_FAIL = Object.freeze({
  HEAD_DRIFT: 'HEAD_DRIFT',
  WORKTREE_NOT_DETACHED: 'WORKTREE_NOT_DETACHED',
  WORKTREE_DIRTY: 'WORKTREE_DIRTY',
  RUNTIME_SHA_MISMATCH: 'RUNTIME_SHA_MISMATCH',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  TTYD_NOT_OWNED: 'TTYD_NOT_OWNED',
  TTYD_GENERATION_CHANGED: 'TTYD_GENERATION_CHANGED',
  LEAK_FIRED: 'LEAK_FIRED',
  WEDGED_CHILD: 'WEDGED_CHILD',
  ORPHAN_GATE: 'ORPHAN_GATE',
  REQUIRED_CHECK_FAILED: 'REQUIRED_CHECK_FAILED'
});

/**
 * Why a state moved when neither a failure nor an extension moved it.
 * @type {Readonly<Record<string, string>>}
 */
const TRANSITION = Object.freeze({
  ADMITTED: 'ADMITTED',
  RECOVERED: 'RECOVERED',
  TARGET_REACHED: 'TARGET_REACHED',
  OPERATOR_ACCEPTED: 'OPERATOR_ACCEPTED',
  OPERATOR_CANCELLED: 'OPERATOR_CANCELLED'
});

/**
 * Refusals thrown by operations on a certification.
 * @type {Readonly<Record<string, string>>}
 */
const REFUSAL = Object.freeze({
  INVALID_MANIFEST: 'INVALID_MANIFEST',
  INVALID_SAMPLE: 'INVALID_SAMPLE',
  INVALID_ACTOR: 'INVALID_ACTOR',
  ADMISSION_REFUSED: 'ADMISSION_REFUSED',
  NOT_AWAITING_REVIEW: 'NOT_AWAITING_REVIEW',
  ALREADY_TERMINAL: 'ALREADY_TERMINAL'
});

/**
 * Where a reason came from: one of a sample's probes, the clocks, the runner,
 * or (for an interval) the previous sample's own reason.
 * @type {readonly string[]}
 */
const PROBES = Object.freeze(['worktree', 'server', 'ttyd', 'github', 'pty', 'clock', 'runner', 'prior-sample']);

/**
 * The values a probe reports for one required check.
 * @type {readonly string[]}
 */
const CHECK_STATES = Object.freeze(['success', 'failure', 'pending', 'missing']);

/** The ttyd leak condition's states, as `lib/system-health.js` reports them. */
const LEAK_STATES = Object.freeze(['fired', 'clear', 'unknown']);

/**
 * A refused certification operation, carrying one REFUSAL code and bounded
 * facts (codes, states, sequence numbers), never paths or prose to parse.
 */
class CertificationError extends Error {
  /**
   * @param {string} code - One of REFUSAL
   * @param {string} message - Human-readable reason
   * @param {object} [details] - Bounded facts
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CertificationError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Whether a state is terminal.
 * @param {string} state - A STATES value
 * @returns {boolean} True for failed, passed and cancelled
 */
function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

/**
 * Rank a code by its position in its category's declared order.
 * @param {Readonly<Record<string, string>>} category - EXTEND or HARD_FAIL
 * @param {string} code - A code from that category
 * @returns {number} Its priority; lower reports first
 */
function priority(category, code) {
  return Object.values(category).indexOf(code);
}

module.exports = {
  SCHEMA,
  STATES,
  TERMINAL_STATES,
  EXTEND,
  HARD_FAIL,
  TRANSITION,
  REFUSAL,
  PROBES,
  CHECK_STATES,
  LEAK_STATES,
  CertificationError,
  isTerminal,
  priority
};
