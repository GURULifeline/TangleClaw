'use strict';

/*
 * The operator bridge's HTTP surface (ADR 0023).
 *
 * Three callers, three proofs, and none stands in for another: the Project
 * Master by its live credential (`tc bridge`, Decision 15), the chat helper by
 * its scoped token, and the operator by a verified account session.
 *
 * Every route is declared in {@link ROUTES} with the principal it belongs to,
 * and {@link handle} proves that principal before the route's handler runs. A
 * handler cannot be reached unauthenticated by forgetting a check, because it
 * has no check to forget: it is handed the proven caller.
 *
 * Every Master write names a request id and the version of the route it read.
 * Its first use is audited whether it is applied or refused; a repeat of the
 * same request id changes nothing and adds no row.
 */

const principal = require('./bridge-principal');
const crypto = require('node:crypto');
const store = require('./store');
const bridgeStore = require('./bridge-store');
const gateway = require('./bridge-gateway');
const { resolveControlCaller } = require('./control-auth');
const { ROUTE_STATES, MAX_OUTBOUND_LENGTH } = require('./bridge-schema');
const { createLogger } = require('./logger');

const log = createLogger('bridge-api');

/** Header the helper presents its token in, and the one carrying a request's nonce. */
const HELPER_TOKEN_HEADER = 'x-tangleclaw-bridge-helper-token';
const HELPER_NONCE_HEADER = 'x-tangleclaw-bridge-nonce';

/** Shape of a route id. Anything else names no route, and is refused before it can reach a table. */
const ROUTE_ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** Shape of a caller-supplied request id. */
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * A refusal in the API's error shape.
 * @param {number} status - HTTP status.
 * @param {string} code - Closed error code.
 * @param {string} error - One plain sentence.
 * @param {object} [extra] - Further fields for the body.
 * @returns {{status: number, body: object}}
 */
function _refuse(status, code, error, extra = {}) {
  return { status, body: { error, code, ...extra } };
}

/**
 * Refuse, and leave a trace of it: the code and nothing about the caller's
 * secret or message.
 * @param {string} who - Which principal's door was tried.
 * @param {number} status - HTTP status.
 * @param {string} code - Closed error code.
 * @param {string} error - One plain sentence.
 * @returns {{status: number, body: object}}
 */
function _refuseLogged(who, status, code, error) {
  log.warn('Bridge request refused', { principal: who, code });
  return _refuse(status, code, error);
}

/**
 * Refuse when the operator has not enabled the bridge.
 * @returns {object|null} The refusal, or null when enabled.
 */
function _disabled() {
  if (bridgeStore.settings.isEnabled()) return null;
  return _refuse(409, 'BRIDGE_DISABLED',
    'The operator bridge is disabled. Enabling it is the operator\'s alone, from a signed-in account session; nothing on this surface can.');
}

/**
 * Each principal's proof. Given the request and the route's declaration, each
 * returns `{caller}` or `{refusal}`.
 */
const PRINCIPALS = Object.freeze({
  /**
   * The Project Master: the live generation's credential.
   * @param {object} request - The request.
   * @param {object} entry - The route's declaration.
   * @returns {{caller: object}|{refusal: object}}
   */
  master(request, entry) {
    const master = principal.verify(request.headers ? request.headers[principal.CREDENTIAL_HEADER] : undefined);
    if (!master) {
      return {
        refusal: _refuseLogged('master', 401, 'BRIDGE_CREDENTIAL_REQUIRED',
          'This surface is the Project Master\'s, and the request did not carry the live Master\'s bridge credential. '
          + 'A Master launched before the bridge existed, or relaunched since, has to be relaunched to hold one.')
      };
    }
    const off = entry.whileDisabled ? null : _disabled();
    return off ? { refusal: off } : { caller: master };
  },

  /**
   * The chat helper: the active scoped token, and on a write a nonce that has
   * not been seen.
   * @param {object} request - The request.
   * @param {object} entry - The route's declaration.
   * @returns {{caller: object}|{refusal: object}}
   */
  helper(request, entry) {
    const headers = request.headers || {};
    const helper = gateway.verifyHelperToken(headers[HELPER_TOKEN_HEADER]);
    if (!helper) {
      return {
        refusal: _refuseLogged('helper', 401, 'HELPER_TOKEN_REQUIRED',
          'This route is the chat helper\'s, and the request did not carry the active helper token.')
      };
    }
    const off = _disabled();
    if (off) return { refusal: off };
    if (entry.method !== 'GET') {
      const nonce = headers[HELPER_NONCE_HEADER];
      if (typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(nonce)) {
        return { refusal: _refuseLogged('helper', 400, 'NONCE_REQUIRED', 'A helper write needs a nonce of 16 to 128 URL-safe characters.') };
      }
      if (!bridgeStore.nonces.claim(nonce)) return { refusal: _refuseLogged('helper', 409, 'NONCE_REUSED', 'That nonce was already used.') };
    }
    return { caller: helper };
  },

  /**
   * The operator: signed in with an account session. A request that merely
   * looks like the dashboard while the gate is open is not enough to read or
   * change bridge policy.
   * @param {object} request - The request; `request.req` is the HTTP request as `server.js` annotated it.
   * @returns {{caller: object}|{refusal: object}}
   */
  operator(request) {
    const req = request.req || {};
    const caller = resolveControlCaller(req);
    if (caller.kind !== 'operator' || !caller.actor || caller.actor.operatorProof !== 'verified-session') {
      return {
        refusal: _refuseLogged('operator', 403, 'OPERATOR_SESSION_REQUIRED',
          'Changing or reading bridge policy needs the operator signed in with an account session. '
          + 'An open gate or a dashboard-shaped request is not enough.')
      };
    }
    const session = req.tcSession || {};
    return { caller: { user: session.username || (session.userId != null ? String(session.userId) : null) } };
  }
});

/**
 * `GET status`: whether the bridge is enabled and which generation is asking.
 * Answers while disabled, so Master can tell "off" from "broken".
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @returns {{status: number, body: object}}
 */
function status(request, master) {
  const enabled = bridgeStore.settings.isEnabled();
  return {
    status: 200,
    body: {
      enabled,
      masterGeneration: master.generation,
      proof: master.proof,
      openRoutes: enabled ? bridgeStore.routes.list().length : 0
    }
  };
}

/**
 * `GET routes`: routes awaiting attention, oldest first, without bodies.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} [request.query] - `states`: comma-separated route states.
 * @returns {{status: number, body: object}}
 */
function listRoutes(request) {
  const raw = request.query && typeof request.query.states === 'string' ? request.query.states : '';
  const states = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = states.filter((s) => !ROUTE_STATES.includes(s));
  if (unknown.length) {
    return _refuse(400, 'UNKNOWN_ROUTE_STATE', `Unknown route state: ${unknown.join(', ')}.`, { states: ROUTE_STATES });
  }
  return { status: 200, body: { routes: bridgeStore.routes.list({ states }) } };
}

/**
 * `GET routes/:routeId`: one route with the bodies still held and its audit.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} request.params - `routeId`.
 * @returns {{status: number, body: object}}
 */
function readRoute(request) {
  const route = ROUTE_ID.test(request.params.routeId) ? bridgeStore.routes.get(request.params.routeId) : null;
  if (!route) return _refuse(404, 'ROUTE_NOT_FOUND', 'No such route.');
  return {
    status: 200,
    body: {
      route,
      // What the operator wrote is conversation. It grants nothing, whatever it asks for.
      authority: 'conversation-only',
      bodies: bridgeStore.routes.bodies(route.routeId),
      audit: bridgeStore.audit.forRoute(route.routeId)
    }
  };
}

/**
 * Validate the two fields every write carries.
 * @param {object} body - Request body.
 * @returns {{requestId: string, expectedVersion: number}|{refusal: object}}
 */
function _writeFields(body) {
  const requestId = body && body.requestId;
  const expectedVersion = body && body.expectedVersion;
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
    return { refusal: _refuse(400, 'REQUEST_ID_REQUIRED', 'A write needs a requestId of 8 to 128 letters, digits, dots, colons, dashes or underscores.') };
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return { refusal: _refuse(400, 'EXPECTED_VERSION_REQUIRED', 'A write needs expectedVersion: the version of the route as you last read it.') };
  }
  return { requestId, expectedVersion };
}

/** HTTP status for each outcome a route write can have. Anything unlisted is a 409 refusal. */
const WRITE_STATUS = Object.freeze({
  applied: 200,
  'route-not-found': 404
});

/**
 * Shape a route write's result as a response.
 * @param {{outcome: string, replayed: boolean, route: (object|null)}} result - From `applyRouteWrite`.
 * @returns {{status: number, body: object}}
 */
function _writeResponse(result) {
  const status = WRITE_STATUS[result.outcome] || 409;
  const body = { outcome: result.outcome, replayed: result.replayed, route: result.route };
  if (status !== 200) {
    body.code = result.outcome.toUpperCase().replace(/-/g, '_');
    body.error = `The write was not applied: ${result.outcome}.`;
  }
  return { status, body };
}

/**
 * `POST routes/:routeId/close`: Master closes a route explicitly (Decision 7).
 * The bodies still held for it are cleared in the same transaction. Allowed
 * while the bridge is disabled, so that turning the bridge off never leaves
 * message text held with no way to let it go.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} request.params - `routeId`.
 * @param {object} request.body - `{requestId, expectedVersion}`.
 * @param {string} [request.at] - Timestamp override (tests).
 * @returns {{status: number, body: object}}
 */
function closeRoute(request, master) {
  const w = _masterWrite(request, master);
  if (w.refusal) return w.refusal;
  const at = request.at || new Date().toISOString();
  const result = bridgeStore.applyRouteWrite({
    op: 'close', requestId: w.fields.requestId, routeId: w.routeId, expectedVersion: w.fields.expectedVersion,
    actor: 'master', proof: master.proof, masterGeneration: master.generation, at,
    change: (route) => {
      if (route.state === 'closed') return { refuse: 'already-closed' };
      return { set: { state: 'closed', closed_by: 'master', closed_at: at }, clearBodies: true, detail: { from: route.state } };
    }
  });
  return _writeResponse(result);
}

/**
 * Whether text is fit to hand to a chat: printable, with no control characters
 * beyond newline and tab and no bidirectional overrides that could reorder
 * what the operator reads.
 * @param {string} text - Candidate text.
 * @returns {boolean}
 */
function _displaySafe(text) {
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/.test(text);
}

/**
 * Read a destination a caller named: `master`, or a project by id or exact name.
 * @param {*} to - What the caller sent.
 * @returns {{kind: string, projectId: (number|null), label: string}|null} Null when it names nothing.
 */
function _destinationFrom(to) {
  if (to === 'master') return { kind: 'master', projectId: null, label: 'Project Master' };
  const project = Number.isInteger(to) ? store.projects.get(to)
    : (typeof to === 'string' && to ? store.projects.getByName(to) : null);
  if (!project || project.archived) return null;
  return { kind: 'project', projectId: project.id, label: project.name };
}

/**
 * The fields every Master write carries, validated.
 * @param {object} request - The request.
 * @param {object} master - The proven Master.
 * @returns {{master: object, fields: object, routeId: string}|{refusal: object}}
 */
function _masterWrite(request, master) {
  const fields = _writeFields(request.body);
  if (fields.refusal) return { refusal: fields.refusal };
  const routeId = request.params.routeId;
  // An id that could not be a route's is refused here: it could not be
  // recorded against the audit either, so there is nothing to apply or audit.
  if (!ROUTE_ID.test(routeId)) return { refusal: _refuse(404, 'ROUTE_NOT_FOUND', 'No such route.') };
  return { master, fields, routeId };
}

/**
 * `POST routes/:routeId/route`: Master names the destination of a route that
 * is waiting for it. The gateway then carries the message there.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} request.params - `routeId`.
 * @param {object} request.body - `{requestId, expectedVersion, to}`; `to` is `master`, a project id or an exact project name.
 * @returns {Promise<{status: number, body: object}>}
 */
async function routeTo(request, master) {
  const w = _masterWrite(request, master);
  if (w.refusal) return w.refusal;
  const destination = _destinationFrom(request.body.to);
  if (!destination) return _refuse(400, 'UNKNOWN_DESTINATION', 'Name the destination exactly: "master", a project id, or a project name.');
  const result = bridgeStore.applyRouteWrite({
    op: 'route', requestId: w.fields.requestId, routeId: w.routeId, expectedVersion: w.fields.expectedVersion,
    actor: 'master', proof: w.master.proof, masterGeneration: w.master.generation,
    change: (route) => {
      if (route.state !== 'awaiting-master') return { refuse: 'not-awaiting-master', detail: { state: route.state } };
      return {
        set: {
          state: 'accepted', resolved_by: 'master', destination_kind: destination.kind,
          destination_project_id: destination.projectId, resolved_generation: w.master.generation, failure_code: null
        },
        detail: { to: destination.kind, projectId: destination.projectId }
      };
    }
  });
  if (result.outcome === 'applied' && !result.replayed) result.route = await gateway.advance(w.routeId);
  return _writeResponse(result);
}

/**
 * Release an answer for a route: the one path by which anything a route
 * produced reaches the operator. The answer is Master's, whatever its source.
 * @param {object} w - What {@link _masterWrite} returned.
 * @param {string} op - `answer` or `release`.
 * @param {(route: object) => ({text: string, label: string}|{refuse: string})} source - Where the text comes from.
 * @returns {{status: number, body: object}}
 */
function _release(w, op, source) {
  const result = bridgeStore.applyRouteWrite({
    op, requestId: w.fields.requestId, routeId: w.routeId, expectedVersion: w.fields.expectedVersion,
    actor: 'master', proof: w.master.proof, masterGeneration: w.master.generation,
    change: (route) => {
      const from = source(route);
      if (from.refuse) return { refuse: from.refuse, detail: { state: route.state } };
      return {
        set: { state: 'released' },
        body: { role: 'answer', text: from.text, digest: bridgeStore.digest(from.text) },
        outbound: {
          idemKey: `route:${route.routeId}:answer`, kind: 'reply', sourceLabel: from.label, text: from.text,
          digest: bridgeStore.digest(from.text), releasedGeneration: w.master.generation
        },
        detail: { from: route.state }
      };
    }
  });
  return _writeResponse(result);
}

/**
 * `POST routes/:routeId/answer`: Master answers the operator in its own words.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} request.params - `routeId`.
 * @param {object} request.body - `{requestId, expectedVersion, text}`.
 * @returns {{status: number, body: object}}
 */
function answerRoute(request, master) {
  const w = _masterWrite(request, master);
  if (w.refusal) return w.refusal;
  const text = request.body.text;
  if (typeof text !== 'string' || !text.trim()) return _refuse(400, 'ANSWER_REQUIRED', 'An answer needs text.');
  if (text.length > MAX_OUTBOUND_LENGTH) return _refuse(413, 'ANSWER_TOO_LONG', `An answer may be at most ${MAX_OUTBOUND_LENGTH} characters.`);
  if (!_displaySafe(text)) return _refuse(400, 'ANSWER_NOT_DISPLAY_SAFE', 'The answer contains control or text-direction characters.');
  return _release(w, 'answer', (route) => (
    ['routed', 'reply-held', 'awaiting-master'].includes(route.state)
      ? { text, label: 'Project Master' }
      : { refuse: 'not-answerable' }
  ));
}

/**
 * `POST routes/:routeId/release`: Master sends on, unchanged, the reply a
 * destination gave and the gateway is holding.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} request.params - `routeId`.
 * @param {object} request.body - `{requestId, expectedVersion}`.
 * @returns {{status: number, body: object}}
 */
function releaseRoute(request, master) {
  const w = _masterWrite(request, master);
  if (w.refusal) return w.refusal;
  return _release(w, 'release', (route) => {
    if (route.state !== 'reply-held') return { refuse: 'no-reply-held' };
    const held = bridgeStore.routes.body(route.routeId, 'reply');
    if (!held || !held.text) return { refuse: 'no-reply-held' };
    if (!_displaySafe(held.text)) return { refuse: 'reply-not-display-safe' };
    const project = route.destination && route.destination.projectId ? store.projects.get(route.destination.projectId) : null;
    return { text: held.text, label: `Project Master, relaying ${project ? project.name : 'a session'}`.slice(0, 80) };
  });
}

/**
 * `POST routes/:routeId/pin`: Master pins the route's conversation to a
 * destination. Conversation-scoped only; a global pin is the operator's.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} request.params - `routeId`.
 * @param {object} request.body - `{requestId, expectedVersion, to}`.
 * @returns {{status: number, body: object}}
 */
function pinRoute(request, master) {
  const w = _masterWrite(request, master);
  if (w.refusal) return w.refusal;
  const destination = _destinationFrom(request.body.to);
  if (!destination) return _refuse(400, 'UNKNOWN_DESTINATION', 'Name the destination exactly: "master", a project id, or a project name.');
  const result = bridgeStore.applyRouteWrite({
    op: 'pin', requestId: w.fields.requestId, routeId: w.routeId, expectedVersion: w.fields.expectedVersion,
    actor: 'master', proof: w.master.proof, masterGeneration: w.master.generation,
    change: (route) => {
      if (route.state === 'closed') return { refuse: 'already-closed' };
      return {
        set: {},
        pin: {
          pinId: `pin_${crypto.randomBytes(9).toString('base64url')}`, conversationKey: gateway.conversationKey(route.context),
          destination: { kind: destination.kind, projectId: destination.projectId }
        },
        detail: { to: destination.kind, projectId: destination.projectId }
      };
    }
  });
  return _writeResponse(result);
}

/**
 * `POST helper/inbound`: the helper hands over one operator message.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} request.body - The message; see `bridge-gateway#acceptInbound`.
 * @returns {Promise<{status: number, body: object}>}
 */
async function helperInbound(request) {
  return gateway.acceptInbound(request.body);
}

/**
 * `GET helper/outbound`: what the helper should post next.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @returns {{status: number, body: object}}
 */
function helperOutbound() {
  return { status: 200, body: { items: gateway.outboundForHelper() } };
}

/**
 * `POST helper/outbound/:outboundId/ack`: the chat confirmed a post.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} request.params - `outboundId`.
 * @param {object} request.body - `{deliveredRef}`: the chat's id for the posted message.
 * @returns {{status: number, body: object}}
 */
function helperAck(request) {
  if (!/^\d{1,12}$/.test(String(request.params.outboundId))) return _refuse(404, 'OUTBOUND_NOT_FOUND', 'No such outbound item.');
  return gateway.acknowledgeOutbound(Number(request.params.outboundId), request.body ? request.body.deliveredRef : undefined);
}

/**
 * Record one operator policy change in the audit.
 * @param {string} op - Operation name.
 * @param {{user: (string|null)}} operator - The verified operator.
 * @param {object} [detail] - Small structured detail; never a secret.
 * @returns {void}
 */
function _auditOperator(op, operator, detail) {
  bridgeStore.audit.append({
    op, actor: 'operator', proof: 'verified-session', outcome: 'applied', detail: { ...(detail || {}), user: operator.user }
  });
}

/**
 * `GET operator/status`: the bridge's policy and what is waiting.
 * @param {object} request
 * @param {object} request.req - The HTTP request.
 * @returns {{status: number, body: object}}
 */
function operatorStatus(request, operator) {
  return {
    status: 200,
    body: {
      enabled: bridgeStore.settings.isEnabled(),
      allowlist: gateway.allowlist(),
      helperToken: bridgeStore.helperTokens.active(),
      masterCredential: bridgeStore.masterCredentials.live(),
      aliases: bridgeStore.aliases.list(),
      pins: bridgeStore.pins.list(),
      openRoutes: bridgeStore.routes.list().length,
      waitingForHelper: bridgeStore.outbound.ready({ limit: 100 }).length,
      droppedArrivals: gateway.droppedArrivals()
    }
  };
}

/**
 * `POST operator/enable` and `operator/disable`: the operator's switch.
 * Enabling is refused until the allowlist is set and a helper token exists,
 * so the bridge never opens to nobody in particular.
 * @param {boolean} enable - Which way.
 * @returns {(request: object) => {status: number, body: object}}
 */
function operatorSwitch(enable) {
  return (request, operator) => {
    if (enable && !gateway.allowlist()) return _refuse(409, 'ALLOWLIST_NOT_SET', 'Set the allowlist before enabling the bridge.');
    if (enable && !bridgeStore.helperTokens.active()) return _refuse(409, 'HELPER_TOKEN_NOT_SET', 'Create the helper token before enabling the bridge.');
    bridgeStore.settings.set('enabled', enable ? 'true' : 'false');
    _auditOperator(enable ? 'enable' : 'disable', operator);
    const listener = gateway.syncListener();
    return { status: 200, body: { enabled: enable, listener: listener.state } };
  };
}

/**
 * `POST operator/allowlist`: the one author, space and channel accepted.
 * @param {object} request
 * @param {object} request.req - The HTTP request.
 * @param {object} request.body - `{authorId, spaceId, channelId}`.
 * @returns {{status: number, body: object}}
 */
function operatorAllowlist(request, operator) {
  const body = request.body || {};
  for (const field of ['authorId', 'spaceId', 'channelId']) {
    if (typeof body[field] !== 'string' || !gateway.CHAT_ID.test(body[field])) {
      return _refuse(400, 'BAD_ALLOWLIST', `Missing or malformed ${field}.`);
    }
  }
  bridgeStore.settings.set('allow.author', body.authorId);
  bridgeStore.settings.set('allow.space', body.spaceId);
  bridgeStore.settings.set('allow.channel', body.channelId);
  // The ids themselves stay out of the audit: they identify a person and a place.
  _auditOperator('allowlist', operator);
  return { status: 200, body: { allowlist: gateway.allowlist() } };
}

/**
 * `POST operator/helper-token`: replace the helper token. The value is in
 * this response and nowhere else; only its hash is kept.
 * @param {object} request
 * @param {object} request.req - The HTTP request.
 * @returns {{status: number, body: object}}
 */
function operatorMintHelperToken(request, operator) {
  const minted = gateway.mintHelperToken();
  _auditOperator('helper-token-mint', operator, { tokenId: minted.tokenId });
  return { status: 201, body: { tokenId: minted.tokenId, token: minted.token, shownOnce: true } };
}

/**
 * `DELETE operator/helper-token`: revoke the helper token.
 * @param {object} request
 * @param {object} request.req - The HTTP request.
 * @returns {{status: number, body: object}}
 */
function operatorRevokeHelperToken(request, operator) {
  const revoked = bridgeStore.helperTokens.revoke();
  _auditOperator('helper-token-revoke', operator, { revoked });
  return { status: 200, body: { revoked } };
}

/**
 * `POST operator/aliases`: create or replace a global alias.
 * @param {object} request
 * @param {object} request.req - The HTTP request.
 * @param {object} request.body - `{alias, to}`.
 * @returns {{status: number, body: object}}
 */
function operatorSetAlias(request, operator) {
  const body = request.body || {};
  const alias = typeof body.alias === 'string' ? body.alias.toLowerCase() : '';
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(alias)) return _refuse(400, 'BAD_ALIAS', 'An alias is 1 to 64 letters, digits, dots, dashes or underscores.');
  if (alias === 'master') return _refuse(409, 'ALIAS_RESERVED', '"master" always means the Project Master and cannot be an alias.');
  const destination = _destinationFrom(body.to);
  if (!destination) return _refuse(400, 'UNKNOWN_DESTINATION', 'Name the destination exactly: "master", a project id, or a project name.');
  bridgeStore.aliases.set(alias, destination);
  _auditOperator('alias-set', operator, { alias, to: destination.kind, projectId: destination.projectId });
  return { status: 200, body: { alias, destination: { kind: destination.kind, projectId: destination.projectId } } };
}

/**
 * `DELETE operator/aliases/:alias`: remove a global alias.
 * @param {object} request
 * @param {object} request.req - The HTTP request.
 * @param {object} request.params - `alias`.
 * @returns {{status: number, body: object}}
 */
function operatorRemoveAlias(request, operator) {
  const alias = String(request.params.alias || '').toLowerCase();
  if (!bridgeStore.aliases.remove(alias)) return _refuse(404, 'ALIAS_NOT_FOUND', 'No such alias.');
  _auditOperator('alias-remove', operator, { alias });
  return { status: 200, body: { removed: alias } };
}

/**
 * `POST operator/pins`: set the operator's pin for one conversation, or for
 * every conversation when no `conversationKey` is given.
 * @param {object} request
 * @param {object} request.req - The HTTP request.
 * @param {object} request.body - `{conversationKey?, to}`.
 * @returns {{status: number, body: object}}
 */
function operatorSetPin(request, operator) {
  const body = request.body || {};
  const key = body.conversationKey == null ? null : body.conversationKey;
  if (key !== null && (typeof key !== 'string' || !/^[A-Za-z0-9_:-]{1,160}$/.test(key))) {
    return _refuse(400, 'BAD_CONVERSATION', 'A conversation key is a channel id, or channel:thread.');
  }
  const destination = _destinationFrom(body.to);
  if (!destination) return _refuse(400, 'UNKNOWN_DESTINATION', 'Name the destination exactly: "master", a project id, or a project name.');
  const pinId = `pin_${crypto.randomBytes(9).toString('base64url')}`;
  bridgeStore.pins.setGlobal({ pinId, conversationKey: key, destination });
  _auditOperator('pin-set', operator, { pinId, to: destination.kind, projectId: destination.projectId, every: key === null });
  return { status: 200, body: { pinId, conversationKey: key, destination: { kind: destination.kind, projectId: destination.projectId } } };
}

/**
 * `DELETE operator/pins/:pinId`: revoke any active pin, the Master's included.
 * @param {object} request
 * @param {object} request.req - The HTTP request.
 * @param {object} request.params - `pinId`.
 * @returns {{status: number, body: object}}
 */
function operatorRevokePin(request, operator) {
  if (!bridgeStore.pins.revoke(String(request.params.pinId || ''))) return _refuse(404, 'PIN_NOT_FOUND', 'No such active pin.');
  _auditOperator('pin-revoke', operator, { pinId: request.params.pinId });
  return { status: 200, body: { revoked: request.params.pinId } };
}

/**
 * Every bridge route: its method, its path, the one principal it belongs to,
 * and its handler. `whileDisabled` marks the few a disabled bridge still
 * answers.
 */
const ROUTES = Object.freeze([
  { method: 'GET', path: '/api/bridge/master/status', principal: 'master', whileDisabled: true, handler: status },
  { method: 'GET', path: '/api/bridge/master/routes', principal: 'master', handler: listRoutes },
  { method: 'GET', path: '/api/bridge/master/routes/:routeId', principal: 'master', handler: readRoute },
  { method: 'POST', path: '/api/bridge/master/routes/:routeId/close', principal: 'master', whileDisabled: true, handler: closeRoute },
  { method: 'POST', path: '/api/bridge/master/routes/:routeId/route', principal: 'master', handler: routeTo },
  { method: 'POST', path: '/api/bridge/master/routes/:routeId/answer', principal: 'master', handler: answerRoute },
  { method: 'POST', path: '/api/bridge/master/routes/:routeId/release', principal: 'master', handler: releaseRoute },
  { method: 'POST', path: '/api/bridge/master/routes/:routeId/pin', principal: 'master', handler: pinRoute },
  { method: 'POST', path: '/api/bridge/helper/inbound', principal: 'helper', handler: helperInbound },
  { method: 'GET', path: '/api/bridge/helper/outbound', principal: 'helper', handler: helperOutbound },
  { method: 'POST', path: '/api/bridge/helper/outbound/:outboundId/ack', principal: 'helper', handler: helperAck },
  { method: 'GET', path: '/api/bridge/operator/status', principal: 'operator', handler: operatorStatus },
  { method: 'POST', path: '/api/bridge/operator/enable', principal: 'operator', handler: operatorSwitch(true) },
  { method: 'POST', path: '/api/bridge/operator/disable', principal: 'operator', handler: operatorSwitch(false) },
  { method: 'POST', path: '/api/bridge/operator/allowlist', principal: 'operator', handler: operatorAllowlist },
  { method: 'POST', path: '/api/bridge/operator/helper-token', principal: 'operator', handler: operatorMintHelperToken },
  { method: 'DELETE', path: '/api/bridge/operator/helper-token', principal: 'operator', handler: operatorRevokeHelperToken },
  { method: 'POST', path: '/api/bridge/operator/aliases', principal: 'operator', handler: operatorSetAlias },
  { method: 'DELETE', path: '/api/bridge/operator/aliases/:alias', principal: 'operator', handler: operatorRemoveAlias },
  { method: 'POST', path: '/api/bridge/operator/pins', principal: 'operator', handler: operatorSetPin },
  { method: 'DELETE', path: '/api/bridge/operator/pins/:pinId', principal: 'operator', handler: operatorRevokePin }
]);

/**
 * Answer one bridge request: prove the route's principal, then run its
 * handler with the proven caller. The only way a handler is reached.
 * @param {{method: string, path: string, principal: string, handler: Function}} entry - A {@link ROUTES} entry.
 * @param {{req?: object, headers: object, params?: object, query?: object, body?: object}} request - The request.
 * @returns {Promise<{status: number, body: object}>}
 */
async function handle(entry, request) {
  const proven = PRINCIPALS[entry.principal](request, entry);
  if (proven.refusal) return proven.refusal;
  return entry.handler({ params: {}, query: {}, ...request }, proven.caller);
}

/**
 * The declared route for a method and path pattern.
 * @param {string} method - HTTP method.
 * @param {string} path - Path pattern as declared.
 * @returns {object} The entry.
 * @throws {Error} When no such route is declared.
 */
function routeFor(method, path) {
  const entry = ROUTES.find((r) => r.method === method && r.path === path);
  if (!entry) throw new Error(`no bridge route ${method} ${path}`);
  return entry;
}

module.exports = { HELPER_TOKEN_HEADER, HELPER_NONCE_HEADER, ROUTES, handle, routeFor };
