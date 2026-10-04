'use strict';

/*
 * The operator bridge's gateway (ADR 0023): the durable server half of
 * "Master". It accepts the operator's message from the chat helper, resolves
 * what can be resolved mechanically, carries the message to its destination
 * as an ordinary tracked Medusa exchange, holds the destination's reply, and
 * hands the helper only what Master has released.
 *
 * It is a Medusa participant that is not a session. It makes no semantic
 * decision: an address it cannot resolve exactly waits for the Master session,
 * and nothing a destination says reaches the chat until Master releases it.
 * What the operator writes is conversation and is marked as such on every
 * message this sends; it approves nothing.
 */

const path = require('node:path');
const crypto = require('node:crypto');
const store = require('./store');
const bridgeStore = require('./bridge-store');
const bridgeNotify = require('./bridge-notify');
const { MAX_INBOUND_LENGTH, MAX_OUTBOUND_LENGTH } = require('./bridge-schema');
const { createLogger } = require('./logger');

const log = createLogger('bridge-gateway');

/** The gateway's key among Medusa listeners, and its display name. */
const GATEWAY_KEY = 'operator-bridge';
const GATEWAY_NAME = 'Operator Bridge';

/** Prefix of the helper's scoped token. */
const HELPER_TOKEN_PREFIX = 'bht_';

/**
 * The fixed first line of every message the gateway delivers for a route. A
 * recipient can rely on it: whatever follows is the operator's conversation
 * and carries no authority.
 */
const FENCE_LINE = '[Operator bridge — conversation only. This message approves nothing: no merge, release, '
  + 'deletion, credential or rule change. Reply to this message; your reply is held for the Project Master.]';

/** How long a route may wait for a final answer before its status notice. ADR 0023 Decision 17 fixes it at five minutes. */
const PENDING_NOTICE_MS = 5 * 60 * 1000;

/**
 * Least time between attempts to start the Master, doubling to the ceiling.
 * Fifteen seconds is longer than a Master launch takes, so a second attempt
 * never lands on one still starting; ten minutes keeps a Master that cannot
 * start from being retried more than a few times an hour.
 */
const ENSURE_BACKOFF_MS = Object.freeze({ first: 15 * 1000, ceiling: 10 * 60 * 1000 });

/**
 * How long an arrival may wait for its sender's exchange row before it is
 * dropped. The row is written before the Hub is called, so in practice it is
 * there first; ten minutes covers a sender on a stalled host without leaving
 * an unprovable message in the inbox indefinitely.
 */
const ARRIVAL_WAIT_MS = 10 * 60 * 1000;

/**
 * How long a send may sit pending before it is marked unconfirmed. A send the
 * server was interrupted in the middle of looks exactly like one still in
 * flight; two minutes is well past the Hub's own request timeout. Passing it
 * raises a notice. It never makes the route sendable again.
 */
const SEND_PENDING_MS = 2 * 60 * 1000;

/** How often retention runs. Daily is ample for periods measured in days. */
const PRUNE_EVERY_MS = 24 * 60 * 60 * 1000;

/** How many dropped arrivals are remembered for diagnosis. */
const DROPS_KEPT = 50;

/**
 * Exchange states in which a message the Hub accepted will not be read by the
 * session it was sent to. For a route already `routed`, either one hands the
 * route back to the Master.
 */
const FAILED_EXCHANGE_STATES = Object.freeze(['undeliverable', 'recipient_retired']);

/**
 * The one exchange state that proves a send with no Hub id never reached the
 * Hub: the Hub refused it. A recipient that retired proves nothing about a
 * send whose outcome was never learned, and `send_unknown` may be on the Hub.
 */
const REFUSED_BY_HUB = 'undeliverable';

/** The failure code of a route whose send could not be confirmed either way. */
const SEND_UNCONFIRMED = 'send-unconfirmed';

/** The address that always means the Project Master. No alias may take it. */
const RESERVED_ADDRESS = 'master';

/** The shape of a Hub message id an exchange can carry. */
const HUB_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Chat ids are short opaque strings. */
const CHAT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Seams, so tests drive the real logic without a Hub, tmux or a clock. */
const _deps = {
  medusa: () => require('./medusa'),
  medusaSend: () => require('./medusa-send'),
  exchanges: () => require('./medusa-exchanges'),
  master: () => require('./master'),
  now: () => new Date().toISOString(),
  id: (prefix) => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`
};

const _state = {
  ensureNextAt: 0, ensureDelay: 0, lastPruneAt: 0, arrivalsFirstSeen: new Map(), mastersTold: new Set(), noListenerLogged: new Set(),
  inFlight: new Map(), dropped: 0, drops: []
};

/**
 * The conversation a route belongs to: its channel, and its thread when it has one.
 * @param {{channelId: string, threadId: (string|null)}} context - A route's chat context.
 * @returns {string}
 */
function conversationKey(context) {
  return context.threadId ? `${context.channelId}:${context.threadId}` : context.channelId;
}

/**
 * The operator's allowlist: the one author, space and channel the bridge
 * accepts. Null until all three are set.
 * @returns {{authorId: string, spaceId: string, channelId: string}|null}
 */
function allowlist() {
  const authorId = bridgeStore.settings.get('allow.author');
  const spaceId = bridgeStore.settings.get('allow.space');
  const channelId = bridgeStore.settings.get('allow.channel');
  return authorId && spaceId && channelId ? { authorId, spaceId, channelId } : null;
}

/**
 * Mint a helper token. Only its hash is stored; the caller shows the value once.
 * @returns {{tokenId: string, token: string}}
 */
function mintHelperToken() {
  const tokenId = _deps.id('bht');
  const token = HELPER_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  bridgeStore.helperTokens.replace(tokenId, bridgeStore.digest(token), { at: _deps.now() });
  return { tokenId, token };
}

/**
 * Whether a presented helper token is the active one.
 * @param {*} presented - The header value as received.
 * @returns {{tokenId: string}|null}
 */
function verifyHelperToken(presented) {
  if (typeof presented !== 'string' || !/^bht_[A-Za-z0-9_-]{43}$/.test(presented)) return null;
  return bridgeStore.helperTokens.findActive(bridgeStore.digest(presented));
}

/**
 * Where the gateway's Medusa registry lives.
 * @returns {{projectPath: string, sessionId: string, name: string}}
 */
function gatewayTarget() {
  return { projectPath: path.join(store._getBasePath(), 'bridge-gateway'), sessionId: GATEWAY_KEY, name: GATEWAY_NAME };
}

/**
 * Make the gateway's listener match the one rule it follows: it listens
 * exactly while the bridge is enabled.
 * @param {object} [options]
 * @param {Function} [options.wsFactory] - Socket factory seam (tests).
 * @returns {{state: string, workspaceId: (string|null)}}
 */
function syncListener(options = {}) {
  const medusa = _deps.medusa();
  if (bridgeStore.settings.isEnabled()) {
    return medusa.startSession({ ...gatewayTarget(), wsFactory: options.wsFactory });
  }
  medusa.stopSession(GATEWAY_KEY);
  return medusa.getStatus(GATEWAY_KEY);
}

/**
 * The gateway's own workspace id, or null when it is not listening.
 * @returns {string|null}
 */
function gatewayWorkspaceId() {
  return _deps.medusa().getStatus(GATEWAY_KEY).workspaceId || null;
}

/**
 * Apply a transition the gateway itself decides. The request id is derived
 * from the route and its version, so a step repeated after a restart is the
 * same request and is applied once.
 * @param {string} op - Operation name.
 * @param {object} route - The route as last read.
 * @param {(route: object) => object} change - The decision.
 * @param {object} [options]
 * @param {string} [options.actor='gateway'] - Who acted.
 * @param {string} [options.proof='gateway'] - How the actor was verified.
 * @returns {{outcome: string, replayed: boolean, route: (object|null)}}
 */
function _step(op, route, change, options = {}) {
  return bridgeStore.applyRouteWrite({
    op,
    requestId: `gw:${op}:${route.routeId}:v${route.version}`,
    routeId: route.routeId,
    expectedVersion: route.version,
    actor: options.actor || 'gateway',
    proof: options.proof || 'gateway',
    at: _deps.now(),
    change
  });
}

/**
 * Queue one delivery-failure notice about a route for the operator.
 * Idempotent on its key, so it is posted once however often the condition is seen.
 * @param {string} routeId - Route id.
 * @param {string} what - Which notice: part of the idempotency key.
 * @param {string} text - What to post.
 * @returns {object} The outbound item.
 */
function _notice(routeId, what, text) {
  return bridgeStore.outbound.enqueue({
    idemKey: `route:${routeId}:${what}`, kind: 'failure', routeId, sourceLabel: 'TangleClaw',
    text, digest: bridgeStore.digest(text), at: _deps.now()
  });
}

/**
 * Give a route its one status notice, if it has not had one. A route gets a
 * single such notice in its life, whichever reason comes first: that Master
 * is unavailable, or that five minutes have passed.
 * @param {string} routeId - Route id.
 * @param {('pending'|'master-unavailable')} which - Which fixed notice.
 * @returns {boolean} True when this call created it.
 */
function _status(routeId, which) {
  return bridgeStore.outbound.enqueueStatus(routeId, which, { at: _deps.now() }).created;
}

/**
 * Resolve a destination mechanically, or say that only Master can.
 *
 * In order: an explicit leading `@name`; the route of the message this one
 * replies to; a pin on the conversation; the default, which is Master itself.
 * An `@name` that matches nothing, or more than one destination, is never
 * guessed at: it waits for Master. A chat application's own mention syntax
 * (`<@123>`) is not an address.
 * @param {object} route - The accepted route.
 * @param {string} text - The operator's message.
 * @returns {{resolvedBy: string, destination: {kind: string, projectId: (number|null)}}|{awaitingMaster: string}}
 */
function resolveDestination(route, text) {
  const addressed = /^@([A-Za-z0-9][A-Za-z0-9._-]{0,63})(?=\s|$)/.exec(String(text).trim());
  if (addressed) {
    const found = _addressed(addressed[1]);
    return found.length === 1 ? { resolvedBy: 'alias', destination: found[0] } : { awaitingMaster: found.length ? 'address-ambiguous' : 'address-unresolved' };
  }
  if (route.context.replyToExternalId) {
    const earlier = bridgeStore.routes.getByExternalId(route.context.replyToExternalId)
      || _routeOfPostedMessage(route.context.replyToExternalId);
    if (earlier && earlier.destination) {
      return { resolvedBy: 'reply-inheritance', destination: { kind: earlier.destination.kind, projectId: earlier.destination.projectId } };
    }
  }
  const pin = bridgeStore.pins.forConversation(conversationKey(route.context));
  if (pin) return { resolvedBy: 'pin', destination: pin.destination };
  return { resolvedBy: 'default', destination: { kind: 'master', projectId: null } };
}

/**
 * Every distinct destination an explicit address names: the reserved
 * `master`, an operator alias, a project by its exact name without regard to
 * case, or a project by its id. One result is an address; none or several is
 * not.
 * @param {string} name - The token after `@`.
 * @returns {{kind: string, projectId: (number|null)}[]}
 */
function _addressed(name) {
  const key = name.toLowerCase();
  if (key === RESERVED_ADDRESS) return [{ kind: 'master', projectId: null }];
  const found = new Map();
  const add = (destination) => found.set(`${destination.kind}:${destination.projectId ?? ''}`, destination);
  const alias = bridgeStore.aliases.get(key);
  if (alias) add(alias);
  for (const project of store.projects.list()) {
    if (project.archived) continue;
    if (String(project.name).toLowerCase() === key || (/^\d+$/.test(name) && project.id === Number(name))) {
      add({ kind: 'project', projectId: project.id });
    }
  }
  return [...found.values()];
}

/**
 * The route whose item was posted to the chat as a given message.
 * @param {string} postedRef - The chat's id for a message the helper posted.
 * @returns {object|null}
 */
function _routeOfPostedMessage(postedRef) {
  const routeId = bridgeStore.outbound.routeIdByDeliveredRef(postedRef);
  return routeId ? bridgeStore.routes.get(routeId) : null;
}

/**
 * Accept one inbound operator message from the helper.
 *
 * Refused before anything is stored when the bridge is disabled or the
 * message is not from the allowlisted author, space and channel. Idempotent
 * on the chat's own message id: a replay returns the same route.
 * @param {object} message
 * @param {string} message.externalId - The chat's own message id.
 * @param {string} message.authorId - Chat author id.
 * @param {string} message.spaceId - Chat space id.
 * @param {string} message.channelId - Chat channel id.
 * @param {string|null} [message.threadId] - Chat thread id.
 * @param {string|null} [message.replyToExternalId] - Message this one answers.
 * @param {string} message.text - The message.
 * @returns {Promise<{status: number, body: object}>}
 */
async function acceptInbound(message) {
  const refuse = (status, code, error) => {
    // A refusal leaves a trace, by code alone: never the message or who sent it.
    if (code !== 'BRIDGE_DISABLED') log.warn('Bridge refused an inbound message', { code });
    return { status, body: { error, code } };
  };
  if (!bridgeStore.settings.isEnabled()) return refuse(409, 'BRIDGE_DISABLED', 'The operator bridge is disabled.');
  const allowed = allowlist();
  if (!allowed) return refuse(409, 'ALLOWLIST_NOT_SET', 'The operator has not set the bridge allowlist.');
  const m = message || {};
  for (const field of ['externalId', 'authorId', 'spaceId', 'channelId']) {
    if (typeof m[field] !== 'string' || !CHAT_ID.test(m[field])) return refuse(400, 'BAD_INBOUND', `Missing or malformed ${field}.`);
  }
  for (const field of ['threadId', 'replyToExternalId']) {
    if (m[field] != null && (typeof m[field] !== 'string' || !CHAT_ID.test(m[field]))) return refuse(400, 'BAD_INBOUND', `Malformed ${field}.`);
  }
  if (m.authorId !== allowed.authorId || m.spaceId !== allowed.spaceId || m.channelId !== allowed.channelId) {
    // Counted, and nothing of the message kept.
    bridgeStore.audit.append({ op: 'inbound', actor: 'helper', proof: 'helper-token', outcome: 'not-allowlisted', at: _deps.now() });
    return refuse(403, 'NOT_ALLOWLISTED', 'That author, space or channel is not on the bridge allowlist.');
  }
  if (typeof m.text !== 'string' || !m.text.trim()) return refuse(400, 'BAD_INBOUND', 'The message has no text.');
  if (m.text.length > MAX_INBOUND_LENGTH) return refuse(413, 'INBOUND_TOO_LONG', `A message may be at most ${MAX_INBOUND_LENGTH} characters.`);

  const accepted = bridgeStore.routes.accept({
    routeId: _deps.id('rt'), externalId: m.externalId, authorId: m.authorId, spaceId: m.spaceId, channelId: m.channelId,
    threadId: m.threadId ?? null, replyToExternalId: m.replyToExternalId ?? null,
    text: m.text, digest: bridgeStore.digest(m.text), at: _deps.now()
  });
  if (accepted.mismatch) {
    return refuse(409, 'EXTERNAL_ID_MISMATCH', 'That message id was already received with a different body or from a different place.');
  }
  if (!accepted.created) return { status: 200, body: { routeId: accepted.route.routeId, state: accepted.route.state, replayed: true } };

  bridgeStore.audit.append({
    op: 'inbound', actor: 'helper', proof: 'helper-token', routeId: accepted.route.routeId, outcome: 'accepted', at: _deps.now()
  });
  const route = await advance(accepted.route.routeId);
  return { status: 202, body: { routeId: route.routeId, state: route.state, replayed: false } };
}

/**
 * Carry a route as far as it can go without Master: resolve it if it is
 * unresolved, then dispatch it. Safe to call at any time and after a restart;
 * every step is applied once.
 *
 * One route is advanced by one caller at a time. Dispatch waits on the Hub
 * between reading the route and recording what happened, and the helper's
 * request, Master's routing and the periodic pass can all arrive for the same
 * route; without this a second caller would act on a send still in flight.
 * @param {string} routeId - Route id.
 * @returns {Promise<object|null>} The route afterwards.
 */
function advance(routeId) {
  const before = _state.inFlight.get(routeId) || Promise.resolve();
  const run = before.catch(() => {}).then(() => _advance(routeId));
  _state.inFlight.set(routeId, run);
  return run.finally(() => {
    if (_state.inFlight.get(routeId) === run) _state.inFlight.delete(routeId);
  });
}

/**
 * The work of {@link advance}, for one caller at a time.
 * @param {string} routeId - Route id.
 * @returns {Promise<object|null>} The route afterwards.
 */
async function _advance(routeId) {
  let route = bridgeStore.routes.get(routeId);
  if (!route) return null;
  // Only an unresolved route is resolved here: a destination Master named is
  // Master's decision and is never second-guessed mechanically.
  if (route.state === 'accepted' && !route.destination) {
    const inbound = bridgeStore.routes.body(routeId, 'inbound');
    const resolved = resolveDestination(route, inbound && inbound.text ? inbound.text : '');
    if (resolved.awaitingMaster) {
      route = _step('resolve', route, () => ({
        set: { state: 'awaiting-master', failure_code: resolved.awaitingMaster }, detail: { reason: resolved.awaitingMaster }
      })).route;
    } else {
      route = _step('resolve', route, () => ({
        set: {
          resolved_by: resolved.resolvedBy, destination_kind: resolved.destination.kind,
          destination_project_id: resolved.destination.kind === 'project' ? resolved.destination.projectId : null
        },
        detail: { resolvedBy: resolved.resolvedBy, kind: resolved.destination.kind }
      })).route;
    }
  }
  if (route.state === 'accepted' && route.destination) route = await dispatch(route);
  if (_needsMaster(route)) route = await _summonMaster(route);
  return route;
}

/**
 * Whether a route is waiting on the Master session: to route it, to answer it
 * as its destination, or to release a reply held for it.
 * @param {object} route - A route.
 * @returns {boolean}
 */
function _needsMaster(route) {
  return route.state === 'awaiting-master' || route.state === 'queued-master-unavailable' || route.state === 'reply-held'
    || (route.state === 'routed' && !!route.destination && route.destination.kind === 'master')
    || (route.state === 'accepted' && route.failureCode === SEND_UNCONFIRMED);
}

/**
 * Apply a gateway step to a route whose version may have moved while the
 * gateway was waiting on the Hub (Master can pin a conversation at any time).
 * The step is re-decided against the route as it now is, a bounded number of
 * times.
 * @param {string} op - Operation name.
 * @param {string} routeId - Route id.
 * @param {(route: object) => object} change - The decision; it sees the current route.
 * @returns {{outcome: string, replayed: boolean, route: (object|null)}}
 */
function _stepCurrent(op, routeId, change) {
  let result = { outcome: 'route-not-found', replayed: false, route: null };
  for (let attempt = 0; attempt < 3; attempt++) {
    const route = bridgeStore.routes.get(routeId);
    if (!route) return result;
    result = _step(op, route, change);
    if (result.outcome !== 'version-conflict') return result;
  }
  return result;
}

/**
 * The request id of a route's current send attempt. It moves on only when an
 * attempt is settled: recorded as sent, or proven not to have been delivered.
 * A send whose outcome is unknown is never settled, so its id stays, the
 * existing exchange is found under it at every later pass and after every
 * restart, and the message is never sent a second time.
 * @param {string} routeId - Route id.
 * @returns {string}
 */
function _sendRequestId(routeId) {
  const settled = bridgeStore.audit.forRoute(routeId).filter((a) => (a.op === 'dispatch' || a.op === 'target-failed') && a.outcome === 'applied').length;
  return `bridge:${routeId}:send${settled + 1}`;
}

/**
 * Send a resolved route to its destination. A project destination gets a
 * tracked, reply-required Medusa message; Master as the destination gets the
 * route itself, to answer through `tc bridge`.
 *
 * Exactly once. The send is looked up before it is made, and what is found
 * decides what happens:
 * - no exchange after trying: nothing was sent, and the route goes back to
 *   Master to route again;
 * - an exchange with a Hub id: the message is on the Hub, and it is recorded;
 * - a Hub id in the send's own answer that the row could not take: the id is
 *   kept, the row is bound again on this and every later pass, and the route
 *   is recorded as sent once it is;
 * - an exchange the Hub refused: the route goes back to Master;
 * - anything else: the outcome is not known. The route stays where it is,
 *   marked unconfirmed after two minutes, and is not sent again by anybody.
 *   Master can answer it or close it; only a proven failure reopens routing.
 * @param {object} route - A resolved route in `accepted`.
 * @returns {Promise<object>} The route afterwards.
 */
async function dispatch(route) {
  if (route.destination.kind === 'master') {
    return _step('dispatch', route, () => ({ set: { state: 'routed' }, detail: { to: 'master' } })).route || route;
  }
  const requestId = _sendRequestId(route.routeId);
  let exchange = store.medusaExchanges.getByRequestId(requestId);
  let answeredHubId = null;
  let target = null;
  if (!exchange) {
    target = _targetWorkspace(route.destination.projectId);
    if (!target) return _returnToMaster(route, 'target-offline', 'has no live session to receive it');
    const inbound = bridgeStore.routes.body(route.routeId, 'inbound');
    try {
      const sent = await _deps.medusaSend().sendTracked({
        sessionId: GATEWAY_KEY,
        senderProjectId: null,
        caller: { kind: 'system' },
        body: { to: target.workspaceId, message: `${FENCE_LINE}\n\n${inbound ? inbound.text : ''}`, replyRequired: true, requestId }
      });
      // The Hub's own answer names the message even when the exchange row
      // could not be updated to say so.
      if (sent && sent.status === 200 && sent.body && typeof sent.body.id === 'string') answeredHubId = sent.body.id;
      else if (sent && sent.body && sent.body.code) log.warn('Bridge dispatch was not accepted', { routeId: route.routeId, code: sent.body.code });
    } catch (err) {
      log.warn('Bridge dispatch failed', { routeId: route.routeId, error: err.code || err.message });
    }
    exchange = store.medusaExchanges.getByRequestId(requestId);
  }
  // No exchange was ever made for this attempt: the send was refused before
  // the Hub was called, so nothing can be on it.
  if (!exchange) return _returnToMaster(route, 'send-failed', 'could not be sent');

  if (!exchange.hub_id) {
    // The Hub may have named the message in an answer the exchange row never
    // took: now, or on an earlier pass that recorded it. A route may rest in
    // `routed` only on an exchange that carries its Hub id, because the
    // target's reply and every later failure are found through that id. So
    // the row is bound first, and the route waits unconfirmed until it is.
    // An id the exchange could never store is not kept and not retried:
    // binding it would fail again on every pass, each time leaving a fact.
    const storable = answeredHubId && HUB_ID.test(answeredHubId) ? answeredHubId : null;
    if (answeredHubId && !storable) log.warn('Bridge was answered with a message id it cannot store', { routeId: route.routeId });
    const known = storable || _answeredHubId(route.routeId, requestId);
    if (known) {
      if (storable) _rememberHubAnswer(route, requestId, storable);
      try {
        _deps.exchanges().bindHubId(exchange.exchange_id, known, { hubStatus: 'received', deliveredTo: exchange.recipient_workspace_id });
        exchange = store.medusaExchanges.getByRequestId(requestId);
      } catch (err) {
        log.warn('Bridge could not bind a sent message to its exchange', { routeId: route.routeId, error: err.message });
      }
    }
  }
  const hubId = exchange.hub_id;
  if (!hubId) {
    if (exchange.state === REFUSED_BY_HUB) {
      return _returnToMaster(route, 'exchange-undeliverable', 'did not reach its destination');
    }
    const waited = Date.parse(_deps.now()) - Date.parse(exchange.created_at);
    if (exchange.state === 'send_pending' && waited < SEND_PENDING_MS && !answeredHubId) return bridgeStore.routes.get(route.routeId) || route;
    return _markUnconfirmed(route);
  }

  // Who it went to is what the exchange recorded when it was sent, not who
  // the project's live session happens to be now.
  const sentTo = target && target.workspaceId === exchange.recipient_workspace_id ? target : _recipientOf(exchange);
  if (!sentTo) return _markUnconfirmed(route);
  const recorded = _stepCurrent('dispatch', route.routeId, (current) => {
    if (current.state !== 'accepted' || !current.destination || current.destination.projectId !== route.destination.projectId) {
      return { refuse: 'no-longer-dispatchable', detail: { state: current.state } };
    }
    return {
      set: { state: 'routed', destination_workspace_id: sentTo.workspaceId, failure_code: null },
      proof: {
        direction: 'to-target', hubId, exchangeId: exchange.exchange_id, senderProof: 'gateway',
        targetProjectId: route.destination.projectId, targetWorkspaceId: sentTo.workspaceId,
        targetSessionId: sentTo.sessionId, targetLaunchId: sentTo.launchId
      },
      detail: { to: 'project', projectId: route.destination.projectId }
    };
  });
  return recorded.route || route;
}

/**
 * Record, durably, the message id the Hub answered a send with when the
 * exchange row could not take it. The audit is the one place that survives a
 * restart and is never compacted while the route is open.
 * @param {object} route - The route.
 * @param {string} requestId - The attempt's request id.
 * @param {string} hubId - The Hub's id for the message.
 * @returns {void}
 */
function _rememberHubAnswer(route, requestId, hubId) {
  if (_answeredHubId(route.routeId, requestId)) return;
  bridgeStore.audit.append({
    op: 'hub-answer', actor: 'gateway', proof: 'gateway', routeId: route.routeId, outcome: 'recorded',
    detail: { requestId, hubId }, at: _deps.now()
  });
}

/**
 * The message id the Hub answered an attempt with, if one was recorded.
 * @param {string} routeId - Route id.
 * @param {string} requestId - The attempt's request id.
 * @returns {string|null}
 */
function _answeredHubId(routeId, requestId) {
  const row = bridgeStore.audit.forRoute(routeId).find((a) => a.op === 'hub-answer' && a.detail && a.detail.requestId === requestId);
  return row ? row.detail.hubId : null;
}

/**
 * Exactly who an exchange was sent to, from the exchange itself.
 * @param {object} exchange - A `medusa_exchanges` row the gateway sent.
 * @returns {{workspaceId: string, sessionId: number, launchId: string}|null}
 *   Null when the row does not name a session with a known launch.
 */
function _recipientOf(exchange) {
  const sessionId = Number(exchange.recipient_session_id);
  if (!exchange.recipient_workspace_id || !Number.isInteger(sessionId) || sessionId <= 0) return null;
  const launchId = _launchOf(sessionId);
  return launchId ? { workspaceId: exchange.recipient_workspace_id, sessionId, launchId } : null;
}

/**
 * Mark a route's send as unconfirmed, once. The route keeps its destination
 * and its place: this records that nobody knows whether the message arrived,
 * and it does not make the route routable again.
 * @param {object} route - The route.
 * @returns {object} The route afterwards.
 */
function _markUnconfirmed(route) {
  if (route.failureCode === SEND_UNCONFIRMED) return route;
  const result = _stepCurrent('send-unconfirmed', route.routeId, (current) => (
    current.state !== 'accepted' || current.failureCode === SEND_UNCONFIRMED
      ? { refuse: 'not-applicable' }
      : { set: { failure_code: SEND_UNCONFIRMED } }
  ));
  if (result.outcome === 'applied' && !result.replayed) {
    _notice(route.routeId, 'send-unconfirmed',
      'It is not known whether your message reached its destination. It has not been sent again. The Project Master will follow up.');
  }
  return result.route || route;
}

/**
 * The launch a session is running under, as the server recorded it.
 * @param {number|string} sessionId - Session id.
 * @returns {string|null}
 */
function _launchOf(sessionId) {
  const sequence = store.launchSequences.getBySession(Number(sessionId));
  return sequence ? sequence.launchId : null;
}

/**
 * Exactly who a project's message would go to: its live session's workspace,
 * that session and its launch. Null unless all three are known, because a
 * reply can only be accepted from a target that was fully named.
 * @param {number} projectId - Project id.
 * @returns {{workspaceId: string, sessionId: number, launchId: string}|null}
 */
function _targetWorkspace(projectId) {
  const session = store.sessions.getActive(projectId);
  if (!session) return null;
  const workspaceId = _deps.medusa().getStatus(session.id).workspaceId;
  const launchId = _launchOf(session.id);
  return workspaceId && launchId ? { workspaceId, sessionId: session.id, launchId } : null;
}

/**
 * Hand a route that could not be delivered back to Master, and tell the
 * operator once. The destination is cleared so Master names the next one.
 * @param {object} route - The route.
 * @param {string} code - Closed failure code.
 * @param {string} words - How the notice describes it.
 * @returns {Promise<object>} The route afterwards.
 */
async function _returnToMaster(route, code, words) {
  const result = _stepCurrent('target-failed', route.routeId, (current) => {
    if (current.state === 'closed' || current.state === 'released') return { refuse: 'already-answered' };
    return {
      set: {
        state: 'awaiting-master', failure_code: code, resolved_by: null, destination_kind: null,
        destination_project_id: null, destination_workspace_id: null, resolved_generation: null
      },
      detail: { code }
    };
  });
  if (result.outcome === 'applied' && !result.replayed) {
    _notice(route.routeId, `failure:${code}:v${result.route.version}`, `Your message ${words}. It is waiting for the Project Master to route it.`);
  }
  return result.route || route;
}

/**
 * Make sure the Master session exists and knows a route is waiting. Rate
 * limited and backed off, never a restart loop; when Master cannot be had a
 * route awaiting its decision is queued, and the operator is told once.
 * @param {object} route - A route that needs the Master session.
 * @returns {Promise<object>} The route afterwards.
 */
async function _summonMaster(route) {
  const master = _deps.master();
  const now = Date.parse(_deps.now());
  let live = master.masterLiveness().live === true;
  if (!live && now >= _state.ensureNextAt) {
    _state.ensureDelay = _state.ensureDelay ? Math.min(_state.ensureDelay * 2, ENSURE_BACKOFF_MS.ceiling) : ENSURE_BACKOFF_MS.first;
    _state.ensureNextAt = now + _state.ensureDelay;
    const ensured = master.ensureMasterSession();
    live = !ensured.error;
    if (ensured.error) log.warn('Bridge could not ensure the Project Master', { error: ensured.error });
  }
  if (live) _state.ensureDelay = 0;

  if (!live) {
    _status(route.routeId, 'master-unavailable');
    if (route.state !== 'awaiting-master') return route;
    return _step('queue', route, () => ({ set: { state: 'queued-master-unavailable' } })).route || route;
  }
  let current = route;
  if (route.state === 'queued-master-unavailable') {
    current = _step('unqueue', route, () => ({ set: { state: 'awaiting-master' } })).route || route;
  }
  await _tellMaster(current);
  return current;
}

/**
 * Tell the Master session what a route needs of it. Told once for each state
 * a route reaches: a route handed back to Master, or one whose reply has just
 * been held, is a new reason and is told again. A notice that could not be
 * sent is not remembered, so the next pass tries again.
 * @param {object} route - A route that needs the Master.
 * @returns {Promise<boolean>} Whether Master has been told of this state.
 */
async function _tellMaster(route) {
  const key = `${route.routeId}:v${route.version}`;
  if (_state.mastersTold.has(key)) return true;
  const workspaceId = _deps.master().getMasterMedusaStatus().workspaceId;
  if (!workspaceId) {
    // Once for each state a route reaches, not on every pass.
    if (!_state.noListenerLogged.has(key)) {
      _state.noListenerLogged.add(key);
      log.warn('Bridge cannot notify the Project Master — it has no Medusa listener', { routeId: route.routeId, state: route.state });
    }
    return false;
  }
  const what = route.state === 'reply-held' ? 'has a reply held for your release' : 'is waiting for you';
  try {
    await _deps.medusa().sendSystemMessage({
      to: workspaceId,
      message: `Operator bridge: route ${route.routeId} ${what}. Run \`tc bridge read ${route.routeId}\`.`
    });
  } catch (err) {
    log.warn('Bridge could not notify the Project Master', { routeId: route.routeId, error: err.code || err.message });
    return false;
  }
  _state.mastersTold.add(key);
  bridgeStore.routes.noteMasterTold(route.routeId, { at: _deps.now() });
  return true;
}

/**
 * Decide what a message that arrived at the gateway's listener is.
 *
 * It is a route's reply only when the sender's own exchange row proves it: a
 * verified launch, addressed to the gateway, answering exactly the message
 * the bridge last sent for that route, from the very workspace, session and
 * launch that message was sent to. Another session of the same project does
 * not qualify; reaching one takes an explicit reroute. Then
 * it is stored and held. Everything else is dropped and counted; nothing is
 * relayed from here.
 * @param {{id: string, from: string, message?: string, content?: string}} message - The arrived message.
 * @returns {('held'|'waiting'|'dropped')} `waiting` when the sender's row has not bound yet.
 */
function considerArrival(message) {
  const drop = (reason, routeId = null) => {
    _state.dropped += 1;
    const entry = { reason, hubId: message && typeof message.id === 'string' ? message.id : null, from: (message && message.from) || null, routeId };
    _state.drops.push(entry);
    if (_state.drops.length > DROPS_KEPT) _state.drops.shift();
    // The message itself is never logged; what identifies it is.
    log.info('Bridge dropped an arrival that is not a route reply', entry);
    return 'dropped';
  };
  if (!message || typeof message.id !== 'string') return drop('malformed');
  if (message.from === 'system') return drop('system-notice');
  if (bridgeStore.proofs.byHubId(message.id)) return 'held';

  const sent = store.medusaExchanges.getByHubId(message.id, 'send');
  if (!sent) {
    const first = _state.arrivalsFirstSeen.get(message.id) || Date.parse(_deps.now());
    _state.arrivalsFirstSeen.set(message.id, first);
    return Date.parse(_deps.now()) - first > ARRIVAL_WAIT_MS ? drop('no-sender-exchange') : 'waiting';
  }
  if (sent.sender_verified !== 1 || sent.sender_proof !== 'launch') return drop('sender-not-a-verified-launch');
  if (sent.recipient_workspace_id !== gatewayWorkspaceId()) return drop('not-addressed-to-the-gateway');
  // A reply names the exchange it answers, not a Hub id: the sender's row
  // was bound to the bridge's own exchange when the reply was sent.
  if (!sent.in_reply_to) return drop('not-a-reply');
  const asked = bridgeStore.proofs.byExchangeId(sent.in_reply_to);
  if (!asked || asked.direction !== 'to-target') return drop('answers-nothing-the-bridge-sent');
  const route = bridgeStore.routes.get(asked.routeId);
  if (!route || route.state !== 'routed') return drop('route-not-awaiting-a-reply', asked.routeId);
  const latest = bridgeStore.proofs.latestToTarget(route.routeId);
  if (!latest || latest.hubId !== asked.hubId) return drop('answers-a-superseded-message', route.routeId);
  // The exact target, not merely its project: the session and launch the
  // message was sent to, speaking from the workspace it was sent to.
  if (!route.destination || route.destination.kind !== 'project' || sent.sender_project_id !== asked.targetProjectId) {
    return drop('sender-is-another-project', route.routeId);
  }
  if (Number(sent.sender_session_id) !== asked.targetSessionId) return drop('sender-is-another-session', route.routeId);
  if (sent.sender_workspace_id !== asked.targetWorkspaceId) return drop('sender-is-another-workspace', route.routeId);
  const launchId = _launchOf(sent.sender_session_id);
  if (!launchId || launchId !== asked.targetLaunchId) return drop('sender-is-another-launch', route.routeId);

  const text = String(message.message ?? message.content ?? '').slice(0, MAX_OUTBOUND_LENGTH);
  if (!text.trim()) return drop('empty-reply', route.routeId);
  const result = _step('reply-held', route, () => ({
    set: { state: 'reply-held' },
    body: { role: 'reply', text, digest: bridgeStore.digest(text) },
    proof: {
      direction: 'from-target', hubId: message.id, exchangeId: sent.exchange_id, inReplyToHubId: asked.hubId,
      senderProof: 'launch', senderProjectId: sent.sender_project_id, senderLaunchId: launchId
    },
    detail: { projectId: sent.sender_project_id }
  }), { actor: 'session', proof: 'launch' });
  return result.outcome === 'applied' || result.replayed ? 'held' : drop(`not-applied:${result.outcome}`, route.routeId);
}

/**
 * Go through the gateway's inbox: hold what is a reply, drop what is not, and
 * leave what cannot be judged yet. Called on every arrival and every tick, so
 * a reply whose sender row binds late is picked up without a second message.
 * @returns {{held: number, dropped: number, waiting: number}}
 */
function drainInbox() {
  const medusa = _deps.medusa();
  const counts = { held: 0, dropped: 0, waiting: 0 };
  const settled = [];
  const held = [];
  for (const message of medusa.getMessages(GATEWAY_KEY) || []) {
    const verdict = considerArrival(message);
    counts[verdict] += 1;
    if (verdict !== 'waiting') {
      settled.push(message.id);
      _state.arrivalsFirstSeen.delete(message.id);
    }
    if (verdict === 'held') held.push(message.id);
  }
  if (settled.length) medusa.markHandled(GATEWAY_KEY, settled);
  for (const hubId of held) {
    const proof = bridgeStore.proofs.byHubId(hubId);
    // A held reply waits for Master's release: a new reason to tell it.
    if (proof) advance(proof.routeId).catch((err) => log.warn('Bridge could not advance a held route', { routeId: proof.routeId, error: err.message }));
  }
  return counts;
}

/**
 * The periodic pass: drain the inbox, carry on any route a restart
 * interrupted, turn delivery failures into a notice and a decision for
 * Master, keep Master told, raise the one status notice, enqueue the typed
 * server notifications, and run retention.
 *
 * While the bridge is disabled only retention runs: nothing is sent, started
 * or resolved, but what has outlived its retention still leaves. Each route is
 * handled apart from the others, so one that fails does not hold up the rest.
 * @returns {Promise<{advanced: number, failed: number, pendingNotices: number, notifications?: object}>}
 */
async function tick() {
  const out = { advanced: 0, failed: 0, pendingNotices: 0 };
  const now = Date.parse(_deps.now());
  try {
    bridgeStore.expire({ now: _deps.now() });
  } catch (err) {
    log.warn('Bridge could not expire what waited too long', { error: err.message });
  }
  if (now - _state.lastPruneAt >= PRUNE_EVERY_MS) {
    _state.lastPruneAt = now;
    try {
      bridgeStore.prune({ now: _deps.now() });
    } catch (err) {
      log.warn('Bridge retention pass failed', { error: err.message });
    }
  }
  if (!bridgeStore.settings.isEnabled()) return out;

  const each = async (routes, work) => {
    for (const route of routes) {
      try {
        await work(route);
      } catch (err) {
        log.warn('Bridge pass failed for a route', { routeId: route.routeId, state: route.state, error: err.message });
      }
    }
  };
  try {
    drainInbox();
  } catch (err) {
    log.warn('Bridge could not drain its inbox', { error: err.message });
  }
  out.notifications = bridgeNotify.reconcile();

  await each(bridgeStore.routes.list({ states: ['routed'] }), async (route) => {
    if (!route.destination || route.destination.kind !== 'project') return;
    const sent = bridgeStore.proofs.latestToTarget(route.routeId);
    const exchange = sent ? store.medusaExchanges.getByHubId(sent.hubId, 'send') : null;
    if (exchange && FAILED_EXCHANGE_STATES.includes(exchange.state)) {
      await _returnToMaster(route, `exchange-${exchange.state.replace(/_/g, '-')}`, 'did not reach its destination');
      out.failed += 1;
    }
  });

  const open = ['accepted', 'awaiting-master', 'queued-master-unavailable', 'routed', 'reply-held'];
  await each(bridgeStore.routes.list({ states: open }), async (route) => {
    const before = `${route.state}:${route.version}`;
    const after = await advance(route.routeId);
    if (after && `${after.state}:${after.version}` !== before) out.advanced += 1;
  });

  await each(bridgeStore.routes.list({ states: open }), async (route) => {
    if (now - Date.parse(route.createdAt) < PENDING_NOTICE_MS) return;
    if (_status(route.routeId, 'pending')) out.pendingNotices += 1;
  });

  // What was remembered about routes that are no longer open is of no further use.
  const stillOpen = new Set(bridgeStore.routes.list({ states: [...open, 'released'] }).map((r) => r.routeId));
  for (const told of [_state.mastersTold, _state.noListenerLogged]) {
    for (const key of told) if (!stillOpen.has(key.slice(0, key.lastIndexOf(':v')))) told.delete(key);
  }
  return out;
}

/**
 * What the helper should post next, oldest first.
 * @param {object} [options]
 * @param {number} [options.limit] - At most this many.
 * @returns {object[]} Items with the chat context to post them in.
 */
function outboundForHelper(options = {}) {
  return bridgeStore.outbound.ready(options).map((item) => {
    const route = item.routeId ? bridgeStore.routes.get(item.routeId) : null;
    return {
      outboundId: item.outboundId, kind: item.kind, sourceLabel: item.sourceLabel, text: item.text,
      inReplyTo: route ? { externalId: route.externalId, channelId: route.context.channelId, threadId: route.context.threadId } : null
    };
  });
}

/**
 * Record that the chat confirmed an item was posted. A delivered answer
 * closes its route and clears what was held for it.
 * @param {number} outboundId - Item id.
 * @param {string} deliveredRef - The chat's id for the posted message.
 * @returns {{status: number, body: object}}
 */
function acknowledgeOutbound(outboundId, deliveredRef) {
  if (typeof deliveredRef !== 'string' || !CHAT_ID.test(deliveredRef)) {
    return { status: 400, body: { error: 'An acknowledgement names the chat\'s id for the posted message.', code: 'BAD_ACK' } };
  }
  const at = _deps.now();
  const item = bridgeStore.outbound.get(outboundId);
  if (!item) return { status: 404, body: { error: 'No such outbound item.', code: 'OUTBOUND_NOT_FOUND' } };
  const done = (replayed) => ({ status: 200, body: { outboundId, state: 'delivered', replayed } });
  if (item.state === 'delivered') {
    if (item.deliveredRef === deliveredRef) return done(true);
    return { status: 409, body: { error: 'That item was already acknowledged with a different message id.', code: 'ACK_MISMATCH' } };
  }
  if (item.state !== 'ready') return { status: 409, body: { error: 'That item is not waiting to be posted.', code: 'OUTBOUND_NOT_READY' } };

  const route = item.kind === 'reply' && item.routeId ? bridgeStore.routes.get(item.routeId) : null;
  if (route && route.state === 'released') {
    // One transaction: the item is delivered and its route closed and cleared
    // together, or neither is.
    const result = bridgeStore.applyRouteWrite({
      op: 'delivered', requestId: `gw:delivered:${route.routeId}:${outboundId}`, routeId: route.routeId,
      expectedVersion: route.version, actor: 'helper', proof: 'helper-token', at,
      change: () => ({
        set: { state: 'closed', closed_by: 'gateway', closed_at: at },
        deliver: { outboundId, deliveredRef }, clearBodies: true, detail: { outboundId }
      })
    });
    if (result.outcome !== 'applied') return { status: 409, body: { error: `The acknowledgement was not applied: ${result.outcome}.`, code: 'ACK_NOT_APPLIED' } };
    return done(result.replayed);
  }
  const marked = bridgeStore.outbound.markDelivered(outboundId, deliveredRef, { at });
  return marked.outcome === 'delivered' ? done(false)
    : { status: 409, body: { error: `The acknowledgement was not applied: ${marked.outcome}.`, code: 'ACK_NOT_APPLIED' } };
}

/**
 * Forget what the gateway holds in memory. For tests.
 * @returns {void}
 */
function _reset() {
  _state.ensureNextAt = 0;
  _state.ensureDelay = 0;
  _state.lastPruneAt = 0;
  _state.arrivalsFirstSeen.clear();
  _state.mastersTold.clear();
  _state.noListenerLogged.clear();
  _state.inFlight.clear();
  _state.dropped = 0;
  _state.drops = [];
}

module.exports = {
  GATEWAY_KEY,
  FENCE_LINE,
  PENDING_NOTICE_MS,
  SEND_PENDING_MS,
  SEND_UNCONFIRMED,
  HELPER_TOKEN_PREFIX,
  CHAT_ID,
  conversationKey,
  allowlist,
  droppedArrivals: () => ({ count: _state.dropped, recent: _state.drops.slice() }),
  mintHelperToken,
  verifyHelperToken,
  gatewayTarget,
  syncListener,
  gatewayWorkspaceId,
  resolveDestination,
  acceptInbound,
  advance,
  dispatch,
  considerArrival,
  drainInbox,
  tick,
  outboundForHelper,
  acknowledgeOutbound,
  _deps,
  _state,
  _reset
};
