'use strict';

/**
 * The certification runner: samples the candidate on a cadence and folds each
 * sample into its stored run.
 *
 * The runner is a separate process from the server it certifies, so a server
 * crash or restart is something it observes rather than something that stops
 * it, and its own downtime shows up as a gap between samples, which the state
 * machine counts against the run.
 *
 * One runner per candidate: `run` holds `runner.lock` in the run directory for
 * its lifetime. Each tick collects a sample outside any lock, then commits it
 * under the store's lock against whatever state is committed at that moment,
 * so an operator's accept or cancel between ticks is never overwritten.
 *
 * Nothing is silent. Every transition, every store recovery and every failed
 * tick is passed to `log` as a structured event.
 *
 * @module lib/release-certification/runner
 */

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const sm = require('./state-machine');
const store = require('./store');
const lockfile = require('./lockfile');
const { REFUSAL, EXTEND, CertificationError, isTerminal } = require('./codes');

/** Sampling cadence bounds: the upper bound keeps one late tick inside the 150 s interval limit. */
const INTERVAL_BOUNDS = Object.freeze({ min: 15 * 1000, max: 120 * 1000, default: 60 * 1000 });

/**
 * The real clocks; tests replace them.
 * @type {{wall: function(): number, mono: function(): number}}
 */
const REAL_CLOCK = Object.freeze({ wall: () => Date.now(), mono: () => performance.now() });

/**
 * Validate a sampling interval.
 * @param {*} ms - Candidate interval
 * @returns {number} The interval
 */
function resolveInterval(ms) {
  if (ms === undefined || ms === null) return INTERVAL_BOUNDS.default;
  if (!Number.isSafeInteger(ms) || ms < INTERVAL_BOUNDS.min || ms > INTERVAL_BOUNDS.max) {
    throw new CertificationError(REFUSAL.INVALID_SAMPLE, `interval must be ${INTERVAL_BOUNDS.min}-${INTERVAL_BOUNDS.max} ms`, { field: 'interval' });
  }
  return ms;
}

/**
 * Read the version a worktree carries.
 * @param {string} worktreePath - Worktree
 * @returns {string|null} `version.json` version
 */
function worktreeVersion(worktreePath) {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(worktreePath, 'version.json'), 'utf8')).version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Create a runner for one candidate.
 * @param {object} ctx
 * @param {string} ctx.base - Evidence base
 * @param {string} ctx.candidateSha - Candidate SHA
 * @param {{collect: function(number): Promise<object>}} ctx.probes - From `createProbes`
 * @param {function(object): void} [ctx.log] - Structured event sink
 * @param {object} [ctx.clock] - `{wall, mono}`
 * @param {string} [ctx.runnerInstance] - This process's identity (random by default)
 * @param {object} [ctx.storeOpts] - Passed to store calls (lock timing in tests)
 * @returns {object} `{start, tick, run}`
 */
function createRunner(ctx) {
  const clock = ctx.clock || REAL_CLOCK;
  const log = ctx.log || (() => {});
  const runnerInstance = ctx.runnerInstance || `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
  const storeOpts = { ...ctx.storeOpts, onRecover: (fact) => log({ event: 'recovered', ...fact }) };

  /**
   * Collect one sample. Both clocks are read after the probes return, so the
   * sample is dated by when its observations were complete.
   * @returns {Promise<object>} Sample
   */
  async function sample() {
    const observations = await ctx.probes.collect(clock.wall());
    return { wallAt: clock.wall(), monoAt: clock.mono(), runnerInstance, observations };
  }

  /**
   * Admit the candidate and create its run.
   * @param {object} spec - `{version, worktreePath, requiredChecks, host, thresholds}`
   * @returns {Promise<object>} The committed state
   */
  async function start(spec) {
    const s = await sample();
    const generation = s.observations.ttyd && s.observations.ttyd.generation;
    if (typeof generation !== 'string') {
      throw new CertificationError(REFUSAL.ADMISSION_REFUSED, 'admission refused: PROBE_UNKNOWN', {
        reasons: [{ code: EXTEND.PROBE_UNKNOWN, probe: 'ttyd', field: 'generation' }]
      });
    }
    const manifest = sm.buildManifest({
      candidateSha: ctx.candidateSha,
      version: spec.version,
      requiredChecks: spec.requiredChecks,
      createdAt: s.wallAt,
      worktreePath: spec.worktreePath,
      ttydGeneration: generation,
      host: spec.host ?? os.hostname(),
      thresholds: spec.thresholds
    });
    const admission = sm.admit(manifest, s);
    const state = store.createRun(ctx.base, manifest, admission, s, storeOpts);
    for (const e of admission.events) log({ event: 'transition', ...e });
    return state;
  }

  /**
   * Take one sample and commit it. A run already in a terminal state is left
   * alone.
   * @returns {Promise<object>} The committed state
   */
  async function tick() {
    const s = await sample();
    let events = [];
    const state = store.updateRun(ctx.base, ctx.candidateSha, (current, manifest) => {
      if (isTerminal(current.state)) return null;
      const out = sm.reduce(current, manifest, s);
      events = out.events;
      return { state: out.state, events: out.events, record: store.sampleRecord(out.state.sampleCount, s, out.verdict, out.interval) };
    }, storeOpts);
    for (const e of events) log({ event: 'transition', ...e });
    return state;
  }

  /**
   * Sample until the run is terminal or `signal` aborts, holding the
   * single-runner lock throughout. A failed tick is logged and the next one
   * still runs: the gap it leaves is judged by the state machine.
   * @param {object} [opts]
   * @param {number} [opts.intervalMs] - Cadence
   * @param {AbortSignal} [opts.signal] - Stops the loop
   * @param {function(number): Promise<void>} [opts.wait] - Sleep seam
   * @returns {Promise<object>} The last committed state
   */
  async function run(opts = {}) {
    const intervalMs = resolveInterval(opts.intervalMs);
    const wait = opts.wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const { paths, state: initial } = store.readRun(ctx.base, ctx.candidateSha);
    const runnerLock = path.join(paths.dir, 'runner.lock');
    const token = lockfile.acquire(runnerLock, {
      timeoutMs: 0,
      deps: storeOpts.lockDeps,
      onReclaim: (holder) => log({ event: 'recovered', kind: 'runner-lock-reclaimed', holder })
    });
    let state = initial;
    log({ event: 'runner-started', runnerInstance, state: state.state });
    try {
      while (!isTerminal(state.state) && !(opts.signal && opts.signal.aborted)) {
        const began = clock.mono();
        try {
          state = await tick();
        } catch (err) {
          log({ event: 'tick-failed', code: err.code || null, message: err.message });
          if (err.code === REFUSAL.MANIFEST_TAMPERED || err.code === REFUSAL.EVIDENCE_CORRUPT) throw err;
        }
        if (isTerminal(state.state)) break;
        await wait(Math.max(0, intervalMs - (clock.mono() - began)));
      }
    } finally {
      lockfile.release(runnerLock, token);
      log({ event: 'runner-stopped', runnerInstance, state: state.state });
    }
    return state;
  }

  return { start, tick, run, runnerInstance };
}

module.exports = { INTERVAL_BOUNDS, resolveInterval, worktreeVersion, createRunner };
