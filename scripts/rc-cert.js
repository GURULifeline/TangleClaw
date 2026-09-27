#!/usr/bin/env node
'use strict';

/**
 * Release-candidate certification CLI (#1949).
 *
 *   rc-cert start  --sha <40> --worktree <abs> [--required-check <name>]... [--repo owner/name]
 *   rc-cert run    --sha <40> [--interval <ms>]   (the repository and checks come from the manifest)
 *   rc-cert status --sha <40> [--json]
 *   rc-cert accept --sha <40> --actor <id>
 *   rc-cert cancel --sha <40> --actor <id>
 *   rc-cert publish --sha <40>   (publish the run's standing to the metrics branch now)
 *   rc-cert list
 *
 * Common flags: `--base <abs>` (evidence base; else config.json
 * `releaseCertification.baseDir`, else `<tangleclawHome>/release-certification/v1`),
 * `--api <url>` (the server under test; else `TANGLECLAW_API`), `--token <t>`
 * (else `TANGLECLAW_SERVICE_TOKEN`), `--ca <file>` (for an https API).
 *
 * `--thresholds <json>` on start overrides the judging thresholds for a smoke
 * run. Such a run reports `canonicalThresholds: false` and never certifies a
 * release.
 *
 * Exit codes: 0 done, 2 usage error, 3 refused (the refusal code is printed as
 * JSON on stderr).
 *
 * @module scripts/rc-cert
 */

const fs = require('node:fs');
const path = require('node:path');
const tangleclawHome = require('../lib/tangleclaw-home');
const store = require('../lib/release-certification/store');
const sm = require('../lib/release-certification/state-machine');
const probesLib = require('../lib/release-certification/probes');
const runnerLib = require('../lib/release-certification/runner');
const publisherLib = require('../lib/release-certification/publisher');
const publicationLib = require('../lib/release-certification/publication');
const { REFUSAL, CertificationError } = require('../lib/release-certification/codes');

const USAGE = [
  'usage: rc-cert start  --sha <40> --worktree <abs> [--repo owner/name] [--required-check <name>]... [--thresholds <json>] [--no-publish-actor]',
  '       rc-cert run    --sha <40> [--interval <ms 15000-120000>]',
  '       rc-cert status --sha <40> [--json]',
  '       rc-cert accept --sha <40> --actor <id>',
  '       rc-cert cancel --sha <40> --actor <id>',
  '       rc-cert publish --sha <40>',
  '       rc-cert list',
  'common: [--base <abs>] [--api <url>] [--token <t>] [--ca <file>]'
].join('\n');
const REPEATABLE = new Set(['required-check']);

/** A malformed or incomplete command line: exit 2 with the usage text. */
class UsageError extends Error {}
const BOOLEAN = new Set(['json', 'no-publish-actor']);

/**
 * Parse `--flag value` arguments.
 * @param {string[]} argv - Arguments after the command
 * @returns {object} Flags; repeatable flags are arrays
 */
function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new UsageError(`unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (BOOLEAN.has(name)) {
      flags[name] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`);
    if (REPEATABLE.has(name)) (flags[name] = flags[name] || []).push(value);
    else flags[name] = value;
  }
  return flags;
}

/**
 * The evidence base: the flag, else the configured override, else the default.
 * A missing config.json means no override; one that cannot be parsed, or a
 * configured value that is not an absolute path, is refused, not ignored.
 * @param {object} flags - Parsed flags
 * @param {string} [configFile] - config.json path
 * @returns {string} Absolute base
 */
function resolveBase(flags, configFile = path.join(tangleclawHome.baseDir(), 'config.json')) {
  if (flags.base) return _absolute(flags.base, '--base');
  let text;
  try {
    text = fs.readFileSync(configFile, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return store.defaultBase();
    throw new CertificationError(REFUSAL.STORE_UNSAFE, `config.json could not be read (${e.code || 'error'}), so releaseCertification.baseDir cannot be read`);
  }
  let configured;
  try {
    configured = JSON.parse(text).releaseCertification?.baseDir;
  } catch {
    // An unreadable config must not silently send evidence to the default
    // location while the operator believes it goes elsewhere.
    throw new CertificationError(REFUSAL.STORE_UNSAFE, 'config.json is not valid JSON, so releaseCertification.baseDir cannot be read');
  }
  if (configured === undefined || configured === null) return store.defaultBase();
  return _absolute(configured, 'releaseCertification.baseDir');
}

/**
 * Require an absolute path.
 * @param {*} p - Candidate
 * @param {string} what - Where it came from
 * @returns {string} The path
 */
function _absolute(p, what) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) throw new CertificationError(REFUSAL.STORE_UNSAFE, `${what} must be an absolute path`);
  return p;
}

/**
 * Parse a flag that must be a JSON object.
 * @param {string} text - Flag value
 * @param {string} what - Flag name
 * @returns {object} Parsed object
 */
function _jsonObject(text, what) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new UsageError(`${what} must be a JSON object`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new UsageError(`${what} must be a JSON object`);
  return value;
}

/**
 * Parse an optional integer flag.
 * @param {string|undefined} text - Flag value
 * @param {string} what - Flag name
 * @returns {number|undefined} The integer, or undefined when absent
 */
function _int(text, what) {
  if (text === undefined) return undefined;
  if (!/^\d+$/.test(text)) throw new UsageError(`${what} must be a whole number`);
  return Number(text);
}

/**
 * Require a flag.
 * @param {object} flags - Parsed flags
 * @param {string} name - Flag name
 * @returns {string} Its value
 */
function _need(flags, name) {
  if (!flags[name]) throw new UsageError(`--${name} is required`);
  return flags[name];
}

/**
 * Probe context for a run.
 * @param {object} flags - Parsed flags
 * @param {object} env - Environment
 * @param {object} spec - `{sha, worktreePath, repo, requiredChecks, maxReadingAgeMs}`
 * @returns {object} Probe context
 */
function _probeCtx(flags, env, spec) {
  const apiBase = flags.api || env.TANGLECLAW_API;
  if (!apiBase) throw new UsageError('--api or TANGLECLAW_API is required');
  return {
    apiBase,
    token: flags.token || env.TANGLECLAW_SERVICE_TOKEN || null,
    ca: flags.ca ? fs.readFileSync(flags.ca) : null,
    worktreePath: spec.worktreePath,
    candidateSha: spec.sha,
    repo: spec.repo,
    requiredChecks: spec.requiredChecks,
    maxReadingAgeMs: spec.maxReadingAgeMs
  };
}

/**
 * The publication for a candidate. It publishes to `remoteUrl` when given
 * (at start, from the worktree's origin), else to the remote its admission
 * recorded, so a run never changes where it publishes.
 * @param {object} c - Command context
 * @param {string} sha - Candidate SHA
 * @param {string} worktreePath - Candidate worktree, for the operator's git identity
 * @param {string|null} remoteUrl - Where to publish, or null to use the recorded remote
 * @returns {Promise<object>} Publication
 */
async function _publication(c, sha, worktreePath, remoteUrl) {
  if (c.deps.publication) return c.deps.publication;
  const facts = await (c.deps.repoFacts || publisherLib.repoFacts)(worktreePath);
  const target = remoteUrl || publicationLib.readStatus(c.base, sha).remoteUrl || facts.remoteUrl;
  const publisher = publisherLib.createPublisher({
    dir: path.join(c.base, '_metrics'), remoteUrl: target, identity: facts.identity,
    onRecover: (fact) => c.emit({ event: 'recovered', ...fact })
  });
  return publicationLib.createPublication({ base: c.base, candidateSha: sha, publisher });
}

/**
 * `publish`: publish a run's standing now (also how a failed publish is retried by hand).
 * @param {object} c - Command context
 * @returns {Promise<number>} Exit code: 0 published, 3 not
 */
async function cmdPublish(c) {
  const sha = _need(c.flags, 'sha');
  const { manifest } = store.readRun(c.base, sha);
  const publication = await _publication(c, sha, manifest.private.worktreePath, null);
  const { published } = await publication.publishCurrent(c.emit);
  c.out.write(`${JSON.stringify({ published })}\n`);
  return published ? 0 : 3;
}

/**
 * `list`: the candidates with runs.
 * @param {object} c - Command context
 * @returns {Promise<number>} Exit code
 */
async function cmdList(c) {
  c.out.write(`${JSON.stringify(store.listRuns(c.base))}\n`);
  return 0;
}

/**
 * `status`: a run's structured health.
 * @param {object} c - Command context
 * @returns {Promise<number>} Exit code
 */
async function cmdStatus(c) {
  const sha = _need(c.flags, 'sha');
  const { manifest, state } = store.readRun(c.base, sha);
  const p = publicationLib.readStatus(c.base, sha);
  const publication = {
    admissionVerifiedAt: p.admission ? p.admission.verifiedAt : null,
    lastPublishedSeq: p.lastPublishedSeq, lastPublishedAt: p.lastPublishedAt,
    failures: p.failures, lastError: p.lastError, nextAttemptAt: p.nextAttemptAt
  };
  const summary = { ...sm.summarize(state, manifest, Date.now()), publication };
  c.out.write(c.flags.json ? `${JSON.stringify(summary)}\n` : _human(summary));
  return 0;
}

/**
 * `accept` / `cancel`: an operator decision, recorded with the actor.
 * @param {object} c - Command context
 * @param {function(object, string, number): object} op - `sm.accept` or `sm.cancel`
 * @returns {Promise<number>} Exit code
 */
async function cmdDecide(c, op) {
  const sha = _need(c.flags, 'sha');
  const actor = _need(c.flags, 'actor');
  const state = store.updateRun(c.base, sha, (s) => op(s, actor, Date.now()), { onRecover: (f) => c.emit({ event: 'recovered', ...f }) });
  // The decision is committed; publishing it is best effort and a failure is
  // recorded for retry (`rc-cert publish`), never undoing the decision.
  const { manifest } = store.readRun(c.base, sha);
  let published = false;
  try {
    const publication = await _publication(c, sha, manifest.private.worktreePath, null);
    ({ published } = await publication.publishCurrent(c.emit));
  } catch (e) {
    c.emit({ event: 'publish-failed', code: e.code || null });
  }
  c.out.write(`${JSON.stringify({ state: state.state, published })}\n`);
  return 0;
}

/**
 * The required checks for `start`: the flags, else main's branch protection.
 * None at all is refused, since GitHub could then never fail the candidate.
 * @param {object} c - Command context
 * @param {string} repo - `owner/name`
 * @returns {Promise<string[]>} Check names
 */
async function _startChecks(c, repo) {
  const checks = c.flags['required-check'] || await (c.deps.requiredChecks || probesLib.requiredChecks)(repo);
  if (!checks) throw new UsageError('could not read main\'s required checks; pass --required-check <name> for each');
  if (checks.length === 0) throw new UsageError('main\'s branch protection requires no checks, so GitHub could never fail this candidate; pass --required-check <name>');
  return checks;
}

/**
 * `start`: admit a candidate.
 * @param {object} c - Command context
 * @returns {Promise<number>} Exit code
 */
async function cmdStart(c) {
  const sha = _need(c.flags, 'sha');
  const thresholds = c.flags.thresholds ? _jsonObject(c.flags.thresholds, '--thresholds') : undefined;
  const worktreePath = _absolute(_need(c.flags, 'worktree'), '--worktree');
  const repo = c.flags.repo || await (c.deps.repository || probesLib.repository)(worktreePath);
  if (!repo) throw new UsageError('could not determine the repository; pass --repo owner/name');
  const requiredChecks = await _startChecks(c, repo);
  const version = runnerLib.worktreeVersion(worktreePath);
  if (!version) throw new UsageError('the worktree has no readable version.json');
  const maxReadingAgeMs = { ...sm.DEFAULT_THRESHOLDS, ...thresholds }.maxIntervalMs;
  const probes = (c.deps.probes || probesLib.createProbes)(_probeCtx(c.flags, c.env, { sha, worktreePath, repo, requiredChecks, maxReadingAgeMs }));
  const facts = c.deps.publication ? { remoteUrl: null } : await (c.deps.repoFacts || publisherLib.repoFacts)(worktreePath);
  const publication = await _publication(c, sha, worktreePath, facts.remoteUrl);
  const runner = (c.deps.runner || runnerLib.createRunner)({ base: c.base, candidateSha: sha, probes, publication, log: c.emit });
  const state = await runner.start({
    version, repository: repo, worktreePath, requiredChecks, thresholds,
    publishActor: !c.flags['no-publish-actor'], remoteUrl: facts.remoteUrl
  });
  c.out.write(`${JSON.stringify({ state: state.state, candidateSha: sha })}\n`);
  return 0;
}

/**
 * `run`: sample until terminal or signalled. The repository, required checks
 * and reading age come from the manifest, never from a fresh lookup.
 * @param {object} c - Command context
 * @returns {Promise<number>} Exit code
 */
async function cmdRun(c) {
  const sha = _need(c.flags, 'sha');
  const intervalMs = _int(c.flags.interval, '--interval');
  if (intervalMs !== undefined) {
    try {
      runnerLib.resolveInterval(intervalMs);
    } catch (e) {
      throw new UsageError(e.message);
    }
  }
  const { manifest } = store.readRun(c.base, sha);
  const probes = (c.deps.probes || probesLib.createProbes)(_probeCtx(c.flags, c.env, {
    sha, worktreePath: manifest.private.worktreePath, repo: manifest.repository,
    requiredChecks: manifest.requiredChecks, maxReadingAgeMs: manifest.thresholds.maxIntervalMs
  }));
  const publication = await _publication(c, sha, manifest.private.worktreePath, null);
  const runner = (c.deps.runner || runnerLib.createRunner)({ base: c.base, candidateSha: sha, probes, publication, log: c.emit });
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (c.signal) c.signal.addEventListener('abort', stop, { once: true });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    const state = await runner.run({ intervalMs, signal: controller.signal });
    c.out.write(`${JSON.stringify({ state: state.state })}\n`);
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (c.signal) c.signal.removeEventListener('abort', stop);
  }
  return 0;
}

/** Each command's handler. */
const COMMANDS = Object.freeze({
  list: cmdList,
  status: cmdStatus,
  accept: (c) => cmdDecide(c, sm.accept),
  cancel: (c) => cmdDecide(c, sm.cancel),
  start: cmdStart,
  run: cmdRun,
  publish: cmdPublish
});

/**
 * Run a command: parse, resolve the evidence base, dispatch, and turn a
 * refusal into exit 3 and a usage error into exit 2.
 * @param {string[]} argv - Command and flags
 * @param {object} [io] - `{stdout, stderr, env, configFile, signal, deps: {probes, runner, repository, requiredChecks}}`
 * @returns {Promise<number>} Exit code
 */
async function main(argv, io = {}) {
  const err = io.stderr || process.stderr;
  const [command, ...rest] = argv;
  try {
    const flags = parseFlags(rest);
    const handler = Object.prototype.hasOwnProperty.call(COMMANDS, command) ? COMMANDS[command] : null;
    if (!handler) throw new UsageError(`unknown command ${command || ''}`.trim());
    return await handler({
      flags,
      base: resolveBase(flags, io.configFile),
      out: io.stdout || process.stdout,
      env: io.env || process.env,
      deps: io.deps || {},
      signal: io.signal,
      emit: (obj) => err.write(`${JSON.stringify(obj)}\n`)
    });
  } catch (e) {
    if (e instanceof CertificationError) {
      err.write(`${JSON.stringify({ error: e.code, message: e.message, details: e.details })}\n`);
      return 3;
    }
    if (e instanceof UsageError) {
      err.write(`${e.message}\n${USAGE}\n`);
      return 2;
    }
    throw e;
  }
}

/**
 * A short human summary.
 * @param {object} s - `summarize` result
 * @returns {string} Text
 */
function _human(s) {
  const h = (ms) => (ms / 3_600_000).toFixed(2);
  const lines = [
    `${s.candidateSha} ${s.version}: ${s.state}${s.canonicalThresholds ? '' : ' (non-canonical thresholds: cannot certify)'}`,
    `qualified ${h(s.qualifiedMs)}h of ${h(s.targetMs)}h, remaining ${h(s.remainingMs)}h, elapsed ${h(s.elapsedMs)}h${s.monitorStale ? ', MONITOR STALE' : ''}`,
    `pty ${s.pty.attaches}/${s.pty.target.attaches} attaches, ${s.pty.detaches}/${s.pty.target.detaches} detaches, span ${h(s.pty.spanMs)}h${s.pty.met ? ' (met)' : ''}`
  ];
  for (const [code, e] of Object.entries(s.extensions)) lines.push(`extended ${code}: ${e.intervals} interval(s), ${h(e.lostMs)}h`);
  if (s.failure) lines.push(`failed ${s.failure.code} at sample ${s.failure.sampleSeq}`);
  if (s.acceptance) lines.push(`accepted by ${s.acceptance.actor}`);
  if (s.cancellation) lines.push(`cancelled by ${s.cancellation.actor}`);
  const p = s.publication;
  if (p) lines.push(p.lastError ? `publishing FAILING: ${p.lastError} (${p.failures} in a row), next attempt ${p.nextAttemptAt}` : `published #${p.lastPublishedSeq} at ${p.lastPublishedAt}`);
  return `${lines.join('\n')}\n`;
}

module.exports = { main, parseFlags, resolveBase };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`${e.stack || e}\n`);
    process.exitCode = 1;
  });
}
