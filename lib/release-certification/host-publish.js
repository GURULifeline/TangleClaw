'use strict';

/**
 * The host relay for a guest's certification (#2020, Architect rulings Q2,
 * A31 constraint 4 and A32).
 *
 * A host-attested run publishes only to a local bare `metrics` repository
 * inside its guest, which has no credentials and no route to GitHub. This is
 * the one place that publishes what it produced, and the only place a
 * host-attested pass becomes a certification of record:
 *
 * 1. The host's own finalization of that exact run must exist and be `ok`,
 *    for the same manifest digest the guest's admission publishes.
 * 2. The guest's whole `metrics` history must pass the branch verifier.
 * 3. The guest's tip is pushed to the public remote as that exact commit,
 *    fast-forward only and never forced, so history already public can never
 *    be rewritten.
 * 4. The remote is read back: it must name exactly that commit, and the
 *    candidate's admission and scorecard must be byte-for-byte the guest's.
 * 5. Only then is the host's record written, and it says a run is certified
 *    only for a `passed` scorecard judged by canonical thresholds.
 *
 * Every step fails closed with a refusal and writes nothing. Only this host
 * process ever names the public remote, so no credential crosses into the
 * guest.
 *
 * @module lib/release-certification/host-publish
 */

const path = require('node:path');
const crypto = require('node:crypto');
const privateFs = require('./private-fs');
const lockfile = require('./lockfile');
const publisherLib = require('./publisher');
const verify = require('./verify');
const sc = require('./scorecard');
const hostChecks = require('./host-checks');
const { REFUSAL, STATES, CertificationError } = require('./codes');

const RECORD_SCHEMA = 'tc.release-certification.record/v1';
const BRANCH = publisherLib.DEFAULT_BRANCH;

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
 * Whether a relayed run is a certification of record: a `passed` scorecard,
 * judged by canonical thresholds, of a run whose host finalization is `ok`.
 * @param {object} scorecard - The published scorecard
 * @param {object|null} finalization - The host's finalization of the run
 * @returns {boolean} True only when all three hold
 */
function certifiedFrom(scorecard, finalization) {
  return Boolean(scorecard && scorecard.state === STATES.PASSED && scorecard.canonicalThresholds === true && finalization && finalization.ok === true);
}

/**
 * The host's record for one relayed run.
 * @param {string} hostBase - Host state directory
 * @param {string} candidateSha - Candidate SHA
 * @param {string} runId - The run
 * @returns {string} Path
 */
function recordPath(hostBase, candidateSha, runId) {
  return path.join(hostChecks.hostPaths(hostBase, candidateSha).dir, `record-${runId}.json`);
}

/**
 * Relay a guest's `metrics` branch to the public remote and, when every check
 * holds, record the result.
 * @param {object} opts
 * @param {string} opts.hostBase - Host state directory
 * @param {string} opts.candidateSha - Candidate SHA
 * @param {string} opts.guestMetrics - The guest's bare `metrics` repository, as the transport brought it to the host
 * @param {string} opts.remoteUrl - The public remote (the host's own credentials)
 * @param {function} [opts.git] - `publisher.runGit` seam
 * @param {function(object): Promise<object>} [opts.verifyHistory] - `verify.verifyHistory` seam
 * @param {function(): number} [opts.now] - Clock
 * @returns {Promise<object>} The record written
 * @throws {CertificationError} `LOCK_HELD` when another relay to the same remote is running
 */
async function relay(opts) {
  const git = opts.git || publisherLib.runGit;
  const now = opts.now || (() => Date.now());
  const docs = sc.paths(opts.candidateSha);
  const must = async (args, step, code = REFUSAL.PUBLISH_FAILED) => {
    const r = await git(args, { env: { GIT_TERMINAL_PROMPT: '0' } });
    if (r.code !== 0) _refuse(code, `git ${step} failed`, { step, stderr: r.stderr.trim().slice(-300) });
    return r.stdout;
  };
  const show = async (gitDir, rev, rel) => {
    const r = await git(['--git-dir', gitDir, 'show', `${rev}:${rel}`], { env: {} });
    return r.code === 0 ? r.stdout : null;
  };
  const parse = (text) => {
    try {
      return text === null ? null : JSON.parse(text);
    } catch {
      return null;
    }
  };

  // One private relay repository per public remote, held under a lock for
  // the whole relay, so two relays can never move each other's refs.
  const remoteKey = crypto.createHash('sha256').update(opts.remoteUrl).digest('hex').slice(0, 32);
  const relayRoot = path.join(opts.hostBase, '_relay');
  privateFs.ensurePrivateDir(relayRoot);
  const relayDir = path.join(relayRoot, `${remoteKey}.git`);
  const lockPath = path.join(relayRoot, `${remoteKey}.lock`);
  const token = lockfile.acquire(lockPath, { timeoutMs: 0 });
  try {
    privateFs.ensurePrivateDir(relayDir);
    if ((await git(['--git-dir', relayDir, 'rev-parse', '--git-dir'], { env: {} })).code !== 0) await must(['init', '-q', '--bare', relayDir], 'init');

    // The guest is the untrusted side and can move its branch at any moment,
    // so it is read exactly once: fetched into the relay and pinned by OID.
    // Every check below, the push and the comparison use that one commit.
    const guestRef = `refs/guest/${opts.candidateSha}`;
    await must(['--git-dir', relayDir, 'fetch', '-q', '--no-tags', opts.guestMetrics, `+refs/heads/${BRANCH}:${guestRef}`], 'fetch guest', REFUSAL.PUBLICATION_MISMATCH);
    const oid = (await must(['--git-dir', relayDir, 'rev-parse', '--verify', `${guestRef}^{commit}`], 'rev-parse', REFUSAL.PUBLICATION_MISMATCH)).trim();
    if (!/^[0-9a-f]{40}$/.test(oid)) _refuse(REFUSAL.PUBLICATION_MISMATCH, 'the guest\'s metrics tip cannot be read');

    const admission = parse(await show(relayDir, oid, docs.admission));
    if (!admission || sc.validateAdmission(admission).length > 0) _refuse(REFUSAL.PUBLICATION_MISMATCH, 'the guest has published no valid admission for this candidate', { path: docs.admission });
    if (admission.checksSource !== 'host-attested') _refuse(REFUSAL.NOT_HOST_ATTESTED, 'only a host-attested run is relayed; a gh run publishes to its remote itself');
    const scorecard = parse(await show(relayDir, oid, docs.scorecard));
    if (!scorecard || sc.validateScorecard(scorecard).length > 0) _refuse(REFUSAL.PUBLICATION_MISMATCH, 'the guest has published no valid scorecard for this candidate', { path: docs.scorecard });

    // 1. The host's own finalization of exactly this run and manifest.
    const finalization = hostChecks.readFinalization(opts.hostBase, opts.candidateSha, admission.runId);
    if (!finalization || finalization.ok !== true || finalization.manifestDigest !== admission.manifestDigest) {
      _refuse(REFUSAL.NOT_FINALIZED, 'the host has no ok finalization of this run and manifest', { runId: admission.runId, reasons: finalization ? finalization.reasons : null });
    }

    // 2. The pinned commit's whole history, by the rules the public branch is held to.
    const history = await (opts.verifyHistory || verify.verifyHistory)({ repoDir: relayDir, ref: oid });
    if (!history.exists || history.violations.length > 0) _refuse(REFUSAL.HISTORY_INVALID, 'the guest\'s metrics history does not verify', { violations: history.violations.slice(0, 10) });

    // 3. Fast-forward only, never forced.
    const remoteRef = 'refs/public/metrics';
    const fetchedRemote = await git(['--git-dir', relayDir, 'fetch', '-q', '--no-tags', opts.remoteUrl, `+refs/heads/${BRANCH}:${remoteRef}`], { env: { GIT_TERMINAL_PROMPT: '0' } });
    if (fetchedRemote.code !== 0) {
      // Only a remote with no metrics branch yet may be missing it; any other
      // failure to read it is not evidence that it is empty.
      const probe = await git(['ls-remote', '--exit-code', '--heads', opts.remoteUrl, BRANCH], { env: { GIT_TERMINAL_PROMPT: '0' } });
      if (probe.code !== 2) _refuse(REFUSAL.PUBLISH_FAILED, 'could not read the public metrics branch', { stderr: fetchedRemote.stderr.trim().slice(-300) });
    } else if ((await git(['--git-dir', relayDir, 'merge-base', '--is-ancestor', remoteRef, oid], { env: {} })).code !== 0) {
      _refuse(REFUSAL.NOT_FAST_FORWARD, 'the public metrics branch holds history the guest\'s does not; it is never overwritten');
    }
    await must(['--git-dir', relayDir, 'push', '-q', opts.remoteUrl, `${oid}:refs/heads/${BRANCH}`], 'push');

    // 4. Read it back from the remote itself, against the pinned commit.
    const listed = await must(['ls-remote', opts.remoteUrl, `refs/heads/${BRANCH}`], 'ls-remote', REFUSAL.PUBLICATION_MISMATCH);
    const remoteOid = (listed.split('\t')[0] || '').trim();
    if (remoteOid !== oid) _refuse(REFUSAL.PUBLICATION_MISMATCH, 'the public metrics branch does not name the relayed commit', { expected: oid, found: remoteOid || null });
    await must(['--git-dir', relayDir, 'fetch', '-q', '--no-tags', opts.remoteUrl, `+refs/heads/${BRANCH}:${remoteRef}`], 'fetch back', REFUSAL.PUBLICATION_MISMATCH);
    for (const rel of [docs.admission, docs.scorecard]) {
      const theirs = await show(relayDir, remoteRef, rel);
      if (theirs === null || theirs !== await show(relayDir, oid, rel)) _refuse(REFUSAL.PUBLICATION_MISMATCH, 'a document read back from the public branch differs from the relayed commit', { path: rel });
    }

    // 5. The record: certification of record exists only here.
    const record = {
      schema: RECORD_SCHEMA,
      candidateSha: opts.candidateSha,
      runId: admission.runId,
      manifestDigest: admission.manifestDigest,
      oid,
      state: scorecard.state,
      canonicalThresholds: scorecard.canonicalThresholds,
      certified: certifiedFrom(scorecard, finalization),
      verifiedAt: now()
    };
    privateFs.replaceAtomic(recordPath(opts.hostBase, opts.candidateSha, admission.runId), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  } finally {
    lockfile.release(lockPath, token);
  }
}

module.exports = { RECORD_SCHEMA, certifiedFrom, recordPath, relay };
