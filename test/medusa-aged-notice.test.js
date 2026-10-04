'use strict';

/*
 * One truthful aged notice per held message (#2086).
 *
 * The watchdog's ladder already aged every tracked exchange once per rung.
 * These hold what #2086 adds to it:
 *
 *   - every notice says whether waiting will fix the hold, from the one
 *     classifier, and never promises a retry from a stopped wake monitor;
 *   - NORMAL mail, which used to stop at the sender, reaches the operator once
 *     when only someone acting can fix it (at the aged rung), when the engine's
 *     own channel has stalled (at the aged rung), or when it has merely waited
 *     too long (at `operatorNormalMs`);
 *   - the alert is exactly one fact and one activity row, across repeated
 *     scans, a restart and competing passes, and it keeps what was true then.
 *
 * Time is a fake clock throughout.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const mx = require('../lib/medusa-exchanges');
const watchdog = require('../lib/medusa-watchdog');
const disposition = require('../lib/medusa-delivery-disposition');

const MIN = 60 * 1000;
const T0 = Date.parse('2026-10-04T12:00:00.000Z');

let tmpDir = null;
let pm;
let builder;
let sent;
let activity;
let failNext;
let monitorRunning;
let workspaces;
let clock;

/**
 * A project with a directory under the scratch store.
 * @param {string} name - Project name
 * @returns {object}
 */
function mkProject(name) {
  const dir = path.join(tmpDir, name);
  fs.mkdirSync(dir);
  return store.projects.create({ name, path: dir, engine: 'claude' });
}

/**
 * A message from the PM to the Builder, stored and delivered.
 * @param {object} [body] - Send body
 * @param {string} [hubId] - Hub id
 * @returns {object} The exchange row
 */
function pmToBuilder(body = {}, hubId = 'hub-1') {
  const caller = { kind: 'project', projectId: pm.id };
  const x = mx.createSendIntent({
    meta: mx.validateSendMeta(body, caller, pm.id),
    sender: { projectId: pm.id, workspaceId: 'pm-ws' },
    recipient: { workspaceId: 'builder-ws', projectId: builder.id, sessionId: 2 }
  });
  mx.bindHubId(x.exchange_id, hubId);
  mx.recordArrival({ hubId, recipientWorkspaceId: 'builder-ws' });
  return store.medusaExchanges.get(x.exchange_id);
}

/**
 * Record what the wake monitor found for the Builder's mail, at a time.
 * @param {string} fact - `wake_blocked`, `wake_pending` or `wake_attempted`
 * @param {string} code - Reason code, or the transport for an attempt
 * @param {number} atMs - Epoch ms
 * @returns {void}
 */
function wake(fact, code, atMs) {
  clock = atMs;
  mx.recordWakeForRecipient('builder-ws', fact, { code, detail: fact === 'wake_attempted' ? { nonce: `n${atMs}` } : null });
}

/**
 * Run one watchdog pass at a time and wait for its notices.
 * @param {number} ms - Epoch ms
 * @returns {Promise<object>}
 */
async function tickAt(ms) {
  clock = ms;
  const out = watchdog.tick(ms);
  await out.notices;
  return out;
}

const row = (x) => store.medusaExchanges.get(x.exchange_id);
const facts = (x) => store.medusaExchanges.facts(x.exchange_id);
const alerts = (x) => facts(x).filter((f) => f.fact === 'operator_alerted');
const detail = (f) => JSON.parse(f.detail_json);

describe('aged notices (#2086)', () => {
  const saved = {};
  const savedNow = mx._internal.now;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-aged-notice-'));
    store._setBasePath(tmpDir);
    store.init();
    clock = T0;
    mx._internal.now = () => new Date(clock);
    pm = mkProject('pm');
    builder = mkProject('builder');
    sent = [];
    activity = [];
    failNext = false;
    monitorRunning = true;
    workspaces = { [pm.id]: 'pm-ws-live' };
    Object.assign(saved, watchdog._internal);
    watchdog._internal.loadConfig = () => ({});
    watchdog._internal.sendSystemMessage = async (m) => {
      if (failNext) throw new Error('hub down');
      sent.push({ to: m.to, body: JSON.parse(m.message) });
      return { status: 'received' };
    };
    watchdog._internal.workspaceForProject = (id) => workspaces[id] || null;
    watchdog._internal.isLocalWorkspace = () => false;
    watchdog._internal.logActivity = (e) => activity.push(e);
    watchdog._internal.monitorRunning = () => monitorRunning;
  });

  afterEach(() => {
    Object.assign(watchdog._internal, saved);
    mx._internal.now = savedNow;
    store._setActivityLogRetention(store.ACTIVITY_LOG_RETENTION);
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('a notice says whether waiting will fix the hold', () => {
    /**
     * The aged notice sent for a normal message held one way.
     * @param {(x: object) => void} hold - Sets the hold before the aged rung
     * @returns {Promise<object>} The notice body
     */
    async function agedNotice(hold) {
      const x = pmToBuilder({});
      hold(x);
      await tickAt(T0 + 30 * MIN);
      assert.equal(sent.length, 1);
      return sent[0].body;
    }

    it('a busy recipient: actionable, wait', async () => {
      const body = await agedNotice(() => wake('wake_blocked', 'pane-turn-in-flight', T0 + MIN));
      assert.deepEqual([body.blocker, body.class, body.nextAction], ['pane-turn-in-flight', 'actionable', 'wait']);
      assert.equal(body.nextActionMeaning, disposition.NEXT_ACTIONS.wait);
    });

    it('a recipient that never opted in: configuration, enable wake', async () => {
      const body = await agedNotice(() => wake('wake_blocked', 'wake-not-opted-in', T0 + MIN));
      assert.deepEqual([body.blocker, body.class, body.nextAction], ['wake-not-opted-in', 'configuration', 'enable-wake']);
      assert.equal(body.nextActionMeaning, disposition.NEXT_ACTIONS['enable-wake']);
    });

    it('mail the monitor has not assessed: actionable, wait, under the exchange\'s own state as blocker', async () => {
      const body = await agedNotice(() => {});
      assert.deepEqual([body.blocker, body.class, body.nextAction], ['delivered', 'actionable', 'wait']);
    });

    it('a recipient that was nudged and has not read: nothing is being held', async () => {
      const body = await agedNotice(() => wake('wake_attempted', 'tmux', T0 + MIN));
      assert.deepEqual([body.class, body.nextAction], ['none', 'none']);
    });

    it('a wake waiting on a re-arm: actionable, wait, never classified by the word "rearmed"', async () => {
      const body = await agedNotice(() => wake('wake_pending', 'rearmed', T0 + MIN));
      assert.deepEqual([body.class, body.nextAction], ['actionable', 'wait']);
    });

    it('a nudge that was not accepted is re-armed at once, and reads as waiting on that re-arm', async () => {
      const body = await agedNotice(() => {
        wake('wake_attempted', 'tmux', T0 + MIN);
        wake('wake_not_accepted', 'nonce-still-in-composer', T0 + 2 * MIN);
      });
      assert.deepEqual([body.blocker, body.class, body.nextAction], ['rearmed', 'actionable', 'wait']);
    });

    it('a nudge that was not accepted is not a nudge: between re-arms, with budget left, it is actionable', async () => {
      // An hour between re-arms, so the second miss is still waiting when the message ages.
      watchdog._internal.loadConfig = () => ({ medusaWatchdog: { backoffMs: [60 * MIN] } });
      const x = pmToBuilder({});
      wake('wake_attempted', 'tmux', T0 + MIN);
      wake('wake_not_accepted', 'nonce-still-in-composer', T0 + 2 * MIN);
      await tickAt(T0 + 3 * MIN);
      assert.equal(row(x).rearm_count, 1);
      wake('wake_attempted', 'tmux', T0 + 4 * MIN);
      wake('wake_not_accepted', 'nonce-still-in-composer', T0 + 5 * MIN);
      await tickAt(T0 + 30 * MIN);
      assert.equal(row(x).state, 'wake_not_accepted');
      assert.equal(row(x).rearm_count, 1, 'the next re-arm is not due yet');
      assert.equal(sent.length, 1);
      assert.deepEqual([sent[0].body.blocker, sent[0].body.class, sent[0].body.nextAction], ['nonce-still-in-composer', 'actionable', 'wait']);
      assert.equal(activity.length, 0, 'and the operator is not told at the aged rung');
    });

    it('a nudge that was not accepted, with the re-arm budget spent, promises no retry and is the operator\'s at once', async () => {
      watchdog._internal.loadConfig = () => ({ medusaWatchdog: { maxRearms: 0 } });
      const x = pmToBuilder({});
      wake('wake_attempted', 'tmux', T0 + MIN);
      wake('wake_not_accepted', 'nonce-still-in-composer', T0 + 2 * MIN);
      await tickAt(T0 + 30 * MIN);
      assert.equal(row(x).state, 'wake_not_accepted');
      assert.equal(sent.length, 1);
      assert.deepEqual([sent[0].body.class, sent[0].body.nextAction], ['configuration', 'investigate']);
      assert.doesNotMatch(sent[0].body.nextActionMeaning, /retries by itself/);
      assert.equal(alerts(x)[0].code, 'configuration-hold');
      assert.deepEqual([detail(alerts(x)[0]).class, detail(alerts(x)[0]).nextAction], ['configuration', 'investigate']);
      assert.equal(activity.length, 1);
    });

    it('a spent re-arm budget says nothing about a wake the monitor is still holding', async () => {
      // The budget bounds re-arms of a nudge that missed. A held wake is retried by the monitor itself.
      watchdog._internal.loadConfig = () => ({ medusaWatchdog: { maxRearms: 0 } });
      const body = await agedNotice(() => wake('wake_blocked', 'pane-turn-in-flight', T0 + MIN));
      assert.deepEqual([body.blocker, body.class, body.nextAction], ['pane-turn-in-flight', 'actionable', 'wait']);
    });

    it('every notice says whether the message is unread or unanswered', async () => {
      const body = await agedNotice(() => wake('wake_blocked', 'pane-turn-in-flight', T0 + MIN));
      assert.equal(body.condition, 'unread');
    });

    it('acknowledged and still owed a reply: no wake is held, and it is visibly unanswered', async () => {
      const x = pmToBuilder({ replyRequired: true });
      clock = T0 + 2 * MIN;
      mx.recordAcknowledged(['hub-1'], 'builder-ws', { kind: 'project', projectId: builder.id });
      await tickAt(T0 + 31 * MIN);
      assert.equal(sent.length, 0, 'measured from the ack');
      await tickAt(T0 + 32 * MIN);
      assert.equal(sent.length, 1);
      assert.deepEqual([sent[0].body.condition, sent[0].body.class, sent[0].body.nextAction], ['unanswered', 'none', 'none']);
      // An hour after the ack it has merely waited too long, and the operator is told once.
      await tickAt(T0 + 62 * MIN);
      assert.equal(alerts(x).length, 1);
      assert.equal(alerts(x)[0].code, 'prolonged-unanswered', 'it was read: the operator is not told it was not');
      assert.deepEqual([detail(alerts(x)[0]).condition, detail(alerts(x)[0]).class], ['unanswered', 'none']);
      assert.equal(activity.length, 1);
      assert.deepEqual([activity[0].detail.reason, activity[0].detail.condition], ['prolonged-unanswered', 'unanswered']);
      const listed = watchdog.listEscalations(T0 + 62 * MIN).find((e) => e.exchangeId === x.exchange_id);
      assert.equal(listed.condition, 'unanswered', 'and the dashboard list says so too');
    });

    it('a reply-required message that has not been acknowledged is unread, not unanswered', async () => {
      const x = pmToBuilder({ replyRequired: true });
      wake('wake_blocked', 'pane-turn-in-flight', T0 + MIN);
      await tickAt(T0 + 30 * MIN);
      assert.equal(sent[0].body.condition, 'unread');
      assert.equal(row(x).esc_level, 'aged');
    });

    it('with the wake monitor stopped, no notice promises a retry', async () => {
      monitorRunning = false;
      const body = await agedNotice(() => wake('wake_blocked', 'pane-turn-in-flight', T0 + MIN));
      assert.deepEqual([body.class, body.nextAction], ['configuration', 'investigate']);
      assert.doesNotMatch(body.nextActionMeaning, /retries by itself/);
    });

    it('a stopped monitor changes nothing for a message that holds no wake: nudged stays none', async () => {
      monitorRunning = false;
      const x = pmToBuilder({});
      wake('wake_attempted', 'tmux', T0 + MIN);
      await tickAt(T0 + 30 * MIN);
      assert.deepEqual([sent[0].body.class, sent[0].body.nextAction], ['none', 'none']);
      assert.equal(activity.length, 0, 'and it is not a configuration hold');
      await tickAt(T0 + 60 * MIN);
      assert.equal(alerts(x)[0].code, 'prolonged-unread');
    });

    it('a stopped monitor does not turn an acknowledged, unanswered message into a configuration hold', async () => {
      monitorRunning = false;
      const x = pmToBuilder({ replyRequired: true });
      clock = T0 + 2 * MIN;
      mx.recordAcknowledged(['hub-1'], 'builder-ws', { kind: 'project', projectId: builder.id });
      await tickAt(T0 + 32 * MIN);
      assert.deepEqual([sent[0].body.condition, sent[0].body.class], ['unanswered', 'none']);
      assert.equal(alerts(x).length, 0);
    });

    it('a stopped monitor leaves a configuration hold what it is, with its own next action', async () => {
      monitorRunning = false;
      const body = await agedNotice(() => wake('wake_blocked', 'wake-not-opted-in', T0 + MIN));
      assert.deepEqual([body.class, body.nextAction], ['configuration', 'enable-wake']);
    });

    it('a monitor whose state cannot be read counts as stopped', async () => {
      watchdog._internal.monitorRunning = () => { throw new Error('no monitor'); };
      const body = await agedNotice(() => wake('wake_blocked', 'pane-turn-in-flight', T0 + MIN));
      assert.deepEqual([body.class, body.nextAction], ['configuration', 'investigate']);
    });

    it('blocking mail carries the same fields on each of its notices, and its ladder is unchanged', async () => {
      const x = pmToBuilder({ priority: 'blocking' });
      wake('wake_blocked', 'engine-thread-busy', T0 + MIN);
      await tickAt(T0 + 5 * MIN);
      await tickAt(T0 + 15 * MIN);
      await tickAt(T0 + 60 * MIN);
      assert.ok(sent.length >= 2);
      for (const n of sent) assert.deepEqual([n.body.class, n.body.nextAction], ['actionable', 'wait']);
      assert.equal(row(x).esc_level, 'operator');
      assert.equal(alerts(x).length, 1);
    });
  });

  describe('the exchange record\'s own wake codes are translated, never classified raw', () => {
    it('every code the record writes stands for a reason the classifier knows', () => {
      for (const [code, reason] of Object.entries(mx.EXCHANGE_WAKE_REASONS)) {
        assert.equal(disposition.classifyReason(reason).known, true, `${code} -> ${reason}`);
        assert.equal(mx.wakeReasonForCode(code), reason);
      }
      assert.equal(mx.wakeReasonForCode(null), 'not-observed');
      assert.equal(mx.wakeReasonForCode('pane-turn-in-flight'), 'pane-turn-in-flight', 'a monitor reason passes through');
      assert.deepEqual({ ...mx.EXCHANGE_WAKE_REASONS }, { 'rearmed': 'not-observed', 'awaiting-read': 'nudged' });
    });

    it('every wake code the exchange module writes itself is in the mapping', () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'medusa-exchanges.js'), 'utf8');
      const written = new Set();
      // The projection: `wake = { state: 'wake_…', code: '…' }`.
      for (const m of src.matchAll(/state:\s*'wake_\w+',\s*code:\s*'([^']+)'/g)) written.add(m[1]);
      // A direct write: `recordWakeForExchange(id, 'wake_…', '…')`.
      for (const m of src.matchAll(/recordWakeForExchange\([^,]+,\s*'wake_\w+',\s*'([^']+)'\)/g)) written.add(m[1]);
      assert.deepEqual([...written].sort(), Object.keys(mx.EXCHANGE_WAKE_REASONS).sort());
    });

    it('attempted, then blocked, then found already nudged: the aged notice says nothing is held', async () => {
      const x = pmToBuilder({});
      wake('wake_attempted', 'tmux', T0 + MIN);
      wake('wake_blocked', 'listener-reconnecting', T0 + 2 * MIN);
      clock = T0 + 3 * MIN;
      assert.equal(mx.noteAwaitingRead('builder-ws'), 1);
      assert.deepEqual([row(x).state, row(x).wake_code], ['wake_pending', 'awaiting-read']);
      await tickAt(T0 + 30 * MIN);
      assert.deepEqual([row(x).state, row(x).wake_code], ['wake_pending', 'awaiting-read'], 'the pass did not re-arm it');
      assert.equal(sent.length, 1);
      assert.deepEqual([sent[0].body.blocker, sent[0].body.class, sent[0].body.nextAction], ['awaiting-read', 'none', 'none']);
      assert.equal(alerts(x).length, 0, 'nudged and unread is not a configuration hold');
      await tickAt(T0 + 60 * MIN);
      assert.equal(alerts(x)[0].code, 'prolonged-unread');
      assert.equal(detail(alerts(x)[0]).class, 'none');
    });
  });

  describe('normal mail reaches the operator once, for a reason', () => {
    it('held by a configuration reason: alerted at the aged rung, as configuration-hold', async () => {
      const x = pmToBuilder({});
      wake('wake_blocked', 'wake-not-opted-in', T0 + MIN);
      await tickAt(T0 + 29 * MIN);
      assert.equal(row(x).esc_level, 'none');
      assert.equal(activity.length, 0);
      await tickAt(T0 + 30 * MIN);
      assert.equal(row(x).esc_level, 'operator');
      assert.equal(alerts(x).length, 1);
      assert.equal(alerts(x)[0].code, 'configuration-hold');
      assert.deepEqual(detail(alerts(x)[0]), {
        blocker: 'wake-not-opted-in', condition: 'unread', class: 'configuration', nextAction: 'enable-wake',
        nextActionMeaning: disposition.NEXT_ACTIONS['enable-wake'], why: 'configuration-hold'
      });
      assert.equal(activity.length, 1);
      assert.deepEqual(
        [activity[0].eventType, activity[0].detail.reason, activity[0].detail.class, activity[0].detail.nextAction, activity[0].projectId],
        ['medusa-escalation', 'configuration-hold', 'configuration', 'enable-wake', builder.id]
      );
    });

    it('merely waiting on a busy recipient: sender only until operatorNormalMs, then alerted once as prolonged-actionable', async () => {
      const x = pmToBuilder({});
      wake('wake_blocked', 'pane-turn-in-flight', T0 + MIN);
      await tickAt(T0 + 30 * MIN);
      await tickAt(T0 + 59 * MIN);
      assert.equal(row(x).esc_level, 'aged');
      assert.equal(activity.length, 0);
      await tickAt(T0 + 60 * MIN);
      assert.equal(alerts(x)[0].code, 'prolonged-actionable');
      assert.deepEqual([detail(alerts(x)[0]).class, detail(alerts(x)[0]).nextAction], ['actionable', 'wait'], 'the class stays what it truthfully is');
      assert.equal(activity.length, 1);
    });

    it('nudged and never read: alerted at operatorNormalMs as prolonged-unread', async () => {
      const x = pmToBuilder({});
      wake('wake_attempted', 'tmux', T0 + MIN);
      await tickAt(T0 + 30 * MIN);
      assert.equal(activity.length, 0);
      await tickAt(T0 + 60 * MIN);
      assert.equal(alerts(x)[0].code, 'prolonged-unread');
      assert.equal(detail(alerts(x)[0]).class, 'none');
    });

    it('held as engine-thread-unknown: alerted at the aged rung as stalled, and still classed actionable', async () => {
      const x = pmToBuilder({});
      wake('wake_blocked', 'engine-thread-unknown', T0 + MIN);
      await tickAt(T0 + 29 * MIN);
      assert.equal(activity.length, 0);
      await tickAt(T0 + 30 * MIN);
      assert.equal(alerts(x)[0].code, 'engine-thread-unknown-stalled');
      assert.deepEqual(
        [detail(alerts(x)[0]).blocker, detail(alerts(x)[0]).class, detail(alerts(x)[0]).nextAction],
        ['engine-thread-unknown', 'actionable', 'wait']
      );
      assert.equal(sent[0].body.class, 'actionable', 'the sender\'s notice is not falsified either');
    });

    it('a late flip to engine-thread-unknown is not a stall until it has held for the stall interval', async () => {
      const x = pmToBuilder({});
      wake('wake_blocked', 'pane-turn-in-flight', T0 + MIN);
      await tickAt(T0 + 30 * MIN);
      wake('wake_blocked', 'engine-thread-unknown', T0 + 35 * MIN);
      await tickAt(T0 + 36 * MIN);
      await tickAt(T0 + 44 * MIN);
      assert.equal(alerts(x).length, 0, 'nine minutes is not a stall');
      await tickAt(T0 + 45 * MIN);
      assert.equal(alerts(x)[0].code, 'engine-thread-unknown-stalled');
    });

    it('a brief flip to engine-thread-unknown that ends is never reported as a stall', async () => {
      const x = pmToBuilder({});
      wake('wake_blocked', 'pane-turn-in-flight', T0 + MIN);
      await tickAt(T0 + 30 * MIN);
      wake('wake_blocked', 'engine-thread-unknown', T0 + 35 * MIN);
      await tickAt(T0 + 36 * MIN);
      wake('wake_blocked', 'pane-turn-in-flight', T0 + 37 * MIN);
      await tickAt(T0 + 50 * MIN);
      assert.equal(alerts(x).length, 0);
      // And the count restarts if it comes back.
      wake('wake_blocked', 'engine-thread-unknown', T0 + 51 * MIN);
      await tickAt(T0 + 59 * MIN);
      assert.equal(alerts(x).length, 0);
      await tickAt(T0 + 60 * MIN);
      assert.equal(alerts(x)[0].code, 'prolonged-actionable', 'an hour of waiting is told as what it is');
    });

    it('a hold that becomes configuration after the aged rung is still alerted, on the pass that finds it', async () => {
      const x = pmToBuilder({});
      wake('wake_blocked', 'pane-turn-in-flight', T0 + MIN);
      await tickAt(T0 + 30 * MIN);
      assert.equal(row(x).esc_level, 'aged');
      wake('wake_blocked', 'engine-channel-absent', T0 + 40 * MIN);
      await tickAt(T0 + 41 * MIN);
      assert.equal(alerts(x)[0].code, 'configuration-hold');
      assert.equal(detail(alerts(x)[0]).blocker, 'engine-channel-absent');
      assert.equal(sent.length, 1, 'no second notice to the sender: an operator alert is not a turn');
    });

    it('a later change of class neither repeats the alert nor rewrites what it recorded', async () => {
      const x = pmToBuilder({});
      wake('wake_blocked', 'wake-not-opted-in', T0 + MIN);
      await tickAt(T0 + 30 * MIN);
      const recorded = JSON.stringify(alerts(x));
      wake('wake_blocked', 'pane-turn-in-flight', T0 + 35 * MIN);
      await tickAt(T0 + 36 * MIN);
      wake('wake_blocked', 'engine-thread-unknown', T0 + 50 * MIN);
      await tickAt(T0 + 24 * 60 * MIN);
      assert.equal(JSON.stringify(alerts(x)), recorded);
      assert.equal(activity.length, 1);
    });

    it('the operator threshold is never sooner than the aged rung, whatever the two are set to', async () => {
      watchdog._internal.loadConfig = () => ({ medusaWatchdog: { agedNormalMs: 90 * MIN, operatorNormalMs: 10 * MIN } });
      const x = pmToBuilder({});
      wake('wake_blocked', 'pane-turn-in-flight', T0 + MIN);
      await tickAt(T0 + 89 * MIN);
      assert.equal(row(x).esc_level, 'none');
      assert.equal(activity.length, 0);
      await tickAt(T0 + 90 * MIN);
      assert.equal(alerts(x)[0].code, 'prolonged-actionable');
      assert.equal(sent.length, 1, 'the sender was told on the same pass');
    });

    it('operatorNormalMs is a bounded setting with a default of an hour', () => {
      assert.equal(watchdog.DEFAULTS.operatorNormalMs, 60 * MIN);
      assert.deepEqual(watchdog.BOUNDS.operatorNormalMs, [5 * MIN, 48 * 60 * MIN]);
      assert.match(watchdog.validatePatch({ operatorNormalMs: MIN }, {}).error, /operatorNormalMs/);
      assert.match(watchdog.validatePatch({ operatorNormalMs: 49 * 60 * MIN }, {}).error, /operatorNormalMs/);
      assert.deepEqual(watchdog.validatePatch({ operatorNormalMs: 2 * 60 * MIN }, {}).value, { operatorNormalMs: 2 * 60 * MIN });
    });
  });

  describe('nobody is told about a hold that is over', () => {
    it('mail read before the aged rung ages nothing and alerts nobody', async () => {
      const x = pmToBuilder({});
      wake('wake_blocked', 'wake-not-opted-in', T0 + MIN);
      clock = T0 + 10 * MIN;
      mx.recordAcknowledged(['hub-1'], 'builder-ws', { kind: 'project', projectId: builder.id });
      await tickAt(T0 + 24 * 60 * MIN);
      assert.equal(alerts(x).length, 0);
      assert.equal(activity.length, 0);
      assert.equal(sent.length, 0);
    });

    it('an exchange that ended never ages afterwards', async () => {
      const x = pmToBuilder({});
      wake('wake_blocked', 'wake-not-opted-in', T0 + MIN);
      clock = T0 + 5 * MIN;
      await watchdog.retireRecipient('builder-ws');
      assert.equal(row(x).state, 'recipient_retired');
      const before = facts(x).length;
      sent.length = 0;
      await tickAt(T0 + 24 * 60 * MIN);
      assert.equal(facts(x).length, before);
      assert.equal(alerts(x).length, 0);
      assert.equal(activity.length, 0);
      assert.equal(sent.length, 0);
    });
  });

  describe('exactly one fact and one activity row', () => {
    it('repeated scans add nothing', async () => {
      const x = pmToBuilder({});
      wake('wake_blocked', 'wake-not-opted-in', T0 + MIN);
      for (let m = 30; m <= 300; m += 10) await tickAt(T0 + m * MIN);
      assert.equal(alerts(x).length, 1);
      assert.equal(activity.length, 1);
      assert.equal(sent.length, 1);
    });

    it('a restart adds nothing: a watchdog with no memory reads the same record', async () => {
      const x = pmToBuilder({});
      wake('wake_blocked', 'wake-not-opted-in', T0 + MIN);
      await tickAt(T0 + 30 * MIN);
      watchdog.stop();
      store.close();
      store._setBasePath(tmpDir);
      store.init();
      await tickAt(T0 + 31 * MIN);
      await tickAt(T0 + 120 * MIN);
      assert.equal(alerts(x).length, 1);
      assert.equal(activity.length, 1);
    });

    it('two passes holding the same stale row record one fact and write one activity row', async () => {
      const x = pmToBuilder({});
      wake('wake_blocked', 'wake-not-opted-in', T0 + MIN);
      // Both passes read the exchange before either has aged it.
      const stale = row(x);
      clock = T0 + 30 * MIN;
      const first = mx.recordEscalationFactOnce(stale.exchange_id, 'operator_alerted', { code: 'configuration-hold', onRecorded: () => activity.push({ by: 'first' }) });
      const second = mx.recordEscalationFactOnce(stale.exchange_id, 'operator_alerted', { code: 'configuration-hold', onRecorded: () => activity.push({ by: 'second' }) });
      assert.deepEqual([first.recorded, second.recorded], [true, false]);
      assert.equal(alerts(x).length, 1);
      assert.deepEqual(activity, [{ by: 'first' }]);
      // And the watchdog itself, coming along after, adds neither.
      await tickAt(T0 + 31 * MIN);
      await tickAt(T0 + 200 * MIN);
      assert.equal(alerts(x).length, 1);
      assert.equal(activity.length, 1);
    });

    it('an activity row that cannot be written leaves no fact, and the next pass records both', async () => {
      const x = pmToBuilder({});
      wake('wake_blocked', 'wake-not-opted-in', T0 + MIN);
      let fail = true;
      watchdog._internal.logActivity = (e) => { if (fail) throw new Error('activity store locked'); activity.push(e); };
      await tickAt(T0 + 30 * MIN);
      assert.equal(alerts(x).length, 0, 'no fact without its activity row');
      assert.equal(row(x).esc_level, 'aged');
      fail = false;
      await tickAt(T0 + 31 * MIN);
      assert.equal(alerts(x).length, 1);
      assert.equal(activity.length, 1);
      await tickAt(T0 + 32 * MIN);
      assert.equal(activity.length, 1);
    });

    it('against the real activity store: a refused row takes the fact back, and the next pass records both', async () => {
      watchdog._internal.logActivity = saved.logActivity;
      const rows = () => store.activity.query({ eventType: 'medusa-escalation' });
      const x = pmToBuilder({});
      wake('wake_blocked', 'wake-not-opted-in', T0 + MIN);
      const db = store.getDb();
      db.exec("CREATE TRIGGER refuse_activity BEFORE INSERT ON activity_log BEGIN SELECT RAISE(ABORT, 'activity refused'); END;");
      await tickAt(T0 + 30 * MIN);
      assert.equal(alerts(x).length, 0, 'no fact without its activity row');
      assert.equal(row(x).esc_level, 'aged');
      assert.equal(rows().length, 0);
      db.exec('DROP TRIGGER refuse_activity;');
      await tickAt(T0 + 31 * MIN);
      await tickAt(T0 + 32 * MIN);
      assert.equal(alerts(x).length, 1);
      assert.equal(rows().length, 1);
      assert.deepEqual(
        [rows()[0].projectId, rows()[0].detail.exchangeId, rows()[0].detail.reason, rows()[0].detail.condition],
        [builder.id, x.exchange_id, 'configuration-hold', 'unread']
      );
    });

    it('against the real activity store: a failed trim after the insert takes the row and the fact back', async () => {
      watchdog._internal.logActivity = saved.logActivity;
      const rows = () => store.activity.query({ eventType: 'medusa-escalation' });
      const x = pmToBuilder({});
      wake('wake_blocked', 'wake-not-opted-in', T0 + MIN);
      const db = store.getDb();
      // One earlier row and a cap of one, so the alert's insert makes the trim delete.
      store.activity.log({ eventType: 'medusa-escalation', detail: { earlier: true } });
      store._setActivityLogRetention(1);
      db.exec("CREATE TRIGGER refuse_trim BEFORE DELETE ON activity_log BEGIN SELECT RAISE(ABORT, 'trim refused'); END;");
      await tickAt(T0 + 30 * MIN);
      assert.equal(alerts(x).length, 0);
      assert.equal(rows().filter((r) => r.detail.exchangeId === x.exchange_id).length, 0, 'the inserted row went with it');
      db.exec('DROP TRIGGER refuse_trim;');
      await tickAt(T0 + 31 * MIN);
      assert.equal(alerts(x).length, 1);
      assert.equal(rows().filter((r) => r.detail.exchangeId === x.exchange_id).length, 1);
    });

    it('a recipient project that no longer exists does not stop the alert: the row is filed without it', async () => {
      watchdog._internal.logActivity = saved.logActivity;
      const caller = { kind: 'project', projectId: pm.id };
      const x = mx.createSendIntent({
        meta: mx.validateSendMeta({}, caller, pm.id),
        sender: { projectId: pm.id, workspaceId: 'pm-ws' },
        recipient: { workspaceId: 'gone-ws', projectId: 987654, sessionId: 2 }
      });
      mx.bindHubId(x.exchange_id, 'hub-gone');
      mx.recordArrival({ hubId: 'hub-gone', recipientWorkspaceId: 'gone-ws' });
      clock = T0 + MIN;
      mx.recordWakeForRecipient('gone-ws', 'wake_blocked', { code: 'wake-not-opted-in' });
      await tickAt(T0 + 30 * MIN);
      assert.equal(alerts(x).length, 1);
      const rows = store.activity.query({ eventType: 'medusa-escalation' });
      assert.deepEqual([rows.length, rows[0].projectId, rows[0].detail.exchangeId], [1, null, x.exchange_id]);
    });

    it('blocking mail writes one activity row too, however many passes follow', async () => {
      const x = pmToBuilder({ priority: 'blocking' });
      for (let m = 5; m <= 300; m += 5) await tickAt(T0 + m * MIN);
      assert.equal(alerts(x).length, 1);
      assert.equal(activity.length, 1);
    });
  });

  describe('a failed notice does not cost the operator alert', () => {
    it('the sender\'s notice fails and is recorded failed; the configuration alert still stands, once', async () => {
      const x = pmToBuilder({});
      wake('wake_blocked', 'wake-not-opted-in', T0 + MIN);
      failNext = true;
      await tickAt(T0 + 30 * MIN);
      const kinds = facts(x).map((f) => f.fact);
      assert.ok(kinds.includes('escalation_failed'));
      assert.equal(alerts(x).length, 1);
      assert.equal(activity.length, 1);
      failNext = false;
      await tickAt(T0 + 40 * MIN);
      assert.equal(sent.length, 0, 'the aged notice is not sent again');
      assert.equal(activity.length, 1);
    });

    it('a sender with no live session is recorded undeliverable; the alert still stands', async () => {
      workspaces = {};
      const x = pmToBuilder({});
      wake('wake_blocked', 'wake-not-opted-in', T0 + MIN);
      await tickAt(T0 + 30 * MIN);
      assert.ok(facts(x).some((f) => f.fact === 'escalation_undeliverable'));
      assert.equal(alerts(x).length, 1);
      assert.equal(activity.length, 1);
    });
  });

  describe('what is left alone', () => {
    it('an untracked exchange is not on the ladder: this host cannot supervise it', async () => {
      const caller = { kind: 'project', projectId: pm.id };
      const x = mx.createSendIntent({
        meta: mx.validateSendMeta({}, caller, pm.id),
        sender: { projectId: pm.id, workspaceId: 'pm-ws' },
        recipient: { workspaceId: 'someone-elsewhere' },
        tracking: 'untracked'
      });
      await tickAt(T0 + 24 * 60 * MIN);
      assert.deepEqual(facts(x).map((f) => f.fact).filter((f) => f === 'aged' || f === 'operator_alerted'), []);
      assert.equal(activity.length, 0);
      assert.equal(sent.length, 0);
    });

    it('the sender is told once per rung and never again: an operator alert sends no message', async () => {
      const x = pmToBuilder({});
      wake('wake_blocked', 'pane-turn-in-flight', T0 + MIN);
      for (let m = 30; m <= 600; m += 30) await tickAt(T0 + m * MIN);
      assert.equal(alerts(x).length, 1);
      assert.deepEqual(sent.map((n) => [n.to, n.body.level]), [['pm-ws-live', 'aged']]);
    });
  });
});
