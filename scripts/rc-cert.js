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
const { REFUSAL, CertificationError } = require('../lib/release-certification/codes');

const USAGE = [
  'usage: rc-cert start  --sha <40> --worktree <abs> [--repo owner/name] [--required-check <name>]... [--thresholds <json>]',
  '       rc-cert run    --sha <40> [--interval <ms 15000-120000>]',
  '       rc-cert status --sha <40> [--json]',
  '       rc-cert accept --sha <40> --actor <id>',
  '       rc-cert cancel --sha <40> --actor <id>',
  '       rc-cert list',
  'common: [--base <abs>] [--api <url>] [--token <t>] [--ca <file>]'
].join('\n');
const REPEATABLE = new Set(['required-check']);

/** A malformed or incomplete command line: exit 2 with the usage text. */
class UsageError extends Error {}
const BOOLEAN = new Set(['json']);

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
 * A configured value that is not an absolute path is refused, not ignored.
 * @param {object} flags - Parsed flags
 * @param {string} [configFile] - config.json path
 * @returns {string} Absolute base
 */
function resolveBase(flags, configFile = path.join(tangleclawHome.baseDir(), 'config.json')) {
  if (flags.base) return _absolute(flags.base, '--base');
  let configured;
  try {
    configured = JSON.parse(fs.readFileSync(configFile, 'utf8')).releaseCertification?.baseDir;
  } catch {
    configured = undefined;
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
 * Run a command.
 * @param {string[]} argv - Command and flags
 * @param {object} [io] - `{stdout, stderr, env, configFile, signal, deps: {probes, runner, repository, requiredChecks}}`
 * @returns {Promise<number>} Exit code
 */
async function main(argv, io = {}) {
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const env = io.env || process.env;
  const deps = io.deps || {};
  const emit = (obj) => err.write(`${JSON.stringify(obj)}\n`);
  const [command, ...rest] = argv;
  let flags;
  try {
    flags = parseFlags(rest);
    if (!['start', 'run', 'status', 'accept', 'cancel', 'list'].includes(command)) throw new UsageError(`unknown command ${command || ''}`.trim());
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err.write(`${e.message}\n${USAGE}\n`);
    return 2;
  }
  try {
    const base = resolveBase(flags, io.configFile);
    if (command === 'list') {
      out.write(`${JSON.stringify(store.listRuns(base))}\n`);
      return 0;
    }
    const sha = _need(flags, 'sha');
    if (command === 'status') {
      const { manifest, state } = store.readRun(base, sha);
      const summary = sm.summarize(state, manifest, Date.now());
      out.write(flags.json ? `${JSON.stringify(summary)}\n` : _human(summary));
      return 0;
    }
    if (command === 'accept' || command === 'cancel') {
      const actor = _need(flags, 'actor');
      const op = command === 'accept' ? sm.accept : sm.cancel;
      const state = store.updateRun(base, sha, (s) => op(s, actor, Date.now()), { onRecover: (f) => emit({ event: 'recovered', ...f }) });
      out.write(`${JSON.stringify({ state: state.state })}\n`);
      return 0;
    }
    if (command === 'start') {
      const thresholds = flags.thresholds ? _jsonObject(flags.thresholds, '--thresholds') : undefined;
      const worktreePath = _absolute(_need(flags, 'worktree'), '--worktree');
      const repo = flags.repo || await (deps.repository || probesLib.repository)(worktreePath);
      if (!repo) throw new UsageError('could not determine the repository; pass --repo owner/name');
      const requiredChecks = flags['required-check'] || await (deps.requiredChecks || probesLib.requiredChecks)(repo);
      if (!requiredChecks) throw new UsageError('could not read main\'s required checks; pass --required-check <name> for each');
      const version = runnerLib.worktreeVersion(worktreePath);
      if (!version) throw new UsageError('the worktree has no readable version.json');
      const maxReadingAgeMs = { ...sm.DEFAULT_THRESHOLDS, ...thresholds }.maxIntervalMs;
      const probes = (deps.probes || probesLib.createProbes)(_probeCtx(flags, env, { sha, worktreePath, repo, requiredChecks, maxReadingAgeMs }));
      const runner = (deps.runner || runnerLib.createRunner)({ base, candidateSha: sha, probes, log: emit });
      const state = await runner.start({ version, repository: repo, worktreePath, requiredChecks, thresholds });
      out.write(`${JSON.stringify({ state: state.state, candidateSha: sha })}\n`);
      return 0;
    }
    const intervalMs = _int(flags.interval, '--interval');
    if (intervalMs !== undefined) {
      try {
        runnerLib.resolveInterval(intervalMs);
      } catch (e) {
        throw new UsageError(e.message);
      }
    }
    const { manifest } = store.readRun(base, sha);
    const worktreePath = manifest.private.worktreePath;
    const probes = (deps.probes || probesLib.createProbes)(_probeCtx(flags, env, {
      sha, worktreePath, repo: manifest.repository, requiredChecks: manifest.requiredChecks, maxReadingAgeMs: manifest.thresholds.maxIntervalMs
    }));
    const runner = (deps.runner || runnerLib.createRunner)({ base, candidateSha: sha, probes, log: emit });
    const controller = new AbortController();
    const stop = () => controller.abort();
    if (io.signal) io.signal.addEventListener('abort', stop, { once: true });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    try {
      const state = await runner.run({ intervalMs, signal: controller.signal });
      out.write(`${JSON.stringify({ state: state.state })}\n`);
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    }
    return 0;
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
  return `${lines.join('\n')}\n`;
}

module.exports = { main, parseFlags, resolveBase };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`${e.stack || e}\n`);
    process.exitCode = 1;
  });
}
