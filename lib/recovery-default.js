'use strict';

// Whether advisory is the default recovery mode on this install right now
// (#1937, ADR 0017 R3).
//
// Advisory lets a session clear its own recovery by writing a reconciliation.
// That is the default only where a signed-in operator can read the
// reconciliation back, which is exactly the login gate's `armed` state: the one
// state in which `server.js#_requireOperatorWrite` can name an operator. In
// every other state a project with no operator decision keeps operator-cleared
// recovery.
//
// The gate state is computed in `server.js`, from caches it owns, so it reaches
// this module through a probe the server installs once its listener is bound.
// A process that installs none (a script, the scanner child, a test) gets the
// operator default. Every failure here answers the same way: an answer this
// module could not get is never the reason a launch gets looser.
//
// The state travels with the answer because "not armed" is five different
// situations (`open`, `fallback`, `account-required`, `locked`, `unreadable`),
// and what an operator can do about a held launch differs between them.

const authGate = require('./auth-gate');
const { createLogger } = require('./logger');

const log = createLogger('recovery-default');

let _probe = null;
let _lastProbeFailure = null;

/**
 * Install, or with `null` remove, the function that answers the login gate's
 * current state.
 * @param {(() => string)|null} probe - Returns a member of `authGate.GATE_STATES`
 * @returns {void}
 */
function setGateStateProbe(probe) {
  _probe = typeof probe === 'function' ? probe : null;
  _lastProbeFailure = null;
}

/**
 * Whether advisory is the default recovery mode right now, and the gate state
 * that answer came from.
 *
 * `gateState` is null when no probe is installed, the probe threw, or it
 * returned something that is not a string. Null means "not known". It never
 * means `open`.
 * @returns {{advisoryDefault: boolean, gateState: (string|null)}}
 */
function gateAnswer() {
  if (!_probe) return { advisoryDefault: false, gateState: null };
  let gateState;
  try {
    gateState = _probe();
  // prawduct:allow prawduct/broad-except -- a launch must survive a gate state that cannot be read, on the operator-cleared side
  } catch (err) {
    // Once per distinct failure: this is asked on every launch and every
    // status read, and a broken probe would otherwise fill the log.
    if (_lastProbeFailure !== err.message) {
      _lastProbeFailure = err.message;
      log.error('The login gate state could not be read, so recovery stays operator-cleared by default', { error: err.message });
    }
    return { advisoryDefault: false, gateState: null };
  }
  _lastProbeFailure = null;
  if (typeof gateState !== 'string') return { advisoryDefault: false, gateState: null };
  return { advisoryDefault: gateState === authGate.GATE_STATES.ARMED, gateState };
}

module.exports = { setGateStateProbe, gateAnswer };
