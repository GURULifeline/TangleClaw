'use strict';

/**
 * What a certification publishes, and when: the policy between the private
 * run and the public `metrics` branch (ADR 0021).
 *
 * - **Admission is fail-closed.** `admit` publishes the admission record and
 *   then reads it back from the remote. A record already there with different
 *   bytes refuses (`ADMISSION_CONFLICT`); a read-back that does not match
 *   refuses (`ADMISSION_UNPUBLISHED`). The runner commits a run only after
 *   `admit` returns.
 * - **Updates never touch certification.** `update` publishes the scorecard,
 *   the transitions not yet published and the index. A failure is recorded
 *   in `publish.json` with an exponential backoff and changes no qualified
 *   time. Publishing is a view of the evidence, not evidence.
 * - **Sequence and history only move forward.** Each scorecard carries a
 *   `publishSeq` above both the remote's and our own last one, and the
 *   remote's transition log must be a prefix of ours (`EVENTS_DIVERGED`
 *   otherwise), so a publish never rewrites history.
 *
 * `publish.json` is private and records only publishing: what was verified,
 * the last sequence published, and the last failure. It is never read as
 * certification state.
 *
 * @module lib/release-certification/publication
 */

const sc = require('./scorecard');
const store = require('./store');
const privateFs = require('./private-fs');
const lockfile = require('./lockfile');
const { REFUSAL, CertificationError, isTerminal } = require('./codes');

const STATUS_SCHEMA = 'tc.release-certification.publish/v1';
/** A live run republishes at least this often, so readers can see it is alive. */
const HEARTBEAT_MS = 60 * 60 * 1000;
/** Backoff after a failed publish: 1 min, doubling, capped at 30 min. */
const BACKOFF_BASE_MS = 60 * 1000;
const BACKOFF_MAX_MS = 30 * 60 * 1000;

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
 * The delay before the next attempt after `failures` consecutive failures.
 * @param {number} failures - Consecutive failures, at least 1
 * @returns {number} Milliseconds
 */
function backoffMs(failures) {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
}

/**
 * Create the publication policy for one candidate.
 * @param {object} ctx
 * @param {string} ctx.base - Evidence base
 * @param {string} ctx.candidateSha - Candidate SHA
 * @param {{publish: Function, read: Function}} ctx.publisher - From `createPublisher`
 * @param {function(): number} [ctx.now] - Clock
 * @returns {object} `{admit, update, due, recordFailure, readStatus}`
 */
function createPublication(ctx) {
  const now = ctx.now || (() => Date.now());
  const docPaths = sc.paths(ctx.candidateSha);
  const sha7 = ctx.candidateSha.slice(0, 7);
  const runPaths = store.runPaths(ctx.base, ctx.candidateSha);

  /**
   * Read `publish.json`, or a fresh status when none exists.
   * @returns {object} Status
   */
  function readStatus() {
    const text = privateFs.readPrivate(runPaths.publish);
    if (text === null) return { schema: STATUS_SCHEMA, admission: null, remoteUrl: null, publishActor: true, lastPublishedSeq: 0, lastPublishedAt: null, failures: 0, lastError: null, nextAttemptAt: null };
    const parsed = JSON.parse(text);
    if (!parsed || parsed.schema !== STATUS_SCHEMA) _refuse(REFUSAL.EVIDENCE_CORRUPT, 'publish.json has an unknown schema', { document: 'publish' });
    return parsed;
  }

  /**
   * Merge fields into `publish.json`.
   * @param {object} fields - Fields to set
   * @returns {object} The new status
   */
  function writeStatus(fields) {
    const next = { ...readStatus(), ...fields };
    privateFs.replaceAtomic(runPaths.publish, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  /**
   * Publish the admission record and prove it landed. Called before the run
   * commits: when this throws, no run begins.
   * @param {object} manifest - The staged manifest
   * @param {string} digest - Its digest
   * @param {{publishActor?: boolean, remoteUrl?: string}} [opts] - Whether operator ids are public for this run, and where it publishes (kept so every later publish goes to the same place)
   * @returns {Promise<{verifiedAt: number}>} When the read-back matched
   */
  async function admit(manifest, digest, opts = {}) {
    const record = sc.admissionRecord(manifest, digest);
    const problems = sc.validateAdmission(record);
    if (problems.length > 0) _refuse(REFUSAL.INVALID_MANIFEST, 'the admission record does not validate', { problems });
    const expected = sc.serialize(record);
    await ctx.publisher.publish((read) => {
      const current = read(docPaths.admission);
      if (current === expected) return {};
      if (current !== null) _refuse(REFUSAL.ADMISSION_CONFLICT, 'a different admission for this candidate is already published', { path: docPaths.admission });
      return { [docPaths.admission]: expected };
    }, `admission: ${sha7} ${manifest.version}`);
    const back = await ctx.publisher.read(docPaths.admission);
    if (back !== expected) _refuse(REFUSAL.ADMISSION_UNPUBLISHED, 'the admission record could not be read back from the metrics branch', { path: docPaths.admission });
    const verifiedAt = now();
    writeStatus({ admission: { digest, verifiedAt }, remoteUrl: opts.remoteUrl ?? null, publishActor: opts.publishActor !== false, failures: 0, lastError: null, nextAttemptAt: null });
    return { verifiedAt };
  }

  /**
   * The files an update writes, computed against the remote's current tip.
   * @param {function(string): (string|null)} read - Remote file reader
   * @param {object} run - `{state, manifest, events}`
   * @param {object} status - `publish.json`
   * @param {number} at - Publish time
   * @returns {{files: Object<string, string>, seq: number}} Files and the sequence used
   */
  function _updateFiles(read, run, status, at) {
    if (read(docPaths.admission) === null) _refuse(REFUSAL.ADMISSION_UNPUBLISHED, 'the admission is not on the metrics branch', { path: docPaths.admission });
    const prevText = read(docPaths.scorecard);
    const prevSeq = prevText === null ? 0 : (JSON.parse(prevText).publishSeq || 0);
    const seq = Math.max(prevSeq, status.lastPublishedSeq || 0) + 1;
    const card = sc.scorecard(run.state, run.manifest, at, seq, { publishActor: status.publishActor !== false });
    const problems = sc.validateScorecard(card);
    if (problems.length > 0) _refuse(REFUSAL.INVALID_SAMPLE, 'the scorecard does not validate', { problems });
    const files = { [docPaths.scorecard]: sc.serialize(card) };
    const ours = run.events.map((e) => JSON.stringify(sc.eventLine(e)));
    const theirs = (read(docPaths.events) || '').split('\n').filter(Boolean);
    if (theirs.length > ours.length || theirs.some((line, i) => line !== ours[i])) {
      _refuse(REFUSAL.EVENTS_DIVERGED, 'the published transition log is not a prefix of this run\'s', { path: docPaths.events });
    }
    if (ours.length > theirs.length) files[docPaths.events] = `${ours.join('\n')}\n`;
    const indexText = read(sc.INDEX_PATH);
    const others = indexText === null ? [] : JSON.parse(indexText).candidates.filter((c) => c.candidateSha !== ctx.candidateSha);
    files[sc.INDEX_PATH] = sc.serialize(sc.indexDoc([...others, card]));
    return { files, seq };
  }

  /**
   * Publish the run's current standing. Holds `publish.lock` so a manual
   * publish and the runner's never interleave.
   * @param {object} run - `{state, manifest, events}`
   * @returns {Promise<{seq: number, changed: boolean}>} What was published
   */
  async function update(run) {
    const token = lockfile.acquire(runPaths.publishLock, { timeoutMs: 0 });
    try {
      const status = readStatus();
      const at = now();
      let seq = null;
      const result = await ctx.publisher.publish((read) => {
        const out = _updateFiles(read, run, status, at);
        seq = out.seq;
        return out.files;
      }, `scorecard: ${sha7} ${run.state.state}`);
      writeStatus({ lastPublishedSeq: seq, lastPublishedAt: at, failures: 0, lastError: null, nextAttemptAt: null });
      return { seq, changed: result.changed };
    } finally {
      lockfile.release(runPaths.publishLock, token);
    }
  }

  /**
   * Record a failed publish and schedule the next attempt.
   * @param {Error} err - The failure
   * @returns {object} The new status
   */
  function recordFailure(err) {
    const failures = (readStatus().failures || 0) + 1;
    return writeStatus({ failures, lastError: err.code || 'PUBLISH_FAILED', nextAttemptAt: now() + backoffMs(failures) });
  }

  /**
   * Whether an update is due: after a transition or a terminal state, when
   * nothing has been published, or once the heartbeat has passed, but never
   * inside a failure backoff.
   * @param {{transitioned: boolean, state: string}} hint - What just happened
   * @returns {boolean} True when the runner should publish now
   */
  function due(hint) {
    const status = readStatus();
    const t = now();
    if (status.nextAttemptAt !== null && t < status.nextAttemptAt) return false;
    if (hint.transitioned || isTerminal(hint.state) || status.lastPublishedAt === null) return true;
    return t - status.lastPublishedAt >= HEARTBEAT_MS;
  }

  return { admit, update, due, recordFailure, readStatus };
}

module.exports = { HEARTBEAT_MS, backoffMs, createPublication };
