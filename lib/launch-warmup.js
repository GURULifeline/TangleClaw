'use strict';

// What is measured off the event loop before a session is launched, so the
// synchronous launch reads facts for its prime and not "pending". One place,
// because two callers launch sessions: the launch route, and the operator
// bridge acting on a consent the Project Master adopted (#2031). Both warm up
// here and then call `sessions.launchSession`. The route also resolves the
// operator's host and checks for stranded wraps afterwards; the bridge has no
// request to read a host from, and does neither.

const store = require('./store');
const ciStatus = require('./ci-status');
const checkoutFreshness = require('./checkout-freshness');

/**
 * Warm the base-branch CI verdict (#991) and the checkout facts (#1678) for a
 * project about to be launched. The two run concurrently, so a hung network
 * costs one wait and not two. Never rejects: a failed probe is an honest
 * unknown in the prime, not a failed launch.
 * @param {object} project - The project row.
 * @returns {Promise<void>}
 */
async function warmForLaunch(project) {
  const checkoutWarm = checkoutFreshness.refreshForLaunch(project, store.config.load());
  await ciStatus.refresh(project.path);
  await checkoutWarm;
}

module.exports = { warmForLaunch };
