'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const ex = require('../lib/soak/executors');
const sched = require('../lib/soak/schedule');

/**
 * A fetch stand-in that records each request and answers from a script.
 * @param {(req: {method: string, path: string, body: *}) => ({status: number, body?: *, text?: string}|Error)} answer - Response per request; an Error is thrown as a fetch failure
 * @returns {{fetch: Function, calls: object[]}} The fake and its log
 */
function fakeFetch(answer) {
  const calls = [];
  const fetch = async (url, init) => {
    const req = {
      method: init.method,
      path: url.pathname,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      headers: init.headers
    };
    calls.push(req);
    const r = answer(req);
    if (r instanceof Error) throw r;
    const text = r.text !== undefined ? r.text : (r.body === undefined ? '' : JSON.stringify(r.body));
    return { status: r.status, text: async () => text };
  };
  return { fetch, calls };
}

/**
 * A call context for tests.
 * @param {Function} fetch - Fetch implementation
 * @param {object} [over] - Overrides
 * @returns {object} Context
 */
function ctx(fetch, over = {}) {
  return { apiBase: 'http://soak-guest.invalid:3102', token: null, fetch, ...over };
}

describe('soak executors — coverage of the catalogue', () => {
  it('has an executor for every api and engine kind, and none for browser or fault kinds', () => {
    for (const t of sched.TASKS) {
      const has = typeof ex.EXECUTORS[t.kind] === 'function';
      assert.equal(has, t.class === 'api' || t.class === 'engine', t.kind);
    }
    for (const f of sched.FAULTS) assert.equal(ex.EXECUTORS[f.kind], undefined, f.kind);
  });

  it('names no kind the schedule does not know', () => {
    const known = new Set([...sched.TASKS, ...sched.FAULTS].map((k) => k.kind));
    for (const kind of Object.keys(ex.EXECUTORS)) assert.ok(known.has(kind), kind);
  });
});

describe('soak executors — single calls', () => {
  it('reports OK for a 2xx and sends the bearer token when one is given', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { ok: true } }));
    const r = await ex.EXECUTORS['api.health'](ctx(f.fetch, { token: 't0k' }), {});
    assert.deepEqual(r, { ok: true, code: 'OK', status: 200, step: null, steps: 1 });
    assert.equal(f.calls[0].method, 'GET');
    assert.equal(f.calls[0].path, '/api/health');
    assert.equal(f.calls[0].headers.authorization, 'Bearer t0k');
  });

  it('sends no authorization header without a token', async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} }));
    await ex.EXECUTORS['api.projects.list'](ctx(f.fetch), {});
    assert.equal(f.calls[0].headers.authorization, undefined);
  });

  it('reports HTTP_STATUS with the status for a non-2xx', async () => {
    const f = fakeFetch(() => ({ status: 503, body: { error: 'down' } }));
    const r = await ex.EXECUTORS['api.ports.list'](ctx(f.fetch), {});
    assert.equal(r.ok, false);
    assert.equal(r.code, 'HTTP_STATUS');
    assert.equal(r.status, 503);
  });

  it('reports TIMEOUT when the request is aborted by its time budget', async () => {
    const err = new Error('timed out');
    err.name = 'TimeoutError';
    const r = await ex.EXECUTORS['api.health'](ctx(fakeFetch(() => err).fetch), {});
    assert.equal(r.code, 'TIMEOUT');
    assert.equal(r.status, null);
  });

  it('reports NETWORK when the connection fails', async () => {
    const r = await ex.EXECUTORS['api.server-info'](ctx(fakeFetch(() => new TypeError('fetch failed')).fetch), {});
    assert.equal(r.code, 'NETWORK');
  });

  it('reports BAD_BODY for a response that is not JSON', async () => {
    const r = await ex.EXECUTORS['api.health'](ctx(fakeFetch(() => ({ status: 200, text: '<html>' })).fetch), {});
    assert.equal(r.code, 'BAD_BODY');
    assert.equal(r.status, 200);
  });

  it('actually times out a hung request with the real AbortSignal', async () => {
    const hung = (url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
    // AbortSignal.timeout's timer is unref'd; a real fetch holds the loop open
    // with its socket, so the fake holds it open with a timer instead.
    const keepAlive = setTimeout(() => {}, 5000);
    try {
      const r = await ex.call(ctx(hung, { timeoutMs: 20 }), 'GET', '/api/health');
      assert.equal(r.code, 'TIMEOUT');
    } finally {
      clearTimeout(keepAlive);
    }
  });
});

describe('soak executors — port lease and release', () => {
  it('leases then releases the scheduled port under the soak project', async () => {
    const f = fakeFetch(() => ({ status: 201, body: {} }));
    const r = await ex.EXECUTORS['api.ports.lease-release'](ctx(f.fetch), { port: 5512 });
    assert.equal(r.ok, true);
    assert.deepEqual(f.calls.map((c) => `${c.method} ${c.path}`), ['POST /api/ports/lease', 'POST /api/ports/release']);
    assert.equal(f.calls[0].body.port, 5512);
    assert.equal(f.calls[0].body.project, ex.LEASE_PROJECT);
    assert.equal(f.calls[0].body.permanent, false);
    assert.equal(f.calls[1].body.project, ex.LEASE_PROJECT);
  });

  it('does not release a port whose lease was refused', async () => {
    const f = fakeFetch(() => ({ status: 409, body: { code: 'PORT_CONFLICT' } }));
    const r = await ex.EXECUTORS['api.ports.lease-release'](ctx(f.fetch), { port: 5512 });
    assert.deepEqual({ ok: r.ok, code: r.code, status: r.status, step: r.step }, { ok: false, code: 'HTTP_STATUS', status: 409, step: 0 });
    assert.equal(f.calls.length, 1);
  });
});

describe('soak executors — engine session cycle', () => {
  it('launches with the stub engine, injects each command, then kills the session', async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} }));
    const r = await ex.EXECUTORS['engine.session.cycle'](ctx(f.fetch), { project: 'soak a', commands: 2 });
    assert.deepEqual(r, { ok: true, code: 'OK', status: null, step: null, steps: 4 });
    assert.deepEqual(f.calls.map((c) => `${c.method} ${c.path}`), [
      'POST /api/sessions/soak%20a',
      'POST /api/sessions/soak%20a/command',
      'POST /api/sessions/soak%20a/command',
      'DELETE /api/sessions/soak%20a'
    ]);
    assert.equal(f.calls[0].body.engineOverride, ex.STUB_ENGINE_ID);
    assert.equal(f.calls[0].body.primePrompt, false);
  });

  it('stops without a kill when the launch fails', async () => {
    const f = fakeFetch(() => ({ status: 404, body: {} }));
    const r = await ex.EXECUTORS['engine.session.cycle'](ctx(f.fetch), { project: 'soak-a', commands: 3 });
    assert.equal(r.step, 0);
    assert.equal(f.calls.length, 1);
  });

  it('still kills the session when a command fails, and reports the failing command', async () => {
    const f = fakeFetch((req) => (req.path.endsWith('/command') && req.body.command === 'soak ping 2' ? { status: 500, body: {} } : { status: 200, body: {} }));
    const r = await ex.EXECUTORS['engine.session.cycle'](ctx(f.fetch), { project: 'soak-a', commands: 3 });
    assert.deepEqual(r, { ok: false, code: 'HTTP_STATUS', status: 500, step: 2, steps: 5, cleanupFailed: false });
    assert.equal(f.calls[f.calls.length - 1].method, 'DELETE');
    assert.equal(f.calls.filter((c) => c.path.endsWith('/command')).length, 2, 'no command after the failed one');
  });

  it('records a failed kill after a failed command as cleanupFailed', async () => {
    const f = fakeFetch((req) => (req.method === 'POST' && !req.path.endsWith('/command') ? { status: 200, body: {} } : { status: 500, body: {} }));
    const r = await ex.EXECUTORS['engine.session.cycle'](ctx(f.fetch), { project: 'soak-a', commands: 1 });
    assert.equal(r.step, 1);
    assert.equal(r.cleanupFailed, true);
  });

  it('reports a failed kill after a clean cycle at the kill step', async () => {
    const f = fakeFetch((req) => (req.method === 'DELETE' ? { status: 500, body: {} } : { status: 200, body: {} }));
    const r = await ex.EXECUTORS['engine.session.cycle'](ctx(f.fetch), { project: 'soak-a', commands: 1 });
    assert.deepEqual({ ok: r.ok, step: r.step, steps: r.steps }, { ok: false, step: 2, steps: 3 });
  });
});
