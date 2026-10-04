'use strict';

// #2031 (ADR 0023 Decision 8): the candidate lane, over HTTP against the real
// server. Any verified session may offer the Master a milestone or an operator
// action, resting on its own workload receipts; only the Master can turn one
// into something the operator reads; and what a candidate rests on is checked
// when it is offered and again when it is approved.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const bridgeStore = require('../lib/bridge-store');
const handoff = require('../lib/bridge-handoff');
const { bindProject } = require('./_shared-docs-callers');

const TC_BIN = path.join(__dirname, '..', 'bin', 'tc');

let tmpDir;
let server;
let origin;
let masterCredential;
let masterGeneration;
let seq = 0;
let clockMs = Date.parse('2026-10-04T00:00:00.000Z');

/**
 * One JSON request to the test server.
 * @param {string} method - HTTP method.
 * @param {string} apiPath - Path.
 * @param {object} [options]
 * @param {object} [options.headers] - Extra headers.
 * @param {object} [options.body] - JSON body.
 * @returns {Promise<{status: number, body: object}>}
 */
async function call(method, apiPath, options = {}) {
  const res = await fetch(`${origin}${apiPath}`, {
    method, headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return { status: res.status, body: await res.json() };
}

/**
 * A project with a live, launch-bound session.
 * @returns {{project: object, sessionId: number, launchId: string, headers: object}}
 */
function liveSession() {
  const name = `Proj${++seq}`;
  const project = store.projects.create({ name, path: path.join(tmpDir, name) });
  return { project, ...bindProject(project) };
}

/**
 * The session reports its workload, as `tc workload set` records it.
 * @param {object} session - What {@link liveSession} returned.
 * @param {string} state - Workload state.
 * @returns {number} The receipt's sequence within the launch.
 */
function reports(session, state = 'complete') {
  clockMs += 5000;
  const result = store.workloadReceipts.append({
    project_id: session.project.id, session_id: session.sessionId, launch_id: session.launchId, assignment_id: null,
    state, clearance: 'safe-to-clear', summary: `work is ${state}`, wait_kind: null, wait_detail: null,
    refs_json: '{"issues":[],"prs":[],"tasks":[]}', branch: null, head_sha: null, source: 'tc-cli',
    received_at: new Date(clockMs).toISOString()
  }, { minIntervalMs: 0, nowMs: clockMs });
  return result.row.seq;
}

/**
 * The session offers a candidate.
 * @param {object} session - The session.
 * @param {object} [over] - Body overrides.
 * @returns {Promise<{status: number, body: object}>}
 */
function offers(session, over = {}) {
  return call('POST', '/api/bridge/session/candidates', {
    headers: session.headers,
    body: { requestId: `req-cand-${++seq}-00`, kind: 'milestone', text: 'PR 12 merged.', receipts: [{ kind: 'workload', seq: 1 }], ...over }
  });
}

/**
 * The Master decides a candidate.
 * @param {string} id - Candidate id.
 * @param {string} op - `approve`, `reject` or `merge`.
 * @param {object} [body] - Fields beyond the request id.
 * @returns {Promise<{status: number, body: object}>}
 */
function master(id, op, body = {}) {
  return call('POST', `/api/bridge/master/candidates/${id}/${op}`, {
    headers: { 'x-tangleclaw-bridge-credential': masterCredential },
    body: { requestId: `req-${op}-${++seq}-0000`, expectedVersion: 1, ...body }
  });
}

/**
 * Outbound candidate items, as the helper would be handed them.
 * @returns {object[]}
 */
function candidateItems() {
  return store.getDb().prepare("SELECT * FROM bridge_outbound WHERE kind = 'candidate' ORDER BY outbound_id").all();
}

describe('bridge candidates (#2031)', () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bridge-candidates-'));
    store._setBasePath(tmpDir);
    store.init();
    const { createServer } = require('../server');
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    const minted = handoff.mintCredential();
    masterGeneration = bridgeStore.masterCredentials.mint(minted.hash);
    bridgeStore.masterCredentials.activate(masterGeneration, minted.hash);
    masterCredential = minted.credential;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    bridgeStore.settings.set('enabled', 'true');
  });

  it('a workload receipt can never be changed or removed, which is what its digest rests on', () => {
    const session = liveSession();
    reports(session);
    const db = store.getDb();
    assert.throws(() => db.exec("UPDATE workload_receipts SET summary = 'rewritten'"), /append-only|ABORT|constraint/i);
    assert.throws(() => db.exec('DELETE FROM workload_receipts'), /append-only|ABORT|constraint/i);
  });

  it('takes a candidate from a verified session, resting on its own receipt, and posts nothing', async () => {
    const session = liveSession();
    const receiptSeq = reports(session);
    const r = await offers(session, { receipts: [{ kind: 'workload', seq: receiptSeq }] });
    assert.deepEqual([r.status, r.body.state, r.body.replayed], [201, 'submitted', false]);
    assert.deepEqual(candidateItems(), [], 'a candidate never reaches the helper by itself');

    const read = await call('GET', `/api/bridge/master/candidates/${r.body.candidateId}`, { headers: { 'x-tangleclaw-bridge-credential': masterCredential } });
    assert.equal(read.body.authority, 'session-claim');
    assert.equal(read.body.candidate.sourceProjectName, session.project.name);
    assert.equal(read.body.candidate.receipts.length, 1);
    assert.equal(read.body.candidate.receipts[0].digest, bridgeStore.receipts.workloadForLaunch(session.launchId, receiptSeq).digest);
    const audit = store.getDb().prepare("SELECT * FROM bridge_audit WHERE op = 'candidate-submit' ORDER BY audit_seq DESC LIMIT 1").get();
    assert.deepEqual([audit.actor, audit.proof, audit.outcome], ['session', 'launch', 'accepted']);
  });

  it('refuses a caller that is not a verified launch, and anything while disabled', async () => {
    const session = liveSession();
    reports(session);
    for (const headers of [{}, { 'x-tangleclaw-project-id': String(session.project.id) },
      { ...session.headers, 'x-tangleclaw-launch-id': 'not-a-launch' },
      { 'x-tangleclaw-bridge-credential': masterCredential }]) {
      const r = await call('POST', '/api/bridge/session/candidates', { headers, body: { requestId: 'req-none-0001', kind: 'milestone', text: 'x', receipts: [{ kind: 'workload', seq: 1 }] } });
      assert.deepEqual([r.status, r.body.code], [403, 'VERIFIED_LAUNCH_REQUIRED']);
    }
    bridgeStore.settings.set('enabled', 'false');
    assert.equal((await offers(session)).body.code, 'BRIDGE_DISABLED');
  });

  it('a session can name only its own launch\'s receipts', async () => {
    const mine = liveSession();
    const other = liveSession();
    reports(other);
    reports(other);
    reports(mine);
    assert.equal((await offers(mine, { receipts: [{ kind: 'workload', seq: 2 }] })).body.code, 'RECEIPT_NOT_FOUND',
      'another launch has a receipt 2; this one does not');
    for (const receipts of [[], [{ kind: 'exchange', seq: 1 }], [{ kind: 'workload', seq: 0 }], [{ kind: 'workload', seq: '1' }], 'workload:1']) {
      const r = await offers(mine, { receipts });
      assert.ok(['RECEIPTS_REQUIRED', 'BAD_RECEIPT'].includes(r.body.code), JSON.stringify(receipts));
    }
    assert.equal((await offers(mine, { kind: 'announcement' })).body.code, 'UNKNOWN_CANDIDATE_KIND');
    assert.equal((await offers(mine, { text: '  ' })).body.code, 'CANDIDATE_TEXT_REQUIRED');
    assert.equal((await offers(mine, { text: 'a\u202Eb' })).body.code, 'CANDIDATE_NOT_DISPLAY_SAFE');
    assert.equal((await offers(mine, { text: 'x'.repeat(1801) })).body.code, 'CANDIDATE_TOO_LONG');
  });

  it('is idempotent on the request id within the launch, and refuses that id with a different payload', async () => {
    const session = liveSession();
    reports(session);
    const first = await offers(session, { requestId: 'req-same-0001' });
    const again = await offers(session, { requestId: 'req-same-0001' });
    assert.deepEqual([again.status, again.body.replayed, again.body.candidateId], [200, true, first.body.candidateId]);
    const changed = await offers(session, { requestId: 'req-same-0001', text: 'Something else entirely.' });
    assert.deepEqual([changed.status, changed.body.code], [409, 'REQUEST_ID_CONFLICT']);

    // The same request id from another launch is another candidate, not a replay.
    const other = liveSession();
    reports(other);
    const theirs = await offers(other, { requestId: 'req-same-0001' });
    assert.equal(theirs.status, 201);
    assert.notEqual(theirs.body.candidateId, first.body.candidateId);
  });

  it('caps how many undecided candidates one launch may have', async () => {
    const session = liveSession();
    reports(session);
    for (let i = 0; i < bridgeStore.MAX_OPEN_CANDIDATES_PER_LAUNCH; i++) assert.equal((await offers(session)).status, 201);
    const over = await offers(session);
    assert.deepEqual([over.status, over.body.code], [429, 'CANDIDATE_LIMIT']);
  });

  it('the Master approves once: one item for the helper, in its words or the session\'s, with its generation', async () => {
    const session = liveSession();
    reports(session);
    const id = (await offers(session, { text: 'PR 12 merged.' })).body.candidateId;
    const body = { requestId: 'req-approve-fixed-1' };
    const first = await master(id, 'approve', body);
    assert.deepEqual([first.status, first.body.candidate.state, first.body.candidate.version], [200, 'approved', 2]);
    const again = await master(id, 'approve', body);
    assert.deepEqual([again.body.outcome, again.body.replayed], ['applied', true]);
    const second = await master(id, 'approve', { expectedVersion: 2 });
    assert.equal(second.body.code, 'ALREADY_DECIDED');

    const items = candidateItems().filter((i) => i.candidate_id === id);
    assert.equal(items.length, 1, 'one item, however often approval is asked for');
    assert.deepEqual([items[0].text, items[0].source_label, items[0].released_generation, items[0].state],
      ['PR 12 merged.', `Project Master, from ${session.project.name}`, masterGeneration, 'ready']);

    const reworded = (await offers(session, { text: 'done lol' })).body.candidateId;
    await master(reworded, 'approve', { text: 'The release branch is merged.' });
    assert.equal(candidateItems().find((i) => i.candidate_id === reworded).text, 'The release branch is merged.');
    const audit = store.getDb().prepare("SELECT * FROM bridge_audit WHERE op = 'candidate-approve' AND outcome = 'applied' ORDER BY audit_seq DESC LIMIT 1").get();
    assert.deepEqual([audit.actor, audit.master_generation, JSON.parse(audit.detail_json).wording], ['master', masterGeneration, 'master']);
  });

  it('a rejected candidate posts nothing and cannot be approved afterwards', async () => {
    const session = liveSession();
    reports(session);
    const id = (await offers(session)).body.candidateId;
    assert.equal((await master(id, 'reject')).body.candidate.state, 'rejected');
    assert.equal((await master(id, 'approve', { expectedVersion: 2 })).body.code, 'ALREADY_DECIDED');
    assert.equal(candidateItems().filter((i) => i.candidate_id === id).length, 0);
  });

  it('merging keeps every receipt on the survivor, and the folded candidate can never be released', async () => {
    const session = liveSession();
    const one = reports(session);
    const two = reports(session, 'working');
    const kept = (await offers(session, { receipts: [{ kind: 'workload', seq: one }] })).body.candidateId;
    const folded = (await offers(session, { receipts: [{ kind: 'workload', seq: two }] })).body.candidateId;

    assert.equal((await master(folded, 'merge', { into: folded })).body.code, 'MERGE_TARGET_REQUIRED');
    assert.equal((await master(folded, 'merge', { into: 'cd_none' })).body.code, 'MERGE_TARGET_NOT_OPEN');
    const merged = await master(folded, 'merge', { into: kept });
    assert.deepEqual([merged.status, merged.body.candidate.state], [200, 'merged']);

    assert.equal(bridgeStore.candidates.receipts(kept).length, 2, 'the survivor rests on both');
    assert.equal(bridgeStore.candidates.receipts(folded).length, 1, 'the folded one keeps its own record');
    assert.equal((await master(folded, 'approve', { expectedVersion: 2 })).body.code, 'ALREADY_DECIDED');
    assert.equal((await master(kept, 'approve', { expectedVersion: 2 })).status, 200);
    assert.equal(candidateItems().filter((i) => [kept, folded].includes(i.candidate_id)).length, 1, 'one release for the pair');
  });

  it('after a merge the survivor\'s version moves, and a faithful replay of either submission is still a replay', async () => {
    const session = liveSession();
    const one = reports(session);
    const two = reports(session, 'working');
    const keptBody = { requestId: 'req-merge-kept-1', receipts: [{ kind: 'workload', seq: one }] };
    const foldedBody = { requestId: 'req-merge-fold-1', receipts: [{ kind: 'workload', seq: two }] };
    const kept = (await offers(session, keptBody)).body.candidateId;
    const folded = (await offers(session, foldedBody)).body.candidateId;
    await master(folded, 'merge', { into: kept });

    assert.equal(bridgeStore.candidates.get(kept).version, 2, 'what it rests on changed');
    const stale = await master(kept, 'approve', { expectedVersion: 1 });
    assert.equal(stale.body.code, 'VERSION_CONFLICT', 'a decision made on the survivor as it was before the merge is stale');

    const again = await offers(session, keptBody);
    assert.deepEqual([again.status, again.body.replayed, again.body.candidateId], [200, true, kept]);
    const foldedAgain = await offers(session, foldedBody);
    assert.deepEqual([foldedAgain.status, foldedAgain.body.replayed, foldedAgain.body.state], [200, true, 'merged']);
    assert.equal((await master(kept, 'approve', { expectedVersion: 2 })).status, 200);
  });

  it('the receipt digest covers every column of the receipts table', () => {
    const columns = store.getDb().prepare('PRAGMA table_info(workload_receipts)').all().map((c) => c.name).sort();
    assert.deepEqual([...bridgeStore.WORKLOAD_RECEIPT_COLUMNS].sort(), columns);
  });

  it('lets go of a candidate the Master never decided, and of an approved item nobody collected', async () => {
    const session = liveSession();
    reports(session);
    const waiting = (await offers(session)).body.candidateId;
    const approved = (await offers(session)).body.candidateId;
    await master(approved, 'approve');
    const now = Date.now();

    assert.deepEqual(bridgeStore.expire({ now: new Date(now + bridgeStore.CANDIDATE_TTL_MS - 60000).toISOString() }), { outbound: 0, candidates: 0 });
    const expired = bridgeStore.expire({ now: new Date(now + bridgeStore.CANDIDATE_TTL_MS + 60000).toISOString() });
    assert.ok(expired.candidates >= 1 && expired.outbound >= 1);
    assert.equal(bridgeStore.candidates.get(waiting).state, 'rejected');
    const item = candidateItems().find((i) => i.candidate_id === approved);
    assert.deepEqual([item.state, item.drop_code, item.text], ['dropped', 'expired', null]);
    assert.equal((await master(waiting, 'approve', { expectedVersion: 2 })).body.code, 'ALREADY_DECIDED');
  });

  it('refuses to approve a candidate whose receipt is no longer what it was', async () => {
    const session = liveSession();
    reports(session);
    const id = (await offers(session)).body.candidateId;
    // Only by removing the table's own protection can a receipt change at all.
    const db = store.getDb();
    const trigger = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'workload_receipts' AND sql LIKE '%UPDATE%'").get();
    db.exec(`DROP TRIGGER ${trigger.name}`);
    db.prepare("UPDATE workload_receipts SET summary = 'rewritten afterwards' WHERE launch_id = ?").run(session.launchId);
    db.exec(trigger.sql);

    const refused = await master(id, 'approve');
    assert.deepEqual([refused.status, refused.body.code], [409, 'RECEIPTS_DO_NOT_HOLD']);
    assert.equal(bridgeStore.candidates.get(id).state, 'submitted', 'the decision and the item land together or not at all');
    assert.equal(candidateItems().filter((i) => i.candidate_id === id).length, 0);
  });

  it('refuses a stale version and a malformed or unknown candidate id, and audits the decision it refused', async () => {
    const session = liveSession();
    reports(session);
    const id = (await offers(session)).body.candidateId;
    const stale = await master(id, 'approve', { requestId: 'req-stale-00001', expectedVersion: 9 });
    assert.deepEqual([stale.status, stale.body.code], [409, 'VERSION_CONFLICT']);
    assert.equal(bridgeStore.audit.findRequest('candidate-approve', 'req-stale-00001').outcome, 'version-conflict');
    assert.equal((await master('cd_unknown', 'reject')).status, 404);
    assert.equal((await master(encodeURIComponent('bad id!'), 'reject')).status, 404);
    assert.equal((await master(id, 'reject', { expectedVersion: undefined })).body.code, 'EXPECTED_VERSION_REQUIRED');
  });

  it('works end to end through the real tc, from a pane and from the Master', async () => {
    const session = liveSession();
    const receiptSeq = reports(session);
    const run = (args, env) => new Promise((resolve) => {
      const base = { PATH: process.env.PATH, HOME: process.env.HOME, TANGLECLAW_API: origin };
      execFile(TC_BIN, args, { env: { ...base, ...env }, encoding: 'utf8' }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    });
    const pane = { TANGLECLAW_PROJECT_ID: String(session.project.id), TANGLECLAW_LAUNCH_ID: session.launchId };
    const masterPane = { TANGLECLAW_ROLE: 'master', [handoff.CREDENTIAL_ENV]: masterCredential };

    const submitted = await run(['candidate', 'submit', '--kind', 'operator-action-required', '--receipt', `workload:${receiptSeq}`, '--text', 'Needs your sign-off.'], pane);
    assert.equal(submitted.code, 0, submitted.stderr);
    assert.match(submitted.stdout, /is with the Project Master\. Nothing has been posted/);
    const id = /Candidate (\S+) /.exec(submitted.stdout)[1];

    assert.equal((await run(['candidate', 'submit', '--kind', 'milestone', '--text', 'x'], pane)).code, 1, 'no receipt named');
    assert.equal((await run(['candidate', 'submit', '--kind', 'milestone', '--receipt', 'pr:12', '--text', 'x'], pane)).code, 1);
    const refused = await run(['candidate', 'submit', '--kind', 'milestone', '--receipt', 'workload:99', '--text', 'x'], pane);
    assert.deepEqual([refused.code, /RECEIPT_NOT_FOUND/.test(refused.stderr)], [2, true]);

    const listed = await run(['bridge', 'candidates'], masterPane);
    assert.match(listed.stdout, new RegExp(`${id}  operator-action-required`));
    const shown = await run(['bridge', 'candidate', id], masterPane);
    assert.match(shown.stdout, /a session's CLAIM for you to judge/);
    assert.match(shown.stdout, /\[text\] Needs your sign-off\./);
    const approved = await run(['bridge', 'approve', id, '--version', '1', '--text', 'A session needs your sign-off.'], masterPane);
    assert.equal(approved.code, 0, approved.stderr);
    assert.match(approved.stdout, /is approved and released to the operator/);
    assert.equal(candidateItems().find((i) => i.candidate_id === id).text, 'A session needs your sign-off.');

    // A pane holds no bridge credential: it cannot decide its own candidate.
    const selfApprove = await run(['bridge', 'approve', id, '--version', '2'], pane);
    assert.deepEqual([selfApprove.code, /BRIDGE_CREDENTIAL_REQUIRED/.test(selfApprove.stderr)], [2, true]);
  });
});
