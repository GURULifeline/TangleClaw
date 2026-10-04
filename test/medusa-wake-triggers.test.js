'use strict';

/*
 * Scan requests in the wake monitor (#2086): a look when something happened,
 * not up to an interval later.
 *
 * `requestScan` is a request. It runs the scan the timer runs, through every
 * gate, and can type nothing a tick would not. What must hold:
 *
 *   - mail that arrives for a pane at rest is nudged about in one minimum
 *     observation gap, not two ticks;
 *   - it is still two at-rest observations of an unchanged pane, that far
 *     apart: one look never nudges, and exactly one follow-up is booked;
 *   - a tick landing between the two does not disturb them;
 *   - requests are bounded: a storm costs one look, and a request that could
 *     only waste a look or restart a streak is dropped;
 *   - nothing happens after `stop()`.
 *
 * Time is the synthetic fleet's virtual clock. Every blocking tmux seam throws
 * if it is reached off a tick.
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');
const { useThrowawayStore } = require('./_engine-store');

setLevel('error');

const _store = useThrowawayStore('medusa-wake-triggers');
after(() => _store.cleanup());

const wake = require('../lib/medusa-wake');
const matrix = require('./helpers/medusa-wake-matrix');

const GAP = wake.MIN_OBSERVATION_GAP_MS;

/**
 * Install a fleet on a started monitor, run `fn`, and always restore.
 * @template T
 * @param {object[]} fleet - Sessions
 * @param {object} opts - `matrix.install` options
 * @param {(world: object) => Promise<T>} fn - The test body
 * @returns {Promise<T>}
 */
async function withFleet(fleet, opts, fn) {
  const world = matrix.install(fleet, { started: true, forbidBlockingOnAnswer: true, ...opts });
  try {
    return await fn(world);
  } finally {
    world.restore();
  }
}

/**
 * Let everything due within `ms` happen.
 * @param {object} world - The installed world
 * @param {number} ms - Virtual milliseconds
 * @returns {Promise<void>}
 */
const pass = (world, ms) => matrix.advance(world, world.clockMs + ms);

/**
 * Pane reads started for one session.
 * @param {object} world - The installed world
 * @param {number|string} id - Session id
 * @returns {number}
 */
const reads = (world, id) => world.paneReads.filter((r) => r.sessionId === id).length;

describe('scan requests — mail for a pane at rest is nudged about in one gap, not two ticks (#2086)', () => {
  it('a request leads to a nudge about one minimum gap later, from two observations', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    await withFleet([session], {}, async (world) => {
      assert.equal(wake.requestScan(1, 'mail-arrived'), true);
      await pass(world, GAP + 1000);
      assert.equal(world.injected.length, 1);
      assert.ok(world.injected[0].at < GAP + 1000, `woken at ${world.injected[0].at} ms`);
      assert.equal(reads(world, 1), 2);
      await pass(world, 30000);
      assert.equal(world.injected.length, 1, 'and never again');
    });
  });

  it('control: without a request the same recipient waits for two ticks', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    await withFleet([session], {}, async (world) => {
      await matrix.runTicksAsync(world, 1);
      await pass(world, 1000);
      assert.equal(world.injected.length, 0);
      await matrix.runTicksAsync(world, 1);
      await pass(world, 1000);
      assert.equal(world.injected.length, 1);
      assert.ok(world.injected[0].at > 2 * matrix.INTERVAL_MS);
    });
  });

  it('one look never nudges: nothing is typed before the follow-up', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    await withFleet([session], {}, async (world) => {
      wake.requestScan(1, 'mail-arrived');
      await pass(world, GAP - 500);
      assert.equal(reads(world, 1), 1);
      assert.equal(world.injected.length, 0);
    });
  });

  it('the two observations are at least the minimum gap apart', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    await withFleet([session], {}, async (world) => {
      wake.requestScan(1, 'mail-arrived');
      await pass(world, GAP + 1000);
      assert.ok(world.paneReads[1].at - world.paneReads[0].at >= GAP);
    });
  });

  it('a tick landing between the two observations starts no read and does not restart the streak', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    await withFleet([session], {}, async (world) => {
      // The request comes a second before the tick.
      await pass(world, matrix.INTERVAL_MS - 1000);
      wake.requestScan(1, 'mail-arrived');
      await pass(world, 1000);
      assert.equal(reads(world, 1), 1);
      // The timer fires now, a second after the first observation.
      wake._internal.tick({ async: true });
      await pass(world, 500);
      assert.equal(reads(world, 1), 1, 'the tick left the session to its booked follow-up');
      assert.equal(world.injected.length, 0);
      await pass(world, GAP);
      assert.equal(reads(world, 1), 2);
      assert.equal(world.injected.length, 1);
    });
  });

  it('a session id given as a string, as a listener gives it, is the same session', async () => {
    const session = matrix.makeSession(7, 'idle-mail');
    await withFleet([session], {}, async (world) => {
      assert.equal(wake.requestScan('7', 'mail-arrived'), true);
      await pass(world, GAP + 1000);
      assert.equal(world.injected.length, 1);
    });
  });

  it('the Master is looked at by its key, with no blocking probe, and nudged through its own injector', async () => {
    await withFleet([], { master: matrix.makeMaster() }, async (world) => {
      wake.requestScan(matrix.MASTER_ID, 'mail-arrived');
      await pass(world, GAP + 1000);
      assert.equal(world.injected.length, 1);
      assert.equal(world.injected[0].sessionId, matrix.MASTER_ID);
      assert.deepEqual(world.blockingTmux, []);
    });
  });
});

describe('scan requests — a request passes every gate (#2086)', () => {
  /**
   * What a request does to a lone session in some state.
   * @param {object} session - The session
   * @param {(world: object) => void} [arrange] - Changes before the request
   * @returns {Promise<{verdict: string, nudges: number, reads: number, followUps: number}>}
   */
  async function request(session, arrange = () => {}) {
    return withFleet([session], {}, async (world) => {
      arrange(world);
      wake.requestScan(session.record.id, 'mail-arrived');
      await pass(world, 1000);
      const followUps = world.timers.length;
      await pass(world, 2 * GAP);
      return {
        verdict: wake.peerReachability(session.status.workspaceId).reason,
        nudges: world.injected.length,
        reads: reads(world, session.record.id),
        followUps
      };
    });
  }

  it('a busy pane is not nudged, and no follow-up is booked for it', async () => {
    const r = await request(matrix.makeSession(1, 'busy'));
    assert.deepEqual(r, { verdict: 'pane-turn-in-flight', nudges: 0, reads: 1, followUps: 0 });
  });

  it('a pane with a draft in it is not nudged', async () => {
    const r = await request(matrix.makeSession(1, 'draft'));
    assert.deepEqual([r.verdict, r.nudges, r.followUps], ['pane-no-prompt', 0, 0]);
  });

  it('a session mid-wrap is not read at all', async () => {
    const r = await request(matrix.makeSession(1, 'idle-mail'), () => { wake._internal.wrapRunning = () => true; });
    assert.deepEqual(r, { verdict: 'wrap-running', nudges: 0, reads: 0, followUps: 0 });
  });

  it('a coordinator in rotation is not read at all', async () => {
    const r = await request(matrix.makeSession(1, 'idle-mail'), () => { wake._internal.rotationOpen = () => true; });
    assert.deepEqual(r, { verdict: 'coordinator-rotating', nudges: 0, reads: 0, followUps: 0 });
  });

  it('a session that has not opted in is not read at all', async () => {
    const r = await request(matrix.makeSession(1, 'idle-mail'), () => { wake._internal.loadProjectConfig = () => ({ medusaWake: false }); });
    assert.deepEqual(r, { verdict: 'wake-not-opted-in', nudges: 0, reads: 0, followUps: 0 });
  });

  it('a session with no mail is not read', async () => {
    const r = await request(matrix.makeSession(1, 'no-mail'));
    assert.deepEqual(r, { verdict: 'no-mail', nudges: 0, reads: 0, followUps: 0 });
  });

  it('a pane that moved before the follow-up is seen as writing, is not nudged, and gets no second follow-up', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    await withFleet([session], {}, async (world) => {
      wake.requestScan(1, 'mail-arrived');
      await pass(world, 1000);
      session.pane = ['a line of new output', ...session.pane];
      await pass(world, GAP);
      assert.equal(wake.peerReachability(session.status.workspaceId).reason, 'pane-writing');
      assert.equal(world.injected.length, 0);
      assert.equal(world.timers.length, 0, 'the timer takes it from here');
    });
  });

  it('a session already nudged is not nudged again by a request', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    await withFleet([session], {}, async (world) => {
      wake.requestScan(1, 'mail-arrived');
      await pass(world, GAP + 1000);
      assert.equal(world.injected.length, 1);
      await pass(world, 2 * GAP);
      wake.requestScan(1, 'listener-listening');
      await pass(world, 3 * GAP);
      assert.equal(world.injected.length, 1);
    });
  });
});

describe('scan requests — bounded (#2086)', () => {
  it('fifty requests for one session before the loop turns cost one look', async () => {
    const session = matrix.makeSession(1, 'busy');
    await withFleet([session], {}, async (world) => {
      for (let i = 0; i < 50; i++) wake.requestScan(1, 'mail-arrived');
      await pass(world, 1000);
      assert.equal(reads(world, 1), 1);
    });
  });

  it('a request while the pane is being read starts no second read', async () => {
    const session = matrix.makeSession(1, 'busy');
    session.readDelays = [2000];
    await withFleet([session], {}, async (world) => {
      wake.requestScan(1, 'mail-arrived');
      await pass(world, 500);
      wake.requestScan(1, 'mail-arrived');
      await pass(world, 500);
      assert.equal(reads(world, 1), 1);
    });
  });

  it('a request while the second observation is being read does not cost the recipient its streak', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    session.readDelays = [100, 1000];
    await withFleet([session], {}, async (world) => {
      await matrix.runTicksAsync(world, 1);
      await pass(world, 500);
      await matrix.runTicksAsync(world, 1);
      // The second read is out. More mail arrives.
      await pass(world, 500);
      wake.requestScan(1, 'mail-arrived');
      await pass(world, 1000);
      assert.equal(world.injected.length, 1, 'the read that was out completed the streak');
      assert.equal(reads(world, 1), 2);
    });
  });

  it('a request while a follow-up is booked changes nothing', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    await withFleet([session], {}, async (world) => {
      wake.requestScan(1, 'mail-arrived');
      await pass(world, 1000);
      wake.requestScan(1, 'mail-arrived');
      await pass(world, 1000);
      assert.equal(reads(world, 1), 1);
      assert.equal(world.timers.length, 1, 'still exactly one follow-up');
      await pass(world, GAP);
      assert.equal(world.injected.length, 1);
    });
  });

  it('a request too soon after an observation is dropped, so it cannot restart the streak', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    await withFleet([session], {}, async (world) => {
      await matrix.runTicksAsync(world, 1);
      await pass(world, 1000);
      assert.equal(reads(world, 1), 1);
      wake.requestScan(1, 'mail-arrived');
      await pass(world, 1000);
      assert.equal(reads(world, 1), 1, 'no look inside the minimum gap');
      await matrix.runTicksAsync(world, 1);
      await pass(world, 1000);
      assert.equal(world.injected.length, 1, 'and the timer\'s second observation still nudges');
    });
  });

  it('a request for a backed-off pane is dropped', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    session.slowReadsLeft = 1;
    await withFleet([session], {}, async (world) => {
      wake.requestScan(1, 'mail-arrived');
      await pass(world, matrix.READ_TIMEOUT_MS + 500);
      assert.equal(reads(world, 1), 1);
      wake.requestScan(1, 'mail-arrived');
      await pass(world, 1000);
      assert.equal(reads(world, 1), 1);
    });
  });

  it('a request for a session that is not live does nothing', async () => {
    await withFleet([matrix.makeSession(1, 'idle-mail')], {}, async (world) => {
      wake.requestScan(999, 'mail-arrived');
      wake.requestScan('not-a-session', 'mail-arrived');
      await pass(world, 1000);
      assert.equal(world.paneReads.length, 0);
    });
  });

  it('an unusable id is refused outright', async () => {
    await withFleet([], {}, async () => {
      assert.equal(wake.requestScan(null, 'x'), false);
      assert.equal(wake.requestScan(undefined, 'x'), false);
      assert.equal(wake.requestScan('', 'x'), false);
    });
  });
});

describe('scan requests — stopping (#2086)', () => {
  it('a stopped monitor refuses requests', async () => {
    const world = matrix.install([matrix.makeSession(1, 'idle-mail')], {});
    try {
      assert.equal(wake.requestScan(1, 'mail-arrived'), false);
      await pass(world, 1000);
      assert.equal(world.paneReads.length, 0);
    } finally {
      world.restore();
    }
  });

  it('a request queued before stop() is never acted on', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    await withFleet([session], {}, async (world) => {
      wake.requestScan(1, 'mail-arrived');
      wake.stop();
      await pass(world, 2 * GAP);
      assert.equal(world.paneReads.length, 0);
    });
  });

  it('stop() cancels a booked follow-up', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    await withFleet([session], {}, async (world) => {
      wake.requestScan(1, 'mail-arrived');
      await pass(world, 1000);
      assert.equal(world.timers.length, 1);
      wake.stop();
      assert.equal(world.timers.length, 0);
      await pass(world, 2 * GAP);
      assert.equal(reads(world, 1), 1);
      assert.equal(world.injected.length, 0);
    });
  });

  it('a session that ends before its follow-up is not read again, and the follow-up is cancelled when a tick prunes it', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    await withFleet([session], {}, async (world) => {
      wake.requestScan(1, 'mail-arrived');
      await pass(world, 1000);
      session.gone = true;
      wake._internal.tick({ async: true });
      assert.equal(world.timers.length, 0);
      await pass(world, 2 * GAP);
      assert.equal(reads(world, 1), 1);
      assert.equal(world.injected.length, 0);
    });
  });
});

describe('scan requests — the follow-up is only ever about the pane that was observed (#2086)', () => {
  it('a session id that names another pane before the follow-up loses the streak and the booking', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    await withFleet([session], {}, async (world) => {
      wake.requestScan(1, 'mail-arrived');
      await pass(world, 1000);
      assert.equal(world.timers.length, 1);
      // The same id, relaunched into another pane, also at rest with mail.
      session.record = { ...session.record, tmuxSession: 'syn-1-relaunched', startedAt: '2026-10-04 10:10:10' };
      wake._internal.tick({ async: true });
      assert.equal(world.timers.length, 0, 'the booking for the old pane is cancelled');
      await pass(world, 1000);
      assert.equal(world.injected.length, 0, 'the new pane\'s first observation does not complete the old pane\'s streak');
      await pass(world, GAP);
      assert.equal(world.injected.length, 0, 'and the cancelled follow-up never ran');
      await matrix.runTicksAsync(world, 1);
      await pass(world, 1000);
      assert.equal(world.injected.length, 1, 'two observations of the new pane, a tick apart, nudge it');
    });
  });

  it('a session replaced under a new id before the follow-up is not typed into from the old one\'s observation', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    await withFleet([session], {}, async (world) => {
      wake.requestScan(1, 'mail-arrived');
      await pass(world, 1000);
      session.gone = true;
      const replacement = matrix.makeSession(2, 'idle-mail');
      world.fleet.push(replacement);
      await pass(world, GAP);
      assert.equal(world.injected.length, 0, 'the old session\'s follow-up found it gone, and the new one has not been observed twice');
      assert.equal(reads(world, 2), 0);
    });
  });

  it('a follow-up that never fires does not hold the session back: the timer takes it up again once it is overdue', async () => {
    const session = matrix.makeSession(1, 'idle-mail');
    await withFleet([session], {}, async (world) => {
      wake.requestScan(1, 'mail-arrived');
      await pass(world, 1000);
      // The booked timer is lost.
      world.timers = [];
      wake._internal.tick({ async: true });
      await pass(world, 500);
      assert.equal(reads(world, 1), 1, 'while the follow-up is still due, the tick leaves the session to it');
      await pass(world, 2 * GAP);
      assert.equal(reads(world, 1), 1);
      // Now it is overdue.
      await matrix.runTicksAsync(world, 2);
      await pass(world, 1000);
      assert.equal(world.injected.length, 1, 'the timer woke the recipient by itself');
    });
  });
});

describe('scan requests — who asks (#2086)', () => {
  const fs = require('node:fs');
  const path = require('node:path');

  /**
   * Record the scan requests made while `fn` runs.
   * @param {() => (void|Promise<void>)} fn - What to run
   * @returns {Promise<Array<[string|number, string]>>}
   */
  async function requestsDuring(fn) {
    const seen = [];
    const real = wake.requestScan;
    wake.requestScan = (id, reason) => { seen.push([id, reason]); return true; };
    try {
      await fn();
    } finally {
      wake.requestScan = real;
    }
    return seen;
  }

  it('a wrap that finishes asks for a look at its session, once, and only when it really finished', async () => {
    const registry = require('../lib/wrap-run-registry');
    const seen = await requestsDuring(() => {
      const begun = registry.begin('trigger-proj', 42);
      assert.equal(registry.finish('trigger-proj', 'not-the-run', null), false);
      assert.equal(registry.finish('trigger-proj', begun.runId, { ok: true }), true);
      assert.equal(registry.finish('trigger-proj', begun.runId, { ok: true }), false);
    });
    assert.deepEqual(seen, [[42, 'wrap-finished']]);
  });

  it('the wrap has finished by the time the request is made', async () => {
    const registry = require('../lib/wrap-run-registry');
    let runningWhenAsked = null;
    const real = wake.requestScan;
    wake.requestScan = () => { runningWhenAsked = registry.get('trigger-proj-2').running; return true; };
    try {
      const begun = registry.begin('trigger-proj-2', 43);
      registry.finish('trigger-proj-2', begun.runId, null);
    } finally {
      wake.requestScan = real;
    }
    assert.equal(runningWhenAsked, false);
  });

  it('a wrap with no session asks for nothing', async () => {
    const registry = require('../lib/wrap-run-registry');
    const seen = await requestsDuring(() => {
      const begun = registry.begin('trigger-proj-3', null);
      assert.equal(registry.finish('trigger-proj-3', begun.runId, null), true);
    });
    assert.deepEqual(seen, []);
  });

  it('a request that throws cannot fail the wrap that finished', () => {
    const registry = require('../lib/wrap-run-registry');
    const real = wake.requestScan;
    wake.requestScan = () => { throw new Error('monitor exploded'); };
    try {
      const begun = registry.begin('trigger-proj-4', 44);
      assert.equal(registry.finish('trigger-proj-4', begun.runId, { ok: true }), true);
      assert.equal(registry.get('trigger-proj-4').running, false);
    } finally {
      wake.requestScan = real;
    }
  });

  it('a request that throws cannot stop a listener reaching listening', async () => {
    const os = require('node:os');
    const medusa = require('../lib/medusa');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-trigger-'));
    /** A WebSocket the test opens and feeds by hand. */
    class FakeSocket {
      constructor() { this.readyState = 0; this.sent = []; this._h = Object.create(null); }
      addEventListener(t, h) { (this._h[t] || (this._h[t] = [])).push(h); }
      send(d) { this.sent.push(d); }
      close() { this.readyState = 3; }
      fire(t, e) { for (const h of this._h[t] || []) h(e); }
    }
    const real = wake.requestScan;
    wake.requestScan = () => { throw new Error('monitor exploded'); };
    try {
      let socket;
      const status = medusa.startSession({ projectPath: dir, sessionId: 4343, name: 'Trigger Two', wsFactory: () => (socket = new FakeSocket()) });
      socket.readyState = 1;
      socket.fire('open', {});
      socket.fire('message', { data: JSON.stringify({ type: 'registered', workspaceId: status.workspaceId, connectionId: 'c1' }) });
      assert.equal(medusa.getStatus(4343).state, 'listening');
    } finally {
      wake.requestScan = real;
      medusa.stopSession(4343);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a listener that reaches listening asks for a look at its session, and not for any other state', async () => {
    const os = require('node:os');
    const medusa = require('../lib/medusa');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-trigger-'));
    /** A WebSocket the test opens and feeds by hand. */
    class FakeSocket {
      constructor() { this.readyState = 0; this.sent = []; this._h = Object.create(null); }
      addEventListener(t, h) { (this._h[t] || (this._h[t] = [])).push(h); }
      send(d) { this.sent.push(d); }
      close() { this.readyState = 3; }
      fire(t, e) { for (const h of this._h[t] || []) h(e); }
    }
    try {
      let socket;
      let status;
      const seen = await requestsDuring(() => {
        status = medusa.startSession({ projectPath: dir, sessionId: 4242, name: 'Trigger', wsFactory: () => (socket = new FakeSocket()) });
        assert.equal(status.state, 'connecting');
        socket.readyState = 1;
        socket.fire('open', {});
        socket.fire('message', { data: JSON.stringify({ type: 'registered', workspaceId: status.workspaceId, connectionId: 'c1' }) });
        assert.equal(medusa.getStatus(4242).state, 'listening');
      });
      assert.deepEqual(seen, [['4242', 'listener-listening']]);
    } finally {
      medusa.stopSession(4242);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the server asks for a look when mail arrives, after recording the arrival', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const start = src.indexOf('medusa.setArrivalObserver(');
    assert.ok(start >= 0);
    const observer = src.slice(start, src.indexOf('\n});', start));
    const recorded = observer.indexOf('medusaExchanges.recordArrival(');
    const asked = observer.indexOf("medusaWake.requestScan(sessionKey, 'mail-arrived')");
    assert.ok(recorded >= 0 && asked > recorded, 'the scan is requested after the arrival is recorded');
    assert.ok(!/return;/.test(observer.slice(0, asked)), 'no early return can skip the request');
    const tail = observer.slice(observer.indexOf('} finally {'));
    assert.ok(tail.includes("medusaWake.requestScan(sessionKey, 'mail-arrived')"), 'the request is made even if recording the arrival throws');
    assert.match(tail, /try \{\s*medusaWake\.requestScan\(sessionKey, 'mail-arrived'\);\s*\} catch/, 'and a request that throws is contained');
  });

  it('a rotation that closes asks for a look at its session', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'coordinator-rotation.js'), 'utf8');
    assert.match(src, /fence lifted'[^\n]*\n\s+if \(done\.rotation\.sessionId != null\) d\.wake\(done\.rotation\.sessionId, 'rotation-closed'\);/);
    assert.match(src, /if \(OPEN_STATES\.has\(rotation\.state\) && done\.rotation\.sessionId != null\) d\.wake\(done\.rotation\.sessionId, 'rotation-closed'\);/);
  });
});
