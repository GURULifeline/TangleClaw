'use strict';

/**
 * A temp store with projects launched into a required recovery, for the tests
 * of clearing one launch and of reading the operator-held fleet.
 *
 * The recovery is reached through the real launch path: a `current.json` this
 * build cannot read makes the preflight demand recovery. No pane is started;
 * tmux and engine detection are stubbed for the length of one launch call.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const store = require('../lib/store');
const lockfile = require('../lib/handoff-lockfile');
const tmux = require('../lib/tmux');
const enginesModule = require('../lib/engines');

/**
 * Point the store at a fresh temp directory with no login and direct ingress.
 * @param {string} prefix - Temp directory prefix
 * @returns {{tempDir: string, projectsDir: string, sessions: object, restore: () => void}}
 *   `restore` closes the temp store, removes it and points the store back
 */
function openTempStore(prefix) {
  const prevBase = store._getBasePath();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  store.close();
  store._setBasePath(tempDir);
  store.init();
  const projectsDir = path.join(tempDir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  const config = store.config.load();
  config.projectsDir = projectsDir;
  config.authEnabled = false;
  config.ingressMode = 'direct';
  store.config.save(config);
  return {
    tempDir,
    projectsDir,
    sessions: require('../lib/sessions'),
    restore() {
      store.close();
      store._setBasePath(prevBase);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  };
}

/**
 * Launch a project with tmux and engine detection stubbed.
 * @param {object} sessions - `lib/sessions`
 * @param {string} name - Project name
 * @returns {object} The launch result
 */
function launchStubbed(sessions, name) {
  const real = {
    create: tmux.createSession, has: tmux.hasSession, kill: tmux.killSession, detect: enginesModule.detectEngine
  };
  tmux.createSession = () => true;
  tmux.hasSession = () => false;
  tmux.killSession = () => true;
  enginesModule.detectEngine = () => ({ available: true, path: '/usr/bin/fake-engine' });
  try {
    return sessions.launchSession(name, {});
  } finally {
    tmux.createSession = real.create;
    tmux.hasSession = real.has;
    tmux.killSession = real.kill;
    enginesModule.detectEngine = real.detect;
  }
}

/**
 * Create a project and launch it into a required recovery.
 * @param {{projectsDir: string, sessions: object}} env - From {@link openTempStore}
 * @param {'operator'|'advisory'} [recoveryMode] - The project's recovery mode
 * @returns {{project: object, sequence: object, binding: object}} The launch, and the
 *   `{sessionId, sequenceId, recoveryRevision}` that names it
 */
function launchInRecovery(env, recoveryMode = 'operator') {
  const name = `held-${Math.random().toString(36).slice(2, 10)}`;
  const dir = path.join(env.projectsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  const project = store.projects.create({ name, path: dir, engine: 'claude' });
  const conf = store.projectConfig.load(dir) || {};
  conf.launchSequence = { ...(conf.launchSequence || {}), recoveryMode };
  store.projectConfig.save(dir, conf);
  // An operator's choice of advisory is a decision on record. The file alone
  // says advisory only while the login is in force.
  if (recoveryMode === 'advisory') store.projectRecoveryState.recordDecision(project.id, 'advisory', 'operator');
  fs.mkdirSync(lockfile.handoffDir(project), { recursive: true });
  fs.writeFileSync(lockfile.currentPath(project), '{"schema":"not-a-handoff"}\n', 'utf8');
  const session = launchStubbed(env.sessions, name).session;
  const sequence = store.launchSequences.getBySession(session.id);
  assert.equal(sequence.recovery, 'required', 'the fixture must actually be in recovery');
  return {
    project,
    sequence,
    binding: { sessionId: sequence.sessionId, sequenceId: sequence.id, recoveryRevision: sequence.recoveryRevision }
  };
}

module.exports = { openTempStore, launchStubbed, launchInRecovery };
