'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const iso = require('../lib/release-certification/isolation');
const sm = require('../lib/release-certification/state-machine');
const { HARD_FAIL, EXTEND, STATES, REFUSAL } = require('../lib/release-certification/codes');
const fx = require('./_release-certification-fixtures');

const { SHA, MIN, T0 } = fx;
const B = { candidateSha: SHA, runId: fx.RUN_ID, manifestDigest: 'e'.repeat(64), sampleSeq: 3 };

describe('isolation attestations (#2020, A43, A44)', () => {
  it('reads a joined, bound, healthy pair as attested, with both digests', () => {
    const r = iso.judgeIsolation(fx.isolationPair(B), B);
    assert.equal(r.error, null);
    assert.deepEqual([r.observation.state, r.observation.bootId, r.observation.rulesetSha256], ['ok', fx.BOOT_ID, fx.RULESET]);
    assert.match(r.observation.adminDigest, /^[0-9a-f]{64}$/);
    assert.notEqual(r.observation.adminDigest, r.observation.workloadDigest);
  });

  it('digests the content, not how the producer ordered its fields', () => {
    const pair = fx.isolationPair(B);
    const reordered = Object.fromEntries(Object.entries(pair.admin).reverse());
    assert.equal(iso.digest(reordered), iso.digest(pair.admin));
    assert.notEqual(iso.digest({ ...pair.admin, observedAt: T0 + 1 }), iso.digest(pair.admin));
  });

  for (const [name, pair, diag] of [
    ['no attestation', null, 'MISSING'],
    ['a missing plane', { admin: fx.isolationPair(B).admin }, 'MISSING'],
    ['an unknown schema', fx.isolationPair(B, { admin: { schema: 'x' } }), 'INVALID'],
    ['an extra field', fx.isolationPair(B, { workload: { extra: 1 } }), 'INVALID'],
    ['a malformed ruleset digest', fx.isolationPair(B, { admin: { rulesetSha256: 'short' } }), 'INVALID'],
    ['a non-boolean egress answer', fx.isolationPair(B, { workload: { egressDenied: { ipv4: true, ipv6: 'yes', dns: true } } }), 'INVALID'],
    ['another sample\'s attestation', fx.isolationPair({ ...B, sampleSeq: 2 }), 'UNBOUND'],
    ['another run\'s attestation', fx.isolationPair({ ...B, runId: 'f'.repeat(32) }), 'UNBOUND'],
    ['one plane bound to another manifest', fx.isolationPair(B, { workload: { manifestDigest: 'f'.repeat(64) } }), 'UNBOUND'],
    ['planes from two different boots', fx.isolationPair(B, { workload: { bootId: 'boot-other' } }), 'SPLIT']
  ]) {
    it(`reads ${name} as unattested (${diag})`, () => {
      assert.deepEqual(iso.judgeIsolation(pair, B), { observation: { state: 'unavailable' }, error: iso.DIAGNOSTIC[diag] });
    });
  }

  for (const [name, over] of [
    ['the packet filter off', { admin: { pfEnabled: false } }],
    ['the management path open', { admin: { managementPath: 'open' } }],
    ['IPv4 egress allowed', { workload: { egressDenied: { ipv4: false, ipv6: true, dns: true } } }],
    ['IPv6 egress allowed', { workload: { egressDenied: { ipv4: true, ipv6: false, dns: true } } }],
    ['DNS allowed', { workload: { egressDenied: { ipv4: true, ipv6: true, dns: false } } }],
    ['sudo allowed', { workload: { sudoRefused: false } }],
    ['pfctl allowed', { workload: { pfctlRefused: false } }],
    ['the loopback API unreachable', { workload: { loopbackApi: false } }],
    ['a root workload', { workload: { uid: 0 } }],
    ['a workload in the admin group', { workload: { groups: [20, 80] } }],
    ['a workload in the wheel group', { workload: { groups: [0] } }]
  ]) {
    it(`reads a well-formed attestation with ${name} as a breach`, () => {
      assert.equal(iso.judgeIsolation(fx.isolationPair(B, over), B).observation.state, 'breached');
    });
  }

  it('reads a producer that throws, or a bad binding, as unattested and never throws', async () => {
    assert.equal((await iso.attest(async () => { throw new Error('ssh down'); }, B)).error, iso.DIAGNOSTIC.MISSING);
    assert.equal((await iso.attest(async (b) => fx.isolationPair(b), { ...B, sampleSeq: 0 })).error, iso.DIAGNOSTIC.MISSING);
    assert.equal((await iso.attest(undefined, B)).error, iso.DIAGNOSTIC.MISSING);
    assert.equal((await iso.attest(async (b) => fx.isolationPair(b), B)).observation.state, 'ok');
  });

  it('runs the pinned producer with the sample\'s binding and reads its JSON, or reads nothing', async () => {
    const calls = [];
    const fake = (out, err) => (program, args, opts, cb) => { calls.push([program, args]); cb(err, out); };
    const pair = fx.isolationPair(B);
    assert.deepEqual(await iso.producer('/x/guest-setup.sh', fake(JSON.stringify(pair), null))(B), pair);
    assert.deepEqual(calls[0], ['/x/guest-setup.sh', ['--verify-network', '--candidate', SHA, '--run-id', fx.RUN_ID, '--manifest-digest', B.manifestDigest, '--sample-seq', '3']]);
    assert.equal(await iso.producer('/x/g', fake('', new Error('exit 1')))(B), null);
    assert.equal(await iso.producer('/x/g', fake('not json', null))(B), null);
  });
});

describe('state machine: a guest run is judged on its isolation (A43, A44, A47)', () => {
  const m = fx.guestManifest();
  const healthy = (over = {}) => ({ ...fx.observations(), isolation: { ...fx.ISOLATED, ...over } });
  const admitted = () => sm.admit(m, fx.sample(0, healthy()));

  it('pins attested isolation and an admission baseline in a guest manifest', () => {
    assert.deepEqual([m.isolation, m.baselineSource, m.private.isolationProducer], ['attested', 'admission', '/x/guest-setup.sh']);
  });

  it('refuses admission without an attestation, and records the whole baseline once when admitted', () => {
    assert.throws(() => sm.admit(m, fx.sample(0)), (e) => e.code === REFUSAL.ADMISSION_REFUSED && e.details.reasons.some((r) => r.code === EXTEND.ISOLATION_UNATTESTED));
    const { state } = admitted();
    assert.deepEqual(state.baseline, { source: 'admission', ttydGeneration: fx.GEN, bootId: fx.BOOT_ID, rulesetSha256: fx.RULESET, adminDigest: fx.ISOLATED.adminDigest, workloadDigest: fx.ISOLATED.workloadDigest });
  });

  it('earns nothing on an unattested sample, and keeps the baseline', () => {
    const s1 = admitted().state;
    const out = sm.reduce(s1, m, fx.sample(MIN, { ...fx.observations(), isolation: { state: 'unavailable' } }));
    assert.equal(out.state.state, STATES.EXTENDED);
    assert.equal(out.state.qualifiedMs, 0);
    assert.ok(out.state.extensions[EXTEND.ISOLATION_UNATTESTED]);
    assert.deepEqual(out.state.baseline, s1.baseline);
  });

  for (const [name, over, code] of [
    ['a breach', { state: 'breached' }, HARD_FAIL.ISOLATION_BREACHED],
    ['a reboot', { bootId: 'boot-after-reboot' }, HARD_FAIL.BOOT_CHANGED],
    ['a changed packet filter', { rulesetSha256: 'c'.repeat(64) }, HARD_FAIL.ISOLATION_CHANGED]
  ]) {
    it(`fails the run irrevocably on ${name}`, () => {
      const s1 = admitted().state;
      const out = sm.reduce(s1, m, fx.sample(MIN, healthy(over)));
      assert.equal(out.state.state, STATES.FAILED);
      assert.equal(out.state.failure.code, code);
      assert.deepEqual(out.state.baseline, s1.baseline, 'the baseline is never rewritten in place');
      assert.throws(() => sm.reduce(out.state, m, fx.sample(2 * MIN, healthy())), (e) => e.code === REFUSAL.ALREADY_TERMINAL);
    });
  }

  it('ignores isolation entirely on a host run', () => {
    const host = fx.manifest();
    const { state } = sm.admit(host, fx.sample(0));
    assert.equal(state.baseline.bootId, null);
    assert.equal(sm.reduce(state, host, fx.sample(MIN)).state.state, STATES.RUNNING);
  });
});
