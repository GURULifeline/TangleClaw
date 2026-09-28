#!/usr/bin/env node
'use strict';

/**
 * Release-candidate soak CLI (#2020): build, check and execute a
 * deterministic load-and-fault schedule.
 *
 *   soak plan     --seed <s> --phase certifying|destructive --duration-hours <h> --out <file>
 *                 [--classes api,engine,browser,fault] [--projects a,b,c]
 *                 [--load-mean-ms <n>] [--fault-mean-ms <n>] [--fault-quiet-ms <n>]
 *   soak validate --schedule <file>
 *   soak run      --schedule <file> --api <url> --log <file> [--allow-unverified-live]
 *
 * `run` executes against the server named by `--api` and nothing else. There
 * is deliberately no fallback to `TANGLECLAW_API`. Because a soak's load
 * writes (port leases, sessions), it refuses the pane's own TangleClaw by
 * address, by what the target's name resolves to, and by server identity.
 * When the live install's identity cannot be read, it refuses unless
 * `--allow-unverified-live` is given, and the log header records that
 * override. The service token is read from `TANGLECLAW_SERVICE_TOKEN` only,
 * never from a flag that would put it in shell history and process listings.
 *
 * Interrupting `run` (SIGINT/SIGTERM) stops before the next event. Running it
 * again with the same log resumes where it stopped.
 *
 * Exit codes: 0 done (completed, or the log had already completed), 2 usage
 * error, 3 refused (the code is printed as JSON on stderr), 4 stopped before
 * the end.
 *
 * @module scripts/soak
 */

const fs = require('node:fs');

const scheduleLib = require('../lib/soak/schedule');
const driver = require('../lib/soak/driver');
const { EXECUTORS } = require('../lib/soak/executors');

const USAGE = [
  'usage: soak plan     --seed <s> --phase certifying|destructive --duration-hours <h> --out <file>',
  '                     [--classes api,engine,browser,fault] [--projects a,b,c]',
  '                     [--load-mean-ms <n>] [--fault-mean-ms <n>] [--fault-quiet-ms <n>]',
  '       soak validate --schedule <file>',
  '       soak run      --schedule <file> --api <url> --log <file> [--allow-unverified-live]'
].join('\n');

const HOUR_MS = 60 * 60 * 1000;

/** Flags that take no value. */
const BOOLEAN = new Set(['allow-unverified-live']);

/** A malformed or incomplete command line: exit 2 with the usage text. */
class UsageError extends Error {}

/**
 * Parse `--flag value` pairs. A flag in `BOOLEAN` takes no value and reads as `true`.
 * @param {string[]} argv - Arguments after the command
 * @returns {Object<string, string|boolean>} Flags
 * @throws {UsageError} On a stray argument, a missing value or a repeated flag
 */
function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new UsageError(`unexpected argument: ${a}`);
    const name = a.slice(2);
    if (BOOLEAN.has(name)) {
      if (Object.prototype.hasOwnProperty.call(flags, name)) throw new UsageError(`--${name} given twice`);
      flags[name] = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new UsageError(`--${name} needs a value`);
    if (Object.prototype.hasOwnProperty.call(flags, name)) throw new UsageError(`--${name} given twice`);
    flags[name] = value;
    i++;
  }
  return flags;
}

/**
 * Require the named flags, and refuse any flag not in `allowed`.
 * @param {Object<string, string>} flags - Parsed flags
 * @param {string[]} required - Flags that must be present
 * @param {string[]} [optional=[]] - Flags that may be present
 * @throws {UsageError} On a missing or unknown flag
 */
function expectFlags(flags, required, optional = []) {
  if (Object.prototype.hasOwnProperty.call(flags, 'token')) {
    throw new UsageError('--token is not accepted; set TANGLECLAW_SERVICE_TOKEN instead');
  }
  for (const f of required) if (flags[f] === undefined) throw new UsageError(`--${f} is required`);
  const known = new Set([...required, ...optional]);
  for (const f of Object.keys(flags)) if (!known.has(f)) throw new UsageError(`unknown flag --${f}`);
}

/**
 * A whole-number flag value.
 * @param {string} name - Flag name
 * @param {string|undefined} v - Raw value
 * @returns {number|undefined} The number, or undefined when absent
 * @throws {UsageError} When present but not a whole number
 */
function intFlag(name, v) {
  if (v === undefined) return undefined;
  if (!/^\d+$/.test(v)) throw new UsageError(`--${name} must be a whole number`);
  return Number(v);
}

/**
 * Read and parse a schedule file.
 * @param {string} file - Path
 * @returns {object} The parsed schedule
 * @throws {UsageError} When it cannot be read or is not JSON
 */
function readSchedule(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new UsageError(`cannot read ${file}: ${err.code || err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new UsageError(`${file} is not JSON`);
  }
}

/**
 * `plan`: build a schedule and write it to a file.
 * @param {Object<string, string>} flags - Flags
 * @param {object} io - `{stderr}`
 * @returns {number} Exit code
 */
function cmdPlan(flags, io) {
  expectFlags(flags, ['seed', 'phase', 'duration-hours', 'out'], ['classes', 'projects', 'load-mean-ms', 'fault-mean-ms', 'fault-quiet-ms']);
  const hours = Number(flags['duration-hours']);
  if (!Number.isFinite(hours) || hours <= 0) throw new UsageError('--duration-hours must be a positive number');
  const list = (v) => (v === undefined ? undefined : v.split(',').map((s) => s.trim()).filter(Boolean));
  let schedule;
  try {
    schedule = scheduleLib.buildSchedule({
      seed: flags.seed,
      phase: flags.phase,
      durationMs: Math.round(hours * HOUR_MS),
      classes: list(flags.classes),
      projects: list(flags.projects),
      loadMeanMs: intFlag('load-mean-ms', flags['load-mean-ms']),
      faultMeanMs: intFlag('fault-mean-ms', flags['fault-mean-ms']),
      faultQuietMs: intFlag('fault-quiet-ms', flags['fault-quiet-ms'])
    });
  } catch (err) {
    if (err.code === scheduleLib.VIOLATION.PARAMS) throw new UsageError(err.message);
    throw err;
  }
  // `wx`: never overwrite a schedule that a run may already be logged against.
  try {
    fs.writeFileSync(flags.out, `${JSON.stringify(schedule, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  } catch (err) {
    if (err.code === 'EEXIST') throw new UsageError(`${flags.out} already exists; a schedule is never overwritten`);
    throw err;
  }
  io.stderr.write(`${JSON.stringify({ out: flags.out, digest: schedule.digest, phase: schedule.params.phase, events: schedule.events.length, byKind: scheduleLib.summarize(schedule) })}\n`);
  return 0;
}

/**
 * `validate`: check a schedule file against every rule.
 * @param {Object<string, string>} flags - Flags
 * @param {object} io - `{stdout, stderr}`
 * @returns {number} Exit code: 0 valid, 3 invalid
 */
function cmdValidate(flags, io) {
  expectFlags(flags, ['schedule']);
  const schedule = readSchedule(flags.schedule);
  const violations = scheduleLib.validateSchedule(schedule);
  if (violations.length > 0) {
    io.stderr.write(`${JSON.stringify({ code: driver.REFUSAL.INVALID_SCHEDULE, violations })}\n`);
    return 3;
  }
  io.stdout.write(`${JSON.stringify({ valid: true, digest: schedule.digest, events: schedule.events.length })}\n`);
  return 0;
}

/**
 * `run`: execute a schedule against the named server.
 * @param {Object<string, string>} flags - Flags
 * @param {object} io - `{stdout, stderr}`
 * @param {object} deps - `{env, fetch, lookup, clock, onStopSignal}`
 * @returns {Promise<number>} Exit code
 */
async function cmdRun(flags, io, deps) {
  expectFlags(flags, ['schedule', 'api', 'log'], ['allow-unverified-live']);
  let api;
  try {
    api = new URL(flags.api);
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    throw new UsageError(`--api is not a URL: ${flags.api}`);
  }
  if (api.protocol !== 'http:' && api.protocol !== 'https:') throw new UsageError('--api must be http or https');
  const liveApi = deps.env.TANGLECLAW_API;
  driver.refuseLiveTarget(api.href, liveApi);
  await driver.refuseLiveResolved({ apiBase: api.href, liveApi, lookup: deps.lookup });
  const schedule = readSchedule(flags.schedule);
  const token = deps.env.TANGLECLAW_SERVICE_TOKEN || null;
  const identity = await driver.refuseSameInstall({ apiBase: api.href, liveApi, fetch: deps.fetch, token, allowUnverifiedLive: flags['allow-unverified-live'] === true });
  if (!identity.checked) io.stderr.write(`${JSON.stringify({ warning: 'IDENTITY_UNCHECKED', reason: identity.reason, liveUnverified: identity.liveUnverified })}\n`);
  let stop = false;
  deps.onStopSignal(() => { stop = true; });
  const result = await driver.runSchedule({
    schedule,
    executors: EXECUTORS,
    ctx: { apiBase: api.href, token, fetch: deps.fetch },
    logPath: flags.log,
    clock: deps.clock,
    shouldStop: () => stop,
    // An override of the live-identity check is part of the run's record,
    // not just a line on a terminal.
    headerExtra: identity.liveUnverified ? { liveIdentityOverride: { reason: identity.reason } } : undefined
  });
  io.stdout.write(`${JSON.stringify(result)}\n`);
  return result.status === 'stopped' ? 4 : 0;
}

/**
 * Entry point, with every side effect injectable for tests.
 * @param {string[]} argv - Arguments after the script name
 * @param {object} [deps] - `{stdout, stderr, env, fetch, lookup, clock, onStopSignal}`
 * @returns {Promise<number>} Exit code
 */
async function main(argv, deps = {}) {
  const io = { stdout: deps.stdout || process.stdout, stderr: deps.stderr || process.stderr };
  const full = {
    env: deps.env || process.env,
    fetch: deps.fetch || globalThis.fetch,
    lookup: deps.lookup,
    clock: deps.clock || { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
    onStopSignal: deps.onStopSignal || ((fn) => { process.once('SIGINT', fn); process.once('SIGTERM', fn); })
  };
  const [command, ...rest] = argv;
  try {
    const flags = parseFlags(rest);
    if (command === 'plan') return cmdPlan(flags, io);
    if (command === 'validate') return cmdValidate(flags, io);
    if (command === 'run') return await cmdRun(flags, io, full);
    throw new UsageError(command ? `unknown command: ${command}` : 'a command is required');
  } catch (err) {
    if (err instanceof UsageError) {
      io.stderr.write(`${err.message}\n${USAGE}\n`);
      return 2;
    }
    if (err instanceof driver.DriverRefusal) {
      io.stderr.write(`${JSON.stringify({ code: err.code, message: err.message, details: err.details })}\n`);
      return 3;
    }
    throw err;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}

module.exports = { main, parseFlags, USAGE };
