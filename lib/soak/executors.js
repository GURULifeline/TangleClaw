'use strict';

/**
 * HTTP executors for the soak's `api` and `engine` load classes (#2020).
 *
 * Each executor performs one scheduled event against the server under test and
 * resolves to an outcome; it never throws. The `browser` and `fault` classes
 * have no executors here. They drive processes inside the isolated soak guest
 * (safaridriver, a server restart, killing tmux), and running one against the
 * wrong machine would disrupt a live install. The driver refuses a schedule
 * containing a kind with no executor, so a missing executor can never
 * silently turn into a skipped fault.
 *
 * @module lib/soak/executors
 */

/** Per-request budget. A soak measures stability, so a hung call is an error, not a wait. */
const REQUEST_TIMEOUT_MS = 30 * 1000;

/** The engine profile id the soak's stub engine registers as (`deploy/soak/stub-engine/`). */
const STUB_ENGINE_ID = 'soak-stub';

/** The project name the soak's port leases are recorded under. */
const LEASE_PROJECT = 'soak-harness';

/** Closed set of outcome codes an executor reports on failure. */
const OUTCOME = Object.freeze({
  OK: 'OK',
  HTTP_STATUS: 'HTTP_STATUS',
  TIMEOUT: 'TIMEOUT',
  NETWORK: 'NETWORK',
  BAD_BODY: 'BAD_BODY',
  FOREIGN_SESSION: 'FOREIGN_SESSION',
  REDIRECT_REFUSED: 'REDIRECT_REFUSED'
});

/**
 * One HTTP call, reduced to an outcome. Only the status and a parsed JSON
 * body are kept; a soak log is evidence, so it must not grow by whatever a
 * route happens to return.
 * @param {object} ctx - `{apiBase, token, fetch, timeoutMs}`
 * @param {string} method - HTTP method
 * @param {string} path - Path beginning with `/api/`
 * @param {object} [body] - JSON body
 * @returns {Promise<{ok: boolean, status: number|null, code: string, body: *}>} Outcome
 */
async function call(ctx, method, path, body) {
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (ctx.token) headers.authorization = `Bearer ${ctx.token}`;
  let res;
  try {
    res = await ctx.fetch(new URL(path, ctx.apiBase), {
      method,
      // Never follow a redirect. A target that passed every guard could
      // answer 307 and have fetch replay this request, method and body
      // included, to any host it names, the live install among them.
      redirect: 'manual',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(ctx.timeoutMs || REQUEST_TIMEOUT_MS)
    });
  } catch (err) { // prawduct:allow prawduct/broad-except -- network boundary: every fetch failure becomes a recorded outcome, never a crash of the soak
    const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return { ok: false, status: null, code: timedOut ? OUTCOME.TIMEOUT : OUTCOME.NETWORK, body: null };
  }
  if (res.status >= 300 && res.status <= 399) {
    const location = res.headers && typeof res.headers.get === 'function' ? res.headers.get('location') : null;
    return { ok: false, status: res.status, code: OUTCOME.REDIRECT_REFUSED, body: null, location };
  }
  let text;
  try {
    text = await res.text();
  } catch (err) { // prawduct:allow prawduct/broad-except -- network boundary: a body cut off mid-read is a recorded outcome
    return { ok: false, status: res.status, code: OUTCOME.NETWORK, body: null };
  }
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { ok: false, status: res.status, code: OUTCOME.BAD_BODY, body: null };
  }
  if (res.status < 200 || res.status > 299) return { ok: false, status: res.status, code: OUTCOME.HTTP_STATUS, body: parsed };
  return { ok: true, status: res.status, code: OUTCOME.OK, body: parsed };
}

/**
 * Run a sequence of calls and stop at the first failure, which names the step
 * that failed. A later step never runs on a failed earlier one: releasing a
 * port that was never leased, or killing a session that never started, would
 * record a second error for the same fault.
 * @param {object} ctx - Call context
 * @param {Array<[string, string, object?]>} steps - `[method, path, body]` triples
 * @returns {Promise<{ok: boolean, code: string, status: number|null, step: number|null, steps: number}>} Outcome
 */
async function _sequence(ctx, steps) {
  for (let i = 0; i < steps.length; i++) {
    const r = await call(ctx, ...steps[i]);
    if (!r.ok) return { ok: false, code: r.code, status: r.status, step: i, steps: steps.length, ...(r.location !== undefined ? { location: r.location } : {}) };
  }
  return { ok: true, code: OUTCOME.OK, status: null, step: null, steps: steps.length };
}

/**
 * A single GET, as an executor.
 * @param {string} path - Route
 * @returns {(ctx: object) => Promise<object>} Executor
 */
function _get(path) {
  return async (ctx) => {
    const r = await call(ctx, 'GET', path);
    return { ok: r.ok, code: r.code, status: r.status, step: r.ok ? null : 0, steps: 1, ...(r.location !== undefined ? { location: r.location } : {}) };
  };
}

/**
 * The executors by event kind. Each takes `(ctx, params)`.
 * @type {Object<string, (ctx: object, params: object) => Promise<object>>}
 */
const EXECUTORS = Object.freeze({
  'api.health': _get('/api/health'),
  'api.server-info': _get('/api/server-info'),
  'api.projects.list': _get('/api/projects'),
  'api.ports.list': _get('/api/ports'),
  'api.ports.lease-release': (ctx, params) => _sequence(ctx, [
    ['POST', '/api/ports/lease', { port: params.port, host: 'localhost', project: LEASE_PROJECT, service: 'soak-load', permanent: false, ttl: 5 * 60 * 1000 }],
    ['POST', '/api/ports/release', { port: params.port, host: 'localhost', project: LEASE_PROJECT }]
  ]),
  'engine.session.cycle': engineSessionCycle
});

/**
 * Launch a stub-engine session, inject commands, and kill it.
 *
 * The cycle first asks for the project's session status, because a cycle that
 * was in flight when the driver crashed runs again on resume, and its session
 * may still be up. What happens next depends on the answer:
 * - No active session: launch.
 * - An active session on the soak's own stub engine: that is a leftover from
 *   this harness, so it is killed (`preKilled: true`) and the cycle launches.
 * - An active session on ANY other engine: it is not the harness's, so it is
 *   never touched. The cycle fails with `FOREIGN_SESSION` and launches nothing.
 * - Status unreadable: the cycle fails at that step and kills nothing, since
 *   it cannot tell whose session it would be killing.
 *
 * Once its own launch has succeeded, the final kill is always attempted, even
 * after a failed command, so one failure cannot leak a session into the rest
 * of the soak.
 * @param {object} ctx - Call context
 * @param {{project: string, commands: number}} params - Event params
 * @returns {Promise<object>} Outcome
 */
async function engineSessionCycle(ctx, params) {
  const base = `/api/sessions/${encodeURIComponent(params.project)}`;
  const commands = [];
  for (let i = 1; i <= params.commands; i++) commands.push(['POST', `${base}/command`, { command: `soak ping ${i}` }]);
  const total = commands.length + 2;

  const status = await call(ctx, 'GET', `${base}/status`);
  if (!status.ok) return { ok: false, code: status.code, status: status.status, step: 'status', steps: total };
  let preNote = {};
  if (status.body && status.body.active === true) {
    if (status.body.engine !== STUB_ENGINE_ID) {
      return { ok: false, code: OUTCOME.FOREIGN_SESSION, status: null, step: 'status', steps: total, foreignEngine: status.body.engine === undefined ? null : status.body.engine };
    }
    const pre = await call(ctx, 'DELETE', base, { reason: 'soak cycle: clear a leftover soak-stub session' });
    if (!pre.ok && pre.status !== 404) {
      return { ok: false, code: pre.code, status: pre.status, step: 'pre-kill', steps: total };
    }
    preNote = pre.ok ? { preKilled: true } : {};
  }

  const launch = await call(ctx, 'POST', base, { engineOverride: STUB_ENGINE_ID, primePrompt: false });
  if (!launch.ok) return { ok: false, code: launch.code, status: launch.status, step: 0, steps: total, ...preNote };
  const middle = await _sequence(ctx, commands);
  const kill = await call(ctx, 'DELETE', base, { reason: 'soak cycle' });
  if (!middle.ok) {
    return { ok: false, code: middle.code, status: middle.status, step: middle.step + 1, steps: total, cleanupFailed: !kill.ok, ...preNote };
  }
  if (!kill.ok) return { ok: false, code: kill.code, status: kill.status, step: total - 1, steps: total, ...preNote };
  return { ok: true, code: OUTCOME.OK, status: null, step: null, steps: total, ...preNote };
}

module.exports = { EXECUTORS, OUTCOME, STUB_ENGINE_ID, LEASE_PROJECT, REQUEST_TIMEOUT_MS, call };
