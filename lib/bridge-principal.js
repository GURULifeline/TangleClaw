'use strict';

/*
 * The Project Master's bridge principal (ADR 0023 Decisions 5 and 14).
 *
 * The Master has no project and no session row, so nothing TangleClaw already
 * records can prove a request is the Master's. This gives it a credential of
 * its own: minted when the Master session is created, bound to a generation,
 * good for bridge routing and nothing else, and revoked when the Master ends
 * or is replaced. The server keeps the SHA-256 of it and never the value.
 *
 * lib/bridge-handoff.js carries the value to the pane; this module decides
 * when one exists and whether a presented one is the live one.
 */

const path = require('node:path');
const store = require('./store');
const handoff = require('./bridge-handoff');
const bridgeStore = require('./bridge-store');
const { createLogger } = require('./logger');

const log = createLogger('bridge-principal');

/** Request header a caller presents the credential in. */
const CREDENTIAL_HEADER = 'x-tangleclaw-bridge-credential';

/** The proof recorded for every decision made under the credential. */
const MASTER_PROOF = 'master-launch';

let _inFlight = Promise.resolve();

/**
 * Where handoff FIFOs are made: in TangleClaw's own state directory, beside
 * the Master's home and never inside it, because the Master can write to its
 * home.
 * @returns {string}
 */
function handoffDir() {
  return path.join(store._getBasePath(), 'bridge-handoff');
}

/**
 * Begin a credential for a Master launch: mint it, record its hash as the next
 * generation (revoking every earlier one) and make the FIFO it will cross.
 * The generation stays `pending` until {@link settle} sees it delivered.
 * @param {object} [options]
 * @param {string} [options.dir] - Handoff directory override (tests).
 * @returns {{generation: number, credential: string, hash: string, fifoPath: string}}
 */
function begin(options = {}) {
  const { credential, hash } = handoff.mintCredential();
  const generation = bridgeStore.masterCredentials.mint(hash);
  try {
    const fifoPath = handoff.prepareFifo(options.dir || handoffDir());
    return { generation, credential, hash, fifoPath };
  } catch (err) {
    bridgeStore.masterCredentials.revoke('handoff-failed', { generation, credentialHash: hash });
    throw err;
  }
}

/**
 * Abandon a launch that never produced a pane: revoke its generation and
 * remove its FIFO. Safe to call more than once.
 * @param {{generation: number, hash: string, fifoPath: string}} issued - What {@link begin} returned.
 * @param {string} [reason='launch-failed'] - Closed reason code.
 * @returns {void}
 */
function abandon(issued, reason = 'launch-failed') {
  bridgeStore.masterCredentials.revoke(reason, { generation: issued.generation, credentialHash: issued.hash });
  try { handoff.removeFifo(issued.fifoPath); } catch { /* nothing more to do */ }
}

/**
 * Hand the credential to the pane and settle the generation: active when the
 * pane took it, revoked when it did not. Never rejects.
 * @param {{generation: number, credential: string, hash: string, fifoPath: string}} issued - What {@link begin} returned.
 * @param {object} [options]
 * @param {number} [options.timeoutMs] - Delivery timeout override (tests).
 * @param {boolean} [options.background] - Do not hold the process open while waiting.
 * @returns {Promise<{generation: number, delivered: boolean, code: string}>}
 */
function settle(issued, options = {}) {
  const run = (async () => {
    let result = { delivered: false, code: 'write-failed' };
    try {
      result = await handoff.deliverCredential(issued.fifoPath, issued.credential, options);
    } catch (err) {
      log.warn('Master bridge credential handoff failed', { generation: issued.generation, error: err.code || 'unknown' });
    }
    try {
      if (result.delivered && bridgeStore.masterCredentials.activate(issued.generation, issued.hash)) {
        log.info('Master bridge credential delivered', { generation: issued.generation });
      } else {
        // Also the path for a generation a later launch already superseded.
        bridgeStore.masterCredentials.revoke('handoff-failed', { generation: issued.generation, credentialHash: issued.hash });
        if (result.delivered) result = { delivered: false, code: 'superseded' };
        log.warn('Master bridge credential not delivered — the Master runs without the bridge capability', {
          generation: issued.generation, code: result.code
        });
      }
    } catch (err) {
      log.warn('Master bridge credential could not be settled', { generation: issued.generation, error: err.message });
      result = { delivered: false, code: 'settle-failed' };
    }
    return { generation: issued.generation, ...result };
  })();
  _inFlight = run;
  return run;
}

/**
 * The most recent handoff, for a caller that needs to know it has finished.
 * @returns {Promise<object>}
 */
function settled() {
  return _inFlight;
}

/**
 * Revoke every live generation. Called when the Master ends.
 * @param {string} reason - Closed reason code.
 * @returns {number} How many generations were revoked.
 */
function revokeAll(reason) {
  const revoked = bridgeStore.masterCredentials.revoke(reason);
  if (revoked) log.info('Master bridge credential revoked', { reason, revoked });
  return revoked;
}

/**
 * Whether a presented credential is the live Master's.
 * @param {*} presented - The header value as received.
 * @returns {{generation: number, proof: string}|null} Null for anything but
 *   the active generation's credential.
 */
function verify(presented) {
  if (!handoff.looksLikeCredential(presented)) return null;
  const match = bridgeStore.masterCredentials.findActive(handoff.hashCredential(presented));
  return match ? { generation: match.generation, proof: MASTER_PROOF } : null;
}

module.exports = {
  CREDENTIAL_HEADER,
  MASTER_PROOF,
  handoffDir,
  begin,
  abandon,
  settle,
  settled,
  revokeAll,
  verify
};
