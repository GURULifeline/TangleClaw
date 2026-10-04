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
 * SHA-256 of a string, hex: the digest every bridge body and token is kept by.
 * @param {string} text - Input.
 * @returns {string}
 */
function digest(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
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
    pendingNoticeAt: row.pending_notice_at,
    masterWakeAt: row.master_wake_at,
    resolvedGeneration: row.resolved_generation,
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
   * The route an external chat message id belongs to.
   * @param {string} externalId - The chat's own message id.
   * @returns {object|null}
   */
  getByExternalId(externalId) {
    const row = store.getDb().prepare('SELECT * FROM bridge_routes WHERE external_id = ?').get(externalId);
    return row ? _routeRow(row) : null;
  },

  /**
   * Store or replace one body of a route. Call inside the route's write.
   * @param {string} routeId - Route id.
   * @param {('inbound'|'reply'|'answer')} role - Which body.
   * @param {string} text - Body text.
   * @param {string} digest - SHA-256 of the text, hex.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {void}
   */
  putBody(routeId, role, text, digest, options = {}) {
    store.getDb().prepare(
      'INSERT INTO bridge_route_bodies (route_id, role, text, digest, created_at) VALUES (?, ?, ?, ?, ?) '
      + 'ON CONFLICT(route_id, role) DO UPDATE SET text = excluded.text, digest = excluded.digest, '
      + 'created_at = excluded.created_at, cleared_at = NULL'
    ).run(routeId, role, text, digest, _now(options.at));
  },

  /**
   * One held body of a route.
   * @param {string} routeId - Route id.
   * @param {string} role - Which body.
   * @returns {{text: (string|null), digest: string}|null}
   */
  body(routeId, role) {
    const row = store.getDb().prepare('SELECT text, digest FROM bridge_route_bodies WHERE route_id = ? AND role = ?').get(routeId, role);
    return row ? { text: row.text, digest: row.digest } : null;
  },

  /**
   * Record when the Master was last told about a route. The gateway's
   * bookkeeping, so it does not change the route's version.
   * @param {string} routeId - Route id.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {void}
   */
  noteMasterTold(routeId, options = {}) {
    store.getDb().prepare('UPDATE bridge_routes SET master_wake_at = ? WHERE route_id = ?').run(_now(options.at), routeId);
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

const proofs = {
  /**
   * Record which Hub message belongs to a route, and under what proof.
   * @param {object} proof
   * @param {string} proof.routeId - Route id.
   * @param {('to-target'|'from-target')} proof.direction - Which way the message went.
   * @param {string} proof.hubId - The Hub's id for the message.
   * @param {string|null} [proof.exchangeId] - The Medusa exchange id.
   * @param {string|null} [proof.inReplyToHubId] - The bridge message a reply answers.
   * @param {('master-launch'|'gateway'|'launch')} proof.senderProof - How the sender was verified.
   * @param {number|null} [proof.masterGeneration] - Master generation, for `master-launch`.
   * @param {number|null} [proof.senderProjectId] - Replying project.
   * @param {string|null} [proof.senderLaunchId] - Replying launch.
   * @param {number|null} [proof.targetProjectId] - Project a sent message went to.
   * @param {string|null} [proof.targetWorkspaceId] - Workspace a sent message went to.
   * @param {number|null} [proof.targetSessionId] - Session a sent message went to.
   * @param {string|null} [proof.targetLaunchId] - That session's launch.
   * @param {string} [proof.at] - Timestamp override.
   * @returns {void}
   */
  record(proof) {
    store.getDb().prepare(
      'INSERT INTO bridge_route_proofs (route_id, direction, hub_id, exchange_id, in_reply_to_hub_id, sender_proof, '
      + 'master_generation, sender_project_id, sender_launch_id, target_project_id, target_workspace_id, target_session_id, '
      + 'target_launch_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      proof.routeId, proof.direction, proof.hubId, proof.exchangeId ?? null, proof.inReplyToHubId ?? null,
      proof.senderProof, proof.masterGeneration ?? null, proof.senderProjectId ?? null, proof.senderLaunchId ?? null,
      proof.targetProjectId ?? null, proof.targetWorkspaceId ?? null, proof.targetSessionId ?? null,
      proof.targetLaunchId ?? null,
      _now(proof.at)
    );
  },

  /**
   * The proof row for a Hub message.
   * @param {string} hubId - Hub message id.
   * @returns {{routeId: string, direction: string, hubId: string, exchangeId: (string|null), senderProof: string, targetWorkspaceId: (string|null), targetSessionId: (number|null), targetLaunchId: (string|null)}|null}
   */
  byHubId(hubId) {
    const row = store.getDb().prepare('SELECT * FROM bridge_route_proofs WHERE hub_id = ?').get(hubId);
    return row
      ? {
        routeId: row.route_id, direction: row.direction, hubId: row.hub_id, exchangeId: row.exchange_id,
        senderProof: row.sender_proof, targetProjectId: row.target_project_id, targetWorkspaceId: row.target_workspace_id,
        targetSessionId: row.target_session_id, targetLaunchId: row.target_launch_id
      }
      : null;
  },

  /**
   * The proof row for a Medusa exchange.
   * @param {string} exchangeId - Exchange id.
   * @returns {object|null} As {@link proofs.byHubId} returns it.
   */
  byExchangeId(exchangeId) {
    const row = store.getDb().prepare('SELECT hub_id FROM bridge_route_proofs WHERE exchange_id = ?').get(exchangeId);
    return row ? proofs.byHubId(row.hub_id) : null;
  },

  /**
   * The newest message the bridge sent to a route's destination.
   * @param {string} routeId - Route id.
   * @returns {{hubId: string, exchangeId: (string|null)}|null}
   */
  latestToTarget(routeId) {
    const row = store.getDb().prepare(
      "SELECT hub_id, exchange_id FROM bridge_route_proofs WHERE route_id = ? AND direction = 'to-target' ORDER BY proof_id DESC LIMIT 1"
    ).get(routeId);
    return row ? { hubId: row.hub_id, exchangeId: row.exchange_id } : null;
  }
};

/**
 * Shape an outbound row for callers.
 * @param {object} row - A `bridge_outbound` row.
 * @returns {object}
 */
function _outboundRow(row) {
  return {
    outboundId: row.outbound_id,
    idemKey: row.idem_key,
    kind: row.kind,
    notifyType: row.notify_type,
    routeId: row.route_id,
    sourceLabel: row.source_label,
    text: row.text,
    state: row.state,
    dropCode: row.drop_code,
    attempts: row.attempts,
    deliveredRef: row.delivered_ref,
    createdAt: row.created_at,
    deliveredAt: row.delivered_at
  };
}

/**
 * The only sentences a status item may carry (ADR 0023 Decisions 4 and 17).
 * Transport control the server wrote, not content.
 */
const STATUS_TEXT = Object.freeze({
  pending: 'Still waiting on an answer to your message. Nothing is lost; you will get it here.',
  'master-unavailable': 'Your message is queued: the Project Master is not available right now.'
});

const outbound = {
  /**
   * Queue one item for the helper. A second call with the same idempotency
   * key changes nothing and returns the item the first call made.
   * @param {object} item
   * @param {string} item.idemKey - The item's own idempotency key.
   * @param {('reply'|'notification'|'failure'|'candidate')} item.kind - Which kind. A status item goes through `enqueueStatus`.
   * @param {string|null} [item.notifyType] - Notification type.
   * @param {string|null} [item.routeId] - Route it belongs to.
   * @param {string|null} [item.candidateId] - Candidate it was approved from.
   * @param {string} item.sourceLabel - Compact source label shown with it.
   * @param {string} item.text - What to post.
   * @param {string} item.digest - SHA-256 of the text, hex.
   * @param {number|null} [item.releasedGeneration] - Master generation that released it.
   * @param {string} [item.at] - Timestamp override.
   * @returns {object} The stored item.
   */
  enqueue(item) {
    if (item.kind === 'status') throw new Error('a status item carries fixed text: use enqueueStatus');
    const at = _now(item.at);
    const db = store.getDb();
    db.prepare(
      'INSERT INTO bridge_outbound (idem_key, kind, notify_type, route_id, candidate_id, source_label, text, digest, state, '
      + "released_generation, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?) "
      + 'ON CONFLICT(idem_key) DO NOTHING'
    ).run(
      item.idemKey, item.kind, item.notifyType ?? null, item.routeId ?? null, item.candidateId ?? null, item.sourceLabel,
      item.text, item.digest, item.releasedGeneration ?? null, at, at
    );
    return _outboundRow(db.prepare('SELECT * FROM bridge_outbound WHERE idem_key = ?').get(item.idemKey));
  },

  /**
   * Queue the one status notice a route may have. The text is one of the
   * fixed sentences the server wrote, chosen by name: a status item carries
   * nobody's prose. A route has one notice in its life: the route records
   * when it was raised, and that record, not the notice's row, is what a
   * second attempt is refused on.
   * @param {string} routeId - Route id.
   * @param {('pending'|'master-unavailable')} which - Which fixed notice.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {{created: boolean, item: (object|null)}} `item` is null once the notice's row has been removed.
   */
  enqueueStatus(routeId, which, options = {}) {
    const text = STATUS_TEXT[which];
    if (!text) throw new Error(`unknown status notice "${which}"`);
    const at = _now(options.at);
    return transaction((db) => {
      // The route itself remembers that it has had its notice. The notice's
      // own row is not the record: it is let go and later removed, and a
      // route may stay open long after that.
      const claimed = db.prepare(
        'UPDATE bridge_routes SET pending_notice_at = ? WHERE route_id = ? AND pending_notice_at IS NULL'
      ).run(at, routeId).changes === 1;
      if (claimed) {
        db.prepare(
          'INSERT INTO bridge_outbound (idem_key, kind, route_id, source_label, text, digest, state, created_at, updated_at) '
          + "VALUES (?, 'status', ?, 'TangleClaw', ?, ?, 'ready', ?, ?)"
        ).run(`route:${routeId}:pending`, routeId, text, digest(text), at, at);
      }
      const row = db.prepare("SELECT * FROM bridge_outbound WHERE route_id = ? AND kind = 'status'").get(routeId);
      return { created: claimed, item: row ? _outboundRow(row) : null };
    });
  },

  /**
   * Items waiting for the helper, oldest first.
   * @param {object} [options]
   * @param {number} [options.limit] - At most this many, capped at {@link MAX_LIST}.
   * @returns {object[]}
   */
  ready(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 20, 1), MAX_LIST);
    return store.getDb().prepare("SELECT * FROM bridge_outbound WHERE state = 'ready' ORDER BY outbound_id LIMIT ?")
      .all(limit).map(_outboundRow);
  },

  /**
   * The route whose item was posted to the chat as a given message.
   * @param {string} deliveredRef - The chat's id for a posted message.
   * @returns {string|null}
   */
  routeIdByDeliveredRef(deliveredRef) {
    const row = store.getDb().prepare(
      'SELECT route_id FROM bridge_outbound WHERE delivered_ref = ? AND route_id IS NOT NULL ORDER BY outbound_id DESC LIMIT 1'
    ).get(deliveredRef);
    return row ? row.route_id : null;
  },

  /**
   * One item by id.
   * @param {number} outboundId - Item id.
   * @returns {object|null}
   */
  get(outboundId) {
    const row = store.getDb().prepare('SELECT * FROM bridge_outbound WHERE outbound_id = ?').get(outboundId);
    return row ? _outboundRow(row) : null;
  },

  /**
   * Record that the chat confirmed an item was posted, and drop its text.
   * Exact: names the item and the chat's own id for the post. Repeating it
   * with the same reference changes nothing; a different reference is refused.
   * @param {number} outboundId - Item id.
   * @param {string} deliveredRef - The chat's id for the posted message.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {{outcome: ('delivered'|'already-delivered'|'not-found'|'reference-mismatch'|'not-ready'), item: (object|null)}}
   */
  markDelivered(outboundId, deliveredRef, options = {}) {
    const at = _now(options.at);
    const db = store.getDb();
    const row = db.prepare('SELECT * FROM bridge_outbound WHERE outbound_id = ?').get(outboundId);
    if (!row) return { outcome: 'not-found', item: null };
    if (row.state === 'delivered') {
      return { outcome: row.delivered_ref === deliveredRef ? 'already-delivered' : 'reference-mismatch', item: _outboundRow(row) };
    }
    // An item that expired between the helper fetching it and posting it was
    // still posted: the acknowledgement is the truth about that, and is taken.
    const expiredInFlight = row.state === 'dropped' && row.drop_code === 'expired';
    if (row.state !== 'ready' && !expiredInFlight) return { outcome: 'not-ready', item: _outboundRow(row) };
    db.prepare(
      "UPDATE bridge_outbound SET state = 'delivered', delivered_ref = ?, delivered_at = ?, updated_at = ?, text = NULL, "
      + 'drop_code = NULL WHERE outbound_id = ? AND state = ?'
    ).run(deliveredRef, at, at, outboundId, row.state);
    return { outcome: 'delivered', item: outbound.get(outboundId) };
  }
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How long each kind of thing may wait before it is let go (Architect ruling,
 * 2026-10-04). A reply is the operator's answer and is never let go.
 *
 * - A milestone is news: after a week it is no longer worth saying.
 * - An operator action stays wanted far longer than news stays new.
 * - `work-blocked` and `operator-needed` describe something that is still so
 *   until somebody acts, so they keep for a week.
 * - `fleet-idle` and a route's status notice describe a moment; a day later
 *   they describe nothing.
 */
const EXPIRY_MS = Object.freeze({
  candidate: Object.freeze({ milestone: 7 * DAY_MS, 'operator-action-required': 30 * DAY_MS }),
  notification: Object.freeze({ 'work-blocked': 7 * DAY_MS, 'operator-needed': 7 * DAY_MS, 'fleet-idle': DAY_MS }),
  status: DAY_MS
});

/**
 * How long a waiting outbound item may wait, or null for one that never expires.
 * @param {{kind: string, notify_type: (string|null), candidate_kind: (string|null)}} row - The item, with its candidate's kind.
 * @returns {number|null}
 */
function _outboundTtl(row) {
  if (row.kind === 'status') return EXPIRY_MS.status;
  if (row.kind === 'notification') return EXPIRY_MS.notification[row.notify_type] ?? null;
  if (row.kind === 'candidate') return EXPIRY_MS.candidate[row.candidate_kind] ?? null;
  return null;
}

/**
 * Let go of what waited too long. A candidate the Master never decided is
 * rejected as expired; an item the helper never collected is dropped. Each one
 * is audited by itself, with the fixed reason `expired` and the id of what was
 * let go. Nothing is deleted here, and nothing let go is ever raised again:
 * its row and its idempotency key remain, so the event that made it is still
 * accounted for. Retention removes the rows later.
 *
 * Something expires when it has waited strictly longer than its limit.
 * @param {object} [options]
 * @param {string} [options.now] - The current instant, ISO; the clock by default.
 * @returns {{outbound: number, candidates: number}}
 */
function expire(options = {}) {
  const at = _now(options.now);
  const now = Date.parse(at);
  const db = store.getDb();
  return transaction(() => {
    const out = { outbound: 0, candidates: 0 };
    const waiting = db.prepare(
      'SELECT o.outbound_id, o.kind, o.notify_type, o.created_at, c.kind AS candidate_kind FROM bridge_outbound o '
      + "LEFT JOIN bridge_candidates c ON c.candidate_id = o.candidate_id WHERE o.state = 'ready' AND o.kind <> 'reply'"
    ).all();
    const drop = db.prepare(
      "UPDATE bridge_outbound SET state = 'dropped', drop_code = 'expired', text = NULL, updated_at = ? WHERE outbound_id = ? AND state = 'ready'"
    );
    for (const row of waiting) {
      const ttl = _outboundTtl(row);
      if (ttl === null || now - Date.parse(row.created_at) <= ttl) continue;
      if (drop.run(at, row.outbound_id).changes !== 1) continue;
      out.outbound += 1;
      audit.append({
        op: 'expire', actor: 'gateway', proof: 'gateway', outcome: 'expired',
        detail: { what: 'outbound', outboundId: row.outbound_id, kind: row.kind, type: row.notify_type || row.candidate_kind || null }, at
      });
    }
    const undecided = db.prepare("SELECT candidate_id, kind, created_at FROM bridge_candidates WHERE state = 'submitted'").all();
    const reject = db.prepare(
      "UPDATE bridge_candidates SET state = 'rejected', version = version + 1, decided_at = ? WHERE candidate_id = ? AND state = 'submitted'"
    );
    for (const row of undecided) {
      const ttl = EXPIRY_MS.candidate[row.kind];
      if (!ttl || now - Date.parse(row.created_at) <= ttl) continue;
      if (reject.run(at, row.candidate_id).changes !== 1) continue;
      out.candidates += 1;
      audit.append({
        op: 'expire', actor: 'gateway', proof: 'gateway', outcome: 'expired',
        detail: { what: 'candidate', candidateId: row.candidate_id, kind: row.kind }, at
      });
    }
    return out;
  });
}

const nonces = {
  /**
   * Record a helper request nonce. False when it was already seen.
   * @param {string} nonce - The request's nonce.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {boolean} True the first time a nonce is seen.
   */
  claim(nonce, options = {}) {
    const result = store.getDb().prepare(
      'INSERT INTO bridge_nonces (nonce, seen_at) VALUES (?, ?) ON CONFLICT(nonce) DO NOTHING'
    ).run(nonce, _now(options.at));
    return result.changes === 1;
  }
};

const helperTokens = {
  /**
   * Replace the helper token: revoke the active one and record the new hash.
   * @param {string} tokenId - New token's id.
   * @param {string} tokenHash - SHA-256 of the new token, hex.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {void}
   */
  replace(tokenId, tokenHash, options = {}) {
    const at = _now(options.at);
    transaction((db) => {
      db.prepare("UPDATE bridge_helper_tokens SET status = 'revoked', revoked_at = ? WHERE status = 'active'").run(at);
      db.prepare(
        "INSERT INTO bridge_helper_tokens (token_id, token_hash, status, created_by, created_at) VALUES (?, ?, 'active', 'operator', ?)"
      ).run(tokenId, tokenHash, at);
    });
  },

  /**
   * Revoke the active helper token.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {number} How many tokens were revoked.
   */
  revoke(options = {}) {
    const result = store.getDb().prepare(
      "UPDATE bridge_helper_tokens SET status = 'revoked', revoked_at = ? WHERE status = 'active'"
    ).run(_now(options.at));
    return Number(result.changes);
  },

  /**
   * Whether a presented hash is the active token's, compared in constant time.
   * @param {string} tokenHash - SHA-256 of the presented token, hex.
   * @returns {{tokenId: string}|null}
   */
  findActive(tokenHash) {
    const row = store.getDb().prepare("SELECT token_id, token_hash FROM bridge_helper_tokens WHERE status = 'active'").get();
    if (!row || typeof tokenHash !== 'string' || tokenHash.length !== row.token_hash.length) return null;
    return crypto.timingSafeEqual(Buffer.from(tokenHash), Buffer.from(row.token_hash)) ? { tokenId: row.token_id } : null;
  },

  /**
   * The active token's id and age, without its hash.
   * @returns {{tokenId: string, createdAt: string}|null}
   */
  active() {
    const row = store.getDb().prepare("SELECT token_id, created_at FROM bridge_helper_tokens WHERE status = 'active'").get();
    return row ? { tokenId: row.token_id, createdAt: row.created_at } : null;
  }
};

/**
 * Shape a destination from a row carrying `destination_kind` and `destination_project_id`.
 * @param {object} row - Alias or pin row.
 * @returns {{kind: string, projectId: (number|null)}}
 */
function _destination(row) {
  return { kind: row.destination_kind, projectId: row.destination_project_id };
}

const aliases = {
  /**
   * Create or replace a global alias. The operator's alone.
   * @param {string} alias - Normalised alias.
   * @param {{kind: ('master'|'project'), projectId?: number}} destination - Where it points.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {void}
   */
  set(alias, destination, options = {}) {
    store.getDb().prepare(
      "INSERT INTO bridge_aliases (alias, destination_kind, destination_project_id, created_by, created_at) VALUES (?, ?, ?, 'operator', ?) "
      + 'ON CONFLICT(alias) DO UPDATE SET destination_kind = excluded.destination_kind, '
      + 'destination_project_id = excluded.destination_project_id, created_at = excluded.created_at'
    ).run(alias, destination.kind, destination.kind === 'project' ? destination.projectId : null, _now(options.at));
  },

  /**
   * Remove an alias.
   * @param {string} alias - Normalised alias.
   * @returns {boolean} Whether one existed.
   */
  remove(alias) {
    return store.getDb().prepare('DELETE FROM bridge_aliases WHERE alias = ?').run(alias).changes === 1;
  },

  /**
   * Where an alias points.
   * @param {string} alias - Normalised alias.
   * @returns {{kind: string, projectId: (number|null)}|null}
   */
  get(alias) {
    const row = store.getDb().prepare('SELECT * FROM bridge_aliases WHERE alias = ?').get(alias);
    return row ? _destination(row) : null;
  },

  /**
   * Every alias.
   * @returns {{alias: string, destination: object}[]}
   */
  list() {
    return store.getDb().prepare('SELECT * FROM bridge_aliases ORDER BY alias').all()
      .map((row) => ({ alias: row.alias, destination: _destination(row) }));
  }
};

const pins = {
  /**
   * Set the operator's global pin for a conversation, or for every
   * conversation when `conversationKey` is null. Replaces the active one.
   * @param {object} pin
   * @param {string} pin.pinId - New pin id.
   * @param {string|null} pin.conversationKey - Conversation, or null for all.
   * @param {{kind: ('master'|'project'), projectId?: number}} pin.destination - Where it points.
   * @param {string} [pin.at] - Timestamp override.
   * @returns {void}
   */
  setGlobal(pin) {
    const at = _now(pin.at);
    transaction((db) => {
      db.prepare(
        "UPDATE bridge_pins SET revoked_at = ? WHERE scope = 'global' AND revoked_at IS NULL AND COALESCE(conversation_key, '*') = COALESCE(?, '*')"
      ).run(at, pin.conversationKey ?? null);
      db.prepare(
        'INSERT INTO bridge_pins (pin_id, scope, conversation_key, destination_kind, destination_project_id, created_by, created_at) '
        + "VALUES (?, 'global', ?, ?, ?, 'operator', ?)"
      ).run(pin.pinId, pin.conversationKey ?? null, pin.destination.kind,
        pin.destination.kind === 'project' ? pin.destination.projectId : null, at);
    });
  },

  /**
   * Set the Master's pin for one conversation, replacing its active one.
   * Call inside the route write that decided it.
   * @param {object} pin
   * @param {string} pin.pinId - New pin id.
   * @param {string} pin.conversationKey - Conversation.
   * @param {{kind: ('master'|'project'), projectId?: number}} pin.destination - Where it points.
   * @param {number} pin.masterGeneration - Master generation that decided it.
   * @param {string} [pin.at] - Timestamp override.
   * @returns {void}
   */
  setConversation(pin) {
    const at = _now(pin.at);
    const db = store.getDb();
    db.prepare(
      "UPDATE bridge_pins SET revoked_at = ? WHERE scope = 'conversation' AND revoked_at IS NULL AND conversation_key = ?"
    ).run(at, pin.conversationKey);
    db.prepare(
      'INSERT INTO bridge_pins (pin_id, scope, conversation_key, destination_kind, destination_project_id, created_by, master_generation, created_at) '
      + "VALUES (?, 'conversation', ?, ?, ?, 'master', ?, ?)"
    ).run(pin.pinId, pin.conversationKey, pin.destination.kind,
      pin.destination.kind === 'project' ? pin.destination.projectId : null, pin.masterGeneration, at);
  },

  /**
   * Revoke one active pin.
   * @param {string} pinId - Pin id.
   * @param {object} [options]
   * @param {string} [options.at] - Timestamp override.
   * @returns {boolean} Whether an active pin was revoked.
   */
  revoke(pinId, options = {}) {
    const result = store.getDb().prepare('UPDATE bridge_pins SET revoked_at = ? WHERE pin_id = ? AND revoked_at IS NULL')
      .run(_now(options.at), pinId);
    return result.changes === 1;
  },

  /**
   * The pin that applies to a conversation: the operator's pin for it, then
   * the operator's pin for every conversation, then the Master's pin for it.
   * @param {string} conversationKey - Conversation.
   * @returns {{pinId: string, scope: string, destination: object}|null}
   */
  forConversation(conversationKey) {
    const db = store.getDb();
    const row = db.prepare(
      "SELECT * FROM bridge_pins WHERE scope = 'global' AND revoked_at IS NULL AND conversation_key = ?"
    ).get(conversationKey)
      || db.prepare("SELECT * FROM bridge_pins WHERE scope = 'global' AND revoked_at IS NULL AND conversation_key IS NULL").get()
      || db.prepare("SELECT * FROM bridge_pins WHERE scope = 'conversation' AND revoked_at IS NULL AND conversation_key = ?").get(conversationKey);
    return row ? { pinId: row.pin_id, scope: row.scope, destination: _destination(row) } : null;
  },

  /**
   * Every active pin.
   * @returns {object[]}
   */
  list() {
    return store.getDb().prepare('SELECT * FROM bridge_pins WHERE revoked_at IS NULL ORDER BY created_at, pin_id').all()
      .map((row) => ({
        pinId: row.pin_id, scope: row.scope, conversationKey: row.conversation_key,
        destination: _destination(row), createdBy: row.created_by
      }));
  }
};

/** Receipt kinds a candidate may rest on. Each names an append-only record the server itself wrote. */
const RECEIPT_KINDS = Object.freeze(['workload']);

/** How many undecided candidates one launch may have waiting at a time. */
const MAX_OPEN_CANDIDATES_PER_LAUNCH = 5;

/**
 * Every column of `workload_receipts`, in the order they are hashed. The whole
 * row is covered; a test holds this list to the table, so a column added later
 * cannot be left out of the digest unnoticed.
 */
const WORKLOAD_RECEIPT_COLUMNS = Object.freeze(['receipt_id', 'project_id', 'session_id', 'launch_id', 'assignment_id', 'seq', 'state',
  'clearance', 'summary', 'wait_kind', 'wait_detail', 'refs_json', 'branch', 'head_sha', 'source', 'received_at']);

/** Names the canonical form a workload receipt is hashed in. A change to the columns or their order is a new version. */
const WORKLOAD_RECEIPT_DIGEST_VERSION = 'workload-receipt.v1';

/**
 * The digest of a workload receipt: SHA-256 over the version and the whole
 * stored row, columns in a fixed order. The table is append-only, so a row's digest never changes; a
 * candidate records it at submission and it is computed again at approval.
 * @param {object} row - A `workload_receipts` row.
 * @returns {string}
 */
function _workloadReceiptDigest(row) {
  return digest(`${WORKLOAD_RECEIPT_DIGEST_VERSION}\n${JSON.stringify(WORKLOAD_RECEIPT_COLUMNS.map((c) => [c, row[c] ?? null]))}`);
}

/**
 * The digest of what a session submitted as a candidate: its kind, its text
 * and the receipts it named. It is what a replay is compared against, and it
 * does not change when a merge later gives the candidate more receipts.
 * @param {string} kind - Candidate kind.
 * @param {string} text - Candidate text.
 * @param {{kind: string, id: string}[]} named - The receipts the session named.
 * @returns {string}
 */
function candidatePayloadDigest(kind, text, named) {
  const ids = named.map((r) => `${r.kind}:${r.id}`).sort();
  return digest(JSON.stringify(['candidate.v1', kind, text, ids]));
}

const receipts = {
  /**
   * A launch's own workload receipt, by the sequence number the session was
   * given for it. Looked up within the launch, so a session can only ever
   * name a receipt that is its own.
   * @param {string} launchId - The launch.
   * @param {number} seq - The receipt's sequence within that launch.
   * @returns {{receiptId: string, projectId: number, launchId: string, seq: number, state: string, digest: string}|null}
   */
  workloadForLaunch(launchId, seq) {
    const row = store.getDb().prepare('SELECT * FROM workload_receipts WHERE launch_id = ? AND seq = ?').get(launchId, seq);
    return row ? receipts._view(row) : null;
  },

  /**
   * A workload receipt by its id, as stored on a candidate.
   * @param {string} receiptId - The receipt's id.
   * @returns {{receiptId: string, projectId: number, launchId: string, seq: number, state: string, digest: string}|null}
   */
  workloadById(receiptId) {
    if (!/^\d{1,15}$/.test(String(receiptId))) return null;
    const row = store.getDb().prepare('SELECT * FROM workload_receipts WHERE receipt_id = ?').get(Number(receiptId));
    return row ? receipts._view(row) : null;
  },

  /**
   * Shape a workload receipt for the bridge.
   * @param {object} row - A `workload_receipts` row.
   * @returns {object}
   */
  _view(row) {
    return {
      receiptId: String(row.receipt_id), projectId: row.project_id, launchId: row.launch_id, seq: row.seq,
      state: row.state, digest: _workloadReceiptDigest(row)
    };
  }
};

/**
 * Shape a candidate row for callers.
 * @param {object} row - A `bridge_candidates` row.
 * @returns {object}
 */
function _candidateRow(row) {
  return {
    candidateId: row.candidate_id, kind: row.kind, sourceProjectId: row.source_project_id, sourceLaunchId: row.source_launch_id,
    payloadDigest: row.digest,
    text: row.text, state: row.state, version: row.version, decidedGeneration: row.decided_generation,
    createdAt: row.created_at, decidedAt: row.decided_at
  };
}

const candidates = {
  /**
   * Store a candidate and the receipts it rests on, together. Idempotent on
   * its key: a repeat returns the candidate the first call made.
   * @param {object} input
   * @param {string} input.candidateId - New candidate id.
   * @param {string} input.idemKey - The submission's idempotency key.
   * @param {('milestone'|'operator-action-required')} input.kind - What it claims.
   * @param {number} input.sourceProjectId - The submitting project.
   * @param {string} input.sourceLaunchId - The submitting launch.
   * @param {string} input.text - What the session wants said.
   * @param {{kind: string, id: string, digest: string}[]} input.receipts - What it rests on; at least one.
   * @param {string} [input.at] - Timestamp override.
   * @returns {{created: boolean, overLimit: boolean, candidate: (object|null)}}
   */
  submit(input) {
    if (!Array.isArray(input.receipts) || input.receipts.length === 0) throw new Error('a candidate rests on at least one receipt');
    const at = _now(input.at);
    return transaction((db) => {
      const existing = db.prepare('SELECT * FROM bridge_candidates WHERE idem_key = ?').get(input.idemKey);
      if (existing) return { created: false, overLimit: false, candidate: _candidateRow(existing) };
      const open = db.prepare(
        "SELECT COUNT(*) AS n FROM bridge_candidates WHERE source_launch_id = ? AND state = 'submitted'"
      ).get(input.sourceLaunchId).n;
      if (open >= MAX_OPEN_CANDIDATES_PER_LAUNCH) return { created: false, overLimit: true, candidate: null };
      db.prepare(
        'INSERT INTO bridge_candidates (candidate_id, idem_key, kind, source_project_id, source_launch_id, text, digest, state, created_at) '
        + "VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', ?)"
      ).run(input.candidateId, input.idemKey, input.kind, input.sourceProjectId, input.sourceLaunchId, input.text,
        candidatePayloadDigest(input.kind, input.text, input.receipts), at);
      const bind = db.prepare('INSERT INTO bridge_candidate_receipts (candidate_id, receipt_kind, receipt_id, receipt_digest) VALUES (?, ?, ?, ?)');
      for (const receipt of input.receipts) bind.run(input.candidateId, receipt.kind, receipt.id, receipt.digest);
      return { created: true, overLimit: false, candidate: candidates.get(input.candidateId) };
    });
  },

  /**
   * One candidate by id.
   * @param {string} candidateId - Candidate id.
   * @returns {object|null}
   */
  get(candidateId) {
    const row = store.getDb().prepare('SELECT * FROM bridge_candidates WHERE candidate_id = ?').get(candidateId);
    return row ? _candidateRow(row) : null;
  },

  /**
   * Candidates in a state, oldest first.
   * @param {object} [options]
   * @param {string} [options.state='submitted'] - Which state.
   * @param {number} [options.limit] - At most this many, capped at {@link MAX_LIST}.
   * @returns {object[]}
   */
  list(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || MAX_LIST, 1), MAX_LIST);
    return store.getDb().prepare('SELECT * FROM bridge_candidates WHERE state = ? ORDER BY created_at, candidate_id LIMIT ?')
      .all(options.state || 'submitted', limit).map(_candidateRow);
  },

  /**
   * The receipts a candidate rests on: the ones its session named, and any
   * carried to it from a candidate the Master merged into it.
   * @param {string} candidateId - Candidate id.
   * @returns {{kind: string, id: string, digest: string}[]}
   */
  receipts(candidateId) {
    return store.getDb().prepare(
      'SELECT receipt_kind, receipt_id, receipt_digest FROM bridge_candidate_receipts WHERE candidate_id = ? ORDER BY receipt_kind, receipt_id'
    ).all(candidateId).map((r) => ({ kind: r.receipt_kind, id: r.receipt_id, digest: r.receipt_digest }));
  }
};

/**
 * Apply the Master's decision on a candidate: idempotent on the request id,
 * refused unless the caller named the candidate's current version, and
 * audited on its first use whether it is applied or refused. The counterpart
 * of {@link applyRouteWrite} for a record that is not a route.
 *
 * `change` decides and writes nothing: it returns `{refuse: '<code>'}` or
 * `{state, outbound?, carryReceiptsTo?}`. An `outbound` item is enqueued in the
 * same transaction, so a candidate is approved and its item exists together
 * or not at all; `carryReceiptsTo` copies this candidate's receipts onto
 * another, for a merge.
 * @param {object} write
 * @param {string} write.op - Operation name.
 * @param {string} write.requestId - Caller's idempotency key.
 * @param {string} write.candidateId - Candidate to decide.
 * @param {number} write.expectedVersion - The version the caller read.
 * @param {number} write.masterGeneration - The Master generation deciding.
 * @param {(candidate: object) => {refuse?: string, state?: string, outbound?: object, carryReceiptsTo?: string, detail?: object}} write.change - The decision.
 * @param {string} [write.at] - Timestamp override.
 * @returns {{outcome: string, replayed: boolean, candidate: (object|null)}}
 */
function applyCandidateWrite(write) {
  const at = _now(write.at);
  return transaction((db) => {
    const prior = audit.findRequest(write.op, write.requestId);
    if (prior) {
      const same = prior.detail && prior.detail.candidateId === write.candidateId;
      return { outcome: same ? prior.outcome : 'request-id-reused', replayed: true, candidate: candidates.get(write.candidateId) };
    }
    const record = (outcome, detail) => audit.append({
      op: write.op, requestId: write.requestId, actor: 'master', proof: 'master-launch', masterGeneration: write.masterGeneration,
      expectedVersion: write.expectedVersion, outcome, detail: { ...(detail || {}), candidateId: write.candidateId }, at
    });
    const candidate = candidates.get(write.candidateId);
    if (!candidate) {
      record('candidate-not-found');
      return { outcome: 'candidate-not-found', replayed: false, candidate: null };
    }
    if (candidate.version !== write.expectedVersion) {
      record('version-conflict', { currentVersion: candidate.version });
      return { outcome: 'version-conflict', replayed: false, candidate };
    }
    const decision = write.change(candidate) || {};
    if (decision.refuse) {
      record(decision.refuse, decision.detail);
      return { outcome: decision.refuse, replayed: false, candidate };
    }
    const result = db.prepare(
      'UPDATE bridge_candidates SET state = ?, version = version + 1, decided_generation = ?, decided_at = ? '
      + "WHERE candidate_id = ? AND version = ? AND state = 'submitted'"
    ).run(decision.state, write.masterGeneration, at, write.candidateId, candidate.version);
    if (result.changes !== 1) throw new Error('bridge candidate changed inside its own write transaction');
    const detail = { ...(decision.detail || {}) };
    if (decision.carryReceiptsTo) {
      // The surviving candidate rests on everything the folded one did.
      detail.receiptsCarried = Number(db.prepare(
        'INSERT OR IGNORE INTO bridge_candidate_receipts (candidate_id, receipt_kind, receipt_id, receipt_digest) '
        + 'SELECT ?, receipt_kind, receipt_id, receipt_digest FROM bridge_candidate_receipts WHERE candidate_id = ?'
      ).run(decision.carryReceiptsTo, write.candidateId).changes);
      // What the survivor rests on has changed, so its version moves: a
      // decision made on what it was before the merge is refused as stale.
      const moved = db.prepare(
        "UPDATE bridge_candidates SET version = version + 1 WHERE candidate_id = ? AND state = 'submitted'"
      ).run(decision.carryReceiptsTo);
      if (moved.changes !== 1) throw new Error('bridge merge target changed inside its own write transaction');
    }
    if (decision.outbound) {
      detail.outboundId = outbound.enqueue({ ...decision.outbound, candidateId: write.candidateId, at }).outboundId;
    }
    record('applied', detail);
    return { outcome: 'applied', replayed: false, candidate: candidates.get(write.candidateId) };
  });
}

/**
 * Apply one write to a route: idempotent on the request id, refused unless the
 * caller named the route's current version, and audited on its first use
 * whether it is applied or refused.
 *
 * A request id is bound to the outcome of its first use, a refusal included: a
 * write refused for a stale version stays refused under that id, and the
 * caller retries with a new one.
 *
 * `change` decides what the write does and writes nothing itself. It receives
 * the current route and returns either `{refuse: '<code>'}` or
 * `{set: {column: value, ...}}`, optionally naming effects: `body` (store a
 * body), `proof` (record which Hub message belongs to the route), `outbound`
 * (enqueue an item for the helper), `pin` (set a conversation pin), `deliver`
 * (mark an outbound item as posted) and `clearBodies`. This function performs them, in that order and in the same
 * transaction, and only on the applied path. A repeated
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
 * @param {(route: object) => {refuse?: string, set?: object, body?: object, proof?: object, outbound?: object, pin?: object, deliver?: object, clearBodies?: boolean, detail?: object}} write.change - The decision.
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
    if (decision.body) routes.putBody(write.routeId, decision.body.role, decision.body.text, decision.body.digest, { at });
    if (decision.proof) proofs.record({ ...decision.proof, routeId: write.routeId, at });
    if (decision.outbound) {
      const item = outbound.enqueue({ ...decision.outbound, routeId: write.routeId, at });
      detail.outboundId = item.outboundId;
    }
    if (decision.pin) pins.setConversation({ ...decision.pin, masterGeneration: write.masterGeneration, at });
    if (decision.deliver) {
      const delivered = outbound.markDelivered(decision.deliver.outboundId, decision.deliver.deliveredRef, { at });
      if (delivered.outcome !== 'delivered') throw new Error(`bridge outbound item could not be marked delivered: ${delivered.outcome}`);
    }
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
 * @returns {{nonces: number, routes: number, outbound: number, candidates: number, pins: number, helperTokens: number, credentials: number, audit: number}}
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
    // A settled item of a route that is still open stays with its route: it
    // is part of what happened to a message somebody is still waiting on.
    outbound: Number(db.prepare(
      "DELETE FROM bridge_outbound WHERE state IN ('delivered','dropped') AND updated_at < ? "
      + "AND (route_id IS NULL OR NOT EXISTS (SELECT 1 FROM bridge_routes r WHERE r.route_id = bridge_outbound.route_id AND r.state <> 'closed'))"
    ).run(before(RETENTION.settledOutboundMs)).changes),
    // A candidate outlives every item made from it: removing it removes its
    // items, and one still waiting or not yet past its own retention must
    // leave by its own rule, audited, not as a side effect of this.
    candidates: Number(db.prepare(
      "DELETE FROM bridge_candidates WHERE state <> 'submitted' AND decided_at < ? "
      + 'AND NOT EXISTS (SELECT 1 FROM bridge_outbound o WHERE o.candidate_id = bridge_candidates.candidate_id)'
    ).run(before(RETENTION.decidedCandidateMs)).changes),
    pins: Number(db.prepare(
      'DELETE FROM bridge_pins WHERE revoked_at IS NOT NULL AND revoked_at < ?'
    ).run(before(RETENTION.revokedCredentialMs)).changes),
    helperTokens: Number(db.prepare(
      "DELETE FROM bridge_helper_tokens WHERE status = 'revoked' AND revoked_at < ?"
    ).run(before(RETENTION.revokedCredentialMs)).changes),
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
  digest,
  expire,
  EXPIRY_MS,
  WORKLOAD_RECEIPT_COLUMNS,
  candidatePayloadDigest,
  STATUS_TEXT,
  RETENTION,
  prune,
  MAX_LIST,
  OPEN_ROUTE_STATES,
  transaction,
  settings,
  masterCredentials,
  audit,
  routes,
  proofs,
  outbound,
  nonces,
  helperTokens,
  aliases,
  pins,
  receipts,
  candidates,
  RECEIPT_KINDS,
  MAX_OPEN_CANDIDATES_PER_LAUNCH,
  applyCandidateWrite,
  applyRouteWrite
};
