'use strict';

/**
 * Whether advisory recovery is the default on this install right now (#1937).
 *
 * The contract is one-sided on purpose. Advisory lets a session clear its own
 * recovery, so it is the default only in the login gate's `armed` state, and
 * every way this answer can fail to be obtained lands on the operator-cleared
 * side. The states are read from `GATE_STATES`, so a state added later is
 * covered here without anyone remembering to add it.
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const authGate = require('../lib/auth-gate');
const recoveryDefault = require('../lib/recovery-default');

describe('recovery-default: the gate answer (#1937)', () => {
  afterEach(() => recoveryDefault.setGateStateProbe(null));

  it('makes advisory the default in `armed` and in no other gate state, and carries the state', () => {
    const states = Object.values(authGate.GATE_STATES);
    assert.ok(states.includes('armed') && states.length > 1, 'precondition: there are other states to refuse');
    for (const state of states) {
      recoveryDefault.setGateStateProbe(() => state);
      assert.deepEqual(recoveryDefault.gateAnswer(), { advisoryDefault: state === 'armed', gateState: state }, state);
    }
  });

  it('refuses a state it does not recognise, and still says what it was', () => {
    for (const state of ['ARMED', 'armed ', 'enabled', '']) {
      recoveryDefault.setGateStateProbe(() => state);
      assert.deepEqual(recoveryDefault.gateAnswer(), { advisoryDefault: false, gateState: state }, JSON.stringify(state));
    }
  });

  it('answers "not known", never `open`, when it could not ask', () => {
    const notKnown = { advisoryDefault: false, gateState: null };
    assert.deepEqual(recoveryDefault.gateAnswer(), notKnown, 'no probe installed');
    recoveryDefault.setGateStateProbe(() => { throw new Error('config unreadable'); });
    assert.deepEqual(recoveryDefault.gateAnswer(), notKnown, 'a probe that throws');
    for (const value of [null, undefined, true, 1, { state: 'armed' }]) {
      recoveryDefault.setGateStateProbe(() => value);
      assert.deepEqual(recoveryDefault.gateAnswer(), notKnown, `a probe returning ${JSON.stringify(value)}`);
    }
    recoveryDefault.setGateStateProbe('armed');
    assert.deepEqual(recoveryDefault.gateAnswer(), notKnown, 'a probe that is not a function installs nothing');
  });

  it('is installed by the server only once its listener is bound', () => {
    // Before the listener is bound it has no address, so the fallback check
    // would be asked about a door that does not exist yet. With no probe a
    // launch takes the operator-cleared default, which is the safe answer for
    // that window.
    const source = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const installs = source.split('recoveryDefault.setGateStateProbe(').length - 1;
    assert.equal(installs, 1, 'one install site');
    const at = source.indexOf('recoveryDefault.setGateStateProbe(');
    const listening = source.lastIndexOf('const onListening = () => {', at);
    const listen = source.indexOf('server.listen(', at);
    assert.ok(listening !== -1 && listen !== -1, 'the install sits between the listening callback and the listen call');
    assert.equal(source.slice(listening, at).includes('\n  };'), false, 'and inside that callback, not after it');
    assert.ok(source.slice(at, at + 80).startsWith('recoveryDefault.setGateStateProbe(_recoveryGateProbeFor(server))'),
      'with the probe built from the bound server');
  });

  it('asks the probe each time, so a login switched on or off is seen on the next read', () => {
    let state = 'open';
    recoveryDefault.setGateStateProbe(() => state);
    assert.equal(recoveryDefault.gateAnswer().advisoryDefault, false);
    state = 'armed';
    assert.equal(recoveryDefault.gateAnswer().advisoryDefault, true);
    state = 'fallback';
    assert.deepEqual(recoveryDefault.gateAnswer(), { advisoryDefault: false, gateState: 'fallback' });
  });
});
