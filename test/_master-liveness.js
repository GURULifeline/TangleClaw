'use strict';

// Test helper: what tmux says about the Project Master, said by the test.
//
// The bridge's Master surface revokes the Master's credential the moment tmux
// answers that there is no Master session. That is production behaviour and
// stays as it is. A test that reaches that surface through the real server
// therefore must not leave the answer to the machine's own tmux: it then
// passes only where a Master happens to be running and fails wherever tmux
// says none is, which is every CI runner. A suite that is not about liveness
// pins the answer here; a test that is about it sets the answer it means.

const gateway = require('../lib/bridge-gateway');

/**
 * Make the gateway see a Master whose tmux liveness is what the test says.
 * Everything else about the Master stays the real module's.
 * @param {{live: boolean, answered: boolean, cause: (string|null)}} [liveness] - tmux's answer; a live Master by default.
 * @returns {{set: function(object): void, restore: function(): void}} `set` changes the answer; `restore` puts the real Master back.
 */
function pinMasterLiveness(liveness = { live: true, answered: true, cause: null }) {
  const real = gateway._deps.master;
  let answer = liveness;
  gateway._deps.master = () => ({ ...real(), masterLiveness: () => answer });
  return {
    set(next) { answer = next; },
    restore() { gateway._deps.master = real; }
  };
}

module.exports = { pinMasterLiveness };
