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
const formats = require('./formats');
const { REFUSAL, EXTEND, CertificationError, isTerminal } = require('./codes');

/**
 * Admission on an idle server: its health cache may still be cold, so the
 * first sample can read unknown for reasons that clear within a minute. Only
 * extension reasons are retried; a hard fail refuses at once.
 */
const ADMISSION_ATTEMPTS = 6;
const ADMISSION_RETRY_MS = 10 * 1000;

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
 * The identity a server reports for the worktree it runs from: sha256 of the
 * worktree's real path (`lib/server-info.js#getCheckoutId` computes the same).
 * @param {string} worktreePath - Worktree
 * @returns {string} Hex digest
 */
function worktreeId(worktreePath) {
  return formats.checkoutDigest(worktreePath);
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
 * Sleep, waking early when the signal aborts, so a stop takes effect at once
 * rather than after up to one full interval.
 * @param {number} ms - Duration
 * @param {AbortSignal} [signal] - Wakes the sleep
 * @returns {Promise<void>} Resolves on timeout or abort
 */
function _abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', done);
      resolve();
    }
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
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
 * @param {object} [ctx.publication] - From `createPublication`. Required to start: no run begins unpublished.
 * @returns {object} `{start, tick, run, publishNow}`
 */
function createRunner(ctx) {
  const clock = ctx.clock || REAL_CLOCK;
  const log = ctx.log || (() => {});
  const runnerInstance = ctx.runnerInstance || `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString('hex')}`;
  const storeOpts = { ...ctx.storeOpts, onRecover: (fact) => log({ event: 'recovered', ...fact }) };
  let publishing = null;
  // Transitions are counted rather than flagged: a publish reads the store
  // when it starts, so it covers only the transitions seen before then. One
  // seen while it is in flight stays owed until a later publish succeeds.
  let transitionsSeen = 0;
  let transitionsPublished = 0;

  /**
   * Collect one sample. Both clocks are read after the probes return, so the
   * sample is dated by when its observations were complete. Why any source
   * gave nothing travels with the sample into the evidence.
   * @returns {Promise<object>} Sample
   */
  async function sample() {
    const { observations, diagnostics } = await ctx.probes.collect(clock.wall());
    return { wallAt: clock.wall(), monoAt: clock.mono(), runnerInstance, observations, diagnostics: diagnostics || {} };
  }

  /**
   * Try to admit one sample: build the manifest around what it observed, then
   * let the state machine judge it. The owned ttyd's generation becomes the
   * run's baseline, so it must be known.
   * @param {object} spec - Start spec
   * @param {object} s - Sample
   * @returns {{manifest: object, admission: object}} On success
   */
  function _tryAdmit(spec, s) {
    const ttyd = s.observations.ttyd;
    const generation = ttyd && typeof ttyd.generation === 'string' ? ttyd.generation : 'unknown';
    const manifest = sm.buildManifest({
      candidateSha: ctx.candidateSha,
      version: spec.version,
      repository: spec.repository,
      requiredChecks: spec.requiredChecks,
      requiredChecksSource: spec.requiredChecksSource,
      createdAt: s.wallAt,
      worktreePath: spec.worktreePath,
      worktreeId: spec.worktreeId ?? worktreeId(spec.worktreePath),
      ttydGeneration: generation,
      host: spec.host ?? os.hostname(),
      thresholds: spec.thresholds,
      publishActor: spec.publishActor !== false,
      publishRemote: spec.remoteUrl ?? null
    });
    return { manifest, admission: sm.admit(manifest, s) };
  }

  /**
   * Admit the candidate and create its run. An idle server's first answers
   * can be unknown (a cold health cache), so a refusal made only of extension
   * reasons is retried a few times; any hard fail refuses at once, and the
   * last refusal is what the caller sees.
   * Admission is fail-closed (ADR 0021): the manifest is staged, its admission
   * record is published and read back from the metrics branch, and only then
   * does the run commit. What the branch already holds decides what is staged
   * (`store.stageManifest`): a start that crashed after publishing reuses the
   * manifest whose admission is public, and one whose admission never became
   * public starts fresh.
   *
   * @param {object} spec - `{version, repository, worktreePath, worktreeId?, requiredChecks, host, thresholds, publishActor, remoteUrl}`
   * @param {object} [opts] - `{attempts, retryMs, wait}`
   * @returns {Promise<object>} The committed state
   */
  async function start(spec, opts = {}) {
    if (!ctx.publication) {
      throw new CertificationError(REFUSAL.ADMISSION_UNPUBLISHED, 'no publisher is configured, and no run may begin unpublished');
    }
    const attempts = opts.attempts ?? ADMISSION_ATTEMPTS;
    const wait = opts.wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 1; ; attempt++) {
      const s = await sample();
      try {
        const built = _tryAdmit(spec, s);
        const publishedDigest = await ctx.publication.publishedDigest();
        const staged = store.stageManifest(ctx.base, built.manifest, publishedDigest, storeOpts);
        const admission = staged.reused ? sm.admit(staged.manifest, s) : built.admission;
        const { verifiedAt } = await ctx.publication.admit(staged.manifest, staged.digest);
        log({ event: 'admission-published', digest: staged.digest, verifiedAt, reusedManifest: staged.reused });
        const state = store.createRun(ctx.base, staged.manifest, admission, s, storeOpts);
        for (const e of admission.events) log({ event: 'transition', ...e });
        return state;
      } catch (err) {
        const reasons = (err.details && err.details.reasons) || [];
        const transient = err.code === REFUSAL.ADMISSION_REFUSED && reasons.length > 0
          && reasons.every((r) => Object.values(EXTEND).includes(r.code));
        if (!transient || attempt >= attempts) throw err;
        log({ event: 'admission-retry', attempt, reasons: reasons.map((r) => r.code), diagnostics: s.diagnostics });
        await wait(opts.retryMs ?? ADMISSION_RETRY_MS);
      }
    }
  }

  /**
   * Publish the run's current standing now. Never throws: the publication
   * records a failure's backoff, because publishing never decides certification.
   * @returns {Promise<boolean>} True when published
   */
  async function publishNow() {
    if (!ctx.publication) return false;
    const through = transitionsSeen;
    const { published } = await ctx.publication.publishCurrent(log);
    if (published) transitionsPublished = Math.max(transitionsPublished, through);
    return published;
  }

  /**
   * Whether a transition has been seen that no successful publish covered.
   * @returns {boolean} True when one is owed
   */
  function _owed() {
    return transitionsSeen > transitionsPublished;
  }

  /**
   * `publishNow` for callers that must not be interrupted by it: the
   * background publish and the final one. A publication is expected never to
   * throw; one that does is reported as a failed publish rather than
   * swallowed, and never replaces the outcome of the loop it runs in.
   * @returns {Promise<boolean>} True when published
   */
  async function _publishReported() {
    try {
      return await publishNow();
    } catch (err) { // prawduct:allow prawduct/broad-except -- publishing never decides certification; a throw is reported and must not replace the run loop's own outcome
      log({ event: 'publish-failed', code: (err && err.code) || 'PUBLISH_FAILED', message: String((err && err.message) || '').slice(0, 300), nextAttemptAt: null });
      return false;
    }
  }

  /**
   * Start a publish in the background when one is due. It is never awaited
   * by the tick: a slow or failing push must not delay the next sample, or
   * publishing would lengthen intervals and cost qualified time. A transition
   * seen while a publish is in flight is owed and published next.
   * @param {object} state - Committed state
   * @param {boolean} transitioned - Whether this tick moved the state
   * @returns {void}
   */
  function _maybePublish(state, transitioned) {
    if (!ctx.publication) return;
    if (transitioned) transitionsSeen++;
    if (publishing || !ctx.publication.due({ transitioned: _owed(), state: state.state })) return;
    publishing = _publishReported().finally(() => { publishing = null; });
  }

  /**
   * Take one sample and commit it, then publish in the background if due. A
   * run already in a terminal state is left alone.
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
    _maybePublish(state, events.length > 0);
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
    const wait = opts.wait || ((ms) => _abortableSleep(ms, opts.signal));
    const { paths, state: initial } = store.readRun(ctx.base, ctx.candidateSha);
    const runnerLock = paths.runnerLock;
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
      try {
        if (publishing) await publishing;
        if (ctx.publication && (_owed() || isTerminal(state.state))) await _publishReported();
      } finally {
        lockfile.release(runnerLock, token);
        log({ event: 'runner-stopped', runnerInstance, state: state.state });
      }
    }
    return state;
  }

  return { start, tick, run, publishNow, runnerInstance };
}

module.exports = { INTERVAL_BOUNDS, ADMISSION_ATTEMPTS, resolveInterval, worktreeVersion, worktreeId, createRunner };
