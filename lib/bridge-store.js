'use strict';

/*
 * Durable state of the Master-mediated operator bridge (ADR 0023, #2031).
 *
 * Everything the gateway remembers lives in the tables of lib/bridge-schema.js
 * and is read and written here. Callers pass decisions in; this module makes
 * each one atomic, idempotent on its request id, checked against the route's
 * version, and audited on first use, refusals included.
 */

const crypto = require('node:crypto');
const store = require('./store');
const { ROUTE_STATES } = require('./bridge-schema');

/** Longest list a single read returns. */
const MAX_LIST = 100;

/** States in which a route still needs somebody's attention. */
const OPEN_ROUTE_STATES = Object.freeze(ROUTE_STATES.filter((s) => s !== 'closed'));

/**
 * Run `fn` as one write transaction.
 * @param {() => *} fn - Synchronous work.
 * @returns {*} Whatever `fn` returns.
 */
function transaction(fn) {
  const db = store.getDb();
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn(db);
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* nothing to roll back */ }
    throw err;
  }
}

/**
 * The current time as an ISO string; a seam so a caller can fix it.
 * @param {string} [at] - Explicit timestamp.
 * @returns {string}
 */
function _now(at) {
  return at || new Date().toISOString();
}

const settings = {
  /**
   * Read one bridge setting.
   * @param {string} key - Setting name.
   * @returns {string|null} The stored value, or null when unset.
   */
  get(key) {
    const row = store.getDb().prepare('SELECT value FROM bridge_settings WHERE key = ?').get(key);
    return row ? row.value : null;
  },

  /**
   * Write one bridge setting. The operator is the only writer there is.
   * @param {string} key - Setting name.
   * @param {string|null} value - New value.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {void}
   */
  set(key, value, options = {}) {
    store.getDb().prepare(
      "INSERT INTO bridge_settings (key, value, updated_by, updated_at) VALUES (?, ?, 'operator', ?) "
      + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at'
    ).run(key, value, _now(options.at));
  },

  /**
   * Whether the operator has enabled the bridge. Off until they say otherwise.
   * @returns {boolean}
   */
  isEnabled() {
    return settings.get('enabled') === 'true';
  }
};

const masterCredentials = {
  /**
   * Record a newly minted credential's hash as the next generation, revoking
   * every generation still live. The new row is `pending` until the credential
   * is known to have reached the Master pane.
   * @param {string} credentialHash - SHA-256 of the credential, hex.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {number} The new generation.
   */
  mint(credentialHash, options = {}) {
    const at = _now(options.at);
    return transaction((db) => {
      db.prepare(
        "UPDATE bridge_master_credentials SET status = 'revoked', revoked_at = ?, revoke_reason = 'superseded' "
        + "WHERE status IN ('pending','active')"
      ).run(at);
      const next = db.prepare('SELECT COALESCE(MAX(generation), 0) + 1 AS g FROM bridge_master_credentials').get().g;
      db.prepare(
        "INSERT INTO bridge_master_credentials (generation, credential_hash, status, minted_at) VALUES (?, ?, 'pending', ?)"
      ).run(next, credentialHash, at);
      return next;
    });
  },

  /**
   * Mark a pending generation as delivered to the Master pane. Named by its
   * hash as well as its number, so a handoff that settles late can only ever
   * touch the row it minted.
   * @param {number} generation - Generation to activate.
   * @param {string} credentialHash - SHA-256 of that generation's credential, hex.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {boolean} False when that generation is no longer pending.
   */
  activate(generation, credentialHash, options = {}) {
    const result = store.getDb().prepare(
      "UPDATE bridge_master_credentials SET status = 'active', delivered_at = ? "
      + "WHERE generation = ? AND credential_hash = ? AND status = 'pending'"
    ).run(_now(options.at), generation, credentialHash);
    return result.changes === 1;
  },

  /**
   * Revoke every live generation, or one named generation.
   * @param {string} reason - Closed reason code.
   * @param {object} [options]
   * @param {number} [options.generation] - Revoke only this generation; needs `credentialHash`.
   * @param {string} [options.credentialHash] - Hash of the generation being revoked.
   * @param {string} [options.at] - Timestamp override.
   * @returns {number} How many generations were revoked.
   */
  revoke(reason, options = {}) {
    const at = _now(options.at);
    const db = store.getDb();
    const result = options.generation
      ? db.prepare(
        "UPDATE bridge_master_credentials SET status = 'revoked', revoked_at = ?, revoke_reason = ? "
        + "WHERE generation = ? AND credential_hash = ? AND status IN ('pending','active')"
      ).run(at, reason, options.generation, options.credentialHash)
      : db.prepare(
        "UPDATE bridge_master_credentials SET status = 'revoked', revoked_at = ?, revoke_reason = ? "
        + "WHERE status IN ('pending','active')"
      ).run(at, reason);
    return Number(result.changes);
  },

  /**
   * Revoke a generation still waiting for its handoff. Nothing carries a
   * handoff across a server restart, so a pending row found at boot can never
   * become active.
   * @param {string} reason - Closed reason code.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {number} How many generations were revoked.
   */
  revokePending(reason, options = {}) {
    const result = store.getDb().prepare(
      "UPDATE bridge_master_credentials SET status = 'revoked', revoked_at = ?, revoke_reason = ? WHERE status = 'pending'"
    ).run(_now(options.at), reason);
    return Number(result.changes);
  },

  /**
   * The active generation, if the presented hash is its hash. Compared in
   * constant time against the one active row rather than looked up by value.
   * @param {string} credentialHash - SHA-256 of the presented credential, hex.
   * @returns {{generation: number, status: string}|null} Null unless the hash
   *   is the active generation's.
   */
  findActive(credentialHash) {
    const row = store.getDb().prepare(
      "SELECT generation, status, credential_hash FROM bridge_master_credentials WHERE status = 'active'"
    ).get();
    if (!row || typeof credentialHash !== 'string' || credentialHash.length !== row.credential_hash.length) return null;
    const same = crypto.timingSafeEqual(Buffer.from(credentialHash), Buffer.from(row.credential_hash));
    return same ? { generation: row.generation, status: row.status } : null;
  },

  /**
   * The live generation, if any, without its hash.
   * @returns {{generation: number, status: string, mintedAt: string, deliveredAt: (string|null)}|null}
   */
  live() {
    const row = store.getDb().prepare(
      "SELECT generation, status, minted_at, delivered_at FROM bridge_master_credentials WHERE status IN ('pending','active')"
    ).get();
    return row
      ? { generation: row.generation, status: row.status, mintedAt: row.minted_at, deliveredAt: row.delivered_at }
      : null;
  }
};

/**
 * Shape an audit row for callers.
 * @param {object} row - A `bridge_audit` row.
 * @returns {object}
 */
function _auditRow(row) {
  return {
    seq: row.audit_seq,
    op: row.op,
    requestId: row.request_id,
    actor: row.actor,
    proof: row.proof,
    masterGeneration: row.master_generation,
    routeId: row.route_id,
    expectedVersion: row.expected_version,
    outcome: row.outcome,
    detail: row.detail_json ? JSON.parse(row.detail_json) : null,
    at: row.at
  };
}

const audit = {
  /**
   * Append one audit row. Call inside the transaction that made the change it
   * describes, so the two land or fail together.
   * @param {object} entry
   * @param {string} entry.op - Operation name.
   * @param {string|null} [entry.requestId] - Caller's idempotency key.
   * @param {string} entry.actor - Who acted.
   * @param {string} entry.proof - How the actor was verified.
   * @param {number|null} [entry.masterGeneration] - Master generation, when Master acted.
   * @param {string|null} [entry.routeId] - Route concerned.
   * @param {number|null} [entry.expectedVersion] - Version the caller named.
   * @param {string} entry.outcome - Closed outcome code.
   * @param {object|null} [entry.detail] - Small structured detail; never a body.
   * @param {string} [entry.at] - Timestamp override.
   * @returns {object} The stored row.
   */
  append(entry) {
    const db = store.getDb();
    const result = db.prepare(
      'INSERT INTO bridge_audit (op, request_id, actor, proof, master_generation, route_id, expected_version, outcome, detail_json, at) '
      + 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      entry.op, entry.requestId ?? null, entry.actor, entry.proof, entry.masterGeneration ?? null,
      entry.routeId ?? null, entry.expectedVersion ?? null, entry.outcome,
      entry.detail ? JSON.stringify(entry.detail) : null, _now(entry.at)
    );
    return _auditRow(db.prepare('SELECT * FROM bridge_audit WHERE audit_seq = ?').get(result.lastInsertRowid));
  },

  /**
   * The audit row a request id already produced for an operation.
   * @param {string} op - Operation name.
   * @param {string} requestId - Caller's idempotency key.
   * @returns {object|null}
   */
  findRequest(op, requestId) {
    const row = store.getDb().prepare('SELECT * FROM bridge_audit WHERE op = ? AND request_id = ?').get(op, requestId);
    return row ? _auditRow(row) : null;
  },

  /**
   * Remove the oldest audit rows, folding them into the audit anchor.
   *
   * Takes the longest run from the start of the table in which every row is
   * older than `before` and belongs to no route that is still open, so a route
   * in progress never loses its history. The anchor is moved first, in the
   * same transaction: that is what permits the delete, and its count and
   * chained digest are all that remains of the rows afterwards. The anchor is
   * one row however many compactions run.
   * @param {object} options
   * @param {string} options.before - Remove rows written before this instant.
   * @param {string} [options.at] - Timestamp override.
   * @returns {{removed: number, throughSeq: (number|null), digest: (string|null)}}
   */
  compact(options) {
    const at = _now(options.at);
    return transaction((db) => {
      const blocker = db.prepare(
        'SELECT MIN(a.audit_seq) AS seq FROM bridge_audit a '
        + 'LEFT JOIN bridge_routes r ON r.route_id = a.route_id '
        + "WHERE a.at >= ? OR (r.route_id IS NOT NULL AND r.state <> 'closed')"
      ).get(options.before).seq;
      const rows = blocker === null
        ? db.prepare('SELECT * FROM bridge_audit ORDER BY audit_seq').all()
        : db.prepare('SELECT * FROM bridge_audit WHERE audit_seq < ? ORDER BY audit_seq').all(blocker);
      if (!rows.length) return { removed: 0, throughSeq: null, digest: null };
      const anchor = db.prepare('SELECT * FROM bridge_audit_anchor WHERE anchor_id = 1').get();
      const hash = crypto.createHash('sha256');
      hash.update(anchor.chain_digest || '');
      for (const row of rows) hash.update(`\n${JSON.stringify(row)}`);
      const digest = hash.digest('hex');
      const throughSeq = rows[rows.length - 1].audit_seq;
      db.prepare(
        'UPDATE bridge_audit_anchor SET through_seq = ?, removed_count = removed_count + ?, compactions = compactions + 1, '
        + 'chain_digest = ?, updated_at = ? WHERE anchor_id = 1'
      ).run(throughSeq, rows.length, digest, at);
      db.prepare('DELETE FROM bridge_audit WHERE audit_seq <= ?').run(throughSeq);
      return { removed: rows.length, throughSeq, digest };
    });
  },

  /**
   * What retention has removed from the audit so far.
   * @returns {{throughSeq: number, removedCount: number, compactions: number, chainDigest: (string|null), updatedAt: string}}
   */
  anchor() {
    const row = store.getDb().prepare('SELECT * FROM bridge_audit_anchor WHERE anchor_id = 1').get();
    return {
      throughSeq: row.through_seq, removedCount: row.removed_count, compactions: row.compactions,
      chainDigest: row.chain_digest, updatedAt: row.updated_at
    };
  },

  /**
   * Audit rows for one route, oldest first.
   * @param {string} routeId - Route id.
   * @returns {object[]}
   */
  forRoute(routeId) {
    return store.getDb().prepare('SELECT * FROM bridge_audit WHERE route_id = ? ORDER BY audit_seq')
      .all(routeId).map(_auditRow);
  }
};

/**
 * Shape a route row for callers. Carries no body.
 * @param {object} row - A `bridge_routes` row.
 * @returns {object}
 */
function _routeRow(row) {
  return {
    routeId: row.route_id,
    externalId: row.external_id,
    context: {
      authorId: row.author_id, spaceId: row.space_id, channelId: row.channel_id,
      threadId: row.thread_id, replyToExternalId: row.reply_to_external_id
    },
    state: row.state,
    version: row.version,
    resolvedBy: row.resolved_by,
    destination: row.destination_kind
      ? { kind: row.destination_kind, projectId: row.destination_project_id, workspaceId: row.destination_workspace_id }
      : null,
    failureCode: row.failure_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    closedBy: row.closed_by
  };
}

const routes = {
  /**
   * Store one inbound operator message as a route, with its body beside it.
   * A second call with the same external id and the same message changes
   * nothing and returns the route the first call made. The same external id
   * with a different body or chat context is refused as a mismatch.
   * @param {object} input
   * @param {string} input.routeId - New route id.
   * @param {string} input.externalId - The chat's own message id.
   * @param {string} input.authorId - Chat author id.
   * @param {string} input.spaceId - Chat space (guild) id.
   * @param {string} input.channelId - Chat channel id.
   * @param {string|null} [input.threadId] - Chat thread id.
   * @param {string|null} [input.replyToExternalId] - Message this one answers.
   * @param {string} input.text - Message body.
   * @param {string} input.digest - SHA-256 of the body, hex.
   * @param {string} [input.at] - Timestamp override.
   * @returns {{created: boolean, mismatch: boolean, route: (object|null)}}
   */
  accept(input) {
    const at = _now(input.at);
    return transaction((db) => {
      const result = db.prepare(
        'INSERT INTO bridge_routes (route_id, external_id, author_id, space_id, channel_id, thread_id, '
        + 'reply_to_external_id, body_digest, state, created_at, updated_at) '
        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?) ON CONFLICT(external_id) DO NOTHING"
      ).run(
        input.routeId, input.externalId, input.authorId, input.spaceId, input.channelId,
        input.threadId ?? null, input.replyToExternalId ?? null, input.digest, at, at
      );
      const created = result.changes === 1;
      const row = db.prepare('SELECT * FROM bridge_routes WHERE external_id = ?').get(input.externalId);
      if (!created) {
        // A replay is the same message again. The same id on a different
        // message, or from a different place, is not a replay and must not be
        // answered with somebody else's route.
        const same = row.body_digest === input.digest
          && row.author_id === input.authorId && row.space_id === input.spaceId
          && row.channel_id === input.channelId
          && (row.thread_id ?? null) === (input.threadId ?? null)
          && (row.reply_to_external_id ?? null) === (input.replyToExternalId ?? null);
        if (!same) return { created: false, mismatch: true, route: null };
      }
      if (created) {
        db.prepare(
          "INSERT INTO bridge_route_bodies (route_id, role, text, digest, created_at) VALUES (?, 'inbound', ?, ?, ?) "
          + 'ON CONFLICT(route_id, role) DO NOTHING'
        ).run(input.routeId, input.text, input.digest, at);
      }
      return { created, mismatch: false, route: _routeRow(row) };
    });
  },

  /**
   * One route by id.
   * @param {string} routeId - Route id.
   * @returns {object|null}
   */
  get(routeId) {
    const row = store.getDb().prepare('SELECT * FROM bridge_routes WHERE route_id = ?').get(routeId);
    return row ? _routeRow(row) : null;
  },

  /**
   * Routes in the given states, oldest first.
   * @param {object} [options]
   * @param {string[]} [options.states] - States to include; open states by default.
   * @param {number} [options.limit] - At most this many, capped at {@link MAX_LIST}.
   * @returns {object[]}
   */
  list(options = {}) {
    const states = (options.states && options.states.length ? options.states : OPEN_ROUTE_STATES)
      .filter((s) => ROUTE_STATES.includes(s));
    if (!states.length) return [];
    const limit = Math.min(Math.max(Number(options.limit) || MAX_LIST, 1), MAX_LIST);
    return store.getDb().prepare(
      `SELECT * FROM bridge_routes WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY created_at, route_id LIMIT ?`
    ).all(...states, limit).map(_routeRow);
  },

  /**
   * The bodies held for a route. A cleared body has `text: null`.
   * @param {string} routeId - Route id.
   * @returns {{role: string, text: (string|null), digest: string, clearedAt: (string|null)}[]}
   */
  bodies(routeId) {
    return store.getDb().prepare(
      'SELECT role, text, digest, cleared_at FROM bridge_route_bodies WHERE route_id = ? ORDER BY body_id'
    ).all(routeId).map((r) => ({ role: r.role, text: r.text, digest: r.digest, clearedAt: r.cleared_at }));
  },

  /**
   * Clear every body still held for a route, keeping the digests.
   * @param {string} routeId - Route id.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {number} How many bodies were cleared.
   */
  clearBodies(routeId, options = {}) {
    const result = store.getDb().prepare(
      'UPDATE bridge_route_bodies SET text = NULL, cleared_at = ? WHERE route_id = ? AND text IS NOT NULL'
    ).run(_now(options.at), routeId);
    return Number(result.changes);
  }
};

/**
 * Apply one write to a route: idempotent on the request id, refused unless the
 * caller named the route's current version, and audited whatever the outcome.
 *
 * `change` decides what the write does and writes nothing itself. It receives
 * the current route and returns either `{refuse: '<code>'}` or
 * `{set: {column: value, ...}}`, optionally with `clearBodies: true`; this
 * function performs the effects, and only on the applied path. A repeated
 * request id returns the outcome its first use produced, applies nothing and
 * adds no audit row.
 * @param {object} write
 * @param {string} write.op - Operation name.
 * @param {string} write.requestId - Caller's idempotency key.
 * @param {string} write.routeId - Route to change.
 * @param {number} write.expectedVersion - The version the caller read.
 * @param {string} write.actor - Who is acting.
 * @param {string} write.proof - How the actor was verified.
 * @param {number|null} [write.masterGeneration] - Master generation, when Master acts.
 * @param {(route: object) => {refuse?: string, set?: object, clearBodies?: boolean, detail?: object}} write.change - The decision.
 * @param {string} [write.at] - Timestamp override.
 * @returns {{outcome: string, replayed: boolean, route: (object|null)}}
 */
function applyRouteWrite(write) {
  const at = _now(write.at);
  return transaction((db) => {
    const prior = audit.findRequest(write.op, write.requestId);
    if (prior) {
      // The same key for a different route is a caller's mistake, not a replay.
      const outcome = prior.routeId === write.routeId ? prior.outcome : 'request-id-reused';
      return { outcome, replayed: true, route: routes.get(write.routeId) };
    }
    const record = (outcome, detail) => audit.append({
      op: write.op, requestId: write.requestId, actor: write.actor, proof: write.proof,
      masterGeneration: write.masterGeneration ?? null, routeId: write.routeId,
      expectedVersion: write.expectedVersion, outcome, detail: detail || null, at
    });
    const row = db.prepare('SELECT * FROM bridge_routes WHERE route_id = ?').get(write.routeId);
    if (!row) {
      record('route-not-found');
      return { outcome: 'route-not-found', replayed: false, route: null };
    }
    if (row.version !== write.expectedVersion) {
      record('version-conflict', { currentVersion: row.version });
      return { outcome: 'version-conflict', replayed: false, route: _routeRow(row) };
    }
    const decision = write.change(_routeRow(row)) || {};
    if (decision.refuse) {
      record(decision.refuse, decision.detail);
      return { outcome: decision.refuse, replayed: false, route: _routeRow(row) };
    }
    const set = { ...(decision.set || {}), version: row.version + 1, updated_at: at };
    const columns = Object.keys(set);
    const result = db.prepare(
      `UPDATE bridge_routes SET ${columns.map((c) => `${c} = ?`).join(', ')} WHERE route_id = ? AND version = ?`
    ).run(...columns.map((c) => set[c]), write.routeId, row.version);
    if (result.changes !== 1) throw new Error('bridge route changed inside its own write transaction');
    const detail = { ...(decision.detail || {}) };
    if (decision.clearBodies) detail.bodiesCleared = routes.clearBodies(write.routeId, { at });
    record('applied', detail);
    return { outcome: 'applied', replayed: false, route: routes.get(write.routeId) };
  });
}

/**
 * How long each kind of bridge record is kept (ADR 0023 Decision 20). Bodies
 * are not here: they are cleared on confirmed delivery or close, not by age.
 */
const RETENTION = Object.freeze({
  nonceMs: 24 * 60 * 60 * 1000,
  closedRouteMs: 30 * 24 * 60 * 60 * 1000,
  settledOutboundMs: 30 * 24 * 60 * 60 * 1000,
  decidedCandidateMs: 30 * 24 * 60 * 60 * 1000,
  revokedCredentialMs: 90 * 24 * 60 * 60 * 1000,
  auditMs: 90 * 24 * 60 * 60 * 1000
});

/**
 * Remove every bridge record that has outlived its retention. What is still
 * in progress is never removed: an open route, an undelivered outbound item,
 * an outbound item with no route that is still undelivered, an undecided
 * candidate and the live credential all stay whatever their age. Removing a
 * closed route removes its bodies, proofs and outbound items with it, in any
 * state: a route closes only once its answer has been relayed or abandoned.
 * @param {object} [options]
 * @param {string} [options.now] - The current instant, ISO; the clock by default.
 * @returns {{nonces: number, routes: number, outbound: number, candidates: number, credentials: number, audit: number}}
 */
function prune(options = {}) {
  const now = Date.parse(_now(options.now));
  const before = (ms) => new Date(now - ms).toISOString();
  const db = store.getDb();
  const removed = transaction(() => ({
    nonces: Number(db.prepare('DELETE FROM bridge_nonces WHERE seen_at < ?').run(before(RETENTION.nonceMs)).changes),
    routes: Number(db.prepare(
      "DELETE FROM bridge_routes WHERE state = 'closed' AND closed_at < ?"
    ).run(before(RETENTION.closedRouteMs)).changes),
    outbound: Number(db.prepare(
      "DELETE FROM bridge_outbound WHERE state IN ('delivered','dropped') AND updated_at < ?"
    ).run(before(RETENTION.settledOutboundMs)).changes),
    candidates: Number(db.prepare(
      "DELETE FROM bridge_candidates WHERE state <> 'submitted' AND decided_at < ?"
    ).run(before(RETENTION.decidedCandidateMs)).changes),
    credentials: Number(db.prepare(
      // The newest generation stays whatever its age: the next one is numbered from it.
      "DELETE FROM bridge_master_credentials WHERE status = 'revoked' AND revoked_at < ? "
      + 'AND generation < (SELECT MAX(generation) FROM bridge_master_credentials)'
    ).run(before(RETENTION.revokedCredentialMs)).changes)
  }));
  // After the routes: a route that just left no longer holds its audit rows back.
  const compacted = audit.compact({ before: before(RETENTION.auditMs), at: _now(options.now) });
  return { ...removed, audit: compacted.removed };
}

module.exports = {
  RETENTION,
  prune,
  MAX_LIST,
  OPEN_ROUTE_STATES,
  transaction,
  settings,
  masterCredentials,
  audit,
  routes,
  applyRouteWrite
};
