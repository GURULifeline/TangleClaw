'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const bundle = require('../lib/soak/bundle');
const driver = require('../lib/soak/driver');
const sched = require('../lib/soak/schedule');
const integrity = require('../lib/soak/integrity');

const MIN = 60 * 1000;

let dir;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soak-bundle-'))); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/**
 * Run a short api schedule to completion with executors that fail every
 * third event, and write the schedule beside the log.
 * @returns {Promise<{schedule: object, schedulePath: string, logPath: string}>} Paths
 */
async function finishedRun() {
  const schedule = sched.buildSchedule({ seed: 'bundle', phase: 'certifying', durationMs: 10 * MIN, loadMeanMs: MIN, classes: ['api'] });
  const schedulePath = path.join(dir, 'schedule.json');
  fs.writeFileSync(schedulePath, JSON.stringify(schedule));
  const logPath = path.join(dir, 'soak.ndjson');
  let n = 0;
  const executors = {};
  for (const t of sched.TASKS.filter((k) => k.class === 'api')) {
    executors[t.kind] = async () => (n++ % 3 === 2 ? { ok: false, code: 'HTTP_STATUS', status: 500 } : { ok: true, code: 'OK', status: 200 });
  }
  let t = 1_790_000_000_000;
  await driver.runSchedule({ schedule, executors, ctx: {}, logPath, clock: { now: () => t, sleep: async (ms) => { t += ms; } } });
  return { schedule, schedulePath, logPath };
}

/**
 * The sha256 of a file.
 * @param {string} p - File
 * @returns {string} Hex digest
 */
function sha(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

describe('soak bundle — a finished run', () => {
  it('copies every input owner-only and binds each in the manifest', async () => {
    const run = await finishedRun();
    const samples = path.join(dir, 'samples.ndjson');
    integrity.appendSample(samples, { type: 'header', schema: integrity.SAMPLES_SCHEMA, home: '/h' });
    integrity.appendSample(samples, { type: 'sample', seq: 0, at: 1, db: { check: 'integrity_check', state: 'ok', bytes: 10 }, process: { pid: 1, alive: true, rssKb: 100, openFds: 20 }, disk: { freeBytes: 500, totalBytes: 1000 }, health: { status: 200 } });
    integrity.appendSample(samples, { type: 'sample', seq: 1, at: 2, db: { check: 'quick_check', state: 'corrupt', bytes: 10 }, process: { pid: 1, alive: true, rssKb: 300, openFds: 25 }, disk: { freeBytes: 200, totalBytes: 1000 }, health: { status: 503 } });
    const attest = path.join(dir, 'admin.json');
    fs.writeFileSync(attest, '{"ok":true}\n');
    const out = path.join(dir, 'evidence');

    const r = bundle.buildBundle({ out, schedule: run.schedulePath, log: run.logPath, samples, attestations: [attest], now: () => 42 });
    assert.equal(fs.statSync(out).mode & 0o777, 0o700);
    const manifest = JSON.parse(fs.readFileSync(r.manifest, 'utf8'));
    assert.equal(manifest.schema, bundle.MANIFEST_SCHEMA);
    assert.equal(manifest.createdAt, 42);
    assert.deepEqual(manifest.files.map((f) => f.path), ['schedule.json', 'soak-log.ndjson', 'samples.ndjson', path.join('attestations', 'admin.json')]);
    for (const f of manifest.files) {
      const p = path.join(out, f.path);
      assert.equal(f.sha256, sha(p), f.path);
      assert.equal(f.bytes, fs.statSync(p).size, f.path);
      assert.equal(fs.statSync(p).mode & 0o777, 0o600, f.path);
    }
    assert.equal(sha(path.join(out, 'soak-log.ndjson')), sha(run.logPath), 'the log is copied byte for byte');
    assert.equal(r.manifestSha256, sha(r.manifest));

    const s = manifest.summary;
    assert.deepEqual([s.schedule.valid, s.schedule.digest, s.schedule.phase], [true, run.schedule.digest, 'certifying']);
    assert.deepEqual([s.log.readable, s.log.scheduleMatches, s.log.completed, s.log.certification.automaticPassAllowed], [true, true, true, true]);
    const ran = Object.values(s.log.byKind).reduce((a, k) => a + k.ran, 0);
    const failed = Object.values(s.log.byKind).reduce((a, k) => a + k.failed, 0);
    assert.equal(ran, run.schedule.events.length);
    assert.equal(failed, Math.floor(run.schedule.events.length / 3));
    assert.deepEqual(s.samples.db, { ok: 1, corrupt: 1, unavailable: 0, firstCorrupt: { seq: 1, at: 2, check: 'quick_check' } });
    assert.deepEqual([s.samples.rssKb, s.samples.openFdsMax, s.samples.freeBytesMin, s.samples.healthNot200], [{ min: 100, max: 300 }, 25, 200, 1]);
    assert.equal(s.dbSnapshot, null);
  });

  it('snapshots the guest database and checks the copy', async () => {
    const run = await finishedRun();
    const home = path.join(dir, 'home');
    fs.mkdirSync(home);
    const db = new DatabaseSync(path.join(home, 'tangleclaw.db'));
    db.exec('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (7);');
    db.close();
    const out = path.join(dir, 'evidence');
    const r = bundle.buildBundle({ out, schedule: run.schedulePath, log: run.logPath, home });
    const snap = path.join(out, 'db', 'tangleclaw.db');
    const copy = new DatabaseSync(snap, { readOnly: true });
    assert.deepEqual(copy.prepare('SELECT v FROM t').all().map((x) => x.v), [7]);
    copy.close();
    assert.equal(r.summary.dbSnapshot.state, 'ok');
    assert.equal(r.summary.dbSnapshot.check, 'integrity_check');
    const manifest = JSON.parse(fs.readFileSync(r.manifest, 'utf8'));
    assert.equal(manifest.files.find((f) => f.path === path.join('db', 'tangleclaw.db')).sha256, sha(snap));
  });
});

describe('soak bundle — a run that is not evidence', () => {
  it('still bundles a log the driver refuses, with the refusal and its sidecar', async () => {
    const run = await finishedRun();
    fs.writeFileSync(driver.lockLostPath(run.logPath), 'damaged sidecar');
    const out = path.join(dir, 'evidence');
    const r = bundle.buildBundle({ out, schedule: run.schedulePath, log: run.logPath });
    assert.equal(r.summary.log.readable, false);
    assert.equal(r.summary.log.refusal.code, driver.REFUSAL.LOG_LOCK_LOST_INVALID);
    assert.ok(fs.existsSync(path.join(out, 'soak-log.ndjson.lock-lost')));
  });

  it('records a log that belongs to another schedule', async () => {
    const run = await finishedRun();
    const other = sched.buildSchedule({ seed: 'other', phase: 'certifying', durationMs: 10 * MIN, loadMeanMs: MIN, classes: ['api'] });
    fs.writeFileSync(run.schedulePath, JSON.stringify(other));
    const r = bundle.buildBundle({ out: path.join(dir, 'e'), schedule: run.schedulePath, log: run.logPath });
    assert.equal(r.summary.log.scheduleMatches, false);
  });

  it('records samples it could not read, and still copies them', async () => {
    const run = await finishedRun();
    const samples = path.join(dir, 'samples.ndjson');
    fs.writeFileSync(samples, '{"type":"header"}\nnot json\n');
    const r = bundle.buildBundle({ out: path.join(dir, 'e'), schedule: run.schedulePath, log: run.logPath, samples });
    assert.match(r.summary.samples.unreadable, /line 2/);
    assert.ok(fs.existsSync(path.join(dir, 'e', 'samples.ndjson')));
  });
});

describe('soak bundle — refusals', () => {
  it('never writes into an existing directory', async () => {
    const run = await finishedRun();
    const out = path.join(dir, 'evidence');
    fs.mkdirSync(out);
    assert.throws(() => bundle.buildBundle({ out, schedule: run.schedulePath, log: run.logPath }), (e) => e.code === 'BUNDLE_REFUSED');
    assert.deepEqual(fs.readdirSync(out), []);
  });

  it('refuses a relative output, a missing input, a symlinked input, and clashing attestation names', async () => {
    const run = await finishedRun();
    const out = path.join(dir, 'evidence');
    assert.throws(() => bundle.buildBundle({ out: 'rel', schedule: run.schedulePath, log: run.logPath }), (e) => e.code === 'BUNDLE_REFUSED');
    assert.throws(() => bundle.buildBundle({ out, schedule: run.schedulePath, log: path.join(dir, 'nope') }), /does not exist/);
    const link = path.join(dir, 'link.ndjson');
    fs.symlinkSync(run.logPath, link);
    assert.throws(() => bundle.buildBundle({ out, schedule: run.schedulePath, log: link }), /not a regular file/);
    fs.mkdirSync(path.join(dir, 'a'));
    fs.mkdirSync(path.join(dir, 'b'));
    fs.writeFileSync(path.join(dir, 'a', 'x.json'), '1');
    fs.writeFileSync(path.join(dir, 'b', 'x.json'), '2');
    assert.throws(() => bundle.buildBundle({ out, schedule: run.schedulePath, log: run.logPath, attestations: [path.join(dir, 'a', 'x.json'), path.join(dir, 'b', 'x.json')] }), /share a file name/);
    assert.equal(fs.existsSync(out), false, 'a refusal writes nothing');
  });

  it('refuses a schedule that is not JSON', async () => {
    const run = await finishedRun();
    fs.writeFileSync(run.schedulePath, 'nope');
    assert.throws(() => bundle.buildBundle({ out: path.join(dir, 'e'), schedule: run.schedulePath, log: run.logPath }), /not JSON/);
  });
});
