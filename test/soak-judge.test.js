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
const integrity = require('../lib/soak/integrity');
const judge = require('../lib/soak/judge');
const sched = require('../lib/soak/schedule');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
/** The sampler's interval in these fixtures. */
const SAMPLE_MS = 10 * MIN;
const T0 = 1_790_000_000_000;
const CAND = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';

let dir;
beforeEach(() => { dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soak-judge-'))); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/**
 * The sha256 of a file.
 * @param {string} p - File
 * @returns {string} Hex digest
 */
function sha(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

/**
 * Run a 72-hour certifying api schedule to completion from T0 on a fake
 * clock, every event succeeding. An hourly load mean keeps it to about 70
 * events.
 * @param {object} [opts] - `{phase, durationMs, seed, outcome, reclaimed, tornEvent}`: the schedule's phase, length and seed; `outcome(n)` gives the n-th event's result; `reclaimed` leaves the run crashed after two events, its lock and open segment naming a dead owner, and resumes it, which the driver records as ownership-unverified; `tornEvent` also makes that crash lose only the second event's final newline, so the resume seals a whole record and runs the event again
 * @returns {Promise<{schedule: object, schedulePath: string, logPath: string, startedAt: number, completedAt: number}>} The run
 */
async function finishedRun(opts = {}) {
  const schedule = sched.buildSchedule({ seed: opts.seed || 'judge', phase: opts.phase || 'certifying', durationMs: opts.durationMs || 72 * HOUR, loadMeanMs: HOUR, classes: ['api'] });
  const schedulePath = path.join(dir, 'schedule.json');
  fs.writeFileSync(schedulePath, JSON.stringify(schedule));
  const logPath = path.join(dir, 'soak.ndjson');
  let n = 0;
  const executors = {};
  for (const t of sched.TASKS.filter((k) => k.class === 'api')) {
    executors[t.kind] = async () => (opts.outcome ? opts.outcome(n++) : { ok: true, code: 'OK', status: 200 });
  }
  let t = T0;
  const clock = { now: () => t, sleep: async (ms) => { t += ms; } };
  // A coarse stop poll keeps the wait to the schedule's horizon cheap here.
  const stopPollMs = HOUR;
  if (opts.reclaimed) {
    const events = () => fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').split('\n').filter((l) => l.includes('"type":"event"')).length : 0;
    await driver.runSchedule({ schedule, executors, ctx: {}, logPath, clock, stopPollMs, shouldStop: () => events() >= 2 });
    if (opts.tornEvent) {
      // A crash, not a stop: no stop record, and the last event's write lost
      // only its newline.
      const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
      assert.equal(JSON.parse(lines.at(-1)).type, 'stop');
      fs.writeFileSync(logPath, lines.slice(0, -1).join('\n'));
      fs.rmSync(driver.segmentPath(logPath), { force: true });
    }
    const owner = { pid: require('node:child_process').spawnSync(process.execPath, ['-e', '0']).pid, host: os.hostname() };
    driver.openSegment(logPath, owner, t);
    fs.writeFileSync(`${logPath}.lock`, JSON.stringify(owner));
  }
  const result = await driver.runSchedule({ schedule, executors, ctx: {}, logPath, clock, stopPollMs });
  assert.equal(result.status, opts.reclaimed ? 'completed-ownership-unverified' : 'completed');
  const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { schedule, schedulePath, logPath, startedAt: lines[0].startEpochMs, completedAt: lines.at(-1).completedAt };
}

/**
 * Write a samples file covering [from, to] every SAMPLE_MS, all healthy
 * unless `edit` changes a record.
 * @param {number} from - First sample time
 * @param {number} to - Last sample time
 * @param {function(object, number): object} [edit] - Rewrites the i-th sample
 * @returns {string} The file
 */
function samplesFile(from, to, edit = (x) => x) {
  const file = path.join(dir, 'samples.ndjson');
  // Written in one go, in the sampler's format: one JSON record per line.
  const records = [{ type: 'header', schema: integrity.SAMPLES_SCHEMA, home: '/h', intervalMs: SAMPLE_MS }];
  let i = 0;
  for (let at = from; at <= to; at += SAMPLE_MS, i++) {
    records.push(edit({ type: 'sample', seq: i, at, db: { check: 'quick_check', state: 'ok', bytes: 10 }, process: { pid: 1, alive: true, rssKb: 100, openFds: 20 }, disk: { freeBytes: 500, totalBytes: 1000 }, health: { status: 200 } }, i));
  }
  fs.writeFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(''), { mode: 0o600 });
  return file;
}

/**
 * A guest home holding a sound database.
 * @returns {string} The home
 */
function home() {
  const h = path.join(dir, 'home');
  fs.mkdirSync(h);
  const db = new DatabaseSync(path.join(h, 'tangleclaw.db'));
  db.exec('CREATE TABLE t (v INTEGER); INSERT INTO t VALUES (7);');
  db.close();
  return h;
}

/**
 * A complete, passing bundle and the certification run it is judged for.
 * @param {object} [opts] - `finishedRun` options, and `{candidateSha, samples: false, db: false, edit}`
 * @returns {Promise<{out: string, run: object, soak: object}>} The bundle, the run identity and the soak run
 */
async function passingBundle(opts = {}) {
  const soak = await finishedRun(opts);
  const samples = opts.samples === false ? undefined : samplesFile(soak.startedAt, soak.completedAt, opts.edit);
  const out = path.join(dir, 'evidence');
  bundle.buildBundle({ candidateSha: opts.candidateSha || CAND, out, schedule: soak.schedulePath, log: soak.logPath, samples, home: opts.db === false ? undefined : home() });
  const run = { candidateSha: CAND, runId: 'a'.repeat(32), manifestDigest: 'b'.repeat(64), startedAt: soak.startedAt - MIN, updatedAt: soak.completedAt + MIN };
  assert.ok(soak.completedAt - soak.startedAt >= soak.schedule.params.durationMs, 'the fixture ran to its horizon');
  return { out, run, soak };
}

/**
 * The reason codes of a judgement.
 * @param {object} j - Judgement
 * @returns {string[]} Codes
 */
function codes(j) {
  return j.reasons.map((r) => r.code);
}

/**
 * A disposition proposal for a judgement's reviewable findings, as an
 * Operator would write it from the judge's own output: bound to the bundle
 * and run the judgement names, with one entry per finding. Each event entry
 * cites the bundled log as its evidence.
 * @param {object} j - A judgement with reviewable findings
 * @param {function(object): void} [edit] - Mutates the proposal before it is serialized
 * @returns {Buffer} The proposal file's bytes
 */
function proposal(j, edit = () => {}) {
  const b = j.binding;
  const issue = { repo: 'Jason-Vaughan/TangleClaw', number: 1949 };
  const d = {
    schema: judge.DISPOSITION_SCHEMA, candidateSha: b.candidateSha, runId: b.runId, bundleManifestSha256: b.bundleManifestSha256,
    scheduleDigest: b.scheduleDigest, logSha256: b.logSha256, logBytes: b.logBytes,
    events: j.findings.filter((f) => f.type === 'event').map((f) => ({
      index: f.index, kind: f.kind, eventCode: f.eventCode, classification: 'harness', rationale: 'the stub hub dropped the request',
      evidence: [{ path: 'soak-log.ndjson', sha256: b.logSha256 }], trackingIssue: issue
    }))
  };
  const own = j.findings.find((f) => f.type === 'ownership');
  if (own) d.ownership = { logPath: own.logPath, logBytes: own.logBytes, logSha256: own.logSha256, rationale: 'the host was power-cycled; the resumed run is the same soak', trackingIssue: issue };
  edit(d);
  return Buffer.from(`${JSON.stringify(d, null, 2)}\n`);
}

/**
 * Rewrite the bundled log's records and re-bind it, as a forger would.
 * @param {string} out - Bundle
 * @param {function(object[]): object[]} edit - Maps the records
 * @returns {void}
 */
function editLog(out, edit) {
  const lines = fs.readFileSync(path.join(out, 'soak-log.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  forge(out, 'soak-log.ndjson', `${edit(lines).map((l) => JSON.stringify(l)).join('\n')}\n`);
}

/** An event outcome that failed. */
const FAILED = { ok: false, code: 'HTTP_STATUS', status: 502 };
/** An event outcome that succeeded. */
const OK = { ok: true, code: 'OK', status: 200 };

/**
 * Rewrite the bundle's manifest, keeping its file list consistent.
 * @param {string} out - Bundle
 * @param {function(object): void} edit - Mutates the manifest
 * @returns {void}
 */
function editManifest(out, edit) {
  const p = path.join(out, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(p, 'utf8'));
  edit(m);
  fs.writeFileSync(p, JSON.stringify(m));
}

/**
 * Replace a bundled file and re-bind it in the manifest, as someone forging a
 * consistent bundle would.
 * @param {string} out - Bundle
 * @param {string} rel - Bundled path
 * @param {string|Buffer} content - New content
 * @returns {void}
 */
function forge(out, rel, content) {
  fs.writeFileSync(path.join(out, rel), content);
  editManifest(out, (m) => {
    const f = m.files.find((x) => x.path === rel);
    f.bytes = fs.statSync(path.join(out, rel)).size;
    f.sha256 = sha(path.join(out, rel));
  });
}

describe('soak judge — a passing bundle', () => {
  it('passes, and binds every digest it vouches for to the run', async () => {
    const { out, run, soak } = await passingBundle();
    const j = judge.judgeBundle({ bundleDir: out, run });
    assert.deepEqual([j.verdict, j.reasons, j.findings, j.disposition], ['pass', [], [], null]);
    assert.equal(j.schema, judge.JUDGEMENT_SCHEMA);
    assert.deepEqual(j.binding, {
      candidateSha: CAND, runId: run.runId, manifestDigest: run.manifestDigest,
      bundleManifestSha256: sha(path.join(out, 'manifest.json')), bundleCandidateSha: CAND,
      scheduleDigest: soak.schedule.digest, logBytes: fs.statSync(soak.logPath).size, logSha256: sha(soak.logPath),
      soakStartedAt: soak.startedAt, soakCompletedAt: soak.completedAt, ownershipVerified: true
    });
  });

  it('tolerates a sample that failed or could not measure, while coverage still holds', async () => {
    const { out, run } = await passingBundle({ edit: (x, i) => {
      if (i === 2) return { type: 'sample-failed', seq: x.seq, at: x.at, error: 'EIO' };
      if (i === 4) return { ...x, db: { check: 'quick_check', state: 'unavailable', error: 'locked' } };
      if (i === 6) return { ...x, process: { pid: 1, alive: null, reason: 'ps timed out' } };
      return x;
    } });
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run })), []);
  });
});

describe('soak judge — the bundle itself (fail closed)', () => {
  it('refuses a missing or unparsable manifest, and judges nothing else', async () => {
    const { out, run } = await passingBundle();
    fs.writeFileSync(path.join(out, 'manifest.json'), '{nope');
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run })), ['MANIFEST_INVALID']);
    fs.rmSync(path.join(out, 'manifest.json'));
    const j = judge.judgeBundle({ bundleDir: out, run });
    assert.deepEqual([codes(j), j.verdict], [['MANIFEST_MISSING'], 'fail']);
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: path.join(dir, 'absent'), run })), ['MANIFEST_MISSING']);
  });

  it('refuses a manifest of another schema, or with a file entry outside the bundle', async () => {
    const { out, run } = await passingBundle();
    editManifest(out, (m) => { m.schema = 'tc.soak-evidence/v0'; });
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run })), ['MANIFEST_INVALID']);
    for (const bad of ['../x', '/etc/passwd', 'a/../schedule.json', 'manifest.json']) {
      const again = await (async () => { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir); return passingBundle(); })();
      editManifest(again.out, (m) => { m.files.push({ path: bad, bytes: 1, sha256: 'c'.repeat(64) }); });
      assert.deepEqual(codes(judge.judgeBundle({ bundleDir: again.out, run: again.run })), ['MANIFEST_INVALID'], bad);
    }
  });

  it('refuses a bundled file whose bytes differ from the manifest', async () => {
    const { out, run } = await passingBundle();
    fs.appendFileSync(path.join(out, 'samples.ndjson'), '');
    const logFile = path.join(out, 'soak-log.ndjson');
    const bytes = fs.readFileSync(logFile);
    bytes[10] = bytes[10] ^ 1;
    fs.writeFileSync(logFile, bytes);
    assert.deepEqual(judge.judgeBundle({ bundleDir: out, run }).reasons, [{ file: 'soak-log.ndjson', code: 'FILE_MISMATCH', class: 'terminal' }]);
  });

  it('refuses a listed file that is missing or a symlink, and a file the manifest does not list', async () => {
    const { out, run } = await passingBundle();
    fs.rmSync(path.join(out, 'samples.ndjson'));
    fs.symlinkSync(path.join(dir, 'samples.ndjson'), path.join(out, 'samples.ndjson'));
    fs.writeFileSync(path.join(out, 'soak-log.ndjson.segment'), '{}\n');
    const j = judge.judgeBundle({ bundleDir: out, run });
    assert.deepEqual(j.reasons, [{ file: 'samples.ndjson', code: 'FILE_MISSING', class: 'terminal' }, { file: 'soak-log.ndjson.segment', code: 'FILE_UNLISTED', class: 'terminal' }]);
    assert.equal(j.binding.bundleManifestSha256, null, 'an untrusted bundle binds nothing');
  });
});

describe('soak judge — a damaged bundle is a reason, never a crash', () => {
  it('refuses a bundle whose manifest does not list the log or the schedule, even with a directory in its place', async () => {
    for (const rel of ['soak-log.ndjson', 'schedule.json']) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir);
      const { out, run } = await passingBundle();
      fs.rmSync(path.join(out, rel));
      fs.mkdirSync(path.join(out, rel));
      editManifest(out, (m) => { m.files = m.files.filter((f) => f.path !== rel); });
      assert.deepEqual(judge.judgeBundle({ bundleDir: out, run }).reasons, [{ file: rel, code: 'FILE_MISSING', class: 'terminal' }], rel);
    }
  });

  it('refuses samples with a line that is JSON but not a record', async () => {
    const { out, run } = await passingBundle();
    forge(out, 'samples.ndjson', `${fs.readFileSync(path.join(out, 'samples.ndjson'), 'utf8')}null\n`);
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run })), ['SAMPLES_UNREADABLE']);
  });
});

describe('soak judge — the candidate (A5)', () => {
  it('refuses a bundle naming another candidate', async () => {
    const { out, run } = await passingBundle({ candidateSha: OTHER });
    const j = judge.judgeBundle({ bundleDir: out, run });
    assert.deepEqual(j.reasons, [{ bundle: OTHER, run: CAND, code: 'CANDIDATE_SHA_MISMATCH', class: 'terminal' }]);
  });

  it('refuses a bundle with no candidate, or a malformed one', async () => {
    for (const bad of [undefined, null, 'abc1234', CAND.toUpperCase(), 42]) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir);
      const { out, run } = await passingBundle();
      editManifest(out, (m) => { if (bad === undefined) delete m.candidateSha; else m.candidateSha = bad; });
      assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run })), ['CANDIDATE_SHA_INVALID'], String(bad));
    }
  });

  it('takes the run identity from the caller only, and refuses a malformed one as a bug', async () => {
    const { out, run } = await passingBundle();
    for (const bad of [null, { ...run, candidateSha: 'abc' }, { ...run, runId: '' }, { ...run, manifestDigest: undefined }, { ...run, startedAt: '1' }]) {
      assert.throws(() => judge.judgeBundle({ bundleDir: out, run: bad }), TypeError);
    }
    assert.throws(() => judge.judgeBundle({ bundleDir: 'relative', run }), TypeError);
  });
});

describe('soak judge — schedule and log', () => {
  it('refuses a destructive-phase soak', async () => {
    const { out, run } = await passingBundle({ phase: 'destructive' });
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run })), ['SCHEDULE_NOT_CERTIFYING']);
  });

  it('refuses a schedule edited after the fact, even re-bound in the manifest', async () => {
    const { out, run } = await passingBundle();
    const s = JSON.parse(fs.readFileSync(path.join(out, 'schedule.json'), 'utf8'));
    s.events.pop();
    forge(out, 'schedule.json', JSON.stringify(s));
    const c = codes(judge.judgeBundle({ bundleDir: out, run }));
    assert.ok(c.includes('SCHEDULE_INVALID'), c.join());
  });

  it('refuses a log that belongs to another schedule', async () => {
    const { out, run } = await passingBundle();
    const other = sched.buildSchedule({ seed: 'another', phase: 'certifying', durationMs: 72 * HOUR, loadMeanMs: HOUR, classes: ['api'] });
    forge(out, 'schedule.json', JSON.stringify(other));
    editManifest(out, (m) => { m.summary.schedule.digest = other.digest; });
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run })), ['LOG_SCHEDULE_MISMATCH']);
  });

  it('refuses a summary that disagrees with what the judge re-derives', async () => {
    const { out, run } = await passingBundle();
    editManifest(out, (m) => { m.summary.log.ended = false; });
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run })), ['SUMMARY_MISMATCH']);
  });

  it('refuses a log that never ended, whatever the summary says', async () => {
    const { out, run } = await passingBundle();
    const lines = fs.readFileSync(path.join(out, 'soak-log.ndjson'), 'utf8').trim().split('\n');
    forge(out, 'soak-log.ndjson', `${lines.slice(0, -1).join('\n')}\n`);
    const c = codes(judge.judgeBundle({ bundleDir: out, run }));
    assert.ok(c.includes('LOG_NOT_ENDED') && c.includes('OUTSIDE_RUN_WINDOW'), c.join());
  });

  it('refuses a log the driver will not read as evidence (a lost lock)', async () => {
    const { out, run } = await passingBundle();
    fs.writeFileSync(driver.lockLostPath(path.join(out, 'soak-log.ndjson')), '{}\n');
    editManifest(out, (m) => {
      const rel = path.basename(driver.lockLostPath(path.join(out, 'soak-log.ndjson')));
      m.files.push({ path: rel, bytes: fs.statSync(path.join(out, rel)).size, sha256: sha(path.join(out, rel)) });
    });
    const j = judge.judgeBundle({ bundleDir: out, run });
    assert.equal(j.reasons[0].code, 'LOG_REFUSED');
    assert.equal(j.verdict, 'fail');
  });

  it('refuses a soak outside the run\'s window', async () => {
    const { out, run, soak } = await passingBundle();
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run: { ...run, startedAt: soak.startedAt + 1 } })), ['OUTSIDE_RUN_WINDOW']);
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run: { ...run, updatedAt: soak.completedAt - 1 } })), ['OUTSIDE_RUN_WINDOW']);
  });
});

describe('soak judge — every scheduled event is a required test', () => {
  it('holds a load event that did not succeed for review, naming the first, the count and every finding', async () => {
    const { out, run } = await passingBundle({ outcome: (n) => (n === 5 || n === 9 ? FAILED : OK) });
    const j = judge.judgeBundle({ bundleDir: out, run });
    assert.equal(j.verdict, 'awaiting-review');
    const [r, ...rest] = j.reasons;
    assert.deepEqual(rest, []);
    assert.deepEqual([r.code, r.class, r.index, r.eventCode, r.count], ['EVENT_FAILED', 'reviewable', 5, 'HTTP_STATUS', 2]);
    assert.deepEqual(j.findings.map((f) => [f.type, f.index, f.eventCode, f.skipped]), [['event', 5, 'HTTP_STATUS', false], ['event', 9, 'HTTP_STATUS', false]]);
    assert.equal(j.disposition, null);
  });

  it('holds a skipped load event for review, including one skipped as stale', async () => {
    const { out, run } = await passingBundle();
    editLog(out, (rs) => rs.map((x) => (x.type === 'event' && x.index === 3 ? { ...x, skipped: true, ok: null, code: 'SKIPPED_STALE' } : x)));
    const j = judge.judgeBundle({ bundleDir: out, run });
    assert.deepEqual([j.verdict, j.reasons.map((r) => [r.code, r.class, r.index])], ['awaiting-review', [['EVENT_SKIPPED', 'reviewable', 3]]]);
    assert.deepEqual(j.findings.map((f) => [f.index, f.eventCode, f.skipped]), [[3, 'SKIPPED_STALE', true]]);
  });

  it('fails a fault that was not ok, whether it failed or was skipped, and no proposal reaches it', async () => {
    for (const [code, outcome] of [['FAULT_FAILED', { ok: false, code: 'RECOVERY_FAILED' }], ['FAULT_SKIPPED', { skipped: true, ok: null, code: 'SKIPPED_STALE' }]]) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir);
      const { out, run } = await passingBundle();
      // The fixture's schedule holds only load events, so turn one into a
      // fault in the schedule and the log alike, and re-bind both as the
      // builder would have.
      const schedule = JSON.parse(fs.readFileSync(path.join(out, 'schedule.json'), 'utf8'));
      const slot = schedule.events[4];
      const faulted = sched.buildSchedule({ ...schedule.params, classes: ['api', 'fault'] });
      const fault = faulted.events.find((e) => e.class === 'fault');
      assert.ok(fault, 'the fixture has a fault to judge');
      forge(out, 'schedule.json', JSON.stringify(faulted));
      editManifest(out, (m) => { m.summary.schedule.digest = faulted.digest; });
      editLog(out, () => {
        const records = [{ type: 'header', schema: 'tc.soak-log/v1', scheduleDigest: faulted.digest, phase: 'certifying', seed: faulted.params.seed, startEpochMs: T0 }];
        for (const e of faulted.events) {
          const base = { type: 'event', index: e.index, kind: e.kind, scheduledAt: T0 + e.atMs, startedAt: T0 + e.atMs, lateMs: 0, paced: null, durationMs: 1 };
          records.push(e.index === fault.index ? { ...base, ...outcome } : { ...base, ok: true, code: 'OK' });
        }
        records.push({ type: 'end', completedAt: T0 + faulted.params.durationMs, events: faulted.events.length });
        return records;
      });
      assert.ok(slot, 'the schedule has events');
      const plain = judge.judgeBundle({ bundleDir: out, run });
      assert.deepEqual([plain.verdict, plain.reasons.map((r) => [r.code, r.class, r.index]), plain.findings], ['fail', [[code, 'terminal', fault.index]], []], code);
      // A proposal naming the fault is not even read beside a terminal reason.
      const named = judge.judgeBundle({ bundleDir: out, run, disposition: proposal({ ...plain, findings: [{ type: 'event', index: fault.index, kind: fault.kind, eventCode: outcome.code }] }) });
      assert.deepEqual([named.verdict, codes(named), named.disposition.state, named.disposition.findings], ['fail', [code], 'not-applied', []]);
    }
  });

  it('fails a missing event, a duplicated one, and one the schedule does not hold', async () => {
    const cases = [
      ['EVENT_MISSING', (rs) => rs.filter((x) => !(x.type === 'event' && x.index === 4))],
      ['EVENT_DUPLICATE', (rs) => rs.flatMap((x) => (x.type === 'event' && x.index === 4 ? [x, x] : [x]))],
      ['EVENT_UNKNOWN', (rs) => rs.map((x) => (x.type === 'event' && x.index === 4 ? { ...x, kind: 'api.not-this-one' } : x))],
      ['EVENT_UNKNOWN', (rs) => [...rs.slice(0, -1), { ...rs.find((x) => x.type === 'event'), index: 99999 }, rs.at(-1)]]
    ];
    for (const [code, edit] of cases) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir);
      const { out, run } = await passingBundle();
      editLog(out, edit);
      const got = judge.judgeBundle({ bundleDir: out, run }).reasons.map((r) => r.code);
      // A kind that does not match leaves its index unaccounted for too.
      assert.deepEqual(got.filter((c) => c !== 'EVENT_MISSING' || code === 'EVENT_MISSING'), [code], `${code}: ${got}`);
    }
  });

  it('fails a log whose end record counts other events than the schedule', async () => {
    const { out, run } = await passingBundle();
    editLog(out, (rs) => rs.map((x) => (x.type === 'end' ? { ...x, events: x.events + 1 } : x)));
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run })), ['EVENT_COUNT_MISMATCH']);
  });
});

describe('soak judge — the certifying 72-hour schedule (A6.5, A7)', () => {
  it('fails a log whose end came before the schedule\'s horizon', async () => {
    const { out, run, soak } = await passingBundle();
    const lines = fs.readFileSync(path.join(out, 'soak-log.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const lastEvent = lines.filter((x) => x.type === 'event').at(-1);
    lines.at(-1).completedAt = lastEvent.startedAt + lastEvent.durationMs;
    forge(out, 'soak-log.ndjson', `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    assert.deepEqual(judge.judgeBundle({ bundleDir: out, run }).reasons,
      [{ ranMs: lines.at(-1).completedAt - soak.startedAt, durationMs: 72 * HOUR, code: 'RUN_TOO_SHORT', class: 'terminal' }]);
  });

  it('fails a certifying schedule of any other length', async () => {
    const { out, run } = await passingBundle({ durationMs: 12 * HOUR });
    assert.deepEqual(judge.judgeBundle({ bundleDir: out, run }).reasons, [{ durationMs: 12 * HOUR, required: judge.CERTIFYING_DURATION_MS, code: 'SCHEDULE_DURATION', class: 'terminal' }]);
  });
});

describe('soak judge — a log that survived a crash', () => {
  it('does not count a sealed record the driver ran again', async () => {
    const { out, run } = await passingBundle({ reclaimed: true, tornEvent: true });
    const lines = fs.readFileSync(path.join(out, 'soak-log.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const indexes = lines.filter((x) => x.type === 'event').map((x) => x.index);
    assert.ok(indexes.length > new Set(indexes).size, 'the fixture really logged one event twice, the first copy sealed');
    assert.ok(lines.some((x) => x.type === 'torn-tail-sealed'));
    // The sealed copy is not a duplicate: the only reason left is the
    // ownership the crash left unverified.
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run })), ['OWNERSHIP_UNVERIFIED']);
  });
});

describe('soak judge — ownership', () => {
  it('holds an ownership-unverified log for review, bound to exactly its bytes', async () => {
    const { out, run, soak } = await passingBundle({ reclaimed: true });
    const j = judge.judgeBundle({ bundleDir: out, run });
    assert.deepEqual([j.verdict, j.reasons], ['awaiting-review', [{ disposition: 'fail-reset', code: 'OWNERSHIP_UNVERIFIED', class: 'reviewable' }]]);
    assert.equal(j.binding.ownershipVerified, false);
    assert.deepEqual(j.findings, [{ type: 'ownership', logPath: path.resolve(soak.logPath), logBytes: j.binding.logBytes, logSha256: j.binding.logSha256 }]);
  });

  it('is covered only by a proposal naming exactly the evidence the driver recorded', async () => {
    const { out, run } = await passingBundle({ reclaimed: true });
    const plain = judge.judgeBundle({ bundleDir: out, run });
    const covered = judge.judgeBundle({ bundleDir: out, run, disposition: proposal(plain) });
    assert.deepEqual([covered.verdict, codes(covered), covered.disposition.state], ['awaiting-review', ['OWNERSHIP_UNVERIFIED'], 'covers']);
    assert.deepEqual(covered.disposition.findings.map((f) => f.type), ['ownership']);
    for (const [edit, code] of [
      [(d) => { d.ownership.logSha256 = 'd'.repeat(64); }, 'DISPOSITION_UNBOUND'],
      [(d) => { d.ownership.logBytes += 1; }, 'DISPOSITION_UNBOUND'],
      [(d) => { d.ownership.logPath = '/elsewhere/soak.ndjson'; }, 'DISPOSITION_UNBOUND'],
      [(d) => { d.ownership.rationale = ' '; }, 'DISPOSITION_INVALID'],
      [(d) => { delete d.ownership.trackingIssue; }, 'DISPOSITION_INVALID'],
      [(d) => { d.ownership.actor = 'operator'; }, 'DISPOSITION_INVALID'],
      [(d) => { delete d.ownership; }, 'DISPOSITION_INCOMPLETE']
    ]) {
      const j = judge.judgeBundle({ bundleDir: out, run, disposition: proposal(plain, edit) });
      assert.deepEqual([j.verdict, codes(j), j.disposition.state, j.disposition.findings], ['awaiting-review', ['OWNERSHIP_UNVERIFIED', code], 'rejected', []], code);
    }
  });

  it('fails an ownership record that does not match the log it is bundled with', async () => {
    const { out, run } = await passingBundle({ reclaimed: true });
    for (const edit of [
      (m) => { m.summary.log.certification.operatorAcceptance.evidence.logSha256 = 'd'.repeat(64); },
      (m) => { m.summary.log.certification.operatorAcceptance.evidence.logBytes += 1; },
      (m) => { m.summary.log.certification.operatorAcceptance = null; },
      (m) => { m.summary.log.certification = null; }
    ]) {
      const before = fs.readFileSync(path.join(out, 'manifest.json'));
      editManifest(out, edit);
      const j = judge.judgeBundle({ bundleDir: out, run });
      assert.deepEqual([j.verdict, j.reasons, j.findings], ['fail', [{ field: 'log.certification', code: 'SUMMARY_MISMATCH', class: 'terminal' }], []]);
      fs.writeFileSync(path.join(out, 'manifest.json'), before);
    }
    // A summary that claims the log was verified when the driver reads it as
    // unverified is the same disagreement, one field up.
    editManifest(out, (m) => { m.summary.log.ownership.verified = true; });
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run })).filter((c) => c === 'SUMMARY_MISMATCH').length > 0, true);
    assert.equal(judge.judgeBundle({ bundleDir: out, run }).verdict, 'fail');
  });

  it('refuses a proposal that disposes of ownership on a verified log', async () => {
    const { out, run } = await passingBundle({ outcome: (n) => (n === 5 ? FAILED : OK) });
    const plain = judge.judgeBundle({ bundleDir: out, run });
    const j = judge.judgeBundle({ bundleDir: out, run, disposition: proposal(plain, (d) => {
      d.ownership = { logPath: '/x', logBytes: 1, logSha256: 'e'.repeat(64), rationale: 'r', trackingIssue: { repo: 'o/r', number: 1 } };
    }) });
    assert.deepEqual([j.verdict, codes(j), j.disposition.state], ['awaiting-review', ['EVENT_FAILED', 'DISPOSITION_EXTRA_EVENT'], 'rejected']);
  });
});

describe('soak judge — the disposition proposal', () => {
  /**
   * A bundle with two failed load events, and its judgement with no proposal.
   * @returns {Promise<{out: string, run: object, plain: object}>} The bundle, its run and the plain judgement
   */
  async function withFindings() {
    const { out, run } = await passingBundle({ outcome: (n) => (n === 5 || n === 9 ? FAILED : OK) });
    return { out, run, plain: judge.judgeBundle({ bundleDir: out, run }) };
  }

  it('covers the findings, records its own digest and every finding in full, and still does not pass', async () => {
    const { out, run, plain } = await withFindings();
    const bytes = proposal(plain);
    const j = judge.judgeBundle({ bundleDir: out, run, disposition: bytes });
    assert.deepEqual([j.verdict, codes(j)], ['awaiting-review', ['EVENT_FAILED']], 'a proposal approves nothing');
    assert.equal(j.disposition.sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal(j.disposition.state, 'covers');
    assert.deepEqual(j.disposition.findings.map((f) => [f.index, f.kind, f.eventCode, f.classification, f.trackingIssue.number]),
      plain.findings.map((f) => [f.index, f.kind, 'HTTP_STATUS', 'harness', 1949]));
    assert.ok(j.disposition.findings.every((f) => f.rationale && f.evidence.length === 1));
    assert.deepEqual(j.findings, plain.findings, 'the findings themselves are unchanged');
  });

  it('accepts each classification in the closed set, and nothing else', async () => {
    const { out, run, plain } = await withFindings();
    for (const c of judge.CLASSIFICATIONS) {
      assert.equal(judge.judgeBundle({ bundleDir: out, run, disposition: proposal(plain, (d) => { d.events[0].classification = c; }) }).disposition.state, 'covers', c);
    }
    assert.deepEqual(judge.CLASSIFICATIONS, ['harness', 'environment', 'candidate-finding']);
    for (const c of ['candidate-accepted', 'accepted', '', null]) {
      assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run, disposition: proposal(plain, (d) => { d.events[0].classification = c; }) })).slice(1), ['DISPOSITION_INVALID', 'DISPOSITION_INCOMPLETE'], String(c));
    }
  });

  it('is rejected unless every binding field is exactly what the judge derived', async () => {
    const { out, run, plain } = await withFindings();
    for (const [field, value] of [
      ['candidateSha', OTHER], ['runId', 'c'.repeat(32)], ['bundleManifestSha256', 'c'.repeat(64)],
      ['scheduleDigest', 'c'.repeat(64)], ['logSha256', 'c'.repeat(64)], ['logBytes', 1]
    ]) {
      const j = judge.judgeBundle({ bundleDir: out, run, disposition: proposal(plain, (d) => { d[field] = value; }) });
      assert.deepEqual([j.verdict, j.reasons.at(-1), j.disposition.state, j.disposition.findings],
        ['awaiting-review', { field, code: 'DISPOSITION_UNBOUND', class: 'disposition' }, 'rejected', []], field);
    }
    // A proposal written for one run does not carry to another run of the same bundle.
    const other = judge.judgeBundle({ bundleDir: out, run: { ...run, runId: 'c'.repeat(32) }, disposition: proposal(plain) });
    assert.deepEqual([codes(other).at(-1), other.disposition.state], ['DISPOSITION_UNBOUND', 'rejected']);
  });

  it('must name exactly the findings: none missing, none extra, none twice, none by pattern', async () => {
    const { out, run, plain } = await withFindings();
    const entry = (d, over) => ({ ...d.events[0], ...over });
    for (const [label, edit, expected] of [
      ['one finding left out', (d) => { d.events.pop(); }, ['DISPOSITION_INCOMPLETE']],
      ['no events at all', (d) => { d.events = []; }, ['DISPOSITION_INCOMPLETE']],
      ['an event that succeeded', (d) => { d.events.push(entry(d, { index: 2 })); }, ['DISPOSITION_EXTRA_EVENT']],
      ['an index the schedule does not hold', (d) => { d.events.push(entry(d, { index: 99999 })); }, ['DISPOSITION_EXTRA_EVENT']],
      ['the same finding twice', (d) => { d.events.push(entry(d, {})); }, ['DISPOSITION_EXTRA_EVENT']],
      ['another kind at that index', (d) => { d.events[0].kind = 'api.not-this-one'; }, ['DISPOSITION_EXTRA_EVENT', 'DISPOSITION_INCOMPLETE']],
      ['another code at that index', (d) => { d.events[0].eventCode = 'TIMEOUT'; }, ['DISPOSITION_EXTRA_EVENT', 'DISPOSITION_INCOMPLETE']],
      ['a range of indexes', (d) => { d.events = [entry(d, { index: [5, 9] })]; }, ['DISPOSITION_INVALID', 'DISPOSITION_INCOMPLETE']],
      ['a wildcard index', (d) => { d.events = [entry(d, { index: '*' })]; }, ['DISPOSITION_INVALID', 'DISPOSITION_INCOMPLETE']],
      ['an entry naming a kind and no index', (d) => { const { index, ...rest } = d.events[0]; assert.ok(index !== undefined); d.events = [rest]; }, ['DISPOSITION_INVALID', 'DISPOSITION_INCOMPLETE']],
      ['events that are not a list', (d) => { d.events = { 5: d.events[0] }; }, ['DISPOSITION_INVALID']]
    ]) {
      const j = judge.judgeBundle({ bundleDir: out, run, disposition: proposal(plain, edit) });
      assert.deepEqual([j.verdict, codes(j).slice(1), j.disposition.state, j.disposition.findings], ['awaiting-review', expected, 'rejected', []], label);
    }
  });

  it('refuses a malformed proposal, and anything in it that claims an approval', async () => {
    const { out, run, plain } = await withFindings();
    for (const [label, bytes] of [
      ['not JSON', Buffer.from('{')],
      ['not an object', Buffer.from('[1]')],
      ['another schema', proposal(plain, (d) => { d.schema = 'tc.soak-disposition/v0'; })],
      ['an approver', proposal(plain, (d) => { d.approver = { actor: 'operator', role: 'operator' }; })],
      ['an approval time', proposal(plain, (d) => { d.approvedAt = T0; })],
      ['a missing binding field', proposal(plain, (d) => { delete d.logBytes; })],
      ['an event with no rationale', proposal(plain, (d) => { d.events[0].rationale = '  '; })],
      ['an event with no tracking issue', proposal(plain, (d) => { delete d.events[0].trackingIssue; })],
      ['a tracking issue with no number', proposal(plain, (d) => { d.events[0].trackingIssue = { repo: 'o/r', number: 0 }; })],
      ['a tracking issue that is a URL', proposal(plain, (d) => { d.events[0].trackingIssue = { repo: 'https://github.com/o/r', number: 1 }; })],
      ['an event with an approver of its own', proposal(plain, (d) => { d.events[0].approver = 'operator'; })]
    ]) {
      const j = judge.judgeBundle({ bundleDir: out, run, disposition: bytes });
      assert.equal(j.verdict, 'awaiting-review', label);
      assert.equal(codes(j)[1], 'DISPOSITION_INVALID', label);
      assert.deepEqual([j.disposition.state, j.disposition.findings], ['rejected', []], label);
    }
    assert.throws(() => judge.judgeBundle({ bundleDir: out, run, disposition: JSON.parse(proposal(plain).toString()) }), TypeError, 'a parsed proposal has no bytes to bind');
  });

  it('takes evidence only from the bundle: a listed file, by its exact digest, through no symlink or traversal', async () => {
    const { out, run, plain } = await withFindings();
    const log = plain.binding.logSha256;
    fs.symlinkSync(path.join(out, 'soak-log.ndjson'), path.join(dir, 'outside-link'));
    for (const [label, evidence] of [
      ['no evidence', []],
      ['evidence that is not a list', { path: 'soak-log.ndjson', sha256: log }],
      ['an absolute host path', [{ path: path.join(out, 'soak-log.ndjson'), sha256: log }]],
      ['a path that climbs out of the bundle', [{ path: '../soak.ndjson', sha256: log }]],
      ['a path that climbs out and back', [{ path: 'db/../soak-log.ndjson', sha256: log }]],
      ['a path that is not normalized', [{ path: './soak-log.ndjson', sha256: log }]],
      ['a file the manifest does not list', [{ path: 'analysis.txt', sha256: log }]],
      ['the manifest itself', [{ path: 'manifest.json', sha256: plain.binding.bundleManifestSha256 }]],
      ['a listed file under another digest', [{ path: 'soak-log.ndjson', sha256: 'c'.repeat(64) }]],
      ['an entry with an extra field', [{ path: 'soak-log.ndjson', sha256: log, note: 'see line 9' }]],
      ['one good entry and one bad', [{ path: 'soak-log.ndjson', sha256: log }, { path: '/etc/hosts', sha256: log }]]
    ]) {
      const j = judge.judgeBundle({ bundleDir: out, run, disposition: proposal(plain, (d) => { d.events[0].evidence = evidence; }) });
      assert.deepEqual([j.verdict, codes(j).slice(1), j.disposition.state], ['awaiting-review', ['DISPOSITION_EVIDENCE', 'DISPOSITION_INCOMPLETE'], 'rejected'], label);
    }
    const samples = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')).files.find((f) => f.path === 'samples.ndjson');
    const two = judge.judgeBundle({ bundleDir: out, run, disposition: proposal(plain, (d) => { d.events[0].evidence.push({ path: samples.path, sha256: samples.sha256 }); }) });
    assert.equal(two.disposition.state, 'covers', 'any file the manifest binds may be cited');
  });

  it('refuses evidence reached through a symlinked directory, even one the manifest lists', async () => {
    const { out, run, plain } = await withFindings();
    // Move the snapshot's directory aside and leave a symlink in its place:
    // the listed path still resolves to the same bytes.
    fs.renameSync(path.join(out, 'db'), path.join(dir, 'db-real'));
    fs.symlinkSync(path.join(dir, 'db-real'), path.join(out, 'db'));
    const db = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')).files.find((f) => f.path === path.join('db', 'tangleclaw.db'));
    const j = judge.judgeBundle({ bundleDir: out, run, disposition: proposal(plain, (d) => { d.events[0].evidence = [{ path: db.path, sha256: db.sha256 }]; }) });
    assert.notEqual(j.disposition.state, 'covers');
  });

  it('is refused when there is nothing to dispose of, so it cannot ride along with a clean pass', async () => {
    const { out, run } = await passingBundle();
    const clean = judge.judgeBundle({ bundleDir: out, run });
    assert.equal(clean.verdict, 'pass');
    const j = judge.judgeBundle({ bundleDir: out, run, disposition: proposal(clean) });
    assert.deepEqual([j.verdict, codes(j), j.disposition.state], ['awaiting-review', ['DISPOSITION_INVALID'], 'rejected']);
  });

  it('never reaches a terminal reason: the verdict is fail and the proposal is recorded as not applied', async () => {
    const { out, run } = await passingBundle({ outcome: (n) => (n === 5 ? FAILED : OK), edit: (x, i) => (i === 3 ? { ...x, db: { check: 'quick_check', state: 'corrupt', bytes: 10 } } : x) });
    const plain = judge.judgeBundle({ bundleDir: out, run });
    assert.deepEqual([plain.verdict, codes(plain)], ['fail', ['EVENT_FAILED', 'DATA_CORRUPTION']]);
    const bytes = proposal(plain);
    const j = judge.judgeBundle({ bundleDir: out, run, disposition: bytes });
    assert.deepEqual([j.verdict, codes(j)], ['fail', ['EVENT_FAILED', 'DATA_CORRUPTION']], 'the proposal adds nothing and removes nothing');
    assert.deepEqual(j.disposition, { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), state: 'not-applied', findings: [] });
    // Nor can a proposal name the terminal reason itself.
    const naming = judge.judgeBundle({ bundleDir: out, run, disposition: proposal(plain, (d) => { d.events.push({ ...d.events[0], index: 3, kind: 'DATA_CORRUPTION', eventCode: null }); }) });
    assert.equal(naming.verdict, 'fail');
    // And a bundle the judge cannot trust at all reads no proposal either.
    fs.rmSync(path.join(out, 'manifest.json'));
    const untrusted = judge.judgeBundle({ bundleDir: out, run, disposition: bytes });
    assert.deepEqual([untrusted.verdict, codes(untrusted), untrusted.disposition.state], ['fail', ['MANIFEST_MISSING'], 'not-applied']);
  });

  it('gives every reason a class, and only the three reviewable codes are reviewable', () => {
    const reviewable = Object.values(judge.REASON).filter((c) => judge.classOf(c) === 'reviewable');
    assert.deepEqual(reviewable.sort(), ['EVENT_FAILED', 'EVENT_SKIPPED', 'OWNERSHIP_UNVERIFIED']);
    assert.ok(Object.values(judge.REASON).filter((c) => c.startsWith('DISPOSITION_')).every((c) => judge.classOf(c) === 'disposition'));
    for (const c of ['FAULT_FAILED', 'FAULT_SKIPPED', 'CANDIDATE_SHA_MISMATCH', 'RUN_TOO_SHORT', 'DATA_CORRUPTION', 'SERVER_NOT_RECOVERED', 'FILE_MISMATCH', 'EVENT_MISSING']) {
      assert.equal(judge.classOf(c), 'terminal', c);
    }
  });
});

describe('soak judge — samples and database', () => {
  it('fails on data corruption in any sample', async () => {
    const { out, run } = await passingBundle({ edit: (x, i) => (i === 3 ? { ...x, db: { check: 'quick_check', state: 'corrupt', bytes: 10 } } : x) });
    assert.deepEqual(judge.judgeBundle({ bundleDir: out, run }).reasons, [{ sampleSeq: 3, code: 'DATA_CORRUPTION', class: 'terminal' }]);
  });

  it('fails when the server is not alive and healthy at the last sample', async () => {
    for (const last of [{ health: { status: 503 } }, { process: { pid: 1, alive: false } }]) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir);
      const { out, run } = await passingBundle();
      const lines = fs.readFileSync(path.join(out, 'samples.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      Object.assign(lines.at(-1), last);
      forge(out, 'samples.ndjson', `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
      assert.deepEqual(judge.judgeBundle({ bundleDir: out, run }).reasons, [{ sampleSeq: lines.at(-1).seq, code: 'SERVER_NOT_RECOVERED', class: 'terminal' }], JSON.stringify(last));
    }
  });

  it('fails a server that died and came back only as unknown', async () => {
    const { out, run } = await passingBundle();
    const lines = fs.readFileSync(path.join(out, 'samples.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    lines.at(-2).process = { pid: 1, alive: false };
    lines.at(-1).process = { pid: 1, alive: null, reason: 'ps timed out' };
    forge(out, 'samples.ndjson', `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    // Unknown liveness is not evidence: recovery is judged at the last sample
    // that is, which found the server down. That sample is one interval
    // before the log's end, so coverage still holds.
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: out, run })), ['SERVER_NOT_RECOVERED']);
  });

  it('fails failed samples once they leave a gap longer than two intervals', async () => {
    const { out, run } = await passingBundle({ edit: (x, i) => (i >= 3 && i <= 5 ? { type: 'sample-failed', seq: x.seq, at: x.at, error: 'EIO' } : x) });
    assert.deepEqual(judge.judgeBundle({ bundleDir: out, run }).reasons, [{ detail: 'gap', afterSampleSeq: 2, code: 'COVERAGE', class: 'terminal' }]);
  });

  it('does not count a sample with no time, and fails samples out of order', async () => {
    const untimed = await passingBundle({ edit: (x, i) => (i > 0 && i < 400 ? { ...x, at: null } : x) });
    assert.deepEqual(judge.judgeBundle({ bundleDir: untimed.out, run: untimed.run }).reasons.map((r) => r.detail), ['gap']);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    const swapped = await passingBundle({ edit: (x, i) => (i === 5 ? { ...x, at: x.at - 2 * SAMPLE_MS } : x) });
    assert.deepEqual(judge.judgeBundle({ bundleDir: swapped.out, run: swapped.run }).reasons.map((r) => r.detail), ['out-of-order']);
  });

  it('needs at least two evidentiary samples', async () => {
    const { out, run } = await passingBundle();
    const lines = fs.readFileSync(path.join(out, 'samples.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    forge(out, 'samples.ndjson', `${[lines[0], lines.at(-1)].map((l) => JSON.stringify(l)).join('\n')}\n`);
    assert.deepEqual(judge.judgeBundle({ bundleDir: out, run }).reasons, [{ detail: 'fewer than two evidentiary samples', code: 'COVERAGE', class: 'terminal' }]);
  });

  it('fails samples that start late, stop early or leave a gap', async () => {
    // A sample whose database check could not run is not evidence, so a run
    // of them is a hole in the coverage.
    const unavailable = (x) => ({ ...x, db: { check: 'quick_check', state: 'unavailable', error: 'locked' } });
    const cases = [
      ['late-start', (x, i) => (i === 0 || i === 1 ? unavailable(x) : x)],
      ['gap', (x, i) => (i >= 3 && i <= 5 ? unavailable(x) : x)]
    ];
    for (const [detail, edit] of cases) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir);
      const { out, run } = await passingBundle({ edit });
      assert.deepEqual(judge.judgeBundle({ bundleDir: out, run }).reasons.map((r) => r.detail), [detail], detail);
    }
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    const { out, run } = await passingBundle();
    const lines = fs.readFileSync(path.join(out, 'samples.ndjson'), 'utf8').trim().split('\n');
    forge(out, 'samples.ndjson', `${lines.slice(0, -3).join('\n')}\n`);
    assert.deepEqual(judge.judgeBundle({ bundleDir: out, run }).reasons.map((r) => r.detail), ['early-stop']);
  });

  it('fails a bundle with no samples, torn samples, or samples with no interval', async () => {
    const none = await passingBundle({ samples: false });
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: none.out, run: none.run })), ['SAMPLES_MISSING']);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    const torn = await passingBundle();
    forge(torn.out, 'samples.ndjson', `${fs.readFileSync(path.join(torn.out, 'samples.ndjson'), 'utf8')}{"type":"sam`);
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: torn.out, run: torn.run })), ['SAMPLES_TORN']);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    const nohdr = await passingBundle();
    const lines = fs.readFileSync(path.join(nohdr.out, 'samples.ndjson'), 'utf8').trim().split('\n');
    forge(nohdr.out, 'samples.ndjson', `${lines.slice(1).join('\n')}\n`);
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: nohdr.out, run: nohdr.run })), ['SAMPLES_UNREADABLE']);
  });

  it('fails a bundle with no database snapshot, or a snapshot that is damaged', async () => {
    const none = await passingBundle({ db: false });
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: none.out, run: none.run })), ['DB_SNAPSHOT_MISSING']);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    const bad = await passingBundle();
    const rel = path.join('db', 'tangleclaw.db');
    const bytes = fs.readFileSync(path.join(bad.out, rel));
    forge(bad.out, rel, Buffer.concat([Buffer.from('not a database'), bytes.subarray(14)]));
    assert.deepEqual(codes(judge.judgeBundle({ bundleDir: bad.out, run: bad.run })), ['DB_SNAPSHOT_NOT_OK']);
  });
});

describe('soak judge — bound into the host\'s finalization and certification of record', () => {
  const fx = require('./_release-certification-fixtures');
  const hc = require('../lib/release-certification/host-checks');
  const hostPublish = require('../lib/release-certification/host-publish');
  const sm = require('../lib/release-certification/state-machine');
  const sc = require('../lib/release-certification/scorecard');
  const store = require('../lib/release-certification/store');
  const GREEN = async () => ({ observation: { state: 'ok', checks: { test: 'success' } }, error: null });

  /**
   * Judge a real bundle for a real host-attested run, finalize it on the host
   * with that judgement, accept the run as the operator would, and say
   * whether the host would certify the scorecard that acceptance publishes.
   * @param {object} bundleOpts - `passingBundle` options
   * @param {object} [how] - `{propose, acceptDigest}`: `propose(plainJudgement)` returns the proposal bytes to finalize with; `acceptDigest(judgement)` returns the digest the operator's accept names
   * @returns {Promise<{judgement: object, outcome: object, certified: boolean, finalization: object, scorecard: object}>} What happened
   */
  async function finalizeWithSoak(bundleOpts, how = {}) {
    const { out, soak } = await passingBundle({ candidateSha: fx.SHA, ...bundleOpts });
    const hostBase = path.join(dir, 'host');
    hc.mintRun(hostBase, { candidateSha: fx.SHA, repository: 'o/r', requiredChecks: ['test'] }, { random: () => fx.RUN_ID });
    const manifest = fx.manifest({ checksSource: 'host-attested', checksExchange: '/x', publishRemote: '/x/metrics.git', isolationProducer: '/x/guest-setup.sh' });
    const digest = store.manifestDigest(store.manifestText(manifest));
    // A run admitted for real, then placed at review over the soak's window:
    // the reducer's path to review is the state machine's own tests' subject.
    // (Admitted under a plain manifest: a host-attested admission needs the
    // guest's isolation attestation, which is not what is under test here.)
    const admitted = sm.admit(fx.manifest(), fx.sample(0)).state;
    const state = { ...admitted, manifestDigest: digest, state: 'awaiting-review', sampleCount: 0, baseline: { ...admitted.baseline, bootId: fx.BOOT_ID }, startedAt: soak.startedAt - MIN, updatedAt: soak.completedAt + MIN, lastSampleAt: soak.completedAt + MIN };
    const run = { candidateSha: manifest.candidateSha, runId: manifest.runId, manifestDigest: digest, startedAt: state.startedAt, updatedAt: state.updatedAt };
    const plain = judge.judgeBundle({ bundleDir: out, run });
    const judgement = how.propose ? judge.judgeBundle({ bundleDir: out, run, disposition: how.propose(plain) }) : plain;
    const outcome = await hc.finalize({ hostBase, manifest, manifestDigest: digest, state, samples: [], observe: GREEN, soakJudgement: judgement });
    const finalization = hc.readFinalization(hostBase, fx.SHA, fx.RUN_ID);
    const named = how.acceptDigest ? how.acceptDigest(judgement) : undefined;
    const passed = sm.accept(state, 'operator', state.updatedAt + MIN, manifest, named).state;
    const scorecard = sc.scorecard(passed, manifest, state.updatedAt + MIN, 1);
    return { judgement, outcome, certified: hostPublish.certifiedFrom(scorecard, finalization), finalization, scorecard };
  }
  const ONE_FAILED = { outcome: (n) => (n === 5 ? FAILED : OK) };
  const itsDigest = (j) => j.disposition.sha256;

  it('certifies a passed run with a passing soak bound to it, and records the evidence it vouched for', async () => {
    const r = await finalizeWithSoak({});
    assert.deepEqual([r.judgement.verdict, r.outcome, r.certified], ['pass', { ok: true, reasons: [] }, true]);
    assert.equal(r.finalization.soak.binding.bundleManifestSha256, sha(path.join(dir, 'evidence', 'manifest.json')));
    assert.equal(r.scorecard.acceptance.soakDisposition, undefined);
  });

  it('never certifies when the soak found data corruption, whatever the acceptance names', async () => {
    const r = await finalizeWithSoak({ edit: (x, i) => (i === 2 ? { ...x, db: { check: 'quick_check', state: 'corrupt', bytes: 10 } } : x) }, { acceptDigest: () => 'd'.repeat(64) });
    assert.deepEqual([r.outcome.reasons, r.certified], [[{ code: 'SOAK_JUDGEMENT_FAILED' }], false]);
    assert.deepEqual(r.finalization.soak.reasons, [{ sampleSeq: 2, code: 'DATA_CORRUPTION', class: 'terminal' }], 'why is on record');
  });

  it('never certifies from a bundle of another candidate', async () => {
    const r = await finalizeWithSoak({ candidateSha: OTHER });
    assert.deepEqual([r.outcome.reasons, r.certified], [[{ code: 'SOAK_JUDGEMENT_FAILED' }], false]);
  });

  it('does not finalize a soak with a failed event and no proposal, and a bare acceptance does not certify it', async () => {
    const r = await finalizeWithSoak(ONE_FAILED);
    assert.deepEqual([r.judgement.verdict, r.outcome, r.certified], ['awaiting-review', { ok: false, reasons: [{ code: 'SOAK_JUDGEMENT_AWAITING_REVIEW' }] }, false]);
  });

  it('finalizes a soak whose findings a proposal covers, and still does not certify it on a bare acceptance', async () => {
    const r = await finalizeWithSoak(ONE_FAILED, { propose: (plain) => proposal(plain) });
    assert.deepEqual([r.judgement.verdict, r.judgement.disposition.state, r.outcome], ['awaiting-review', 'covers', { ok: true, reasons: [] }]);
    assert.equal(r.certified, false, 'a proposal is not an approval, and an acceptance that names none approves none');
  });

  it('certifies it as passed with findings only when the operator\'s acceptance binds exactly that proposal', async () => {
    const r = await finalizeWithSoak(ONE_FAILED, { propose: (plain) => proposal(plain), acceptDigest: itsDigest });
    assert.equal(r.certified, true);
    assert.deepEqual(r.scorecard.acceptance.soakDisposition, { sha256: r.judgement.disposition.sha256, candidateSha: fx.SHA, runId: fx.RUN_ID });
    assert.deepEqual(sc.validateScorecard(r.scorecard), []);
    assert.equal(hc.soakCertification(r.finalization.soak, { candidateSha: fx.SHA, runId: fx.RUN_ID, manifestDigest: r.finalization.manifestDigest }, r.scorecard.acceptance), 'pass-with-findings');
    assert.deepEqual(r.finalization.soak.disposition.findings.map((f) => [f.index, f.classification]), [[5, 'harness']], 'the findings are on the host\'s record');
  });

  it('does not certify when the acceptance names any other proposal, such as an edited copy', async () => {
    const edited = (j) => crypto.createHash('sha256').update(proposal(j, (d) => { d.events[0].classification = 'environment'; })).digest('hex');
    const r = await finalizeWithSoak(ONE_FAILED, { propose: (plain) => proposal(plain), acceptDigest: edited });
    assert.notEqual(r.scorecard.acceptance.soakDisposition.sha256, r.judgement.disposition.sha256);
    assert.equal(r.certified, false);
  });

  it('does not certify findings on an acceptance that names a proposal the judge rejected', async () => {
    const r = await finalizeWithSoak(ONE_FAILED, { propose: (plain) => proposal(plain, (d) => { d.events = []; }), acceptDigest: itsDigest });
    assert.deepEqual([r.judgement.disposition.state, r.outcome.reasons, r.certified], ['rejected', [{ code: 'SOAK_JUDGEMENT_AWAITING_REVIEW' }], false]);
  });

  it('certifies an ownership-unverified soak only when the acceptance binds a proposal of exactly its log', async () => {
    const refused = await finalizeWithSoak({ reclaimed: true });
    assert.deepEqual([refused.outcome.reasons, refused.certified], [[{ code: 'SOAK_JUDGEMENT_AWAITING_REVIEW' }], false]);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    const accepted = await finalizeWithSoak({ reclaimed: true }, { propose: (plain) => proposal(plain), acceptDigest: itsDigest });
    assert.deepEqual([accepted.outcome, accepted.certified], [{ ok: true, reasons: [] }, true]);
  });
});
