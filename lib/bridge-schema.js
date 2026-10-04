'use strict';

/*
 * Storage shape for the Master-mediated operator bridge (ADR 0023, #2031).
 *
 * Kept apart from lib/store.js so the DDL and the proof of its shape are one
 * readable unit: `_createTables` and the migration both execute
 * `bridgeTablesDdl()`, and every startup runs `verifyBridgeSchema()`, so a
 * fresh install, an upgraded store and a store somebody edited by hand are all
 * held to the same shape.
 *
 * Nothing here touches `medusa_exchanges`. A message the bridge sends is an
 * ordinary tracked exchange; what makes it the bridge's is the proof row in
 * `bridge_route_proofs`, keyed to the exact route and Hub id.
 */

/** Closed state vocabulary of a route: one inbound operator message. */
const ROUTE_STATES = Object.freeze([
  'accepted', 'awaiting-master', 'queued-master-unavailable', 'routed',
  'reply-held', 'released', 'replied', 'closed'
]);

/** How a route's destination was resolved. */
const ROUTE_RESOLUTIONS = Object.freeze(['reply-inheritance', 'pin', 'alias', 'default', 'master']);

/** The only four kinds of item that may reach the chat (ADR 0023 Decision 8). */
const OUTBOUND_KINDS = Object.freeze(['reply', 'notification', 'failure', 'candidate']);

/** The typed server notifications that ship first (Decision 9). */
const NOTIFICATION_TYPES = Object.freeze(['operator-needed', 'work-blocked', 'fleet-idle']);

/** What a verified session may submit to Master for consideration. */
const CANDIDATE_KINDS = Object.freeze(['milestone', 'operator-action-required']);

/** Longest operator message the gateway stores. */
const MAX_INBOUND_LENGTH = 8000;

/** Longest held reply or rendered outbound item. */
const MAX_OUTBOUND_LENGTH = 8000;

/**
 * Render a vocabulary as the body of a SQL `IN (...)` list.
 * @param {readonly string[]} values - Closed vocabulary.
 * @returns {string}
 */
function _inList(values) {
  return values.map((v) => `'${v}'`).join(',');
}

/**
 * DDL for every bridge table, in its final shape.
 *
 * Tables only; {@link bridgeIndexDdl} holds the indexes and triggers and
 * {@link createBridgeSchema} runs both in order. Idempotent (`IF NOT EXISTS`
 * throughout). Purely additive: a server that
 * predates the bridge ignores these tables, so the rows survive a rollback and
 * a re-upgrade.
 *
 * - `bridge_settings`: the operator's local switches. Absent `enabled` means off.
 * - `bridge_master_credentials`: verification material for the Master
 *   principal, one row per generation. The credential itself is never stored.
 * - `bridge_helper_tokens`: verification material for the chat helper's scoped
 *   token, hash only.
 * - `bridge_nonces`: request nonces already seen from the helper.
 * - `bridge_routes`: one row per inbound operator message, unique on the
 *   chat's own message id so a replay can never become a second message.
 * - `bridge_route_bodies`: the text of a route, held apart so it can be
 *   cleared after delivery or close while the route record stays.
 * - `bridge_route_proofs`: which Hub message belongs to which route, and under
 *   what proof. A reply is the bridge's only if this table says so.
 * - `bridge_outbound`: what waits for the helper. Every row has its own
 *   idempotency key; `hub_id` is nullable because most kinds never had one.
 * - `bridge_candidates`, `bridge_candidate_receipts`: facts a session offers
 *   Master, each bound to the receipts it rests on by id and digest.
 * - `bridge_aliases`, `bridge_pins`: routing policy. Global entries are the
 *   operator's; Master may hold a conversation-scoped pin only.
 * - `bridge_audit`: every bridge write. Never updated, and removed only by a
 *   compaction recorded in `bridge_audit_compactions`, which keeps a chained
 *   digest of what left. A request id is unique per operation, which is what
 *   makes a repeated write return its first result.
 * @returns {string}
 */
function bridgeTablesDdl() {
  return `
    CREATE TABLE IF NOT EXISTS bridge_settings (
      key        TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 60),
      value      TEXT CHECK (value IS NULL OR length(value) <= 200),
      updated_by TEXT NOT NULL CHECK (updated_by IN ('operator')),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bridge_master_credentials (
      generation      INTEGER PRIMARY KEY CHECK (generation >= 1),
      credential_hash TEXT    NOT NULL UNIQUE CHECK (length(credential_hash) = 64),
      status          TEXT    NOT NULL CHECK (status IN ('pending','active','revoked')),
      minted_at       TEXT    NOT NULL,
      delivered_at    TEXT,
      revoked_at      TEXT,
      revoke_reason   TEXT    CHECK (revoke_reason IS NULL OR length(revoke_reason) <= 40)
    );

    CREATE TABLE IF NOT EXISTS bridge_helper_tokens (
      token_id    TEXT PRIMARY KEY CHECK (length(token_id) BETWEEN 1 AND 64),
      token_hash  TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
      status      TEXT NOT NULL CHECK (status IN ('active','revoked')),
      created_by  TEXT NOT NULL CHECK (created_by IN ('operator')),
      created_at  TEXT NOT NULL,
      revoked_at  TEXT
    );

    CREATE TABLE IF NOT EXISTS bridge_nonces (
      nonce   TEXT PRIMARY KEY CHECK (length(nonce) BETWEEN 16 AND 128),
      seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bridge_routes (
      route_id                 TEXT    PRIMARY KEY CHECK (length(route_id) BETWEEN 1 AND 64),
      external_id              TEXT    NOT NULL UNIQUE CHECK (length(external_id) BETWEEN 1 AND 64),
      author_id                TEXT    NOT NULL CHECK (length(author_id) <= 64),
      space_id                 TEXT    NOT NULL CHECK (length(space_id) <= 64),
      channel_id               TEXT    NOT NULL CHECK (length(channel_id) <= 64),
      thread_id                TEXT    CHECK (thread_id IS NULL OR length(thread_id) <= 64),
      reply_to_external_id     TEXT    CHECK (reply_to_external_id IS NULL OR length(reply_to_external_id) <= 64),
      body_digest              TEXT    NOT NULL CHECK (length(body_digest) = 64),
      state                    TEXT    NOT NULL CHECK (state IN (${_inList(ROUTE_STATES)})),
      version                  INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      resolved_by              TEXT    CHECK (resolved_by IS NULL OR resolved_by IN (${_inList(ROUTE_RESOLUTIONS)})),
      destination_kind         TEXT    CHECK (destination_kind IS NULL OR destination_kind IN ('master','project')),
      destination_project_id   INTEGER,
      destination_workspace_id TEXT    CHECK (destination_workspace_id IS NULL OR length(destination_workspace_id) <= 128),
      resolved_generation      INTEGER CHECK (resolved_generation IS NULL OR resolved_generation >= 1),
      pending_notice_at        TEXT,
      master_wake_at           TEXT,
      failure_code             TEXT    CHECK (failure_code IS NULL OR length(failure_code) <= 40),
      closed_by                TEXT    CHECK (closed_by IS NULL OR closed_by IN ('gateway','master','operator')),
      created_at               TEXT    NOT NULL,
      updated_at               TEXT    NOT NULL,
      closed_at                TEXT,
      -- A destination is either wholly absent, workspace and generation
      -- included, or wholly named, and a project destination names its project.
      CHECK (
        (resolved_by IS NULL AND destination_kind IS NULL AND destination_project_id IS NULL
          AND destination_workspace_id IS NULL AND resolved_generation IS NULL)
        OR (resolved_by IS NOT NULL AND destination_kind = 'master' AND destination_project_id IS NULL)
        OR (resolved_by IS NOT NULL AND destination_kind = 'project' AND destination_project_id IS NOT NULL)
      ),
      -- A decision by the Master session names the generation that made it; a
      -- mechanical resolution was made by no generation and names none.
      CHECK (resolved_by IS NULL OR (resolved_by = 'master') = (resolved_generation IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_bridge_routes_conversation ON bridge_routes(channel_id, thread_id, created_at);

    CREATE TABLE IF NOT EXISTS bridge_route_bodies (
      body_id    INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id   TEXT    NOT NULL CHECK (length(route_id) <= 64),
      role       TEXT    NOT NULL CHECK (role IN ('inbound','reply','answer')),
      text       TEXT    CHECK (text IS NULL OR length(text) <= ${Math.max(MAX_INBOUND_LENGTH, MAX_OUTBOUND_LENGTH)}),
      digest     TEXT    NOT NULL CHECK (length(digest) = 64),
      created_at TEXT    NOT NULL,
      cleared_at TEXT,
      -- Cleared means the text is gone and the time it went is recorded.
      CHECK ((text IS NULL) = (cleared_at IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS bridge_route_proofs (
      proof_id            INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id            TEXT    NOT NULL CHECK (length(route_id) <= 64),
      direction           TEXT    NOT NULL CHECK (direction IN ('to-target','from-target')),
      hub_id              TEXT    NOT NULL CHECK (length(hub_id) BETWEEN 1 AND 128),
      exchange_id         TEXT    CHECK (exchange_id IS NULL OR length(exchange_id) <= 64),
      in_reply_to_hub_id  TEXT    CHECK (in_reply_to_hub_id IS NULL OR length(in_reply_to_hub_id) <= 128),
      sender_proof        TEXT    NOT NULL CHECK (sender_proof IN ('master-launch','gateway','launch')),
      master_generation   INTEGER CHECK (master_generation IS NULL OR master_generation >= 1),
      sender_project_id   INTEGER,
      sender_launch_id    TEXT    CHECK (sender_launch_id IS NULL OR length(sender_launch_id) <= 128),
      recorded_at         TEXT    NOT NULL,
      -- Master's proof always names the generation it was given under; a
      -- target's reply always names the launch and project that sent it and
      -- the bridge message it answers.
      CHECK (sender_proof <> 'master-launch' OR master_generation IS NOT NULL),
      CHECK (direction <> 'from-target'
        OR (sender_proof = 'launch' AND sender_project_id IS NOT NULL
            AND sender_launch_id IS NOT NULL AND in_reply_to_hub_id IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_bridge_route_proofs_route ON bridge_route_proofs(route_id, proof_id);

    CREATE TABLE IF NOT EXISTS bridge_outbound (
      outbound_id         INTEGER PRIMARY KEY AUTOINCREMENT,
      idem_key            TEXT    NOT NULL UNIQUE CHECK (length(idem_key) BETWEEN 1 AND 160),
      kind                TEXT    NOT NULL CHECK (kind IN (${_inList(OUTBOUND_KINDS)})),
      notify_type         TEXT    CHECK (notify_type IS NULL OR notify_type IN (${_inList(NOTIFICATION_TYPES)})),
      route_id            TEXT    CHECK (route_id IS NULL OR length(route_id) <= 64),
      candidate_id        TEXT    CHECK (candidate_id IS NULL OR length(candidate_id) <= 64),
      hub_id              TEXT    CHECK (hub_id IS NULL OR length(hub_id) <= 128),
      source_label        TEXT    NOT NULL CHECK (length(source_label) BETWEEN 1 AND 80),
      text                TEXT    CHECK (text IS NULL OR length(text) <= ${MAX_OUTBOUND_LENGTH}),
      digest              TEXT    NOT NULL CHECK (length(digest) = 64),
      state               TEXT    NOT NULL CHECK (state IN ('ready','delivered','dropped')),
      drop_code           TEXT    CHECK (drop_code IS NULL OR length(drop_code) <= 40),
      attempts            INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      delivered_ref       TEXT    CHECK (delivered_ref IS NULL OR length(delivered_ref) <= 64),
      released_generation INTEGER CHECK (released_generation IS NULL OR released_generation >= 1),
      created_at          TEXT    NOT NULL,
      updated_at          TEXT    NOT NULL,
      delivered_at        TEXT,
      -- Each kind carries exactly the references that make it that kind.
      CHECK (
        (kind = 'reply' AND route_id IS NOT NULL AND released_generation IS NOT NULL
          AND notify_type IS NULL AND candidate_id IS NULL)
        OR (kind = 'notification' AND notify_type IS NOT NULL AND candidate_id IS NULL)
        OR (kind = 'failure' AND route_id IS NOT NULL AND notify_type IS NULL AND candidate_id IS NULL)
        OR (kind = 'candidate' AND candidate_id IS NOT NULL AND released_generation IS NOT NULL
          AND notify_type IS NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS bridge_candidates (
      candidate_id      TEXT    PRIMARY KEY CHECK (length(candidate_id) BETWEEN 1 AND 64),
      idem_key          TEXT    NOT NULL UNIQUE CHECK (length(idem_key) BETWEEN 1 AND 160),
      kind              TEXT    NOT NULL CHECK (kind IN (${_inList(CANDIDATE_KINDS)})),
      source_project_id INTEGER NOT NULL,
      source_launch_id  TEXT    NOT NULL CHECK (length(source_launch_id) <= 128),
      text              TEXT    CHECK (text IS NULL OR length(text) <= ${MAX_OUTBOUND_LENGTH}),
      digest            TEXT    NOT NULL CHECK (length(digest) = 64),
      state             TEXT    NOT NULL CHECK (state IN ('submitted','approved','rejected','merged')),
      version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
      decided_generation INTEGER CHECK (decided_generation IS NULL OR decided_generation >= 1),
      created_at        TEXT    NOT NULL,
      decided_at        TEXT
    );

    CREATE TABLE IF NOT EXISTS bridge_candidate_receipts (
      candidate_id   TEXT NOT NULL CHECK (length(candidate_id) BETWEEN 1 AND 64),
      receipt_kind   TEXT NOT NULL CHECK (length(receipt_kind) BETWEEN 1 AND 40),
      receipt_id     TEXT NOT NULL CHECK (length(receipt_id) BETWEEN 1 AND 128),
      receipt_digest TEXT NOT NULL CHECK (length(receipt_digest) = 64),
      PRIMARY KEY (candidate_id, receipt_kind, receipt_id)
    );

    CREATE TABLE IF NOT EXISTS bridge_aliases (
      alias                  TEXT    PRIMARY KEY CHECK (length(alias) BETWEEN 1 AND 64),
      destination_kind       TEXT    NOT NULL CHECK (destination_kind IN ('master','project')),
      destination_project_id INTEGER,
      created_by             TEXT    NOT NULL CHECK (created_by IN ('operator')),
      created_at             TEXT    NOT NULL,
      CHECK ((destination_kind = 'project') = (destination_project_id IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS bridge_pins (
      pin_id                 TEXT    PRIMARY KEY CHECK (length(pin_id) BETWEEN 1 AND 64),
      scope                  TEXT    NOT NULL CHECK (scope IN ('global','conversation')),
      conversation_key       TEXT    CHECK (conversation_key IS NULL OR length(conversation_key) <= 160),
      destination_kind       TEXT    NOT NULL CHECK (destination_kind IN ('master','project')),
      destination_project_id INTEGER,
      created_by             TEXT    NOT NULL CHECK (created_by IN ('operator','master')),
      master_generation      INTEGER CHECK (master_generation IS NULL OR master_generation >= 1),
      created_at             TEXT    NOT NULL,
      revoked_at             TEXT,
      CHECK ((destination_kind = 'project') = (destination_project_id IS NOT NULL)),
      -- A conversation pin always names its conversation. A global pin may
      -- name one, or none, which means every conversation.
      CHECK (scope <> 'conversation' OR conversation_key IS NOT NULL),
      -- A global pin is the operator's alone; Master's pin names its generation.
      CHECK (scope <> 'global' OR created_by = 'operator'),
      CHECK ((created_by = 'master') = (master_generation IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_pins_conversation
      ON bridge_pins(conversation_key) WHERE scope = 'conversation' AND revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS bridge_audit_compactions (
      compaction_id   INTEGER PRIMARY KEY AUTOINCREMENT,
      through_seq     INTEGER NOT NULL CHECK (through_seq >= 1),
      row_count       INTEGER NOT NULL CHECK (row_count >= 1),
      rows_digest     TEXT    NOT NULL CHECK (length(rows_digest) = 64),
      previous_digest TEXT    CHECK (previous_digest IS NULL OR length(previous_digest) = 64),
      at              TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS bridge_audit (
      -- AUTOINCREMENT, so a sequence a compaction removed is never issued again.
      audit_seq         INTEGER PRIMARY KEY AUTOINCREMENT,
      op                TEXT    NOT NULL CHECK (length(op) BETWEEN 1 AND 40),
      request_id        TEXT    CHECK (request_id IS NULL OR length(request_id) BETWEEN 8 AND 128),
      actor             TEXT    NOT NULL CHECK (actor IN ('master','operator','helper','gateway','session')),
      proof             TEXT    NOT NULL CHECK (length(proof) BETWEEN 1 AND 40),
      master_generation INTEGER CHECK (master_generation IS NULL OR master_generation >= 1),
      route_id          TEXT    CHECK (route_id IS NULL OR length(route_id) <= 64),
      expected_version  INTEGER,
      outcome           TEXT    NOT NULL CHECK (length(outcome) BETWEEN 1 AND 40),
      detail_json       TEXT    CHECK (detail_json IS NULL OR length(detail_json) <= 2048),
      at                TEXT    NOT NULL,
      CHECK (actor <> 'master' OR master_generation IS NOT NULL)
    );
    CREATE INDEX IF NOT EXISTS idx_bridge_audit_route ON bridge_audit(route_id, audit_seq);

    -- A row can leave only under a compaction that has already recorded,
    -- in the same transaction, what it is removing.
    CREATE TRIGGER IF NOT EXISTS bridge_audit_append_only_delete
      BEFORE DELETE ON bridge_audit
      WHEN NOT EXISTS (SELECT 1 FROM bridge_audit_compactions WHERE through_seq >= OLD.audit_seq)
      BEGIN SELECT RAISE(ABORT, 'bridge_audit is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS bridge_audit_compactions_append_only_update
      BEFORE UPDATE ON bridge_audit_compactions
      BEGIN SELECT RAISE(ABORT, 'bridge_audit_compactions is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS bridge_audit_compactions_append_only_delete
      BEFORE DELETE ON bridge_audit_compactions
      BEGIN SELECT RAISE(ABORT, 'bridge_audit_compactions is append-only'); END;
    -- Integrity the store enforces without foreign keys, which this database
    -- does not run with: a child row needs its parent, and a route that is
    -- removed takes its bodies, proofs and outbound items with it.
    CREATE TRIGGER IF NOT EXISTS bridge_route_bodies_need_route
      BEFORE INSERT ON bridge_route_bodies
      WHEN NOT EXISTS (SELECT 1 FROM bridge_routes WHERE route_id = NEW.route_id)
      BEGIN SELECT RAISE(ABORT, 'bridge_route_bodies needs its route'); END;
    CREATE TRIGGER IF NOT EXISTS bridge_route_proofs_need_route
      BEFORE INSERT ON bridge_route_proofs
      WHEN NOT EXISTS (SELECT 1 FROM bridge_routes WHERE route_id = NEW.route_id)
      BEGIN SELECT RAISE(ABORT, 'bridge_route_proofs needs its route'); END;
    CREATE TRIGGER IF NOT EXISTS bridge_outbound_needs_parents
      BEFORE INSERT ON bridge_outbound
      WHEN (NEW.route_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bridge_routes WHERE route_id = NEW.route_id))
        OR (NEW.candidate_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM bridge_candidates WHERE candidate_id = NEW.candidate_id))
      BEGIN SELECT RAISE(ABORT, 'bridge_outbound needs its route or candidate'); END;
    CREATE TRIGGER IF NOT EXISTS bridge_candidates_need_project
      BEFORE INSERT ON bridge_candidates
      WHEN NOT EXISTS (SELECT 1 FROM projects WHERE id = NEW.source_project_id)
      BEGIN SELECT RAISE(ABORT, 'bridge_candidates needs its source project'); END;
    CREATE TRIGGER IF NOT EXISTS bridge_candidate_receipts_need_candidate
      BEFORE INSERT ON bridge_candidate_receipts
      WHEN NOT EXISTS (SELECT 1 FROM bridge_candidates WHERE candidate_id = NEW.candidate_id)
      BEGIN SELECT RAISE(ABORT, 'bridge_candidate_receipts needs its candidate'); END;
    CREATE TRIGGER IF NOT EXISTS bridge_candidate_receipts_immutable
      BEFORE UPDATE ON bridge_candidate_receipts
      BEGIN SELECT RAISE(ABORT, 'bridge_candidate_receipts is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS bridge_routes_delete_children
      AFTER DELETE ON bridge_routes
      BEGIN
        DELETE FROM bridge_route_bodies WHERE route_id = OLD.route_id;
        DELETE FROM bridge_route_proofs WHERE route_id = OLD.route_id;
        DELETE FROM bridge_outbound WHERE route_id = OLD.route_id;
      END;
    CREATE TRIGGER IF NOT EXISTS bridge_candidates_delete_children
      AFTER DELETE ON bridge_candidates
      BEGIN
        DELETE FROM bridge_candidate_receipts WHERE candidate_id = OLD.candidate_id;
        DELETE FROM bridge_outbound WHERE candidate_id = OLD.candidate_id;
      END;
  `;
}

/**
 * DDL for the bridge's indexes and triggers. Separate from the tables because
 * each names columns a table of the wrong shape lacks: created only once the
 * tables' shapes are proven, so a misshapen table is refused by name rather
 * than by whichever column SQLite trips on first.
 * @returns {string}
 */
function bridgeIndexDdl() {
  return `
    -- One slot, not one per status: a pending and an active generation at
    -- once would be two live credentials.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_master_credentials_live
      ON bridge_master_credentials((1)) WHERE status IN ('pending','active');

    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_helper_tokens_active
      ON bridge_helper_tokens(status) WHERE status = 'active';

    CREATE INDEX IF NOT EXISTS idx_bridge_nonces_seen ON bridge_nonces(seen_at);

    CREATE INDEX IF NOT EXISTS idx_bridge_routes_state ON bridge_routes(state, created_at);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_route_bodies_role ON bridge_route_bodies(route_id, role);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_route_proofs_hub ON bridge_route_proofs(hub_id);

    CREATE INDEX IF NOT EXISTS idx_bridge_outbound_state ON bridge_outbound(state, outbound_id);

    CREATE INDEX IF NOT EXISTS idx_bridge_candidates_state ON bridge_candidates(state, created_at);

    -- One active pin per scope and conversation; the operator may hold many
    -- global pins, one for each conversation and one for all of them.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_pins_global
      ON bridge_pins(COALESCE(conversation_key, '*')) WHERE scope = 'global' AND revoked_at IS NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_audit_request
      ON bridge_audit(op, request_id) WHERE request_id IS NOT NULL;

    CREATE TRIGGER IF NOT EXISTS bridge_audit_append_only_update
      BEFORE UPDATE ON bridge_audit
      BEGIN SELECT RAISE(ABORT, 'bridge_audit is append-only'); END;
  `;
}

/**
 * Every object the bridge needs, with the fragments its SQL must contain. A
 * name alone is not proof: a table of the right name and the wrong shape is
 * exactly what a half-applied or hand-edited store looks like.
 */
const BRIDGE_SCHEMA_OBJECTS = Object.freeze([
  { type: 'table', name: 'bridge_settings', needs: [/updated_by/] },
  { type: 'table', name: 'bridge_master_credentials', needs: [/credential_hash[^,]*UNIQUE/, /'pending','active','revoked'/] },
  { type: 'index', name: 'idx_bridge_master_credentials_live', needs: [/UNIQUE/i, /\(\(1\)\)/, /WHERE/i] },
  { type: 'table', name: 'bridge_helper_tokens', needs: [/token_hash[^,]*UNIQUE/] },
  { type: 'index', name: 'idx_bridge_helper_tokens_active', needs: [/UNIQUE/i, /WHERE/i] },
  { type: 'table', name: 'bridge_nonces', needs: [/nonce\s+TEXT PRIMARY KEY/] },
  { type: 'table', name: 'bridge_routes', needs: [/external_id[^,]*UNIQUE/, /version\s+INTEGER NOT NULL/, /'awaiting-master'/, /'reply-held'/, /\(resolved_by = 'master'\) = \(resolved_generation IS NOT NULL\)/] },
  { type: 'table', name: 'bridge_route_bodies', needs: [/cleared_at/, /\(text IS NULL\) = \(cleared_at IS NOT NULL\)/] },
  { type: 'index', name: 'idx_bridge_route_bodies_role', needs: [/UNIQUE/i] },
  { type: 'table', name: 'bridge_route_proofs', needs: [/'master-launch'/, /master_generation/, /in_reply_to_hub_id/] },
  { type: 'index', name: 'idx_bridge_route_proofs_hub', needs: [/UNIQUE/i] },
  { type: 'table', name: 'bridge_outbound', needs: [/idem_key[^,]*NOT NULL UNIQUE/, /kind\s+TEXT\s+NOT NULL/, /hub_id\s+TEXT\s+CHECK \(hub_id IS NULL/] },
  { type: 'table', name: 'bridge_candidates', needs: [/idem_key[^,]*NOT NULL UNIQUE/, /source_launch_id/] },
  { type: 'table', name: 'bridge_candidate_receipts', needs: [/receipt_digest/, /PRIMARY KEY \(candidate_id, receipt_kind, receipt_id\)/] },
  { type: 'table', name: 'bridge_aliases', needs: [/created_by[^,]*'operator'/] },
  { type: 'table', name: 'bridge_pins', needs: [/scope <> 'global' OR created_by = 'operator'/] },
  { type: 'index', name: 'idx_bridge_pins_global', needs: [/UNIQUE/i, /COALESCE\(conversation_key/, /WHERE/i] },
  { type: 'index', name: 'idx_bridge_pins_conversation', needs: [/UNIQUE/i, /WHERE/i] },
  { type: 'table', name: 'bridge_audit', needs: [/audit_seq\s+INTEGER PRIMARY KEY AUTOINCREMENT/, /master_generation/, /expected_version/] },
  { type: 'index', name: 'idx_bridge_audit_request', needs: [/UNIQUE/i, /WHERE/i] },
  { type: 'trigger', name: 'bridge_audit_append_only_update', needs: [/RAISE\(ABORT/] },
  { type: 'trigger', name: 'bridge_audit_append_only_delete', needs: [/RAISE\(ABORT/, /bridge_audit_compactions/] },
  { type: 'table', name: 'bridge_audit_compactions', needs: [/through_seq/, /rows_digest/, /previous_digest/] },
  { type: 'trigger', name: 'bridge_audit_compactions_append_only_update', needs: [/RAISE\(ABORT/] },
  { type: 'trigger', name: 'bridge_audit_compactions_append_only_delete', needs: [/RAISE\(ABORT/] },
  { type: 'trigger', name: 'bridge_route_bodies_need_route', needs: [/RAISE\(ABORT/] },
  { type: 'trigger', name: 'bridge_route_proofs_need_route', needs: [/RAISE\(ABORT/] },
  { type: 'trigger', name: 'bridge_outbound_needs_parents', needs: [/RAISE\(ABORT/] },
  { type: 'trigger', name: 'bridge_candidates_need_project', needs: [/RAISE\(ABORT/] },
  { type: 'trigger', name: 'bridge_candidate_receipts_need_candidate', needs: [/RAISE\(ABORT/] },
  { type: 'trigger', name: 'bridge_candidate_receipts_immutable', needs: [/RAISE\(ABORT/] },
  { type: 'trigger', name: 'bridge_routes_delete_children', needs: [/bridge_route_proofs/, /bridge_outbound/] },
  { type: 'trigger', name: 'bridge_candidates_delete_children', needs: [/bridge_candidate_receipts/] }
]);

/**
 * What is wrong with the bridge's storage, as a list of plain statements.
 * Empty when every object exists in the shape the gateway rests on.
 * @param {object} db - An open `node:sqlite` database.
 * @param {string[]|null} [types=null] - Limit the check to these object types.
 * @returns {string[]}
 */
function bridgeSchemaProblems(db, types = null) {
  const problems = [];
  const lookup = db.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?');
  for (const object of BRIDGE_SCHEMA_OBJECTS) {
    if (types && !types.includes(object.type)) continue;
    const row = lookup.get(object.type, object.name);
    if (!row) {
      problems.push(`no ${object.type} ${object.name}`);
      continue;
    }
    const missing = object.needs.filter((fragment) => !fragment.test(row.sql || ''));
    if (missing.length) problems.push(`${object.type} ${object.name} in an unexpected shape`);
  }
  return problems;
}

/**
 * Refuse a store whose bridge tables are missing or misshapen.
 * @param {object} db - An open `node:sqlite` database.
 * @param {string} [context='startup'] - Where the check ran, for the message.
 * @returns {void}
 * @throws {Error} Naming every problem found.
 */
function verifyBridgeSchema(db, context = 'startup') {
  const problems = bridgeSchemaProblems(db);
  if (problems.length) {
    throw new Error(`Operator bridge storage failed its shape check at ${context}: ${problems.join('; ')}.`);
  }
}

/**
 * Create the bridge's storage and prove it: tables, then their shape, then
 * the indexes and triggers that depend on that shape, then the whole. Runs on
 * every boot and inside the migration; a no-op on a store already correct.
 * @param {object} db - An open `node:sqlite` database.
 * @param {string} [context='startup'] - Where it ran, for the message.
 * @returns {void}
 * @throws {Error} Naming every problem found.
 */
function createBridgeSchema(db, context = 'startup') {
  db.exec(bridgeTablesDdl());
  const tableProblems = bridgeSchemaProblems(db, ['table']);
  if (tableProblems.length) {
    throw new Error(`Operator bridge storage failed its shape check at ${context}: ${tableProblems.join('; ')}.`);
  }
  db.exec(bridgeIndexDdl());
  verifyBridgeSchema(db, context);
}

module.exports = {
  ROUTE_STATES,
  ROUTE_RESOLUTIONS,
  OUTBOUND_KINDS,
  NOTIFICATION_TYPES,
  CANDIDATE_KINDS,
  MAX_INBOUND_LENGTH,
  MAX_OUTBOUND_LENGTH,
  BRIDGE_SCHEMA_OBJECTS,
  bridgeTablesDdl,
  bridgeIndexDdl,
  createBridgeSchema,
  bridgeSchemaProblems,
  verifyBridgeSchema
};
