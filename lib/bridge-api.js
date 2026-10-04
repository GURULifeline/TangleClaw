'use strict';

/*
 * The Project Master's structured surface on the operator bridge (ADR 0023
 * Decision 15). `tc bridge` speaks to these handlers; the gateway never reads
 * a routing decision out of prose.
 *
 * Every handler answers `{status, body}` and is authorised the same way: the
 * request must carry the live Master generation's credential. Nothing else
 * admits a caller here, and the credential admits its holder nowhere else.
 * Every write names a request id and the version of the route it read. Its
 * first use is audited whether it is applied or refused; a repeat of the same
 * request id changes nothing and adds no row.
 *
 * This is the surface and its guarantees. The transitions a route can make
 * arrive with the gateway's state machine; until then the one decision Master
 * can record is closing a route.
 */

const principal = require('./bridge-principal');
const bridgeStore = require('./bridge-store');
const { ROUTE_STATES } = require('./bridge-schema');
const { createLogger } = require('./logger');

const log = createLogger('bridge-api');

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
 * Resolve the caller as the live Master, or produce the refusal.
 * @param {object} headers - Request headers.
 * @returns {{master: {generation: number, proof: string}}|{refusal: object}}
 */
function _authorise(headers) {
  const master = principal.verify(headers ? headers[principal.CREDENTIAL_HEADER] : undefined);
  if (!master) {
    // Recorded so a refused attempt leaves a trace. Whether a credential was
    // presented is the only thing said about it.
    log.warn('Bridge request refused — not the live Master credential', {
      presented: !!(headers && headers[principal.CREDENTIAL_HEADER])
    });
    return {
      refusal: _refuse(401, 'BRIDGE_CREDENTIAL_REQUIRED',
        'This surface is the Project Master\'s, and the request did not carry the live Master\'s bridge credential. '
        + 'A Master launched before the bridge existed, or relaunched since, has to be relaunched to hold one.')
    };
  }
  return { master };
}

/**
 * Refuse when the operator has not enabled the bridge.
 * @returns {object|null} The refusal, or null when enabled.
 */
function _disabled() {
  if (bridgeStore.settings.isEnabled()) return null;
  return _refuse(409, 'BRIDGE_DISABLED',
    'The operator bridge is disabled. Enabling it is the operator\'s alone and is done locally; nothing on this surface can.');
}

/**
 * `GET status`: whether the bridge is enabled and which generation is asking.
 * Answers while disabled, so Master can tell "off" from "broken".
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @returns {{status: number, body: object}}
 */
function status(request) {
  const auth = _authorise(request.headers);
  if (auth.refusal) return auth.refusal;
  const enabled = bridgeStore.settings.isEnabled();
  return {
    status: 200,
    body: {
      enabled,
      masterGeneration: auth.master.generation,
      proof: auth.master.proof,
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
  const auth = _authorise(request.headers);
  if (auth.refusal) return auth.refusal;
  const off = _disabled();
  if (off) return off;
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
  const auth = _authorise(request.headers);
  if (auth.refusal) return auth.refusal;
  const off = _disabled();
  if (off) return off;
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

/** HTTP status for each outcome a route write can have. */
const WRITE_STATUS = Object.freeze({
  applied: 200,
  'route-not-found': 404,
  'version-conflict': 409,
  'request-id-reused': 409,
  'already-closed': 409
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
 * The bodies still held for it are cleared in the same transaction.
 * @param {object} request
 * @param {object} request.headers - Request headers.
 * @param {object} request.params - `routeId`.
 * @param {object} request.body - `{requestId, expectedVersion}`.
 * @param {string} [request.at] - Timestamp override (tests).
 * @returns {{status: number, body: object}}
 */
function closeRoute(request) {
  const auth = _authorise(request.headers);
  if (auth.refusal) return auth.refusal;
  const off = _disabled();
  if (off) return off;
  const fields = _writeFields(request.body);
  if (fields.refusal) return fields.refusal;
  const at = request.at || new Date().toISOString();
  const routeId = request.params.routeId;
  // An id that could not be a route's is refused here: it could not be
  // recorded against the audit either, so there is nothing to apply or audit.
  if (!ROUTE_ID.test(routeId)) return _refuse(404, 'ROUTE_NOT_FOUND', 'No such route.');
  const result = bridgeStore.applyRouteWrite({
    op: 'close',
    requestId: fields.requestId,
    routeId,
    expectedVersion: fields.expectedVersion,
    actor: 'master',
    proof: auth.master.proof,
    masterGeneration: auth.master.generation,
    at,
    change: (route) => {
      if (route.state === 'closed') return { refuse: 'already-closed' };
      return {
        set: { state: 'closed', closed_by: 'master', closed_at: at },
        clearBodies: true,
        detail: { from: route.state }
      };
    }
  });
  return _writeResponse(result);
}

module.exports = { status, listRoutes, readRoute, closeRoute };
