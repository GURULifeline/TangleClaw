'use strict';

/**
 * The evidence store for release-candidate certification.
 *
 * One run per candidate SHA, in a private directory:
 *
 *   <base>/<candidateSha>/
 *     manifest.json   written once; what is being certified and how
 *     state.json      the run's current state; the commit point
 *     samples.ndjson  every sample, append-only
 *     snapshots/      one file per state transition, in order
 *     lock            held around every read-modify-write
 *
 * `state.json` is the commit point. A sample record is appended before it is
 * written, so a committed state can always be traced to the sample that
 * produced it; a record numbered past the committed `sampleCount` is from a
 * write that never committed, and readers ignore it. A snapshot is written
 * after it, so a crash can lose a snapshot but never leave one describing a
 * transition that did not happen.
 *
 * The manifest's sha256 is kept in `state.json` and in every snapshot. A
 * manifest whose bytes no longer match is refused on every read, so a run
 * cannot be quietly re-pointed at different thresholds or a different SHA.
 *
 * @module lib/release-certification/store
 */

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const tangleclawHome = require('../tangleclaw-home');
const privateFs = require('./private-fs');
const lockfile = require('./lockfile');
const { SCHEMA, REFUSAL, CertificationError } = require('./codes');

const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Throw a store refusal.
 * @param {string} code - A REFUSAL code
 * @param {string} message - Why
 * @param {object} [details] - Bounded facts
 * @returns {never}
 */
function _refuse(code, message, details) {
  throw new CertificationError(code, message, details);
}

/**
 * The default evidence base: `<tangleclawHome>/release-certification/v1`.
 * @returns {string} Absolute path
 */
function defaultBase() {
  return path.join(tangleclawHome.baseDir(), 'release-certification', 'v1');
}

/**
 * The paths of one run.
 * @param {string} base - Evidence base
 * @param {string} candidateSha - 40-character SHA
 * @returns {{dir: string, manifest: string, state: string, samples: string, snapshots: string, lock: string}} Paths
 */
function runPaths(base, candidateSha) {
  if (typeof candidateSha !== 'string' || !SHA_RE.test(candidateSha)) {
    _refuse(REFUSAL.INVALID_MANIFEST, 'candidateSha must be 40 lowercase hex characters', { field: 'candidateSha' });
  }
  if (typeof base !== 'string' || !path.isAbsolute(base)) _refuse(REFUSAL.STORE_UNSAFE, 'the evidence base must be absolute');
  const dir = path.join(base, candidateSha);
  return {
    dir,
    manifest: path.join(dir, 'manifest.json'),
    state: path.join(dir, 'state.json'),
    samples: path.join(dir, 'samples.ndjson'),
    snapshots: path.join(dir, 'snapshots'),
    lock: path.join(dir, 'lock')
  };
}

/**
 * Make the base and run directories, each private.
 * @param {string} base - Evidence base
 * @param {object} paths - From `runPaths`
 * @returns {void}
 */
function _ensureDirs(base, paths) {
  privateFs.ensurePrivateDir(base);
  privateFs.ensurePrivateDir(paths.dir);
  privateFs.ensurePrivateDir(paths.snapshots);
}

/**
 * sha256 of a manifest's exact bytes.
 * @param {string} text - Manifest file contents
 * @returns {string} Hex digest
 */
function _digest(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Parse an evidence document, refusing damage.
 * @param {string} text - File contents
 * @param {string} what - Which document, for the message
 * @returns {object} Parsed document
 */
function _parse(text, what) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    _refuse(REFUSAL.EVIDENCE_CORRUPT, `${what} is not valid JSON`, { document: what });
  }
  if (!doc || doc.schema !== SCHEMA) _refuse(REFUSAL.EVIDENCE_CORRUPT, `${what} has an unknown schema`, { document: what });
  return doc;
}

/**
 * The sample record appended to `samples.ndjson`: the sample exactly as
 * observed, plus what the state machine made of it.
 * @param {number} seq - Sample sequence number
 * @param {object} sample - The sample
 * @param {object|null} verdict - `classify` result
 * @param {object|null} interval - `assessInterval` result (null at admission)
 * @returns {object} Record
 */
function sampleRecord(seq, sample, verdict, interval) {
  return { schema: SCHEMA, seq, ...sample, verdict, interval };
}

/**
 * Write snapshots for transition events, after the state that contains them
 * committed. Names lead with a running index, under the lock, so listing
 * order is transition order even when an operator's event shares a sample
 * number with the transition before it.
 * @param {object} paths - Run paths
 * @param {object} state - Committed state
 * @param {object[]} events - Transition events
 * @returns {void}
 */
function _writeSnapshots(paths, state, events) {
  let index = fs.readdirSync(paths.snapshots).filter((n) => n.endsWith('.json')).length;
  for (const event of events) {
    index += 1;
    const seq = String(event.sampleSeq ?? state.sampleCount).padStart(8, '0');
    const file = path.join(paths.snapshots, `${String(index).padStart(6, '0')}-${seq}-${event.code}-${event.to}.json`);
    const doc = { schema: SCHEMA, manifestDigest: state.manifestDigest, event, state };
    privateFs.replaceAtomic(file, `${JSON.stringify(doc, null, 2)}\n`);
  }
}

/**
 * Persist one committed change under a held lock: sample record, then state,
 * then snapshots.
 * @param {object} paths - Run paths
 * @param {string} token - Lock token
 * @param {{state: object, events: object[], record?: object}} change - What to persist
 * @returns {void}
 */
function _persist(paths, token, change) {
  lockfile.assertHeld(paths.lock, token);
  if (change.record) privateFs.appendLine(paths.samples, JSON.stringify(change.record));
  lockfile.assertHeld(paths.lock, token);
  privateFs.replaceAtomic(paths.state, `${JSON.stringify(change.state, null, 2)}\n`);
  _writeSnapshots(paths, change.state, change.events);
}

/**
 * Run a function while holding a run's lock.
 * @param {object} paths - Run paths
 * @param {object} opts - `{lockTimeoutMs, lockDeps}`
 * @param {function(string): *} fn - Receives the token
 * @returns {*} What `fn` returns
 */
function _withLock(paths, opts, fn) {
  const token = lockfile.acquire(paths.lock, { timeoutMs: opts.lockTimeoutMs, deps: opts.lockDeps });
  try {
    return fn(token);
  } finally {
    lockfile.release(paths.lock, token);
  }
}

/**
 * Create a run from an admitted candidate. A run exists once its state is
 * committed; until then nothing depends on a manifest, so one left by a crash
 * during an earlier attempt is replaced. Once a state exists the run is
 * refused, and its manifest is never rewritten.
 * @param {string} base - Evidence base
 * @param {object} manifest - From `buildManifest`
 * @param {{state: object, events: object[]}} admission - From `admit`
 * @param {object} sample - The admission sample
 * @param {object} [opts] - `{lockTimeoutMs, lockDeps}`
 * @returns {object} The committed state
 */
function createRun(base, manifest, admission, sample, opts = {}) {
  const paths = runPaths(base, manifest.candidateSha);
  _ensureDirs(base, paths);
  return _withLock(paths, opts, (token) => {
    if (privateFs.readPrivate(paths.state) !== null) _refuse(REFUSAL.RUN_EXISTS, 'a run already exists for this candidate');
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    if (!privateFs.writeOnce(paths.manifest, text)) privateFs.replaceAtomic(paths.manifest, text);
    const state = { ...admission.state, manifestDigest: _digest(text) };
    _persist(paths, token, { state, events: admission.events, record: sampleRecord(1, sample, null, null) });
    return state;
  });
}

/**
 * Read a run, verifying its manifest has not changed since the run began.
 * @param {string} base - Evidence base
 * @param {string} candidateSha - 40-character SHA
 * @returns {{paths: object, manifest: object, state: object}} The run
 */
function readRun(base, candidateSha) {
  const paths = runPaths(base, candidateSha);
  const manifestText = privateFs.readPrivate(paths.manifest);
  const stateText = privateFs.readPrivate(paths.state);
  if (manifestText === null || stateText === null) _refuse(REFUSAL.RUN_NOT_FOUND, 'no run exists for this candidate');
  const state = _parse(stateText, 'state');
  if (_digest(manifestText) !== state.manifestDigest) _refuse(REFUSAL.MANIFEST_TAMPERED, 'the manifest changed after the run began');
  const manifest = _parse(manifestText, 'manifest');
  if (manifest.candidateSha !== candidateSha || state.candidateSha !== candidateSha) {
    _refuse(REFUSAL.EVIDENCE_CORRUPT, 'the evidence names a different candidate', { document: 'manifest' });
  }
  return { paths, manifest, state };
}

/**
 * Apply a change to a run under its lock: read the current state, let `fn`
 * decide, persist what it returns. `fn` sees the state as committed, so a
 * runner tick and an operator's accept never overwrite each other.
 * @param {string} base - Evidence base
 * @param {string} candidateSha - 40-character SHA
 * @param {function(object, object): ({state: object, events: object[], record?: object}|null)} fn - `(state, manifest)`; null changes nothing
 * @param {object} [opts] - `{lockTimeoutMs, lockDeps}`
 * @returns {object} The state after the change
 */
function updateRun(base, candidateSha, fn, opts = {}) {
  const paths = runPaths(base, candidateSha);
  _ensureDirs(base, paths);
  return _withLock(paths, opts, (token) => {
    const { manifest, state } = readRun(base, candidateSha);
    const change = fn(state, manifest);
    if (!change) return state;
    _persist(paths, token, change);
    return change.state;
  });
}

/**
 * The committed sample records of a run, oldest first. Records past the
 * committed count, and all but the last record for a sequence number, come
 * from writes that did not commit and are left out.
 * @param {string} base - Evidence base
 * @param {string} candidateSha - 40-character SHA
 * @returns {object[]} Sample records
 */
function readSamples(base, candidateSha) {
  const { paths, state } = readRun(base, candidateSha);
  const bySeq = new Map();
  for (const record of privateFs.readLines(paths.samples).records) {
    if (Number.isSafeInteger(record.seq) && record.seq >= 1 && record.seq <= state.sampleCount) bySeq.set(record.seq, record);
  }
  return [...bySeq.keys()].sort((a, b) => a - b).map((seq) => bySeq.get(seq));
}

/**
 * The transition snapshots of a run, oldest first.
 * @param {string} base - Evidence base
 * @param {string} candidateSha - 40-character SHA
 * @returns {object[]} Snapshot documents
 */
function readSnapshots(base, candidateSha) {
  const { paths } = readRun(base, candidateSha);
  let names;
  try {
    names = fs.readdirSync(paths.snapshots).filter((n) => n.endsWith('.json')).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names.map((n) => _parse(privateFs.readPrivate(path.join(paths.snapshots, n)), 'snapshot'));
}

/**
 * The candidate SHAs that have runs under a base.
 * @param {string} base - Evidence base
 * @returns {string[]} SHAs, sorted
 */
function listRuns(base) {
  let names;
  try {
    names = fs.readdirSync(base);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return names.filter((n) => SHA_RE.test(n)).sort();
}

module.exports = {
  defaultBase,
  runPaths,
  sampleRecord,
  createRun,
  readRun,
  updateRun,
  readSamples,
  readSnapshots,
  listRuns
};
