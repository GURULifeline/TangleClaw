'use strict';

/**
 * A stand-in for the Medusa Hub under the operator bridge's tests.
 *
 * Only the wire is faked: `lib/medusa.js`'s send, status and inbox calls. The
 * tracked-send path (`lib/medusa-send.js`), the exchange rows it writes and the
 * reply binding it enforces are the real ones, so a reply in these tests is
 * recorded exactly as a session's reply is recorded in production. A fixture
 * that wrote exchange rows by hand is how a reply-correlation defect once
 * passed every test.
 *
 * Not a test file: the leading underscore keeps it out of the suite glob.
 * @module test/_bridge-hub
 */

const path = require('node:path');
const store = require('../lib/store');
const medusa = require('../lib/medusa');
const medusaSend = require('../lib/medusa-send');
const gateway = require('../lib/bridge-gateway');
const { bindProject } = require('./_shared-docs-callers');

const GATEWAY_WS = 'operator-bridge-ws';
const MASTER_WS = 'master-ws';
// Hub ids are unique for the life of the process: a test file may install the
// stand-in more than once over one store, and a Hub never reissues an id.
let issued = 0;

const PATCHED = ['sendMessage', 'getStatus', 'getMessages', 'markHandled', 'sendSystemMessage', 'startSession', 'stopSession'];

/**
 * Put the stand-in Hub in place of the wire.
 * @returns {object} The hub: what was sent, the gateway's inbox, and helpers.
 */
function install() {
  const real = Object.fromEntries(PATCHED.map((name) => [name, medusa[name]]));
  const hub = {
    sent: [], system: [], inbox: [], handled: [], workspaces: new Map(), failSend: null, systemFails: false,
    restore() { Object.assign(medusa, real); }
  };
  const workspaceOf = (key) => {
    if (String(key) === gateway.GATEWAY_KEY) return GATEWAY_WS;
    if (String(key) === 'master') return MASTER_WS;
    return hub.workspaces.get(String(key)) || null;
  };
  Object.assign(medusa, {
    getStatus: (key) => ({ workspaceId: workspaceOf(key), state: workspaceOf(key) ? 'listening' : 'off', unread: 0 }),
    getMessages: (key) => (String(key) === gateway.GATEWAY_KEY ? hub.inbox.slice() : []),
    markHandled: (_key, ids) => {
      hub.handled.push(...ids);
      hub.inbox = hub.inbox.filter((m) => !ids.includes(m.id));
    },
    sendSystemMessage: async (m) => {
      if (hub.systemFails) throw Object.assign(new Error('bridge unreachable'), { code: 'BRIDGE_UNREACHABLE' });
      hub.system.push(m);
      return { status: 'received', id: `sys-${++issued}`, to: m.to };
    },
    startSession: () => ({ state: 'listening', workspaceId: GATEWAY_WS }),
    stopSession: () => {},
    sendMessage: async ({ sessionId, to, message, beforeHub }) => {
      const from = workspaceOf(sessionId);
      if (typeof beforeHub === 'function') beforeHub({ from });
      if (hub.failSend) throw Object.assign(new Error('hub failure'), { httpStatus: 502, code: 'BRIDGE_UNREACHABLE', hubOutcome: hub.failSend });
      const id = `hub-${++issued}`;
      hub.sent.push({ sessionId: String(sessionId), from, to, message, hubId: id });
      return { status: 'received', id, to };
    }
  });

  /**
   * A project with a live, launch-bound session and a workspace.
   * @param {string} name - Project name.
   * @param {string} dir - Directory to put the project path under.
   * @returns {{project: object, sessionId: number, launchId: string, workspaceId: string}}
   */
  hub.liveProject = (name, dir) => {
    const project = store.projects.create({ name, path: path.join(dir, name) });
    return hub.anotherSession(project);
  };

  /**
   * A further live, launch-bound session of a project, with its own workspace.
   * @param {object} project - Project record.
   * @returns {{project: object, sessionId: number, launchId: string, workspaceId: string}}
   */
  hub.anotherSession = (project) => {
    const bound = bindProject(project);
    const workspaceId = `${String(project.name).toLowerCase()}-ws-${bound.sessionId}`;
    hub.workspaces.set(String(bound.sessionId), workspaceId);
    return { project, sessionId: bound.sessionId, launchId: bound.launchId, workspaceId };
  };

  /**
   * A session sends a Medusa message through the real tracked-send path, and
   * the Hub delivers it to the gateway. The caller is the session's own
   * verified launch unless overridden.
   * @param {object} target - What `liveProject` returned.
   * @param {object} options
   * @param {string|null} [options.inReplyTo] - Hub id of the message it answers.
   * @param {string} [options.text] - Message body.
   * @param {string} [options.to] - Recipient workspace; the gateway by default.
   * @param {object} [options.caller] - Caller override.
   * @param {boolean} [options.deliver=true] - Whether it lands in the gateway's inbox.
   * @returns {Promise<{status: number, body: object}>} What the send answered.
   */
  hub.sessionSends = async (target, options = {}) => {
    const body = { to: options.to || GATEWAY_WS, message: options.text ?? 'the answer', requestId: `req-${++issued}-session` };
    if (options.inReplyTo) body.inReplyTo = options.inReplyTo;
    const result = await medusaSend.sendTracked({
      sessionId: target.sessionId,
      senderProjectId: target.project.id,
      caller: options.caller || { kind: 'project', projectId: target.project.id },
      body
    });
    if (result.status === 200 && options.deliver !== false) {
      hub.inbox.push({ id: result.body.id, from: target.workspaceId, message: body.message });
    }
    return result;
  };

  /**
   * The messages the gateway itself sent.
   * @returns {object[]}
   */
  hub.fromGateway = () => hub.sent.filter((m) => m.sessionId === gateway.GATEWAY_KEY);
  return hub;
}

let decided = 0;

/**
 * The Project Master routes a waiting route where the gateway suggested, as
 * its own decision: the same write `tc bridge route` makes, then the gateway
 * carries the route on. Every inbound waits for this; a suite that is not
 * about the decision itself makes it here, so the decision is still made and
 * still on the record.
 *
 * A route with no suggestion, or one not waiting for the Master, is left
 * exactly as it is.
 * @param {string} routeId - The route.
 * @param {object} [options]
 * @param {number} [options.generation=1] - The Master generation deciding.
 * @param {string} [options.at] - Timestamp override.
 * @param {boolean} [options.advance=true] - Whether the gateway then carries the route on; false leaves it routed and not yet sent.
 * @returns {Promise<object|null>} The route afterwards.
 */
async function masterTakesSuggestion(routeId, options = {}) {
  const bridgeStore = require('../lib/bridge-store');
  const route = bridgeStore.routes.get(routeId);
  const suggestion = route ? bridgeStore.audit.suggestionFor(routeId) : null;
  if (!route || route.state !== 'awaiting-master' || !suggestion || !suggestion.to) return route;
  const generation = options.generation || 1;
  const result = bridgeStore.applyRouteWrite({
    op: 'route', requestId: `test-master-route-${++decided}-${routeId}`.slice(0, 120), routeId, expectedVersion: route.version,
    actor: 'master', proof: 'master-launch', masterGeneration: generation, at: options.at,
    change: (current) => (current.state !== 'awaiting-master' ? { refuse: 'not-awaiting-master' } : {
      set: {
        state: 'accepted', resolved_by: 'master', destination_kind: suggestion.to,
        destination_project_id: suggestion.to === 'project' ? suggestion.projectId : null, resolved_generation: generation, failure_code: null
      },
      detail: { to: suggestion.to, projectId: suggestion.projectId }
    })
  });
  if (result.outcome !== 'applied' || options.advance === false) return result.route;
  return gateway.advance(routeId);
}

module.exports = { install, masterTakesSuggestion, GATEWAY_WS, MASTER_WS };
