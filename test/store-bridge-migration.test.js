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

describe('store: operator bridge schema (v52, #2031)', () => {
  afterEach(() => {
    store.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = null;
  });

  it('a fresh install has every bridge object in its checked shape', () => {
    freshStore('fresh');
    assert.ok(store.CURRENT_SCHEMA_VERSION >= 52);
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
    mint.run(1, 'b'.repeat(64), 'active', at);
    assert.throws(() => mint.run(2, 'c'.repeat(64), 'active', at), /UNIQUE/);
    assert.throws(() => mint.run(2, 'c'.repeat(64), 'pending', at), /UNIQUE/, 'pending and active are one slot');
    mint.run(2, 'c'.repeat(64), 'revoked', at);

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
      "INSERT INTO bridge_route_proofs (route_id, direction, hub_id, sender_proof, master_generation, recorded_at) VALUES ('r1', 'to-target', 'h1', 'master-launch', 3, ?)"
    ).run(at);
    // One Hub message belongs to one route.
    assert.throws(() => db.prepare(
      "INSERT INTO bridge_route_proofs (route_id, direction, hub_id, sender_proof, master_generation, recorded_at) VALUES ('r2', 'to-target', 'h1', 'master-launch', 3, ?)"
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
    db.prepare("INSERT INTO bridge_route_proofs (route_id, direction, hub_id, sender_proof, master_generation, recorded_at) VALUES ('r1', 'to-target', 'h1', 'master-launch', 1, ?)").run(at);
    db.prepare(
      'INSERT INTO bridge_outbound (idem_key, kind, route_id, source_label, text, digest, state, created_at, updated_at) '
      + "VALUES ('route:r1:failure', 'failure', 'r1', 'TangleClaw', 'x', ?, 'ready', ?, ?)"
    ).run(digest, at, at);
    db.exec("DELETE FROM bridge_routes WHERE route_id = 'r1'");
    for (const table of ['bridge_route_bodies', 'bridge_route_proofs', 'bridge_outbound']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0, table);
    }
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

  it('lets a compaction remove audit rows it has recorded, and nothing else', () => {
    freshStore('compaction');
    const db = store.getDb();
    const add = db.prepare("INSERT INTO bridge_audit (op, actor, proof, outcome, at) VALUES ('close', 'operator', 'operator', 'applied', ?)");
    add.run(at);
    add.run(at);
    db.prepare('INSERT INTO bridge_audit_compactions (through_seq, row_count, rows_digest, at) VALUES (1, 1, ?, ?)').run(digest, at);
    assert.equal(db.prepare('DELETE FROM bridge_audit WHERE audit_seq = 1').run().changes, 1);
    assert.throws(() => db.exec('DELETE FROM bridge_audit WHERE audit_seq = 2'), /append-only/);
    assert.throws(() => db.exec('UPDATE bridge_audit_compactions SET row_count = 9'), /append-only/);
    assert.throws(() => db.exec('DELETE FROM bridge_audit_compactions'), /append-only/);
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
