'use strict';

/**
 * Required checks judged by the host, for a runner that has no route to
 * GitHub (#2020, Architect rulings Q1, A31 and A32).
 *
 * The certifying soak runs in a guest with no egress and no credentials, yet
 * a certification still has to know, at admission and at every sample, that
 * the candidate's required checks are green. So the host reads GitHub and the
 * guest asks it: for each sample the guest writes a request into an exchange
 * directory, and the host answers with a verdict bound to that exact sample.
 *
 * - **Every verdict is bound** to the candidate SHA, the run id the host
 *   minted, the sample's sequence number and the manifest digest, and carries
 *   a digest of its own content. The guest accepts a verdict only when every
 *   binding matches the sample it is taking; anything else (missing, late,
 *   unparsable, mismatched, stale) reads as GitHub unavailable, which earns no
 *   time. Nothing here decides a pass; it only stops a sample vouching for
 *   checks nobody verified.
 * - **The host answers only for runs it minted.** `mintRun` records a run id
 *   together with the repository and checks it will judge; a request naming
 *   any other run id is never answered, so the guest's wait fails closed.
 * - **The host keeps its own record.** Every verdict it issues is appended to
 *   a host-private ledger. `finalize` joins the run's exported samples against
 *   that ledger: the admission sample and every sample that earned time must
 *   carry a verdict the host really issued, green for every required check,
 *   and the checks must still be green when read once more at the end.
 *
 * The exchange directory is plain files, `requests/<seq>.json` and
 * `verdicts/<seq>.json`, so whatever transport carries files between host and
 * guest can mirror it. The host side takes GitHub's observer as a parameter
 * (`probes.observeGithub`), which keeps this module free of GitHub and of any
 * dependency on the probes that call it.
 *
 * @module lib/release-certification/host-checks
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const privateFs = require('./private-fs');
const { SHA_RE, DIGEST_RE, RUN_ID_RE, REPO_RE, isCount, validRequiredChecks } = require('./formats');
const { REFUSAL, CertificationError } = require('./codes');

const REQUEST_SCHEMA = 'tc.release-certification.checks-request/v1';
const VERDICT_SCHEMA = 'tc.release-certification.checks-verdict/v1';
const MINT_SCHEMA = 'tc.release-certification.checks-run/v1';
const FINALIZATION_SCHEMA = 'tc.release-certification.checks-finalization/v1';

/** How long a sample waits for its verdict by default: well inside the shortest sampling interval. */
const DEFAULT_WAIT_MS = 10 * 1000;
const POLL_MS = 250;

/** Why a sample's checks could not be vouched for. Recorded as the sample's GitHub diagnostic. */
const DIAGNOSTIC = Object.freeze({
  UNBOUND: 'host-verdict-unbound',
  MISSING: 'host-verdict-missing',
  INVALID: 'host-verdict-invalid',
  MISMATCH: 'host-verdict-mismatch',
  STALE: 'host-verdict-stale',
  REQUEST_FAILED: 'host-request-failed'
});

/** Why a host finalization failed. Closed codes, each naming a sample where one applies. */
const FINALIZATION = Object.freeze({
  NOT_HOST_ATTESTED: 'NOT_HOST_ATTESTED',
  RUN_NOT_MINTED: 'RUN_NOT_MINTED',
  CHECKS_LIST_DRIFT: 'CHECKS_LIST_DRIFT',
  NOT_REVIEWABLE: 'NOT_REVIEWABLE',
  VERDICT_MISSING: 'VERDICT_MISSING',
  VERDICT_MISMATCH: 'VERDICT_MISMATCH',
  VERDICT_NOT_GREEN: 'VERDICT_NOT_GREEN',
  FINAL_CHECKS_UNAVAILABLE: 'FINAL_CHECKS_UNAVAILABLE',
  FINAL_CHECKS_NOT_GREEN: 'FINAL_CHECKS_NOT_GREEN'
});

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
 * The exchange directory's two halves.
 * @param {string} dir - Exchange directory
 * @returns {{requests: string, verdicts: string}} Paths
 */
function exchangePaths(dir) {
  return { requests: path.join(dir, 'requests'), verdicts: path.join(dir, 'verdicts') };
}

/**
 * The host's private files for one candidate.
 * @param {string} hostBase - Host state directory
 * @param {string} candidateSha - Candidate SHA
 * @returns {{dir: string, runs: string, ledger: string, finalization: string}} Paths
 */
function hostPaths(hostBase, candidateSha) {
  if (typeof hostBase !== 'string' || !path.isAbsolute(hostBase)) _refuse(REFUSAL.STORE_UNSAFE, 'the host state directory must be absolute');
  if (typeof candidateSha !== 'string' || !SHA_RE.test(candidateSha)) _refuse(REFUSAL.INVALID_MANIFEST, 'candidateSha must be 40 lowercase hex characters', { field: 'candidateSha' });
  const dir = path.join(hostBase, candidateSha);
  return { dir, runs: path.join(dir, 'runs.ndjson'), ledger: path.join(dir, 'verdicts.ndjson'), finalization: path.join(dir, 'finalization.json') };
}

/**
 * The digest a verdict is known by: sha256 over its fields in a fixed order,
 * excluding the digest itself.
 * @param {object} v - Verdict
 * @returns {string} Hex sha256
 */
function verdictDigest(v) {
  const canonical = JSON.stringify([
    v.schema, v.candidateSha, v.runId, v.manifestDigest, v.sampleSeq, v.requestedAt, v.observedAt,
    v.observation && v.observation.state,
    v.observation && v.observation.checks ? Object.keys(v.observation.checks).sort().map((k) => [k, v.observation.checks[k]]) : null
  ]);
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Whether a GitHub observation is well formed: `ok` with a state per check,
 * or `unavailable` with none.
 * @param {*} o - Observation
 * @returns {boolean} True when usable
 */
function _observationValid(o) {
  if (!o || typeof o !== 'object') return false;
  if (o.state === 'unavailable') return o.checks === null;
  if (o.state !== 'ok' || !o.checks || typeof o.checks !== 'object' || Array.isArray(o.checks)) return false;
  return Object.values(o.checks).every((c) => ['success', 'failure', 'pending', 'missing'].includes(c));
}

/**
 * Judge a verdict's text against the sample it must vouch for.
 * @param {string|null} text - The verdict file, or null when absent
 * @param {{candidateSha: string, runId: string, manifestDigest: string, sampleSeq: number, requestedAt: number}} expected - The sample's binding
 * @param {number} now - Epoch ms
 * @param {number} maxAgeMs - Oldest verdict that may vouch for this sample
 * @returns {{observation: object, binding: {sampleSeq: number, verdictDigest: string}}|{diagnostic: string}} The observation and binding, or why not
 */
function judgeVerdict(text, expected, now, maxAgeMs) {
  if (text === null) return { diagnostic: DIAGNOSTIC.MISSING };
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return { diagnostic: DIAGNOSTIC.INVALID };
  }
  if (!v || v.schema !== VERDICT_SCHEMA || !_observationValid(v.observation) || !isCount(v.observedAt) || typeof v.verdictDigest !== 'string') {
    return { diagnostic: DIAGNOSTIC.INVALID };
  }
  const bound = ['candidateSha', 'runId', 'manifestDigest', 'sampleSeq', 'requestedAt'].every((k) => v[k] === expected[k]);
  if (!bound || verdictDigest(v) !== v.verdictDigest) return { diagnostic: DIAGNOSTIC.MISMATCH };
  // A verdict observed before the sample asked, or too long ago to speak for
  // it now, cannot vouch for this sample's checks.
  if (v.observedAt < expected.requestedAt || now - v.observedAt > maxAgeMs) return { diagnostic: DIAGNOSTIC.STALE };
  return { observation: { state: v.observation.state, checks: v.observation.checks }, binding: { sampleSeq: v.sampleSeq, verdictDigest: v.verdictDigest } };
}

/**
 * Guest side: ask the host for this sample's checks and wait, bounded, for a
 * verdict bound to it. Never throws: anything short of a verified verdict is
 * GitHub unavailable, with the reason as the diagnostic.
 * @param {object} ctx - Probe context: `{candidateSha, runId, exchangeDir, hostVerdictWaitMs, maxReadingAgeMs}`
 * @param {{seq: number, manifestDigest: string}|undefined} binding - The sample being taken
 * @param {object} [deps] - `{now, sleep}` seams
 * @returns {Promise<{observation: object, error: string|null, binding?: object}>} What the probe reports
 */
async function attest(ctx, binding, deps = {}) {
  const unavailable = (error) => ({ observation: { state: 'unavailable', checks: null }, error });
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  if (!binding || !Number.isSafeInteger(binding.seq) || binding.seq < 1 || typeof binding.manifestDigest !== 'string' || !RUN_ID_RE.test(ctx.runId || '')) {
    return unavailable(DIAGNOSTIC.UNBOUND);
  }
  const expected = { candidateSha: ctx.candidateSha, runId: ctx.runId, manifestDigest: binding.manifestDigest, sampleSeq: binding.seq, requestedAt: now() };
  const paths = exchangePaths(ctx.exchangeDir);
  const verdictPath = path.join(paths.verdicts, `${binding.seq}.json`);
  try {
    privateFs.ensurePrivateDir(paths.requests);
    // A verdict left from an earlier attempt at the same seq is for another
    // request time, so it is removed before asking; it could never match.
    fs.rmSync(verdictPath, { force: true });
    privateFs.replaceAtomic(path.join(paths.requests, `${binding.seq}.json`), `${JSON.stringify({ schema: REQUEST_SCHEMA, ...expected })}\n`);
  } catch (err) { // prawduct:allow prawduct/broad-except -- probe boundary: a request that cannot be written is a sample without checks, never a crash of the runner
    return unavailable(DIAGNOSTIC.REQUEST_FAILED);
  }
  const deadline = expected.requestedAt + (ctx.hostVerdictWaitMs ?? DEFAULT_WAIT_MS);
  for (;;) {
    let text = null;
    try {
      text = privateFs.readPrivate(verdictPath);
    } catch (err) {
      if (!(err instanceof CertificationError)) throw err;
      return unavailable(DIAGNOSTIC.INVALID);
    }
    if (text !== null) {
      const judged = judgeVerdict(text, expected, now(), ctx.maxReadingAgeMs);
      if (judged.diagnostic) return unavailable(judged.diagnostic);
      return { observation: judged.observation, error: null, binding: judged.binding };
    }
    if (now() >= deadline) return unavailable(DIAGNOSTIC.MISSING);
    await sleep(Math.min(POLL_MS, Math.max(1, deadline - now())));
  }
}

/**
 * Read an append-only ndjson file of the host's, keeping only complete records.
 * @param {string} file - Path
 * @returns {object[]} Records
 */
function _records(file) {
  return privateFs.readLines(file).records;
}

/**
 * Host side: mint a run id for a candidate and record what the host will
 * judge for it. The id is 128 random bits and is minted once per run: a
 * crash-retry reuses the run whose admission is public, and a genuinely new
 * start mints a new one.
 * @param {string} hostBase - Host state directory
 * @param {{candidateSha: string, repository: string, requiredChecks: string[]}} run - What the run is judged by
 * @param {object} [deps] - `{now, random}` seams
 * @returns {{runId: string}} The minted id
 */
function mintRun(hostBase, run, deps = {}) {
  const paths = hostPaths(hostBase, run.candidateSha);
  if (typeof run.repository !== 'string' || !REPO_RE.test(run.repository)) _refuse(REFUSAL.INVALID_MANIFEST, 'repository must be owner/name', { field: 'repository' });
  if (!validRequiredChecks(run.requiredChecks)) _refuse(REFUSAL.INVALID_MANIFEST, 'requiredChecks must name 1 to 64 unique checks', { field: 'requiredChecks' });
  const runId = (deps.random || (() => crypto.randomBytes(16).toString('hex')))();
  if (!RUN_ID_RE.test(runId)) _refuse(REFUSAL.INVALID_MANIFEST, 'a minted run id must be 32 lowercase hex characters', { field: 'runId' });
  privateFs.ensurePrivateDir(paths.dir);
  const record = { schema: MINT_SCHEMA, candidateSha: run.candidateSha, runId, repository: run.repository, requiredChecks: [...run.requiredChecks].sort(), mintedAt: (deps.now || Date.now)() };
  privateFs.appendLine(paths.runs, JSON.stringify(record));
  return { runId };
}

/**
 * The runs the host minted for a candidate, by run id.
 * @param {string} hostBase - Host state directory
 * @param {string} candidateSha - Candidate SHA
 * @returns {Map<string, object>} Run id to its mint record
 */
function mintedRuns(hostBase, candidateSha) {
  const out = new Map();
  for (const r of _records(hostPaths(hostBase, candidateSha).runs)) {
    if (r && r.schema === MINT_SCHEMA && r.candidateSha === candidateSha && RUN_ID_RE.test(r.runId || '')) out.set(r.runId, r);
  }
  return out;
}

/**
 * Parse a request, or null when it is not one this host can answer.
 * @param {string|null} text - Request file
 * @param {string} candidateSha - The candidate this host is answering for
 * @param {string} seqName - The file's sequence number, from its name
 * @returns {object|null} The request
 */
function _parseRequest(text, candidateSha, seqName) {
  let r;
  try {
    r = JSON.parse(text);
  } catch {
    return null;
  }
  const ok = r && r.schema === REQUEST_SCHEMA && r.candidateSha === candidateSha && RUN_ID_RE.test(r.runId || '')
    && typeof r.manifestDigest === 'string' && DIGEST_RE.test(r.manifestDigest)
    && Number.isSafeInteger(r.sampleSeq) && r.sampleSeq >= 1 && String(r.sampleSeq) === seqName && isCount(r.requestedAt);
  return ok ? r : null;
}

/**
 * Host side: answer every pending request in the exchange directory. Each
 * answer reads GitHub afresh, is appended to the host's ledger, and is then
 * written for the guest. A request for a run this host never minted, or one
 * that does not parse, is skipped and reported, never answered.
 * @param {object} opts
 * @param {string} opts.hostBase - Host state directory
 * @param {string} opts.exchangeDir - Exchange directory
 * @param {string} opts.candidateSha - Candidate SHA
 * @param {function({repo: string, candidateSha: string, requiredChecks: string[]}): Promise<{observation: object, error: string|null}>} opts.observe - GitHub observer (`probes.observeGithub`)
 * @param {function(): number} [opts.now] - Clock
 * @returns {Promise<{answered: number[], skipped: {file: string, reason: string}[]}>} What was done
 */
async function answerRequests(opts) {
  const now = opts.now || (() => Date.now());
  const paths = exchangePaths(opts.exchangeDir);
  const ledgerPath = hostPaths(opts.hostBase, opts.candidateSha).ledger;
  const minted = mintedRuns(opts.hostBase, opts.candidateSha);
  const answered = [];
  const skipped = [];
  let names = [];
  try {
    names = fs.readdirSync(paths.requests).filter((n) => /^[1-9][0-9]{0,15}\.json$/.test(n));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  privateFs.ensurePrivateDir(paths.verdicts);
  for (const name of names.sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10))) {
    const seqName = name.slice(0, -'.json'.length);
    const request = _parseRequest(privateFs.readPrivate(path.join(paths.requests, name)), opts.candidateSha, seqName);
    if (!request) {
      skipped.push({ file: name, reason: 'invalid-request' });
      continue;
    }
    const run = minted.get(request.runId);
    if (!run) {
      skipped.push({ file: name, reason: 'run-not-minted' });
      continue;
    }
    const verdictPath = path.join(paths.verdicts, name);
    const existing = privateFs.readPrivate(verdictPath);
    if (existing !== null && judgeVerdict(existing, request, now(), Number.MAX_SAFE_INTEGER).binding) continue;
    const { observation } = await opts.observe({ repo: run.repository, candidateSha: opts.candidateSha, requiredChecks: run.requiredChecks });
    const verdict = {
      schema: VERDICT_SCHEMA,
      candidateSha: request.candidateSha,
      runId: request.runId,
      manifestDigest: request.manifestDigest,
      sampleSeq: request.sampleSeq,
      requestedAt: request.requestedAt,
      observedAt: now(),
      observation: _observationValid(observation) ? observation : { state: 'unavailable', checks: null }
    };
    verdict.verdictDigest = verdictDigest(verdict);
    // The ledger first: a verdict the guest can see is always one the host
    // has on record, so finalization can never meet a verdict it did not issue.
    privateFs.appendLine(ledgerPath, JSON.stringify(verdict));
    privateFs.replaceAtomic(verdictPath, `${JSON.stringify(verdict)}\n`);
    answered.push(request.sampleSeq);
  }
  return { answered, skipped };
}

/**
 * Host side: decide whether a finished run's checks were really vouched for,
 * and record the answer. The run is read from its exported evidence; the host
 * trusts nothing in it that its own ledger does not confirm.
 * @param {object} opts
 * @param {string} opts.hostBase - Host state directory
 * @param {object} opts.manifest - The run's manifest
 * @param {string} opts.manifestDigest - The digest of the manifest as stored
 * @param {object} opts.state - The run's committed state
 * @param {object[]} opts.samples - The run's sample records (`store.readSamples`)
 * @param {function(object): Promise<{observation: object, error: string|null}>} opts.observe - GitHub observer, for the final read
 * @param {function(): number} [opts.now] - Clock
 * @returns {Promise<{ok: boolean, reasons: {code: string, sampleSeq?: number}[]}>} The outcome, also written to `finalization.json`
 */
async function finalize(opts) {
  const now = opts.now || (() => Date.now());
  const { manifest } = opts;
  const reasons = [];
  const add = (code, extra = {}) => reasons.push({ code, ...extra });
  const paths = hostPaths(opts.hostBase, manifest.candidateSha);
  const run = mintedRuns(opts.hostBase, manifest.candidateSha).get(manifest.runId);
  if (manifest.checksSource !== 'host-attested') add(FINALIZATION.NOT_HOST_ATTESTED);
  if (!run) add(FINALIZATION.RUN_NOT_MINTED);
  else if (JSON.stringify([...manifest.requiredChecks].sort()) !== JSON.stringify(run.requiredChecks) || manifest.repository !== run.repository) {
    add(FINALIZATION.CHECKS_LIST_DRIFT);
  }
  if (!['awaiting-review', 'passed'].includes(opts.state.state)) add(FINALIZATION.NOT_REVIEWABLE);
  const ledger = new Map();
  for (const v of _records(paths.ledger)) {
    if (v && v.schema === VERDICT_SCHEMA && v.candidateSha === manifest.candidateSha && v.runId === manifest.runId && v.manifestDigest === opts.manifestDigest) {
      ledger.set(`${v.sampleSeq}:${v.verdictDigest}`, v);
    }
  }
  const green = (o) => o && o.state === 'ok' && manifest.requiredChecks.every((c) => o.checks[c] === 'success');
  for (const record of opts.samples) {
    // Admission (seq 1) and every sample that earned time must be vouched for.
    const mustVouch = record.seq === 1 || (record.interval && record.interval.qualifies === true);
    if (!mustVouch) continue;
    const b = record.checks;
    if (!b || b.sampleSeq !== record.seq || typeof b.verdictDigest !== 'string') {
      add(FINALIZATION.VERDICT_MISSING, { sampleSeq: record.seq });
      continue;
    }
    const issued = ledger.get(`${record.seq}:${b.verdictDigest}`);
    if (!issued || verdictDigest(issued) !== b.verdictDigest) add(FINALIZATION.VERDICT_MISMATCH, { sampleSeq: record.seq });
    else if (!green(issued.observation)) add(FINALIZATION.VERDICT_NOT_GREEN, { sampleSeq: record.seq });
  }
  if (run) {
    const final = await opts.observe({ repo: run.repository, candidateSha: manifest.candidateSha, requiredChecks: run.requiredChecks });
    if (!final.observation || final.observation.state !== 'ok') add(FINALIZATION.FINAL_CHECKS_UNAVAILABLE);
    else if (!green(final.observation)) add(FINALIZATION.FINAL_CHECKS_NOT_GREEN);
  }
  const outcome = { ok: reasons.length === 0, reasons };
  privateFs.ensurePrivateDir(paths.dir);
  privateFs.replaceAtomic(paths.finalization, `${JSON.stringify({
    schema: FINALIZATION_SCHEMA, candidateSha: manifest.candidateSha, runId: manifest.runId ?? null,
    manifestDigest: opts.manifestDigest, state: opts.state.state, ...outcome, finalizedAt: now()
  }, null, 2)}\n`);
  return outcome;
}

/**
 * The host's recorded finalization for a candidate, or null when none exists.
 * @param {string} hostBase - Host state directory
 * @param {string} candidateSha - Candidate SHA
 * @returns {object|null} The record
 */
function readFinalization(hostBase, candidateSha) {
  const text = privateFs.readPrivate(hostPaths(hostBase, candidateSha).finalization);
  if (text === null) return null;
  try {
    const doc = JSON.parse(text);
    return doc && doc.schema === FINALIZATION_SCHEMA ? doc : null;
  } catch {
    return null;
  }
}

module.exports = {
  REQUEST_SCHEMA,
  VERDICT_SCHEMA,
  DEFAULT_WAIT_MS,
  DIAGNOSTIC,
  FINALIZATION,
  exchangePaths,
  hostPaths,
  verdictDigest,
  judgeVerdict,
  attest,
  mintRun,
  mintedRuns,
  answerRequests,
  finalize,
  readFinalization
};
