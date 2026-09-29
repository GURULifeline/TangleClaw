'use strict';

/**
 * The provider side of the soak guest's isolation attestation (#2020,
 * Architect ruling 2baeac0d on the Chunk 1 / B7 interface).
 *
 * `guest-setup.sh --verify-network` obtains one fresh `--verify-admin` line
 * and one fresh `--verify-workload` line (the guest's own raw
 * `tc.soak-guest-attest/v1` evidence) and hands both here with the sample's
 * binding. This turns them into exactly one `{admin, workload}` pair in the
 * release-certification isolation schemas, with the binding copied into both
 * planes, or refuses. The judge (`lib/release-certification/isolation.js`)
 * never parses the raw lines itself.
 *
 * It refuses, and so yields no pair, on anything it cannot convert without
 * guessing: a missing or malformed binding, anything but exactly one JSON line
 * per plane, a plane that is not `ok`, a field it needs that is missing or
 * mistyped, a boot or artifact identity the two planes disagree on, or a value
 * outside what it maps. A refusal is recorded by the runner as unattested,
 * which earns no time. Only healthy (`ok`) lines are ever converted, so a
 * pair it produces describes a guest both planes found isolated.
 *
 * @module lib/soak/attest-bridge
 */

const RAW_SCHEMA = 'tc.soak-guest-attest/v1';
const ADMIN_SCHEMA = 'tc.release-certification.isolation-admin/v1';
const WORKLOAD_SCHEMA = 'tc.release-certification.isolation-workload/v1';

const SHA_RE = /^[0-9a-f]{40}$/;
const RUN_ID_RE = /^[0-9a-f]{32}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const SEQ_RE = /^[1-9][0-9]{0,15}$/;
const TEXT_RE = /^[^\u0000-\u001f]{1,256}$/;

/** A refusal: the bridge yields no pair. */
class BridgeError extends Error {
  /**
   * @param {string} code - Closed code
   * @param {string} message - Why
   */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Throw a refusal.
 * @param {string} code - Closed code
 * @param {string} message - Why
 * @returns {never}
 */
function _refuse(code, message) {
  throw new BridgeError(code, message);
}

/**
 * Validate the sample's binding, as the four command-line values.
 * @param {{candidateSha: string, runId: string, manifestDigest: string, sampleSeq: string}} raw - The values as given
 * @returns {{candidateSha: string, runId: string, manifestDigest: string, sampleSeq: number}} The binding
 */
function parseBinding(raw) {
  if (!raw || !SHA_RE.test(raw.candidateSha || '')) _refuse('BINDING', 'candidate must be 40 lowercase hex characters');
  if (!RUN_ID_RE.test(raw.runId || '')) _refuse('BINDING', 'run id must be 32 lowercase hex characters');
  if (!DIGEST_RE.test(raw.manifestDigest || '')) _refuse('BINDING', 'manifest digest must be 64 lowercase hex characters');
  if (!SEQ_RE.test(raw.sampleSeq || '')) _refuse('BINDING', 'sample sequence must be a positive integer');
  const sampleSeq = Number(raw.sampleSeq);
  if (!Number.isSafeInteger(sampleSeq)) _refuse('BINDING', 'sample sequence is out of range');
  return { candidateSha: raw.candidateSha, runId: raw.runId, manifestDigest: raw.manifestDigest, sampleSeq };
}

/**
 * Parse one plane's output: exactly one JSON line, of the raw schema and mode,
 * reporting `ok`.
 * @param {*} text - The verifier's stdout
 * @param {'admin'|'workload'} mode - The plane
 * @returns {object} The parsed line
 */
function _line(text, mode) {
  if (typeof text !== 'string') _refuse('OUTPUT', `no ${mode} output`);
  const trimmed = text.replace(/\n$/, '');
  if (trimmed.length === 0 || trimmed.includes('\n') || trimmed.includes('\r')) _refuse('OUTPUT', `the ${mode} verifier must print exactly one line`);
  let doc;
  try {
    doc = JSON.parse(trimmed);
  } catch {
    _refuse('OUTPUT', `the ${mode} line is not JSON`);
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) _refuse('OUTPUT', `the ${mode} line is not a JSON object`);
  if (doc.schema !== RAW_SCHEMA || doc.mode !== mode) _refuse('OUTPUT', `the ${mode} line is not a ${RAW_SCHEMA} ${mode} attestation`);
  if (doc.ok !== true) _refuse('NOT_OK', `the ${mode} verifier did not attest: ${String(doc.code || '')} ${String(doc.reason || '').slice(0, 200)}`);
  return doc;
}

/**
 * Read a nested field, refusing when it is missing or fails `check`.
 * @param {object} doc - Parsed line
 * @param {string} dotted - Path such as `boot.session`
 * @param {function(*): boolean} check - Validity test
 * @param {string} mode - The plane, for the message
 * @returns {*} The value
 */
function _field(doc, dotted, check, mode) {
  let v = doc;
  for (const k of dotted.split('.')) v = v && typeof v === 'object' && !Array.isArray(v) ? v[k] : undefined;
  if (v === undefined || !check(v)) _refuse('FIELD', `the ${mode} line's ${dotted} is missing or malformed`);
  return v;
}

const isText = (v) => typeof v === 'string' && TEXT_RE.test(v);
const isDigest = (v) => typeof v === 'string' && DIGEST_RE.test(v);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isTrue = (v) => v === true;

/**
 * The epoch milliseconds of an attestation's own ISO time.
 * @param {object} doc - Parsed line
 * @param {string} mode - The plane
 * @returns {number} Epoch ms
 */
function _time(doc, mode) {
  const iso = _field(doc, 'time', (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v), mode);
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms <= 0) _refuse('FIELD', `the ${mode} line's time does not parse`);
  return ms;
}

/**
 * The boot and artifact identity a line carries: what both planes must agree on.
 * @param {object} doc - Parsed line
 * @param {string} mode - The plane
 * @returns {{bootId: string, artifacts: string}} Identity
 */
function _identity(doc, mode) {
  const session = _field(doc, 'boot.session', isText, mode);
  const time = _field(doc, 'boot.time', isCount, mode);
  const artifacts = ['scriptSha256', 'profileSha256', 'guestConfSha256'].map((k) => _field(doc, `artifact.${k}`, isDigest, mode));
  return { bootId: `${session}@${time}`, artifacts: artifacts.join(',') };
}

/**
 * Convert one fresh admin line and one fresh workload line into the bound pair.
 * @param {string} adminText - `--verify-admin` stdout
 * @param {string} workloadText - `--verify-workload` stdout
 * @param {object} rawBinding - The four binding values as given on the command line
 * @returns {{admin: object, workload: object}} The pair, in the release-certification isolation schemas
 */
function bridge(adminText, workloadText, rawBinding) {
  const binding = parseBinding(rawBinding);
  const a = _line(adminText, 'admin');
  const w = _line(workloadText, 'workload');
  const ai = _identity(a, 'admin');
  const wi = _identity(w, 'workload');
  if (ai.bootId !== wi.bootId) _refuse('SPLIT', 'the two planes report different boots');
  if (ai.artifacts !== wi.artifacts) _refuse('SPLIT', 'the two planes ran different guest-setup, profile or guest.conf artifacts');

  // The admin plane. An `ok` line has already proven the loaded ruleset is
  // exactly the profile, and that profile admits inbound SSH from the
  // configured host only while denying all guest-initiated egress: that is
  // what `host-only` asserts. A listening SSH is never read as closed.
  const expected = _field(a, 'pf.expectedRulesSha256', isDigest, 'admin');
  const active = _field(a, 'pf.activeRulesSha256', isDigest, 'admin');
  if (expected !== active) _refuse('FIELD', 'the admin line reports a ruleset that is not the profile');
  _field(a, 'pf.enabled', isTrue, 'admin');
  _field(a, 'pf.rulesMatch', isTrue, 'admin');
  const ssh = _field(a, 'management.ssh', isText, 'admin');
  if (ssh !== 'listening') _refuse('FIELD', `the admin line reports management.ssh '${ssh.slice(0, 40)}', which has no mapping`);
  const ifName = _field(a, 'interface.name', (v) => typeof v === 'string' && /^[a-z]+[0-9]+$/.test(v), 'admin');
  const ifAddr = _field(a, 'interface.address', (v) => typeof v === 'string' && /^[0-9]{1,3}(\.[0-9]{1,3}){3}$/.test(v), 'admin');
  const admin = {
    schema: ADMIN_SCHEMA,
    ...binding,
    bootId: ai.bootId,
    pfEnabled: true,
    rulesetSha256: active,
    interfaces: [`${ifName}=${ifAddr}`],
    managementPath: 'host-only',
    observedAt: _time(a, 'admin')
  };

  // The workload plane. Group ids come from the verifier's own numeric
  // evidence, never from resolving names.
  const uid = _field(w, 'identity.uid', (v) => Number.isSafeInteger(v) && v >= 501, 'workload');
  const gidsText = _field(w, 'identity.gids', (v) => typeof v === 'string' && /^[0-9]{1,10}( [0-9]{1,10}){0,63}$/.test(v), 'workload');
  const groups = gidsText.split(' ').map(Number);
  if (!groups.every((g) => Number.isSafeInteger(g))) _refuse('FIELD', 'the workload line\'s identity.gids is malformed');
  for (const k of ['refused.sudo', 'refused.pfctl', 'loopback.ipv4', 'loopback.ipv6', 'loopback.api']) _field(w, k, isTrue, 'workload');
  for (const k of ['egress.tcp4', 'egress.tcp6', 'egress.udpDns']) _field(w, k, (v) => v === 'denied', 'workload');
  const workload = {
    schema: WORKLOAD_SCHEMA,
    ...binding,
    bootId: wi.bootId,
    uid,
    groups,
    sudoRefused: true,
    pfctlRefused: true,
    loopbackApi: true,
    egressDenied: { ipv4: true, ipv6: true, dns: true },
    observedAt: _time(w, 'workload')
  };
  return { admin, workload };
}

/**
 * The command-line entry `guest-setup.sh --verify-network` calls: the two
 * raw lines and the four binding values, in that order. Prints exactly one
 * JSON line and exits 0, or prints the refusal to stderr and exits 3 with
 * nothing on stdout.
 * @param {string[]} args - `[adminText, workloadText, candidateSha, runId, manifestDigest, sampleSeq]`
 * @param {{stdout: {write: Function}, stderr: {write: Function}}} io - Streams
 * @returns {number} Exit code
 */
function main(args, io) {
  if (!Array.isArray(args) || args.length !== 6) {
    io.stderr.write('attest-bridge: expected exactly six arguments\n');
    return 3;
  }
  try {
    const [adminText, workloadText, candidateSha, runId, manifestDigest, sampleSeq] = args;
    const pair = bridge(adminText, workloadText, { candidateSha, runId, manifestDigest, sampleSeq });
    io.stdout.write(`${JSON.stringify(pair)}\n`);
    return 0;
  } catch (err) {
    if (!(err instanceof BridgeError)) throw err;
    io.stderr.write(`attest-bridge refused (${err.code}): ${err.message}\n`);
    return 3;
  }
}

module.exports = { RAW_SCHEMA, ADMIN_SCHEMA, WORKLOAD_SCHEMA, BridgeError, parseBinding, bridge, main };
