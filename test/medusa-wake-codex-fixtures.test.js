'use strict';

/*
 * The wake gate across Codex's engine states, on fixtures that say which
 * codex-cli version they came from (#2086).
 *
 * `test/_wake-fixtures.js` holds the Codex panes in `CODEX_FIXTURE_SETS`, each
 * set carrying `engine`, the exact `cliVersion` and the capture date, and each
 * pane saying whether it is a live capture or was derived. This file:
 *
 *   - checks that metadata, so no Codex pane fixture exists without a version;
 *   - runs every pane of every set against every answer the engine's channel
 *     can give, through the real gate, and pins what the gate does.
 *
 * What this proves is bounded by what was captured. The versions listed in
 * `PROVEN_CLI_VERSIONS` are the only ones proven; no other version is, and
 * nothing here infers that a neighbouring version behaves the same. The
 * channel's answers are TangleClaw's own normalized shape
 * (`lib/startup-control.js` `observeActivity`), not Codex wire bytes, so they
 * carry no Codex version: the app-server protocol is not proven here either.
 *
 * A captured version is not a supported one. The sets for 0.159.0 and 0.161.0
 * exist to pin what the gate REFUSES on them (#2059); whether a session of
 * such a version may be woken at all is decided by the engine profile's
 * verified versions, which the last block here reads.
 */

const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fixtures = require('./_wake-fixtures');
const { setLevel } = require('../lib/logger');
const { useThrowawayStore } = require('./_engine-store');

setLevel('error');

const _store = useThrowawayStore('medusa-wake-codex-fixtures');
after(() => _store.cleanup());

const wake = require('../lib/medusa-wake');

const { CODEX_FIXTURE_SETS } = fixtures;

/** The codex-cli versions with captured fixtures. Every other version is unproven. */
const PROVEN_CLI_VERSIONS = ['0.155.1', '0.156.1', '0.159.0', '0.161.0'];

const PROVENANCE = ['live-capture', 'derived'];

const IDLE = { channel: 'present', state: 'idle', reasonCode: 'thread-idle' };

/**
 * What the engine's channel can answer. `open` is whether the session has a
 * channel at all; `answer` builds the reply for each read.
 */
const CHANNEL_ANSWERS = {
  idle: { open: true, answer: () => Promise.resolve(IDLE) },
  busy: { open: true, answer: () => Promise.resolve({ channel: 'present', state: 'busy', reasonCode: 'thread-active' }) },
  unknown: { open: true, answer: () => Promise.resolve({ channel: 'present', state: 'unknown', reasonCode: 'thread-ambiguous' }) },
  failed: { open: true, answer: () => Promise.reject(new Error('read failed')) },
  // One idle answer, then silence for longer than an answer stays fresh.
  stale: { open: true, stale: true, answer: (n) => (n === 0 ? Promise.resolve(IDLE) : new Promise(() => {})) },
  absent: { open: false, answer: () => Promise.resolve(IDLE) }
};

/** What the gate does whatever the pane shows, for every answer but a fresh idle. */
const HELD_BY_CHANNEL = {
  busy: 'engine-thread-busy',
  unknown: 'engine-thread-unknown',
  failed: 'engine-thread-unknown',
  stale: 'engine-thread-unknown',
  absent: 'engine-channel-absent'
};

/**
 * With a fresh idle from the channel the pane decides: `null` is a nudge, a
 * string is the hold. Only live captures are pinned here.
 */
const ON_FRESH_IDLE = {
  idle: null,
  idleWithNeighbour: null,
  clippedStatusRow: null,
  quotedProse: null,
  busy: 'pane-turn-in-flight',
  dialog: 'pane-no-prompt',
  typing: 'pane-no-prompt',
  // A status line without the run-state item never draws the at-rest marker;
  // the channel's idle answer is what stands in for it.
  idleDefaultLayout: null,
  idleRunState: null,
  busyDefaultLayout: 'pane-turn-in-flight',
  busyRunState: 'pane-turn-in-flight',
  trustDialog: 'pane-no-prompt',
  updateDialog: 'pane-no-prompt'
};

/**
 * Live panes the pane gate does NOT refuse on a fresh idle from the channel,
 * although nothing should be typed into them.
 *
 * Codex draws its empty composer on the screen it opens with, before the
 * folder-trust or update prompt replaces it: no busy marker, a bare prompt, a
 * still transcript. Only the missing at-rest marker refuses that screen, and a
 * fresh idle from the channel excuses exactly that marker. So what keeps a
 * nudge out of it is the channel not answering idle while it is up, which no
 * fixture can show. The cell is pinned as it behaves so that closing it is a
 * deliberate edit here, never a silent one.
 */
const NOT_REFUSED_ON_FRESH_IDLE = ['startScreen'];

/**
 * Cells this file does not prove: a fresh idle from the channel against a pane
 * that was derived, not captured. Where the channel holds, the pane is never
 * consulted, so those cells are proven for derived panes too.
 */
const UNPROVEN_ON_FRESH_IDLE = [['0.155.1', 'thinking']];

/**
 * Live-captured panes that say the same thing as an earlier one, in any set.
 * Compared by content, with trailing space on each row ignored, so a pasted
 * literal is found as well as a reused constant. Two versions that truly draw
 * the same pane would be reported too: that is for whoever adds the set to
 * explain here, not for this check to wave through.
 * @param {object[]} sets - Fixture sets
 * @returns {string[]} One line per copy, empty when there are none
 */
function copiedPanes(sets) {
  const seen = new Map();
  const copies = [];
  for (const set of sets) {
    for (const [name, pane] of Object.entries(set.panes)) {
      if (pane.provenance !== 'live-capture') continue;
      const content = pane.lines.map((row) => row.trimEnd()).join('\n');
      const label = `${set.cliVersion} ${name}`;
      if (seen.has(content)) copies.push(`${label} copies ${seen.get(content)}`);
      else seen.set(content, label);
    }
  }
  return copies;
}

/** Let pending observation promises settle. @returns {Promise<void>} */
const settle = () => new Promise((resolve) => setImmediate(resolve));

let nextSession = 1;

/**
 * Judge one Codex pane under one channel answer through the real gate.
 * @param {string[]} pane - Pane lines
 * @param {object} channel - An entry of `CHANNEL_ANSWERS`
 * @returns {Promise<{injected: number, held: (string|null)}>}
 */
async function judge(pane, channel) {
  const sessionId = nextSession++;
  const world = { clock: 1_000_000, injected: [], recorded: [], reads: 0 };
  const s = wake._internal;
  s.listLiveAll = () => [{ id: sessionId, projectId: 10, sessionMode: 'tmux', tmuxSession: `tc-cx-${sessionId}`, engineId: 'codex' }];
  s.getProject = () => ({ id: 10, name: 'proj-cx', path: '/tmp/proj-cx' });
  s.loadProjectConfig = () => ({ medusaWake: true });
  s.wrapRunning = () => false;
  s.rotationOpen = () => false;
  s.getStatus = () => ({ state: 'listening', workspaceId: 'proj-cx-abc123', unread: 1, lastError: null });
  s.getMessages = () => [{ id: 'm1', from: 'peer', message: 'hello' }];
  s.capturePane = () => ({ lines: pane });
  s.cursorInfo = () => null;
  s.masterWakeRecord = () => null;
  s.recordDelivery = (entry) => { world.recorded.push(entry); };
  s.injectCommand = (projectName, command) => { world.injected.push(command); return { ok: true, error: null }; };
  s.openChannel = () => (channel.open
    ? { id: 7, sessionId, sequenceId: 70, engineId: 'codex', adapter: 'codex', state: 'open', adapterState: { threadId: 't-1' } }
    : null);
  s.launchSequence = () => ({ id: 70, sessionId });
  s.declaresObserver = (engineId) => engineId === 'codex';
  s.observeActivity = () => channel.answer(world.reads++);
  s.now = () => world.clock;
  // The exchange record is not what is under test here.
  s.recordWakeFacts = () => 0;
  s.alreadyAttempted = () => false;
  s.rearmDue = () => false;
  s.awaitingReadiness = () => false;
  s.noteAwaitingRead = () => 0;
  s.noteReadiness = () => 0;
  s.verifySubmission = () => Promise.resolve({ outcome: 'unknown', reason: 'fixture' });

  if (channel.stale) {
    s.tick();
    await settle();
    world.clock += wake.ENGINE_ACTIVITY_MAX_AGE_MS + 1;
  }
  for (let i = 0; i < 2 + wake.IDLE_TICKS_REQUIRED + 2; i++) {
    s.tick();
    await settle();
  }
  const last = world.recorded.length ? world.recorded[world.recorded.length - 1] : null;
  return { injected: world.injected.length, held: last && last.outcome === 'skipped' ? last.skipReason : null };
}

describe('Codex wake fixtures are qualified by version (#2086)', () => {
  it('every set names the engine, an exact codex-cli version and its capture date', () => {
    assert.ok(CODEX_FIXTURE_SETS.length > 0);
    for (const set of CODEX_FIXTURE_SETS) {
      assert.equal(set.engine, 'codex');
      assert.match(set.cliVersion, /^\d+\.\d+\.\d+$/, 'an exact version, not a range');
      assert.match(set.capturedOn, /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(Object.keys(set.panes).length > 0);
      for (const [name, pane] of Object.entries(set.panes)) {
        assert.ok(PROVENANCE.includes(pane.provenance), `${set.cliVersion} ${name}: says how it was obtained`);
        assert.ok(Array.isArray(pane.lines) && pane.lines.length > 0, `${set.cliVersion} ${name}`);
      }
    }
  });

  it('the proven versions are exactly the ones with a fixture set, one set each', () => {
    assert.deepEqual(CODEX_FIXTURE_SETS.map((set) => set.cliVersion), PROVEN_CLI_VERSIONS);
  });

  it('no Codex pane fixture exists outside a versioned set', () => {
    const versioned = new Set(CODEX_FIXTURE_SETS.flatMap((set) => Object.values(set.panes).map((pane) => pane.lines)));
    const exported = Object.entries(fixtures).filter(([name]) => /^CX_.*_PANE$/.test(name));
    assert.ok(exported.length > 0);
    for (const [name, lines] of exported) assert.ok(versioned.has(lines), `${name} belongs to no versioned set`);
  });

  it('a set is not a copy of another under a new version number', () => {
    assert.deepEqual(copiedPanes(CODEX_FIXTURE_SETS), []);
  });

  it('the copy check reads what a pane says, so a pasted copy is caught as surely as a reused constant', () => {
    const [real] = CODEX_FIXTURE_SETS;
    const pasted = {
      engine: 'codex',
      cliVersion: '9.9.9',
      capturedOn: '2026-10-04',
      panes: { idle: { lines: JSON.parse(JSON.stringify(real.panes.idle.lines)), provenance: 'live-capture' } }
    };
    assert.notEqual(pasted.panes.idle.lines, real.panes.idle.lines, 'a different array holding the same rows');
    assert.deepEqual(copiedPanes([real, pasted]), [`9.9.9 idle copies ${real.cliVersion} idle`]);
    // Trailing spaces and a re-wrapped array do not disguise one.
    const padded = { ...pasted, panes: { idle: { lines: real.panes.idle.lines.map((row) => `${row}  `), provenance: 'live-capture' } } };
    assert.equal(copiedPanes([real, padded]).length, 1);
    // A pane that really differs is not a copy, and a derived pane is not held to this.
    const different = { ...pasted, panes: { idle: { lines: ['\u203a', '  Ready now'], provenance: 'live-capture' } } };
    assert.deepEqual(copiedPanes([real, different]), []);
    const derived = { ...pasted, panes: { thinking: { lines: [...real.panes.thinking.lines], provenance: 'derived' } } };
    assert.deepEqual(copiedPanes([real, derived]), []);
  });

  it('the cells left unproven are exactly the derived panes, and they are named', () => {
    const derived = CODEX_FIXTURE_SETS.flatMap((set) => Object.entries(set.panes)
      .filter(([, pane]) => pane.provenance !== 'live-capture')
      .map(([name]) => [set.cliVersion, name]));
    assert.deepEqual(derived, UNPROVEN_ON_FRESH_IDLE);
    for (const [, name] of derived) assert.ok(!(name in ON_FRESH_IDLE), `${name} has no pinned outcome to mistake for proof`);
  });

  it('the wake profile under test is the bundled Codex profile', () => {
    assert.ok(wake.ENGINE_WAKE_PROFILES.codex, 'the gate has a Codex profile to judge these panes with');
  });
});

describe('the wake gate over every Codex engine state, per captured version (#2086)', () => {
  let saved;
  beforeEach(() => {
    saved = { ...wake._internal };
    wake.stop();
  });
  afterEach(() => {
    wake.stop();
    Object.assign(wake._internal, saved);
  });

  for (const set of CODEX_FIXTURE_SETS) {
    describe(`codex-cli ${set.cliVersion}`, () => {
      for (const [paneName, pane] of Object.entries(set.panes)) {
        for (const [answerName, held] of Object.entries(HELD_BY_CHANNEL)) {
          it(`${paneName} pane, channel ${answerName}: held as ${held}, nothing typed`, async () => {
            const out = await judge(pane.lines, CHANNEL_ANSWERS[answerName]);
            assert.deepEqual(out, { injected: 0, held });
          });
        }

        // A pane nobody observed cannot prove what the gate does with a real
        // one, so its fresh-idle cell is not asserted: see UNPROVEN_ON_FRESH_IDLE.
        if (pane.provenance !== 'live-capture') continue;
        if (NOT_REFUSED_ON_FRESH_IDLE.includes(paneName)) {
          it(`${paneName} pane, channel idle: not refused by the pane, so the channel is the only guard`, async () => {
            const out = await judge(pane.lines, CHANNEL_ANSWERS.idle);
            assert.deepEqual(out, { injected: 1, held: null });
          });
          continue;
        }
        const expected = ON_FRESH_IDLE[paneName];
        it(`${paneName} pane, channel idle: ${expected === null ? 'nudged once' : `held as ${expected}`}`, async () => {
          assert.ok(paneName in ON_FRESH_IDLE, 'a new live pane needs an expected outcome here');
          const out = await judge(pane.lines, CHANNEL_ANSWERS.idle);
          assert.deepEqual(out, expected === null ? { injected: 1, held: null } : { injected: 0, held: expected });
        });
      }
    });
  }
});

/** Every live pane of every set, as `[version, name, lines]`. */
const LIVE_PANES = CODEX_FIXTURE_SETS.flatMap((set) => Object.entries(set.panes)
  .filter(([, pane]) => pane.provenance === 'live-capture')
  .map(([name, pane]) => [set.cliVersion, name, pane.lines]));

/**
 * The pane gate's own verdict, with no channel involved.
 * @param {string[]} lines - Pane lines
 * @param {object} profile - Wake profile
 * @returns {string} `idle`, or the refusal reason
 */
function paneVerdict(lines, profile) {
  const verdict = wake._assessPane(lines, profile, null, false);
  return verdict.idle ? 'idle' : verdict.reason;
}

describe('what refuses a Codex pane when no channel has spoken (#2059)', () => {
  const shipped = () => wake.ENGINE_WAKE_PROFILES.codex;
  /** The rule #2059 asked for: the same profile with no at-rest marker. */
  const markerless = () => ({ ...shipped(), idleMarker: null });

  it('the start screen is captured for every version it was seen on', () => {
    const withStart = CODEX_FIXTURE_SETS.filter((set) => 'startScreen' in set.panes).map((set) => set.cliVersion);
    assert.deepEqual(withStart, ['0.156.1', '0.159.0', '0.161.0']);
  });

  for (const [version, name, lines] of LIVE_PANES.filter(([, name]) => name === 'startScreen')) {
    it(`codex-cli ${version}: the start screen is not at rest under the shipped profile`, () => {
      assert.equal(paneVerdict(lines, shipped()), 'not-at-rest');
    });

    it(`codex-cli ${version}: without an at-rest marker the start screen would read idle`, () => {
      assert.equal(paneVerdict(lines, markerless()), 'idle', `${name} is the case a markerless rule gets wrong`);
    });
  }

  it('the shipped Codex profile keeps a positive at-rest marker', () => {
    assert.equal(typeof shipped().idleMarker, 'string');
    assert.ok(shipped().idleMarker.length > 0);
  });

  for (const [version, name, lines] of LIVE_PANES) {
    const refusal = { busyDefaultLayout: 'turn-in-flight', busyRunState: 'turn-in-flight', busy: 'turn-in-flight', trustDialog: 'no-prompt', updateDialog: 'no-prompt', dialog: 'no-prompt', typing: 'no-prompt' }[name];
    if (!refusal) continue;
    it(`codex-cli ${version}: ${name} is refused as ${refusal} even with no at-rest marker required`, () => {
      assert.equal(paneVerdict(lines, markerless()), refusal);
      assert.notEqual(paneVerdict(lines, shipped()), 'idle');
    });
  }

  for (const [version, name, lines] of LIVE_PANES.filter(([, name]) => name === 'idleDefaultLayout')) {
    it(`codex-cli ${version}: at rest with Codex's default status line is held as not-at-rest`, () => {
      assert.equal(paneVerdict(lines, shipped()), 'not-at-rest', `${name} draws no run-state item`);
    });
  }

  for (const [version, , lines] of LIVE_PANES.filter(([, name]) => name === 'idleRunState')) {
    it(`codex-cli ${version}: at rest with the run-state item shown reads idle`, () => {
      assert.equal(paneVerdict(lines, shipped()), 'idle');
    });
  }
});

describe('a captured Codex version is woken only if the profile verified it (#2059)', () => {
  const startupControl = require('../lib/startup-control');
  const profile = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'codex.json'), 'utf8'));
  const verified = profile.capabilities.startupControl.verifiedVersions;

  /**
   * Resolve the Codex startup channel as if `version` were installed.
   * @param {string} version - codex-cli version
   * @returns {{supported: boolean, reasonCode: (string|null)}}
   */
  function resolveAt(version) {
    const adapters = { codex: { installedVersion: () => version, observeActivity: () => null } };
    return startupControl.resolve(profile, adapters, 'codex');
  }

  it('the captured versions split into verified and not, and both kinds are present', () => {
    const captured = CODEX_FIXTURE_SETS.map((set) => set.cliVersion);
    assert.ok(captured.some((version) => verified.includes(version)), 'a verified version is captured');
    assert.ok(captured.some((version) => !verified.includes(version)), 'an unverified version is captured');
  });

  for (const set of CODEX_FIXTURE_SETS) {
    if (verified.includes(set.cliVersion)) {
      it(`codex-cli ${set.cliVersion} is verified: its launch gets a channel`, () => {
        const out = resolveAt(set.cliVersion);
        assert.equal(out.supported, true);
        assert.equal(out.reasonCode, null);
      });
      continue;
    }
    it(`codex-cli ${set.cliVersion} is not verified: its launch gets no channel`, () => {
      const out = resolveAt(set.cliVersion);
      assert.equal(out.supported, false);
      assert.equal(out.reasonCode, 'version_unverified');
    });

    it(`codex-cli ${set.cliVersion}: an unverified version is still an engine judged by its channel`, () => {
      const adapters = { codex: { installedVersion: () => set.cliVersion, observeActivity: () => null } };
      assert.equal(startupControl.declaresObserver('codex', () => profile, adapters), true);
    });
  }

  // What the gate then does with such a session is the `absent` row of the
  // matrix above: held as engine-channel-absent on every pane of every set.
});
