'use strict';

/**
 * Shared fixtures for the release-certification suites: one healthy run's
 * manifest, observations and samples.
 *
 * Every suite used to carry its own copy, and the copies drifted (a field the
 * probes emit was missing from some). A new field is added here once. Values
 * a suite's assertions depend on, such as the worktree path a privacy test
 * looks for, are passed explicitly rather than assumed.
 *
 * @module test/_release-certification-fixtures
 */

const sm = require('../lib/release-certification/state-machine');

const SHA = 'a'.repeat(40);
const WTID = 'c'.repeat(64);
const GEN = '4242@Sun Sep 27 09:00:00 2026';
const MIN = 60 * 1000;
const T0 = 1_000_000;

/**
 * A manifest for the candidate, from `sm.buildManifest`.
 * @param {object} [over] - Fields to set or replace, e.g. `{createdAt, worktreePath, host, thresholds}`
 * @returns {object} Manifest
 */
function manifest(over = {}) {
  return sm.buildManifest({
    candidateSha: SHA,
    version: '5.30.0',
    repository: 'o/r',
    requiredChecks: ['test'],
    requiredChecksSource: 'branch-protection',
    createdAt: T0,
    worktreePath: '/tmp/wt',
    worktreeId: WTID,
    ttydGeneration: GEN,
    host: 'h',
    ...over
  });
}

/**
 * Observations of a healthy candidate, with every field the probes emit.
 * Each key of `over` is merged into that probe's observation; `null` makes
 * the probe unavailable.
 * @param {object} [over] - Per-probe overrides
 * @param {object} [base] - Per-probe values replacing the defaults before `over` applies (a suite's own pool size or process ids)
 * @returns {object} Observations
 */
function observations(over = {}, base = {}) {
  const b = {
    worktree: { headSha: SHA, detached: true, dirty: false },
    server: { checkoutId: WTID, currentDiskSha: SHA, isStale: false, startupSha: SHA, shaBaselineSource: 'startup', runningVersion: '5.30.0', startedAt: 500 },
    ttyd: { applicable: true, managed: true, generation: GEN, leakState: 'clear', wedgedCount: 0, orphanGate: false, poolUsed: 1 },
    github: { state: 'ok', checks: { test: 'success' } },
    pty: { instance: 's1', attaches: 0, detaches: 0, lastAt: null }
  };
  for (const [k, v] of Object.entries(base)) b[k] = { ...b[k], ...v };
  for (const [k, v] of Object.entries(over)) b[k] = v === null ? null : { ...b[k], ...v };
  return b;
}

/**
 * One sample taken `t` ms after `T0`.
 * @param {number} t - Offset in ms (also the monotonic reading)
 * @param {object} [obs] - Observations
 * @param {object} [extra] - Fields to set on the sample, e.g. `{runnerInstance, monoAt, diagnostics}`
 * @returns {object} Sample
 */
function sample(t, obs = observations(), extra = {}) {
  return { wallAt: T0 + t, monoAt: t, runnerInstance: 'r1', observations: obs, ...extra };
}

module.exports = { SHA, WTID, GEN, MIN, T0, manifest, observations, sample };
