'use strict';

// #2031 (ADR 0023): schema v52 adds the Master-mediated operator bridge's
// storage in its final shape. A fresh install and a v51 store reach the same
// shape; a store whose bridge tables are the wrong shape is refused at the
// migration and at every later startup; and the Medusa exchange table is left
// exactly as it was.

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const bridgeSchema = require('../lib/bridge-schema');

let tmpDir = null;

/**
 * The SQL of every bridge object, by name.
 * @returns {Map<string, string>}
 */
function bridgeObjects() {
  const rows = store.getDb().prepare(
    "SELECT name, sql FROM sqlite_master WHERE name LIKE 'bridge_%' OR name LIKE 'idx_bridge_%' ORDER BY name"
  ).all();
  return new Map(rows.map((r) => [r.name, r.sql]));
}

/**
 * Open a fresh store in a new temp dir.
 * @param {string} label - Temp dir label.
 * @returns {void}
 */
function freshStore(label) {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `tc-bridge-${label}-`));
  store._setBasePath(tmpDir);
  store.init();
}

/**
 * Turn the open store back into a v51 one: drop every bridge object and the newer stamp.
 * @returns {void}
 */
function rewindToV51() {
  const db = store.getDb();
  for (const object of bridgeSchema.BRIDGE_SCHEMA_OBJECTS.filter((o) => o.type === 'trigger')) {
    db.exec(`DROP TRIGGER ${object.name}`);
  }
  for (const object of bridgeSchema.BRIDGE_SCHEMA_OBJECTS.filter((o) => o.type === 'table')) {
    db.exec(`DROP TABLE ${object.name}`);
  }
  db.exec('DELETE FROM schema_version WHERE version >= 52');
  db.exec('INSERT INTO schema_version (version) VALUES (51)');
  store.close();
}

/**
 * Reopen the store in the current temp dir.
 * @returns {void}
 */
function reopen() {
  store._setBasePath(tmpDir);
  store.init();
}

describe('store: operator bridge schema (v52 to v54, #2031)', () => {
  afterEach(() => {
    store.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('a fresh install has every bridge object in its checked shape', () => {
    freshStore('fresh');
    // This file owns the exact number: v52 created the bridge's storage, v53
    // reshaped two tables, and v54 added the helper's fetch leases.
    assert.equal(store.CURRENT_SCHEMA_VERSION, 54);
    assert.equal(bridgeSchema.BRIDGE_SCHEMA_VERSION, 54);
    assert.deepEqual(bridgeSchema.bridgeSchemaProblems(store.getDb()), []);
    const have = bridgeObjects();
    for (const object of bridgeSchema.BRIDGE_SCHEMA_OBJECTS) assert.ok(have.has(object.name), `missing ${object.name}`);
  });

  it('a v51 store migrates to the same shape a fresh install has', () => {
    freshStore('v51');
    const fresh = bridgeObjects();
    rewindToV51();

    reopen();
    assert.deepEqual([...bridgeObjects()], [...fresh]);
    const version = store.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
    assert.equal(version, store.CURRENT_SCHEMA_VERSION);
  });

  it('leaves the Medusa exchange table exactly as it was', () => {
    freshStore('exchanges');
    const sql = () => store.getDb().prepare("SELECT sql FROM sqlite_master WHERE name = 'medusa_exchanges'").get().sql;
    const before = sql();
    rewindToV51();
    reopen();
    assert.equal(sql(), before);
    assert.ok(!/master-launch|sender_generation/.test(before));
  });

  /**
   * Turn the open store into one as schema v52 left it: the two tables v53
   * changed are put back in their v52 shape (no `status` kind, and a sent
   * message that did not record who it was sent to), and the stamp is 52.
   * @param {(db: object) => void} [populate] - Insert v52-era rows.
   * @returns {void}
   */
  function rewindToV52(populate) {
    const db = store.getDb();
    db.exec('DROP TABLE bridge_outbound');
    db.exec('DROP TABLE bridge_route_proofs');
    db.exec(`
      CREATE TABLE bridge_route_proofs (
        proof_id INTEGER PRIMARY KEY AUTOINCREMENT, route_id TEXT NOT NULL, direction TEXT NOT NULL, hub_id TEXT NOT NULL,
        exchange_id TEXT, in_reply_to_hub_id TEXT, sender_proof TEXT NOT NULL CHECK (sender_proof IN ('master-launch','gateway','launch')),
        master_generation INTEGER, sender_project_id INTEGER, sender_launch_id TEXT, recorded_at TEXT NOT NULL
      );
      CREATE TABLE bridge_outbound (
        outbound_id INTEGER PRIMARY KEY AUTOINCREMENT, idem_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('reply','notification','failure','candidate')), notify_type TEXT, route_id TEXT,
        candidate_id TEXT, hub_id TEXT CHECK (hub_id IS NULL OR length(hub_id) <= 128), source_label TEXT NOT NULL, text TEXT,
        digest TEXT NOT NULL, state TEXT NOT NULL, drop_code TEXT, attempts INTEGER NOT NULL DEFAULT 0, delivered_ref TEXT,
        released_generation INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, delivered_at TEXT
      );
    `);
    // Dropping a table takes its own indexes and triggers with it; put them back.
    db.exec(bridgeSchema.bridgeIndexDdl());
    if (populate) populate(db);
    db.exec('DELETE FROM schema_version WHERE version >= 53');
    db.exec('INSERT INTO schema_version (version) VALUES (52)');
    store.close();
  }

  it('upgrades a v52 store in place: both changed tables are rebuilt and keep every row and id', () => {
    freshStore('v52');
    const fresh = bridgeObjects();
    const at = '2026-10-04T00:00:00.000Z';
    rewindToV52((db) => {
      const item = db.prepare(
        "INSERT INTO bridge_outbound (idem_key, kind, notify_type, source_label, text, digest, state, created_at, updated_at) VALUES (?, 'notification', 'fleet-idle', 'TangleClaw', ?, ?, 'ready', ?, ?)"
      );
      item.run('notify:fleet-idle:1', 'first', 'a'.repeat(64), at, at);
      item.run('notify:fleet-idle:2', 'kept', 'a'.repeat(64), at, at);
      // A row that existed and was removed: its id must never be issued again.
      item.run('notify:fleet-idle:3', 'gone', 'a'.repeat(64), at, at);
      db.exec("DELETE FROM bridge_outbound WHERE idem_key = 'notify:fleet-idle:3'");
      db.prepare(
        "INSERT INTO bridge_routes (route_id, external_id, author_id, space_id, channel_id, body_digest, state, created_at, updated_at) VALUES ('r1', 'ext-r1', 'a', 's', 'c', ?, 'accepted', ?, ?)"
      ).run('a'.repeat(64), at, at);
      db.prepare(
        "INSERT INTO bridge_route_proofs (route_id, direction, hub_id, in_reply_to_hub_id, sender_proof, sender_project_id, sender_launch_id, recorded_at) VALUES ('r1', 'from-target', 'h9', 'h1', 'launch', 4, 'launch', ?)"
      ).run(at);
    });

    reopen();
    assert.deepEqual([...bridgeObjects()], [...fresh], 'the upgraded store has exactly the shape of a fresh one');
    const after = store.getDb();
    assert.deepEqual(after.prepare('SELECT outbound_id, idem_key, text FROM bridge_outbound ORDER BY outbound_id').all().map((r) => [r.outbound_id, r.idem_key, r.text]),
      [[1, 'notify:fleet-idle:1', 'first'], [2, 'notify:fleet-idle:2', 'kept']]);
    assert.deepEqual(after.prepare('SELECT hub_id, in_reply_to_hub_id FROM bridge_route_proofs').all().map((r) => [r.hub_id, r.in_reply_to_hub_id]),
      [['h9', 'h1']]);
    const next = after.prepare(
      "INSERT INTO bridge_outbound (idem_key, kind, notify_type, source_label, text, digest, state, created_at, updated_at) VALUES ('notify:fleet-idle:4', 'notification', 'fleet-idle', 'TangleClaw', 'new', ?, 'ready', ?, ?)"
    ).run('a'.repeat(64), at, at);
    assert.equal(Number(next.lastInsertRowid), 4, 'the id of a removed row is not reused');
    assert.equal(after.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%_superseded'").get().n, 0);
    assert.equal(after.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, store.CURRENT_SCHEMA_VERSION);
  });

  it('booting an upgraded store again changes nothing', () => {
    freshStore('reboot');
    rewindToV52();
    reopen();
    const once = [...bridgeObjects()];
    const stamps = () => store.getDb().prepare('SELECT version FROM schema_version ORDER BY version').all().map((r) => r.version);
    const stamped = stamps();
    store.close();
    reopen();
    store.close();
    reopen();
    assert.deepEqual([...bridgeObjects()], once);
    assert.deepEqual(stamps(), stamped);
    assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_audit_anchor').get().n, 1);
  });

  it('refuses a v52 store with a bridge table missing, and does not advance the stamp', () => {
    freshStore('half');
    rewindToV52();
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
    raw.exec('DROP TABLE bridge_nonces');
    raw.close();
    store._setBasePath(tmpDir);
    assert.throws(() => store.init(), /not a sound v52 store.*bridge_nonces/);
    store.close();
    const check = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
    assert.equal(check.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 52);
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%_superseded'").get().n, 0, 'nothing was set aside');
    check.close();
  });

  it('refuses a v52 store with a misshapen bridge table, and does not advance the stamp', () => {
    freshStore('malformed');
    rewindToV52();
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
    raw.exec('DROP TABLE bridge_outbound');
    raw.exec('CREATE TABLE bridge_outbound (outbound_id INTEGER PRIMARY KEY, hub_id TEXT UNIQUE, text TEXT)');
    raw.close();
    store._setBasePath(tmpDir);
    assert.throws(() => store.init(), /not a sound v52 store.*bridge_outbound/);
    store.close();
    const check = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
    assert.equal(check.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 52);
    check.close();
  });

  it('is a superset of v52: everything a server from before v53 required still holds', () => {
    freshStore('superset');
    assert.deepEqual(bridgeSchema.bridgeSchemaProblems(store.getDb(), null, 52), []);
    assert.deepEqual(bridgeSchema.bridgeSchemaProblems(store.getDb(), null, 53), []);
    store.close();
    freshStore('superset-upgraded');
    rewindToV52();
    reopen();
    assert.deepEqual(bridgeSchema.bridgeSchemaProblems(store.getDb(), null, 52), []);
  });

  /**
   * Turn the open store into one as schema v53 left it: no lease table, and a
   * helper-token table without the revoked-time check. The stamp is 53.
   * @param {(db: object) => void} [populate] - Insert v53-era rows.
   * @returns {void}
   */
  function rewindToV53(populate) {
    const db = store.getDb();
    db.exec('DROP TABLE bridge_outbound_leases');
    db.exec('DROP TABLE bridge_outbound_claims');
    db.exec('DROP TABLE bridge_outbound_parts');
    db.exec('DROP TABLE bridge_route_reply_context');
    db.exec('DROP TRIGGER bridge_routes_delete_reply_context');
    db.exec('DROP TABLE bridge_helper_tokens');
    db.exec('DROP TRIGGER bridge_outbound_delete_leases');
    db.exec(`
      CREATE TABLE bridge_helper_tokens (
        token_id    TEXT PRIMARY KEY CHECK (length(token_id) BETWEEN 1 AND 64),
        token_hash  TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
        status      TEXT NOT NULL CHECK (status IN ('active','revoked')),
        created_by  TEXT NOT NULL CHECK (created_by IN ('operator')),
        created_at  TEXT NOT NULL,
        revoked_at  TEXT
      );
      CREATE UNIQUE INDEX idx_bridge_helper_tokens_active ON bridge_helper_tokens(status) WHERE status = 'active';
    `);
    // The two v52 tables v54 reshapes, put back as v53 had them: no set-aside
    // state on an item, and no resolution by a posted message's record.
    const asV53 = {
      bridge_outbound: (sql) => sql.replace("'ready','blocked','delivered','dropped'", "'ready','delivered','dropped'")
        .split('\n').filter((line) => !/block_code|An item set aside/.test(line)).join('\n'),
      bridge_routes: (sql) => sql.replace("'outbound-correlation',", '')
    };
    for (const [table, reshape] of Object.entries(asV53)) {
      const now = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table).sql;
      const was = reshape(now).replace('CREATE TABLE IF NOT EXISTS', 'CREATE TABLE');
      assert.notEqual(was, now, `${table} differs between v53 and v54`);
      assert.ok(!/'blocked'|block_code|outbound-correlation/.test(was), `${table} is back in its v53 shape`);
      db.exec(`DROP TABLE ${table}`);
      db.exec(was);
    }
    for (const trigger of bridgeSchema.BRIDGE_SCHEMA_OBJECTS.filter((o) => o.type === 'trigger' && (o.since || 52) > 53)) {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}`);
    }
    // Dropping a table takes its own indexes and triggers with it; put back those v53 had.
    db.exec(bridgeSchema.bridgeIndexDdl().split(/;\s*\n/).filter((stmt) => !/bridge_outbound_(leases|claims|parts)|bridge_route_reply_context/.test(stmt)).join(';\n'));
    if (populate) populate(db);
    db.exec('DELETE FROM schema_version WHERE version >= 54');
    db.exec('INSERT INTO schema_version (version) VALUES (53)');
    store.close();
  }

  it('upgrades a v53 store: the lease table appears and the helper tokens keep their rows', () => {
    freshStore('v53');
    const fresh = bridgeObjects();
    const at = '2026-10-04T00:00:00.000Z';
    rewindToV53((db) => {
      const token = db.prepare('INSERT INTO bridge_helper_tokens (token_id, token_hash, status, created_by, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)');
      token.run('t-old', 'e'.repeat(64), 'revoked', 'operator', at, at);
      token.run('t-live', 'f'.repeat(64), 'active', 'operator', at, null);
    });
    reopen();
    assert.deepEqual([...bridgeObjects()], [...fresh], 'the upgraded store has exactly the shape of a fresh one');
    const db = store.getDb();
    assert.deepEqual(db.prepare('SELECT token_id, status FROM bridge_helper_tokens ORDER BY token_id').all().map((r) => [r.token_id, r.status]),
      [['t-live', 'active'], ['t-old', 'revoked']]);
    assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 54);
    assert.throws(() => db.exec("UPDATE bridge_helper_tokens SET status = 'revoked' WHERE token_id = 't-live'"), /CHECK/,
      'a token can no longer be revoked without recording when');
  });

  it('refuses a v53 store whose rows the new check would not admit, and leaves the stamp at 53', () => {
    freshStore('v53-bad-row');
    rewindToV53((db) => {
      // Revoked, with no time recorded: a state the v53 table allowed.
      db.prepare("INSERT INTO bridge_helper_tokens (token_id, token_hash, status, created_by, created_at) VALUES ('t-bad', ?, 'revoked', 'operator', 'x')").run('e'.repeat(64));
    });
    store._setBasePath(tmpDir);
    assert.throws(() => store.init(), /CHECK/);
    store.close();
    const { DatabaseSync } = require('node:sqlite');
    const check = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
    assert.equal(check.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 53);
    assert.equal(check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%_superseded'").get().n, 0, 'nothing was left set aside');
    assert.equal(check.prepare("SELECT status FROM bridge_helper_tokens WHERE token_id = 't-bad'").get().status, 'revoked', 'and its row is untouched');
    check.close();
  });

  it('refuses a v53 store that is not sound, before touching it', () => {
    freshStore('v53-unsound');
    rewindToV53();
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
    raw.exec('DROP INDEX idx_bridge_outbound_status');
    raw.close();
    store._setBasePath(tmpDir);
    assert.throws(() => store.init(), /not a sound v53 store.*idx_bridge_outbound_status/);
    store.close();
    const check = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
    assert.equal(check.prepare('SELECT MAX(version) AS v FROM schema_version').get().v, 53);
    check.close();
  });

  it('v54 is a superset of v53 and of v52: what each earlier server required still holds', () => {
    freshStore('superset-54');
    for (const version of [52, 53, 54]) assert.deepEqual(bridgeSchema.bridgeSchemaProblems(store.getDb(), null, version), [], `v${version}`);
    store.close();
    freshStore('superset-54-upgraded');
    rewindToV53();
    reopen();
    for (const version of [52, 53, 54]) assert.deepEqual(bridgeSchema.bridgeSchemaProblems(store.getDb(), null, version), [], `v${version} after upgrade`);
  });

  it('a lease is fixed once issued, final once settled, one live per item, and goes with its item', () => {
    freshStore('leases');
    const db = store.getDb();
    const at = '2026-10-04T00:00:00.000Z';
    const later = '2026-10-04T00:02:00.000Z';
    db.prepare(
      "INSERT INTO bridge_outbound (idem_key, kind, notify_type, source_label, text, digest, state, created_at, updated_at) VALUES ('n:1', 'notification', 'fleet-idle', 'TangleClaw', 'x', ?, 'ready', ?, ?)"
    ).run('a'.repeat(64), at, at);
    const claim = 'claim-nonce-00000001';
    const lease = db.prepare(
      'INSERT INTO bridge_outbound_leases (lease_id, claim_nonce, outbound_id, item_digest, token_id, state, issued_at, expires_at) '
      + `VALUES (?, '${claim}', ?, ?, 't1', 'live', ?, ?)`
    );
    assert.throws(() => lease.run('lease-0000000000000008', 1, 'a'.repeat(64), at, later), /needs the claim/);
    db.prepare("INSERT INTO bridge_outbound_claims (claim_nonce, token_id, request_digest, claimed_at) VALUES (?, 't1', ?, ?)").run(claim, 'b'.repeat(64), at);
    assert.throws(() => db.exec("UPDATE bridge_outbound_claims SET token_id = 't2'"), /fixed once recorded/);
    assert.throws(() => lease.run('lease-0000000000000009', 99, 'a'.repeat(64), at, later), /needs its item/);
    assert.throws(() => lease.run('lease-0000000000000000', 1, 'a'.repeat(64), later, at), /CHECK/, 'it lapses after it is issued');
    lease.run('lease-0000000000000001', 1, 'a'.repeat(64), at, later);
    assert.throws(() => lease.run('lease-0000000000000002', 1, 'a'.repeat(64), at, later), /UNIQUE/, 'one live lease per item');
    assert.throws(() => db.exec("UPDATE bridge_outbound_leases SET token_id = 't2'"), /fixed once issued/);
    assert.throws(() => db.exec("UPDATE bridge_outbound_leases SET expires_at = '2027-01-01T00:00:00.000Z'"), /fixed once issued/);
    assert.throws(() => db.exec("UPDATE bridge_outbound_leases SET state = 'used'"), /CHECK/, 'settling records when');
    db.exec(`UPDATE bridge_outbound_leases SET state = 'used', settled_at = '${later}'`);
    assert.throws(() => db.exec(`UPDATE bridge_outbound_leases SET state = 'lapsed', settled_at = '${later}'`), /final once settled/);
    lease.run('lease-0000000000000003', 1, 'a'.repeat(64), at, later);
    db.exec('DELETE FROM bridge_outbound WHERE outbound_id = 1');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bridge_outbound_leases').get().n, 0);
  });

  it('admits one fixed status item per route, and only for a route', () => {
    freshStore('status');
    const db = store.getDb();
    const at = '2026-10-04T00:00:00.000Z';
    db.prepare(
      "INSERT INTO bridge_routes (route_id, external_id, author_id, space_id, channel_id, body_digest, state, created_at, updated_at) VALUES ('r1', 'ext-r1', 'a', 's', 'c', ?, 'accepted', ?, ?)"
    ).run('a'.repeat(64), at, at);
    const item = db.prepare(
      'INSERT INTO bridge_outbound (idem_key, kind, route_id, released_generation, source_label, text, digest, state, created_at, updated_at) '
      + "VALUES (?, 'status', ?, ?, 'TangleClaw', 'x', ?, 'ready', ?, ?) ON CONFLICT(idem_key) DO NOTHING"
    );
    assert.equal(item.run('route:r1:pending', 'r1', null, 'a'.repeat(64), at, at).changes, 1);
    assert.equal(item.run('route:r1:pending', 'r1', null, 'a'.repeat(64), at, at).changes, 0, 'one per route');
    assert.throws(() => db.prepare(
      'INSERT INTO bridge_outbound (idem_key, kind, route_id, source_label, text, digest, state, created_at, updated_at) '
      + "VALUES ('route:r1:another', 'status', 'r1', 'TangleClaw', 'x', ?, 'ready', ?, ?)"
    ).run('a'.repeat(64), at, at), /UNIQUE/, 'a second status item under another key is still refused');
    assert.throws(() => item.run('route:none:pending', null, null, 'a'.repeat(64), at, at), /CHECK/);
    assert.throws(() => item.run('route:r1:pending2', 'r1', 3, 'a'.repeat(64), at, at), /CHECK/, 'nobody released it: the server wrote it');
  });

  it('refuses to advance over a bridge table of the wrong shape', () => {
    freshStore('misshapen');
    rewindToV51();
    // An outbound table from the superseded design: no idempotency key of its
    // own, so nothing could tell two notifications apart.
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
    raw.exec('CREATE TABLE bridge_outbound (outbound_id INTEGER PRIMARY KEY, hub_id TEXT UNIQUE, text TEXT)');
    raw.close();

    store._setBasePath(tmpDir);
    assert.throws(() => store.init(), /bridge_outbound/);
    store.close();
    const check = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
    const version = check.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
    check.close();
    assert.equal(version, 51);
  });

  it('refuses at startup when a bridge object goes missing after the migration', () => {
    freshStore('tampered');
    store.getDb().exec('DROP TRIGGER bridge_audit_append_only_delete');
    store.close();
    // The table DDL would quietly put a missing TABLE back; a store that lost
    // an index it rests on is the case only the startup check sees.
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
    raw.exec('DROP INDEX idx_bridge_route_proofs_hub');
    raw.exec('CREATE INDEX idx_bridge_route_proofs_hub ON bridge_route_proofs(hub_id)');
    raw.close();

    store._setBasePath(tmpDir);
    assert.throws(() => store.init(), /idx_bridge_route_proofs_hub/);
  });
});

describe('store: operator bridge constraints (#2031)', () => {
  afterEach(() => {
    store.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  const at = '2026-10-04T00:00:00.000Z';
  const digest = 'a'.repeat(64);

  it('keeps the audit append-only', () => {
    freshStore('audit');
    const db = store.getDb();
    db.prepare(
      "INSERT INTO bridge_audit (op, request_id, actor, proof, outcome, at) VALUES ('close', 'req-00000001', 'operator', 'operator', 'applied', ?)"
    ).run(at);
    assert.throws(() => db.exec("UPDATE bridge_audit SET outcome = 'changed'"), /append-only/);
    assert.throws(() => db.exec('DELETE FROM bridge_audit'), /append-only/);
  });

  it('refuses an audit row for Master that names no generation', () => {
    freshStore('audit-gen');
    assert.throws(() => store.getDb().prepare(
      "INSERT INTO bridge_audit (op, actor, proof, outcome, at) VALUES ('close', 'master', 'master-launch', 'applied', ?)"
    ).run(at), /CHECK/);
  });

  it('allows one live Master generation and one active helper token', () => {
    freshStore('single');
    const db = store.getDb();
    const mint = db.prepare('INSERT INTO bridge_master_credentials (generation, credential_hash, status, minted_at) VALUES (?, ?, ?, ?)');
    const revoked = db.prepare("INSERT INTO bridge_master_credentials (generation, credential_hash, status, minted_at, revoked_at) VALUES (?, ?, 'revoked', ?, ?)");
    mint.run(1, 'b'.repeat(64), 'active', at);
    assert.throws(() => mint.run(2, 'c'.repeat(64), 'active', at), /UNIQUE/);
    assert.throws(() => mint.run(2, 'c'.repeat(64), 'pending', at), /UNIQUE/, 'pending and active are one slot');
    revoked.run(2, 'c'.repeat(64), at, at);
    assert.throws(() => mint.run(3, 'f'.repeat(64), 'revoked', at), /CHECK/, 'a revoked generation records when');

    const token = db.prepare("INSERT INTO bridge_helper_tokens (token_id, token_hash, status, created_by, created_at) VALUES (?, ?, 'active', 'operator', ?)");
    token.run('t1', 'd'.repeat(64), at);
    assert.throws(() => token.run('t2', 'e'.repeat(64), at), /UNIQUE/);
  });

  it('gives every outbound item its own idempotency key and no synthetic Hub id', () => {
    freshStore('outbound');
    const db = store.getDb();
    const insert = db.prepare(
      'INSERT INTO bridge_outbound (idem_key, kind, notify_type, source_label, text, digest, state, created_at, updated_at) '
      + "VALUES (?, 'notification', ?, 'TangleClaw', 'x', ?, 'ready', ?, ?) ON CONFLICT(idem_key) DO NOTHING"
    );
    assert.equal(insert.run('notify:fleet-idle:1', 'fleet-idle', digest, at, at).changes, 1);
    assert.equal(insert.run('notify:fleet-idle:1', 'fleet-idle', digest, at, at).changes, 0);
    assert.equal(insert.run('notify:fleet-idle:2', 'fleet-idle', digest, at, at).changes, 1);
    const rows = db.prepare('SELECT hub_id FROM bridge_outbound').all();
    assert.deepEqual(rows.map((r) => r.hub_id), [null, null]);
    // A reserved notification type has no producer yet and is not storable.
    assert.throws(() => insert.run('notify:x:1', 'release-action-needed', digest, at, at), /CHECK/);
  });

  /**
   * Insert a bare route row.
   * @param {string} id - Route id.
   * @returns {void}
   */
  function route(id) {
    store.getDb().prepare(
      "INSERT INTO bridge_routes (route_id, external_id, author_id, space_id, channel_id, body_digest, state, created_at, updated_at) VALUES (?, ?, 'a', 's', 'c', ?, 'accepted', ?, ?)"
    ).run(id, `ext-${id}`, digest, at, at);
  }

  it('refuses a reply that was not released by a Master generation', () => {
    freshStore('reply');
    route('r1');
    assert.throws(() => store.getDb().prepare(
      'INSERT INTO bridge_outbound (idem_key, kind, route_id, source_label, text, digest, state, created_at, updated_at) '
      + "VALUES ('route:r1:answer', 'reply', 'r1', 'Master', 'x', ?, 'ready', ?, ?)"
    ).run(digest, at, at), /CHECK/);
  });

  it('refuses a reply proof that does not name its launch, project and the message it answers', () => {
    freshStore('proof');
    const db = store.getDb();
    route('r1');
    route('r2');
    assert.throws(() => db.prepare(
      "INSERT INTO bridge_route_proofs (route_id, direction, hub_id, sender_proof, recorded_at) VALUES ('r1', 'from-target', 'h2', 'launch', ?)"
    ).run(at), /CHECK/);
    assert.throws(() => db.prepare(
      "INSERT INTO bridge_route_proofs (route_id, direction, hub_id, sender_proof, recorded_at) VALUES ('r1', 'to-target', 'h1', 'master-launch', ?)"
    ).run(at), /CHECK/);
    db.prepare(
      "INSERT INTO bridge_route_proofs (route_id, direction, hub_id, sender_proof, master_generation, target_project_id, target_workspace_id, target_session_id, target_launch_id, recorded_at) VALUES ('r1', 'to-target', 'h1', 'master-launch', 3, 9, 'ws', 5, 'launch', ?)"
    ).run(at);
    // A message the bridge sent must say exactly who it went to.
    assert.throws(() => db.prepare(
      "INSERT INTO bridge_route_proofs (route_id, direction, hub_id, sender_proof, recorded_at) VALUES ('r1', 'to-target', 'h3', 'gateway', ?)"
    ).run(at), /CHECK/);
    assert.throws(() => db.prepare(
      "INSERT INTO bridge_route_proofs (route_id, direction, hub_id, sender_proof, target_workspace_id, target_session_id, target_launch_id, recorded_at) VALUES ('r1', 'to-target', 'h4', 'gateway', 'ws', 5, 'launch', ?)"
    ).run(at), /CHECK/, 'the project is part of who it went to');
    // A proof is never changed afterwards.
    assert.throws(() => db.exec("UPDATE bridge_route_proofs SET target_session_id = 6"), /immutable/);
    // One Hub message belongs to one route.
    assert.throws(() => db.prepare(
      "INSERT INTO bridge_route_proofs (route_id, direction, hub_id, sender_proof, master_generation, target_project_id, target_workspace_id, target_session_id, target_launch_id, recorded_at) VALUES ('r2', 'to-target', 'h1', 'master-launch', 3, 9, 'ws', 5, 'launch', ?)"
    ).run(at), /UNIQUE/);
  });

  it('refuses a child row whose parent does not exist', () => {
    freshStore('orphans');
    const db = store.getDb();
    assert.throws(() => db.prepare(
      "INSERT INTO bridge_route_bodies (route_id, role, text, digest, created_at) VALUES ('none', 'inbound', 'x', ?, ?)"
    ).run(digest, at), /needs its route/);
    assert.throws(() => db.prepare(
      "INSERT INTO bridge_route_proofs (route_id, direction, hub_id, sender_proof, master_generation, recorded_at) VALUES ('none', 'to-target', 'h9', 'master-launch', 1, ?)"
    ).run(at), /needs its route/);
    assert.throws(() => db.prepare(
      'INSERT INTO bridge_outbound (idem_key, kind, route_id, source_label, text, digest, state, created_at, updated_at) '
      + "VALUES ('route:none:failure', 'failure', 'none', 'TangleClaw', 'x', ?, 'ready', ?, ?)"
    ).run(digest, at, at), /needs its route or candidate/);
    assert.throws(() => db.prepare(
      'INSERT INTO bridge_candidates (candidate_id, idem_key, kind, source_project_id, source_launch_id, text, digest, state, created_at) '
      + "VALUES ('c1', 'cand:1', 'milestone', 424242, 'launch', 'x', ?, 'submitted', ?)"
    ).run(digest, at), /needs its source project/);
    assert.throws(() => db.prepare(
      "INSERT INTO bridge_candidate_receipts (candidate_id, receipt_kind, receipt_id, receipt_digest) VALUES ('none', 'workload', 'w1', ?)"
    ).run(digest), /needs its candidate/);
  });

  it('binds a candidate to its receipts by id and digest, immutably', () => {
    freshStore('receipts');
    const db = store.getDb();
    const project = store.projects.create({ name: 'p', path: path.join(tmpDir, 'p') });
    db.prepare(
      'INSERT INTO bridge_candidates (candidate_id, idem_key, kind, source_project_id, source_launch_id, text, digest, state, created_at) '
      + "VALUES ('c1', 'cand:1', 'milestone', ?, 'launch', 'x', ?, 'submitted', ?)"
    ).run(project.id, digest, at);
    const bind = db.prepare('INSERT INTO bridge_candidate_receipts (candidate_id, receipt_kind, receipt_id, receipt_digest) VALUES (?, ?, ?, ?)');
    bind.run('c1', 'workload', 'w1', digest);
    assert.throws(() => bind.run('c1', 'workload', 'w1', 'b'.repeat(64)), /UNIQUE|PRIMARY/);
    assert.throws(() => db.exec("UPDATE bridge_candidate_receipts SET receipt_digest = 'x'"), /immutable/);
    db.exec("DELETE FROM bridge_candidates WHERE candidate_id = 'c1'");
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bridge_candidate_receipts').get().n, 0);
  });

  it('removing a route removes its bodies, proofs and outbound items', () => {
    freshStore('cascade');
    const db = store.getDb();
    route('r1');
    db.prepare("INSERT INTO bridge_route_bodies (route_id, role, text, digest, created_at) VALUES ('r1', 'inbound', 'x', ?, ?)").run(digest, at);
    db.prepare("INSERT INTO bridge_route_proofs (route_id, direction, hub_id, sender_proof, master_generation, target_project_id, target_workspace_id, target_session_id, target_launch_id, recorded_at) VALUES ('r1', 'to-target', 'h1', 'master-launch', 1, 9, 'ws', 5, 'launch', ?)").run(at);
    db.prepare(
      'INSERT INTO bridge_outbound (idem_key, kind, route_id, source_label, text, digest, state, created_at, updated_at) '
      + "VALUES ('route:r1:failure', 'failure', 'r1', 'TangleClaw', 'x', ?, 'ready', ?, ?)"
    ).run(digest, at, at);
    db.exec("DELETE FROM bridge_routes WHERE route_id = 'r1'");
    for (const table of ['bridge_route_bodies', 'bridge_route_proofs', 'bridge_outbound']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
    }
  });

  it('gives every terminal row the timestamp retention works from', () => {
    freshStore('terminal');
    const db = store.getDb();
    route('r1');
    assert.throws(() => db.exec("UPDATE bridge_routes SET state = 'closed' WHERE route_id = 'r1'"), /CHECK/);
    assert.throws(() => db.exec(`UPDATE bridge_routes SET closed_at = '${at}' WHERE route_id = 'r1'`), /CHECK/);
    db.exec(`UPDATE bridge_routes SET state = 'closed', closed_at = '${at}' WHERE route_id = 'r1'`);
    const item = db.prepare(
      'INSERT INTO bridge_outbound (idem_key, kind, notify_type, source_label, text, digest, state, delivered_at, created_at, updated_at) '
      + "VALUES (?, 'notification', 'fleet-idle', 'TangleClaw', 'x', ?, ?, ?, ?, ?)"
    );
    assert.throws(() => item.run('n:1', digest, 'delivered', null, at, at), /CHECK/);
    assert.throws(() => item.run('n:1', digest, 'ready', at, at, at), /CHECK/);
    item.run('n:1', digest, 'delivered', at, at, at);
  });

  it('keeps an unresolved route free of destination fields and ties a generation to a Master decision', () => {
    freshStore('route-checks');
    const db = store.getDb();
    route('r1');
    const set = (sql) => () => db.exec(`UPDATE bridge_routes SET ${sql} WHERE route_id = 'r1'`);
    assert.throws(set("destination_workspace_id = 'ws'"), /CHECK/);
    assert.throws(set('resolved_generation = 2'), /CHECK/);
    assert.throws(set("resolved_by = 'master', destination_kind = 'master'"), /CHECK/, 'a Master decision needs its generation');
    assert.throws(set("resolved_by = 'alias', destination_kind = 'master', resolved_generation = 2"), /CHECK/, 'a mechanical resolution has none');
    set("resolved_by = 'master', destination_kind = 'project', destination_project_id = 5, resolved_generation = 2")();
    set("resolved_by = 'default', destination_kind = 'master', destination_project_id = NULL, resolved_generation = NULL")();
  });

  it('lets audit rows leave only behind the anchor, which is one row and only moves forward', () => {
    freshStore('anchor');
    const db = store.getDb();
    const add = db.prepare("INSERT INTO bridge_audit (op, actor, proof, outcome, at) VALUES ('close', 'operator', 'operator', 'applied', ?)");
    add.run(at);
    add.run(at);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM bridge_audit_anchor').get().n, 1, 'seeded at creation');
    const move = (sql) => () => db.exec(`UPDATE bridge_audit_anchor SET ${sql}`);
    move(`through_seq = 1, removed_count = 1, compactions = 1, chain_digest = '${digest}'`)();
    assert.equal(db.prepare('DELETE FROM bridge_audit WHERE audit_seq = 1').run().changes, 1);
    assert.throws(() => db.exec('DELETE FROM bridge_audit WHERE audit_seq = 2'), /append-only/);
    assert.throws(move('through_seq = 0, removed_count = 2, compactions = 2'), /only moves forward/);
    assert.throws(move('through_seq = 2, removed_count = 1, compactions = 2'), /only moves forward/);
    assert.throws(move('through_seq = 2, removed_count = 2, compactions = 5'), /only moves forward/);
    assert.throws(() => db.exec('DELETE FROM bridge_audit_anchor'), /permanent/);
    assert.throws(() => db.exec(
      "INSERT INTO bridge_audit_anchor (anchor_id, through_seq, removed_count, compactions, updated_at) VALUES (2, 0, 0, 0, 'x')"
    ), /CHECK/);
  });

  it('keeps global pins for the operator, one active pin per conversation in each scope', () => {
    freshStore('pins');
    const db = store.getDb();
    const pin = db.prepare(
      'INSERT INTO bridge_pins (pin_id, scope, conversation_key, destination_kind, created_by, master_generation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    assert.throws(() => pin.run('p0', 'global', null, 'master', 'master', 1, at), /CHECK/, 'Master cannot hold a global pin');
    assert.throws(() => pin.run('p0', 'conversation', null, 'master', 'master', 1, at), /CHECK/, 'a conversation pin names its conversation');
    pin.run('p1', 'conversation', 'chan:1', 'master', 'master', 1, at);
    assert.throws(() => pin.run('p2', 'conversation', 'chan:1', 'master', 'master', 1, at), /UNIQUE/);
    // The operator may pin every conversation, and any number of single ones.
    pin.run('p3', 'global', null, 'master', 'operator', null, at);
    pin.run('p4', 'global', 'chan:1', 'master', 'operator', null, at);
    pin.run('p5', 'global', 'chan:2', 'master', 'operator', null, at);
    assert.throws(() => pin.run('p6', 'global', null, 'master', 'operator', null, at), /UNIQUE/);
    assert.throws(() => pin.run('p7', 'global', 'chan:1', 'master', 'operator', null, at), /UNIQUE/);
    db.exec("UPDATE bridge_pins SET revoked_at = '2026-10-05T00:00:00.000Z' WHERE pin_id = 'p4'");
    pin.run('p8', 'global', 'chan:1', 'master', 'operator', null, at);
  });
});
