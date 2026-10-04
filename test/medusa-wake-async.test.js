'use strict';

/*
 * Non-blocking pane reads in the wake monitor (#2086).
 *
 * The timer-driven tick starts a read for every session holding mail and
 * returns. Each read is judged when it answers, on its own. What must hold:
 *
 *   - a hung pane delays nobody: a later recipient is woken as fast as if the
 *     hung pane were not there, and the tick itself takes no time;
 *   - a read's answer is never acted on blind: the whole gate chain runs again
 *     on the session as it is NOW, so a wrap, a rotation, a replacement, mail
 *     already read or a wake already recorded refuses the nudge;
 *   - a tick that did not get a look at a pane (a read still in flight, a
 *     timeout, a read error, a backoff) is not an observation of it;
 *   - one read per session at a time, and nothing after `stop()`.
 *
 * Time is the synthetic fleet's virtual clock.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');
const { useThrowawayStore } = require('./_engine-store');

setLevel('error');

const _store = useThrowawayStore('medusa-wake-async');
after(() => _store.cleanup());

const wake = require('../lib/medusa-wake');
const matrix = require('./helpers/medusa-wake-matrix');
const { TYPING_PANE } = require('./_wake-fixtures');

/**
 * Install a fleet, run `fn` against it, and always restore the monitor.
 * @template T
 * @param {object[]} fleet - Sessions
 * @param {object} opts - `matrix.install` options
 * @param {(world: object) => Promise<T>} fn - The test body
 * @returns {Promise<T>}
 */
async function withFleet(fleet, opts, fn) {
  const world = matrix.install(fleet, opts);
  try {
    return await fn(world);
  } finally {
    world.restore();
  }
}

/**
 * One async tick, then every read it started answered.
 * @param {object} world - The installed world
 * @returns {Promise<void>}
 */
async function tickAndSettle(world) {
  await matrix.runTicksAsync(world, 1);
  await matrix.advance(world, world.clockMs + matrix.READ_TIMEOUT_MS);
}

/**
 * Nudges typed into one session.
 * @param {object} world - The installed world
 * @param {number} id - Session id
 * @returns {number}
 */
const nudged = (world, id) => world.injected.filter((n) => n.sessionId === id).length;

/**
 * Pane reads started for one session.
 * @param {object} world - The installed world
 * @param {number} id - Session id
 * @returns {number}
 */
const reads = (world, id) => world.paneReads.filter((r) => r.sessionId === id).length;

describe('async pane reads — a hung pane delays nobody (#2086)', () => {
  it('a tick takes no time to speak of, however many panes hang', async () => {
    const fleet = matrix.buildFleet({ size: 30, lead: new Array(10).fill('slow') });
    await withFleet(fleet, {}, async (world) => {
      const ticks = await matrix.runTicksAsync(world, 3);
      for (const [i, t] of ticks.entries()) assert.ok(t.durationMs < 100, `tick ${i + 1} held the thread for ${t.durationMs} ms`);
    });
  });

  for (const hung of [0, 1, 3, 10]) {
    it(`30 sessions with ${hung} hung pane(s) scanned first: the last recipient is woken on its second tick, once`, async () => {
      const cell = await matrix.runCellAsync({ size: 30, lead: new Array(hung).fill('slow') });
      assert.equal(cell.nudgesToEligible, 1);
      assert.equal(cell.nudgesToOthers, 0);
      assert.equal(cell.ticks, wake.IDLE_TICKS_REQUIRED);
      assert.ok(cell.wakeMs < 2 * matrix.INTERVAL_MS + matrix.READ_TIMEOUT_MS, `woken at ${cell.wakeMs} ms`);
    });
  }

  it('a fast pane scanned after a slow one is judged first', async () => {
    const slow = matrix.makeSession(1, 'slow');
    const fast = matrix.makeSession(2, 'idle-mail');
    await withFleet([slow, fast], {}, async (world) => {
      await matrix.runTicksAsync(world, 1);
      await matrix.advance(world, world.clockMs + 1000);
      assert.equal(wake.peerReachability(fast.status.workspaceId).reason, 'pane-at-prompt', 'the fast pane has its verdict');
      assert.equal(world.pending.length, 1, 'while the slow read is still out');
      assert.equal(world.pending[0].sessionId, 1);
    });
  });

  it('every session holding mail is read on the same tick', async () => {
    const fleet = matrix.buildFleet({ size: 30, fillers: ['busy', 'draft'] });
    await withFleet(fleet, {}, async (world) => {
      await matrix.runTicksAsync(world, 1);
      assert.equal(world.paneReads.length, 30);
      assert.equal(new Set(world.paneReads.map((r) => r.at)).size <= 30, true);
      assert.ok(world.paneReads.every((r) => r.at - world.paneReads[0].at < 100), 'all started within the one tick');
    });
  });

  for (const size of matrix.SIZES) {
    it(`${size} session(s): each state gets the verdict the synchronous scan gives it`, async () => {
      const blocking = matrix.runCell({ size });
      const nonBlocking = await matrix.runCellAsync({ size });
      assert.deepEqual(nonBlocking.verdicts, blocking.verdicts);
      assert.equal(nonBlocking.nudgesToEligible, 1);
      assert.equal(nonBlocking.nudgesToOthers, 0);
    });
  }

  for (const engine of ['claude', 'antigravity']) {
    it(`${engine}: a mixed fleet behind hung panes nudges the one eligible recipient and no other`, async () => {
      const cell = await matrix.runCellAsync({ size: 10, engine, lead: ['slow', 'slow'] });
      assert.equal(cell.nudgesToEligible, 1);
      assert.equal(cell.nudgesToOthers, 0);
    });
  }
});

describe('async pane reads — an answer is judged against the session as it is now (#2086)', () => {
  /**
   * A recipient one observation from its nudge, with its second read in flight.
   * @param {(world: object, session: object) => void} change - What happens while tmux is being asked
   * @returns {Promise<{world: object, verdict: string|null, nudges: number}>}
   */
  async function changeDuringRead(change) {
    const session = matrix.makeSession(1, 'idle-mail');
    return withFleet([session], {}, async (world) => {
      await tickAndSettle(world);
      assert.equal(nudged(world, 1), 0);
      await matrix.runTicksAsync(world, 1);
      assert.equal(world.pending.length, 1, 'the second read is in flight');
      change(world, session);
      await matrix.advance(world, world.clockMs + matrix.READ_TIMEOUT_MS);
      let verdict = null;
      try { verdict = wake.peerReachability(session.status.workspaceId).reason; } catch { /* the workspace changed */ }
      return { world, verdict, nudges: world.injected.length };
    });
  }

  it('control: with nothing changing, that second read nudges', async () => {
    const r = await changeDuringRead(() => {});
    assert.equal(r.nudges, 1);
  });

  it('a wrap that began during the read refuses the nudge', async () => {
    const r = await changeDuringRead(() => { wake._internal.wrapRunning = () => true; });
    assert.equal(r.nudges, 0);
    assert.equal(r.verdict, 'wrap-running');
  });

  it('a rotation that opened during the read refuses the nudge', async () => {
    const r = await changeDuringRead(() => { wake._internal.rotationOpen = () => true; });
    assert.equal(r.nudges, 0);
    assert.equal(r.verdict, 'coordinator-rotating');
  });

  it('mail read during the read leaves nothing to nudge about', async () => {
    const r = await changeDuringRead((world, s) => { s.status.unread = 0; });
    assert.equal(r.nudges, 0);
    assert.equal(r.verdict, 'no-mail');
  });

  it('a listener that dropped during the read holds the nudge', async () => {
    const r = await changeDuringRead((world, s) => { s.status.state = 'connecting'; });
    assert.equal(r.nudges, 0);
    assert.equal(r.verdict, 'listener-connecting');
  });

  it('a wake recorded durably during the read is not repeated', async () => {
    const r = await changeDuringRead((world, s) => { world.attempted.add(s.status.workspaceId); });
    assert.equal(r.nudges, 0);
    assert.equal(r.verdict, 'nudged');
  });

  it('a wake opt-in withdrawn during the read refuses the nudge', async () => {
    const r = await changeDuringRead(() => { wake._internal.loadProjectConfig = () => ({ medusaWake: false }); });
    assert.equal(r.nudges, 0);
    assert.equal(r.verdict, 'wake-not-opted-in');
  });

  it('a session that ended during the read is not typed into', async () => {
    const r = await changeDuringRead((world, s) => { s.gone = true; });
    assert.equal(r.nudges, 0);
  });

  it('a session whose status left active during the read is not typed into', async () => {
    const r = await changeDuringRead((world, s) => { s.record.status = 'ended'; });
    assert.equal(r.nudges, 0);
    assert.equal(r.verdict, 'session-ended');
  });

  it('a session id that now names another pane is not typed into', async () => {
    const r = await changeDuringRead((world, s) => { s.record = { ...s.record, tmuxSession: 'syn-replacement' }; });
    assert.equal(r.nudges, 0);
  });

  it('a workspace that changed during the read discards it, and the next nudge needs two fresh observations', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    await withFleet([session], {}, async (world) => {
      await tickAndSettle(world);
      await matrix.runTicksAsync(world, 1);
      session.status = { ...session.status, workspaceId: 'syn-ws-replacement' };
      await matrix.advance(world, world.clockMs + matrix.READ_TIMEOUT_MS);
      assert.equal(world.injected.length, 0);
      assert.equal(wake.peerReachability('syn-ws-replacement').reason, 'pane-read-stale');
      await tickAndSettle(world);
      assert.equal(world.injected.length, 0, 'one observation after the discarded read is not enough');
      await tickAndSettle(world);
      assert.equal(world.injected.length, 1);
    });
  });

  it('what is judged is the pane as tmux returned it: a draft typed during the read refuses the nudge', async () => {
    const r = await changeDuringRead((world, s) => { s.pane = TYPING_PANE; });
    assert.equal(r.nudges, 0);
    assert.equal(r.verdict, 'pane-no-prompt');
  });
});

describe('async pane reads — a tick that got no look at a pane is not an observation (#2086)', () => {
  it('a read that times out ends the idle streak and backs the pane off; the nudge then needs two fresh observations', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    await withFleet([session], {}, async (world) => {
      await tickAndSettle(world);
      session.slowReadsLeft = 1;
      await tickAndSettle(world);
      assert.equal(wake.peerReachability(session.status.workspaceId).reason, 'pane-capture-failed');
      await tickAndSettle(world);
      assert.equal(wake.peerReachability(session.status.workspaceId).reason, 'pane-read-backoff');
      assert.equal(reads(world, 1), 2, 'a backed-off pane is not read');
      let ticks = 0;
      while (ticks < 10 && world.injected.length === 0) { await tickAndSettle(world); ticks += 1; }
      assert.equal(world.injected.length, 1);
      // At rest, timed out, then two ordinary reads on consecutive ticks.
      const before = world.paneReads.filter((r) => r.at < world.injected[0].at);
      assert.equal(before.length, 4);
      assert.equal(before[3].at - before[2].at, matrix.INTERVAL_MS);
    });
  });

  it('a read that fails ends the idle streak without a backoff', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    await withFleet([session], {}, async (world) => {
      await tickAndSettle(world);
      session.failReadsLeft = 1;
      await tickAndSettle(world);
      assert.equal(wake.peerReachability(session.status.workspaceId).reason, 'pane-capture-failed');
      await tickAndSettle(world);
      assert.equal(world.injected.length, 0, 'one observation after the failed read is not enough');
      assert.equal(reads(world, 1), 3, 'and the pane was read again at once: a failed read is not a slow one');
      await tickAndSettle(world);
      assert.equal(world.injected.length, 1);
    });
  });

  it('a slow read that still answers is backed off, and does not count towards the streak', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    session.slowAnswersLeft = 1;
    await withFleet([session], { slowMs: wake.SLOW_PANE_READ_MS }, async (world) => {
      let ticks = 0;
      while (ticks < 12 && world.injected.length === 0) { await tickAndSettle(world); ticks += 1; }
      assert.equal(world.injected.length, 1);
      assert.equal(world.paneReads.filter((r) => r.at < world.injected[0].at).length, 1 + wake.IDLE_TICKS_REQUIRED);
    });
  });

  it('a tick that finds the last read still in flight starts no second read and ends the streak', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    await withFleet([session], {}, async (world) => {
      await tickAndSettle(world);
      // The second read is held back past the next tick.
      await matrix.runTicksAsync(world, 1);
      world.pending[0].at += 2 * matrix.INTERVAL_MS;
      wake._internal.tick({ async: true });
      assert.equal(reads(world, 1), 2, 'no overlapping read');
      await matrix.advance(world, world.clockMs + 3 * matrix.INTERVAL_MS);
      assert.equal(world.injected.length, 0, 'the late answer is not the second observation');
      // A read that outlived a tick was slow, so the pane is backed off as well.
      await tickAndSettle(world);
      assert.equal(wake.peerReachability(session.status.workspaceId).reason, 'pane-read-backoff');
      let ticks = 0;
      while (ticks < 10 && world.injected.length === 0) { await tickAndSettle(world); ticks += 1; }
      assert.equal(world.injected.length, 1);
      const before = world.paneReads.filter((r) => r.at < world.injected[0].at);
      assert.equal(before.length, 4, 'at rest, the late read, then two fresh ones');
      assert.equal(before[3].at - before[2].at, matrix.INTERVAL_MS);
    });
  });
});

describe('async pane reads — stopping and restarting (#2086)', () => {
  it('a read that answers after stop() types nothing and stamps no verdict', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    await withFleet([session], {}, async (world) => {
      await tickAndSettle(world);
      await matrix.runTicksAsync(world, 1);
      assert.equal(world.pending.length, 1);
      wake.stop();
      await matrix.advance(world, world.clockMs + matrix.READ_TIMEOUT_MS);
      assert.equal(world.injected.length, 0);
      assert.equal(wake.peerReachability(session.status.workspaceId).reason, 'not-observed');
    });
  });

  it('a restart with a read in flight does not let the old read count: the new monitor needs its own two observations', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    await withFleet([session], {}, async (world) => {
      await tickAndSettle(world);
      await matrix.runTicksAsync(world, 1);
      wake.stop();
      await tickAndSettle(world);
      assert.equal(world.injected.length, 0);
      await tickAndSettle(world);
      assert.equal(world.injected.length, 1);
    });
  });

  it('a restart after the nudge does not repeat it while the durable attempt record is readable', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    await withFleet([session], {}, async (world) => {
      await tickAndSettle(world);
      await tickAndSettle(world);
      assert.equal(world.injected.length, 1);
      wake.stop();
      for (let i = 0; i < 5; i++) await tickAndSettle(world);
      assert.equal(world.injected.length, 1);
    });
  });

  it('a reader that throws instead of returning a promise is a failed read, not a crashed tick', async () => {
    const a = matrix.makeSession(1, 'idle-mail');
    const b = matrix.makeSession(2, 'idle-mail');
    await withFleet([a, b], {}, async (world) => {
      const real = wake._internal.readPaneAsync;
      wake._internal.readPaneAsync = (name, o) => { if (name === a.record.tmuxSession) throw new Error('spawn failed'); return real(name, o); };
      await tickAndSettle(world);
      await tickAndSettle(world);
      assert.equal(nudged(world, 2), 1, 'the other session is unaffected');
      assert.equal(nudged(world, 1), 0);
      assert.equal(wake.peerReachability(a.status.workspaceId).reason, 'pane-capture-failed');
    });
  });
});

describe('async pane reads — the timer uses them (#2086)', () => {
  it('start() ticks with non-blocking reads, and a hand-driven tick stays synchronous', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    await withFleet([session], {}, async (world) => {
      let asyncReads = 0;
      let syncReads = 0;
      const realAsync = wake._internal.readPaneAsync;
      const realSync = wake._internal.capturePane;
      wake._internal.readPaneAsync = (...a) => { asyncReads += 1; return realAsync(...a); };
      wake._internal.capturePane = (...a) => { syncReads += 1; return realSync(...a); };
      wake.start({ intervalMs: 20 });
      await new Promise((resolve) => setTimeout(resolve, 90));
      wake.stop();
      assert.ok(asyncReads >= 1, 'the timer read the pane without blocking');
      assert.equal(syncReads, 0, 'and never through the blocking seam');
      wake._internal.tick();
      assert.equal(syncReads, 1);
    });
  });
});
