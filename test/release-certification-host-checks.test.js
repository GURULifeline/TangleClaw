'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const hc = require('../lib/release-certification/host-checks');
const { CertificationError, REFUSAL } = require('../lib/release-certification/codes');
const fx = require('./_release-certification-fixtures');

const { SHA, T0 } = fx;
const DIGEST = 'e'.repeat(64);
const GREEN = { state: 'ok', checks: { test: 'success' } };

let tmp;
let hostBase;
let exchange;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-rc-host-')));
  hostBase = path.join(tmp, 'host');
  exchange = path.join(tmp, 'exchange');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/**
 * A controllable clock.
 * @param {number} [t] - Start time
 * @returns {{now: function(): number, advance: function(number): void}} Clock
 */
function clock(t = T0) {
  let at = t;
  return { now: () => at, advance: (ms) => { at += ms; } };
}

/**
 * Mint a run for the fixture candidate.
 * @param {string} [runId] - The id to mint
 * @returns {string} Run id
 */
function mint(runId = fx.RUN_ID) {
  return hc.mintRun(hostBase, { candidateSha: SHA, repository: 'o/r', requiredChecks: ['test'] }, { random: () => runId, now: () => T0 }).runId;
}

/**
 * An observer standing in for GitHub, counting its calls.
 * @param {object} [observation] - What GitHub reports
 * @returns {{observe: Function, calls: object[]}} Observer
 */
function observer(observation = GREEN) {
  const calls = [];
  return { calls, observe: async (ctx) => { calls.push(ctx); return { observation, error: null }; } };
}

/**
 * The guest's probe context.
 * @param {object} [over] - Overrides
 * @returns {object} Context
 */
function guest(over = {}) {
  return { candidateSha: SHA, runId: fx.RUN_ID, exchangeDir: exchange, hostVerdictWaitMs: 5000, maxReadingAgeMs: 150_000, ...over };
}

/**
 * Attest a sample with a host that answers whenever the guest waits.
 * @param {object} ctx - Guest context
 * @param {object} binding - `{seq, manifestDigest}`
 * @param {object} [opts] - `{observe, c, host}`; `host: false` means no host answers
 * @returns {Promise<object>} The attest result
 */
function attestAnswered(ctx, binding, opts = {}) {
  const c = opts.c || clock();
  const obs = opts.observe || observer().observe;
  return hc.attest(ctx, binding, {
    now: c.now,
    sleep: async (ms) => {
      if (opts.host !== false) await hc.answerRequests({ hostBase, exchangeDir: exchange, candidateSha: SHA, observe: obs, now: c.now });
      c.advance(ms);
    }
  });
}

/**
 * Write a verdict file by hand, the way a tampered transport could.
 * @param {number} seq - Sample number
 * @param {object} verdict - Verdict
 * @returns {void}
 */
function plant(seq, verdict) {
  fs.mkdirSync(path.join(exchange, 'verdicts'), { recursive: true });
  fs.writeFileSync(path.join(exchange, 'verdicts', `${seq}.json`), JSON.stringify(verdict));
}

describe('host checks: minting and answering (#2020 Q1)', () => {
  it('mints a 128-bit run id and records what the host will judge', () => {
    const { runId } = hc.mintRun(hostBase, { candidateSha: SHA, repository: 'o/r', requiredChecks: ['test', 'lint'] });
    assert.match(runId, /^[0-9a-f]{32}$/);
    const rec = hc.mintedRuns(hostBase, SHA).get(runId);
    assert.deepEqual([rec.repository, rec.requiredChecks], ['o/r', ['lint', 'test']]);
    assert.notEqual(hc.mintRun(hostBase, { candidateSha: SHA, repository: 'o/r', requiredChecks: ['test'] }).runId, runId);
  });

  it('refuses to mint without a repository or with no required checks', () => {
    assert.throws(() => hc.mintRun(hostBase, { candidateSha: SHA, repository: 'nope', requiredChecks: ['test'] }), (e) => e instanceof CertificationError && e.code === REFUSAL.INVALID_MANIFEST);
    assert.throws(() => hc.mintRun(hostBase, { candidateSha: SHA, repository: 'o/r', requiredChecks: [] }), (e) => e.code === REFUSAL.INVALID_MANIFEST);
  });

  it('answers a minted run\'s request once, from GitHub, and records the verdict in its ledger first', async () => {
    mint();
    const o = observer();
    const r = await attestAnswered(guest(), { seq: 3, manifestDigest: DIGEST }, { observe: o.observe });
    assert.deepEqual(r.observation, GREEN);
    assert.equal(r.binding.sampleSeq, 3);
    assert.deepEqual(o.calls, [{ repo: 'o/r', candidateSha: SHA, requiredChecks: ['test'] }]);
    const ledger = fs.readFileSync(hc.hostPaths(hostBase, SHA).ledger, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].verdictDigest, r.binding.verdictDigest);
    const again = await hc.answerRequests({ hostBase, exchangeDir: exchange, candidateSha: SHA, observe: o.observe, now: () => T0 });
    assert.deepEqual(again.answered, [], 'an answered request is not answered twice');
  });

  it('never answers a run it did not mint, so the guest fails closed', async () => {
    mint();
    const o = observer();
    const r = await attestAnswered(guest({ runId: 'f'.repeat(32) }), { seq: 1, manifestDigest: DIGEST }, { observe: o.observe });
    assert.deepEqual(r, { observation: { state: 'unavailable', checks: null }, error: hc.DIAGNOSTIC.MISSING });
    assert.equal(o.calls.length, 0, 'GitHub was never read for it');
    assert.equal(fs.existsSync(path.join(exchange, 'verdicts', '1.json')), false);
  });

  it('skips a request that does not parse or whose file name disagrees with its sequence', async () => {
    mint();
    fs.mkdirSync(path.join(exchange, 'requests'), { recursive: true });
    fs.writeFileSync(path.join(exchange, 'requests', '2.json'), '{broken');
    fs.writeFileSync(path.join(exchange, 'requests', '4.json'), JSON.stringify({ schema: hc.REQUEST_SCHEMA, candidateSha: SHA, runId: fx.RUN_ID, manifestDigest: DIGEST, sampleSeq: 5, requestedAt: T0 }));
    const r = await hc.answerRequests({ hostBase, exchangeDir: exchange, candidateSha: SHA, observe: observer().observe, now: () => T0 });
    assert.deepEqual(r.answered, []);
    assert.deepEqual(r.skipped.map((s) => s.reason), ['invalid-request', 'invalid-request']);
  });
});

describe('host checks: the guest accepts only a verdict bound to its own sample', () => {
  /**
   * A valid verdict for the default binding, which a test then breaks.
   * @param {object} [over] - Fields to change after the digest is computed
   * @param {object} [pre] - Fields to change before the digest is computed
   * @returns {object} Verdict
   */
  function verdict(over = {}, pre = {}) {
    const v = { schema: hc.VERDICT_SCHEMA, candidateSha: SHA, runId: fx.RUN_ID, manifestDigest: DIGEST, sampleSeq: 1, requestedAt: T0, observedAt: T0 + 10, observation: GREEN, ...pre };
    v.verdictDigest = hc.verdictDigest(v);
    return { ...v, ...over };
  }
  const expected = { candidateSha: SHA, runId: fx.RUN_ID, manifestDigest: DIGEST, sampleSeq: 1, requestedAt: T0 };

  it('accepts a verdict whose every binding matches', () => {
    const r = hc.judgeVerdict(JSON.stringify(verdict()), expected, T0 + 20, 150_000);
    assert.deepEqual(r.observation, GREEN);
  });

  for (const [name, text, diag] of [
    ['no verdict', null, 'MISSING'],
    ['unparsable text', '{nope', 'INVALID'],
    ['a malformed observation', JSON.stringify(verdict({}, { observation: { state: 'ok', checks: { test: 'green' } } })), 'INVALID'],
    ['another candidate', JSON.stringify(verdict({}, { candidateSha: 'b'.repeat(40) })), 'MISMATCH'],
    ['another run id', JSON.stringify(verdict({}, { runId: 'f'.repeat(32) })), 'MISMATCH'],
    ['another manifest digest', JSON.stringify(verdict({}, { manifestDigest: 'f'.repeat(64) })), 'MISMATCH'],
    ['another sample', JSON.stringify(verdict({}, { sampleSeq: 2 })), 'MISMATCH'],
    ['another request time', JSON.stringify(verdict({}, { requestedAt: T0 - 1 })), 'MISMATCH'],
    ['an observation edited after the host signed off on it', JSON.stringify(verdict({ observation: { state: 'ok', checks: { test: 'success', lint: 'success' } } }, { observation: { state: 'ok', checks: { test: 'failure' } } })), 'MISMATCH'],
    ['an observation made before the request', JSON.stringify(verdict({}, { observedAt: T0 - 1 })), 'STALE'],
    ['an observation too old to vouch for the sample', JSON.stringify(verdict({}, { observedAt: T0 + 10 })), 'STALE']
  ]) {
    it(`reads ${name} as GitHub unavailable (${diag})`, () => {
      const now = name.includes('too old') ? T0 + 10 + 150_001 : T0 + 20;
      assert.deepEqual(hc.judgeVerdict(text, expected, now, 150_000), { diagnostic: hc.DIAGNOSTIC[diag] });
    });
  }

  it('waits only as long as allowed for a verdict, then reports it missing', async () => {
    const c = clock();
    const r = await attestAnswered(guest({ hostVerdictWaitMs: 3000 }), { seq: 1, manifestDigest: DIGEST }, { c, host: false });
    assert.equal(r.error, hc.DIAGNOSTIC.MISSING);
    assert.ok(c.now() - T0 >= 3000 && c.now() - T0 < 3000 + 1000);
  });

  it('does not accept a verdict left from an earlier attempt at the same sample', async () => {
    mint();
    plant(1, verdict({}, { requestedAt: T0 - 5000, observedAt: T0 - 4000 }));
    const r = await attestAnswered(guest(), { seq: 1, manifestDigest: DIGEST }, { host: false });
    assert.equal(r.error, hc.DIAGNOSTIC.MISSING, 'the old verdict was removed before asking, not read');
  });

  it('reads a verdict delivered through a symlink as invalid', async () => {
    fs.mkdirSync(path.join(exchange, 'verdicts'), { recursive: true });
    const elsewhere = path.join(tmp, 'elsewhere.json');
    const c = clock();
    const ctx = guest();
    const p = hc.attest(ctx, { seq: 1, manifestDigest: DIGEST }, {
      now: c.now,
      sleep: async (ms) => {
        fs.writeFileSync(elsewhere, JSON.stringify(verdict()));
        fs.rmSync(path.join(exchange, 'verdicts', '1.json'), { force: true });
        fs.symlinkSync(elsewhere, path.join(exchange, 'verdicts', '1.json'));
        c.advance(ms);
      }
    });
    assert.equal((await p).error, hc.DIAGNOSTIC.INVALID);
  });

  it('refuses to vouch for a sample it was not told about', async () => {
    assert.equal((await hc.attest(guest(), undefined)).error, hc.DIAGNOSTIC.UNBOUND);
    assert.equal((await hc.attest(guest({ runId: null }), { seq: 1, manifestDigest: DIGEST })).error, hc.DIAGNOSTIC.UNBOUND);
    assert.equal((await hc.attest(guest(), { seq: 0, manifestDigest: DIGEST })).error, hc.DIAGNOSTIC.UNBOUND);
  });
});

describe('host checks: finalization trusts only the host\'s own ledger', () => {
  const manifest = fx.manifest({ checksSource: 'host-attested', checksExchange: '/x' });

  /**
   * Take samples 1..n through the real exchange, each answered by the host.
   * @param {number} n - How many
   * @param {object} [opts] - `{observe, qualifies}`; `qualifies(seq)` says which intervals earned time
   * @returns {Promise<object[]>} Sample records
   */
  async function samples(n, opts = {}) {
    const out = [];
    for (let seq = 1; seq <= n; seq++) {
      const r = await attestAnswered(guest(), { seq, manifestDigest: DIGEST }, { observe: opts.observe });
      const qualifies = seq > 1 && (opts.qualifies ? opts.qualifies(seq) : true);
      out.push({ seq, ...(r.binding ? { checks: r.binding } : {}), interval: seq === 1 ? null : { qualifies } });
    }
    return out;
  }
  const finalize = (s, over = {}) => hc.finalize({
    hostBase, manifest, manifestDigest: DIGEST, state: { state: 'awaiting-review' }, samples: s, observe: observer().observe, now: () => T0, ...over
  });

  it('passes a run whose admission and every earning sample the host vouched for, and records it', async () => {
    mint();
    const out = await finalize(await samples(4));
    assert.deepEqual(out, { ok: true, reasons: [] });
    const rec = hc.readFinalization(hostBase, SHA);
    assert.deepEqual([rec.ok, rec.runId, rec.manifestDigest], [true, fx.RUN_ID, DIGEST]);
  });

  it('ignores a missing verdict on a sample that earned no time', async () => {
    mint();
    const s = await samples(3, { qualifies: (seq) => seq !== 2 });
    delete s[1].checks;
    assert.equal((await finalize(s)).ok, true);
  });

  it('fails on a gap, a verdict it never issued, or one that was not green, naming each sample', async () => {
    mint();
    const s = await samples(4);
    delete s[1].checks;
    s[2].checks = { ...s[2].checks, verdictDigest: 'f'.repeat(64) };
    const out = await finalize(s);
    assert.deepEqual(out.reasons, [{ code: 'VERDICT_MISSING', sampleSeq: 2 }, { code: 'VERDICT_MISMATCH', sampleSeq: 3 }]);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp);
    mint();
    const pending = await samples(2, { observe: observer({ state: 'ok', checks: { test: 'pending' } }).observe });
    assert.deepEqual((await finalize(pending)).reasons, [{ code: 'VERDICT_NOT_GREEN', sampleSeq: 1 }, { code: 'VERDICT_NOT_GREEN', sampleSeq: 2 }]);
  });

  it('fails a run the host never minted, one judged by other checks, and one not yet up for review', async () => {
    const s = await samples(2);
    assert.ok((await finalize(s)).reasons.some((r) => r.code === 'RUN_NOT_MINTED'));
    hc.mintRun(hostBase, { candidateSha: SHA, repository: 'o/r', requiredChecks: ['test', 'lint'] }, { random: () => fx.RUN_ID });
    const out = await finalize(s, { state: { state: 'running' } });
    assert.deepEqual(out.reasons.map((r) => r.code).filter((c) => ['CHECKS_LIST_DRIFT', 'NOT_REVIEWABLE'].includes(c)), ['CHECKS_LIST_DRIFT', 'NOT_REVIEWABLE']);
  });

  it('fails when the checks drift by the end, or cannot be read then', async () => {
    mint();
    const s = await samples(2);
    assert.deepEqual((await finalize(s, { observe: observer({ state: 'ok', checks: { test: 'failure' } }).observe })).reasons, [{ code: 'FINAL_CHECKS_NOT_GREEN' }]);
    assert.deepEqual((await finalize(s, { observe: observer({ state: 'unavailable', checks: null }).observe })).reasons, [{ code: 'FINAL_CHECKS_UNAVAILABLE' }]);
    assert.equal(hc.readFinalization(hostBase, SHA).ok, false, 'the failed outcome is what is recorded');
  });

  it('refuses to finalize a run that did not use host-attested checks', async () => {
    mint();
    const out = await hc.finalize({ hostBase, manifest: fx.manifest(), manifestDigest: DIGEST, state: { state: 'awaiting-review' }, samples: [], observe: observer().observe });
    assert.ok(out.reasons.some((r) => r.code === 'NOT_HOST_ATTESTED'));
  });
});
